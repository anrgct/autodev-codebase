import { OpenAI } from "openai"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import {
  MAX_BATCH_TOKENS,
  MAX_ITEM_TOKENS,
  MAX_BATCH_RETRIES as MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { getDefaultModelId, getModelQueryPrefix } from "../../shared/embeddingModels"
import { withValidationErrorHandling, HttpError, formatEmbeddingError } from "../shared/validation-helpers"
import { handleOpenAIError } from "../shared/openai-error-handler"
import { Mutex } from "async-mutex"
import { fetch, ProxyAgent } from "undici"

interface EmbeddingItem {
  embedding: string | number[]
  [key: string]: any
}

interface OpenAIEmbeddingResponse {
  data: EmbeddingItem[]
  usage?: {
    prompt_tokens?: number
    total_tokens?: number
  }
}

/**
 * OpenAI Compatible implementation of the embedder interface with batching and rate limiting.
 * This embedder allows using any OpenAI-compatible API endpoint by specifying a custom baseURL.
 */
export class OpenAICompatibleEmbedder implements IEmbedder {
  private embeddingsClient: OpenAI
  private readonly defaultModelId: string
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly isFullUrl: boolean
  private readonly maxItemTokens: number
  private readonly _optimalBatchSize: number

  // Global rate limiting state shared across all instances
  private static globalRateLimitState = {
    isRateLimited: false,
    rateLimitResetTime: 0,
    consecutiveRateLimitErrors: 0,
    lastRateLimitError: 0,
    // Mutex to ensure thread-safe access to rate limit state
    mutex: new Mutex(),
  }

  /**
   * Creates a new OpenAI Compatible embedder
   * @param baseUrl The base URL for the OpenAI-compatible API endpoint
   * @param apiKey The API key for authentication
   * @param modelId Optional model identifier (defaults to "text-embedding-3-small")
   * @param maxItemTokens Optional maximum tokens per item (defaults to MAX_ITEM_TOKENS)
   */
  constructor(baseUrl: string, apiKey: string, modelId?: string, maxItemTokens?: number) {
    if (!baseUrl) {
      throw new Error("Base URL is required for OpenAI Compatible embedder")
    }
    if (!apiKey) {
      throw new Error("API key is required for OpenAI Compatible embedder")
    }

    this.baseUrl = baseUrl
    this.apiKey = apiKey
    // Initialize optimal batch size for OpenAI Compatible (can be customized via options)
    this._optimalBatchSize = 60

    // Wrap OpenAI client creation to handle invalid API key characters
    try {
      // 检查环境变量中的代理设置
      const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
      const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

      // 根据目标 URL 协议选择合适的代理
      const proxyUrl = baseUrl.startsWith('https:') ? httpsProxy : (httpProxy || httpsProxy)

      let dispatcher: any = undefined
      if (proxyUrl) {
        try {
          dispatcher = new ProxyAgent(proxyUrl)
          console.log('✓ OpenAI Compatible Embedding using undici ProxyAgent:', proxyUrl)
        } catch (error) {
          console.error('✗ Failed to create undici ProxyAgent for OpenAI Compatible Embedding:', error)
        }
      }

      // 调试OpenAI客户端配置
      const clientConfig: any = {
        baseURL: baseUrl,
        apiKey: apiKey,
        dangerouslyAllowBrowser: true,
      }

      if (dispatcher) {
        clientConfig.fetch = (url: string, init?: any) => {
          return fetch(url, {
            ...init,
            dispatcher
          })
        }
        console.log('📝 调试: OpenAI客户端将使用 undici ProxyAgent 代理')
      } else {
        clientConfig.fetch = fetch
      }

      this.embeddingsClient = new OpenAI(clientConfig)
    } catch (error) {
      // Use the error handler to transform ByteString conversion errors
      throw handleOpenAIError(error, "OpenAI Compatible")
    }

    this.defaultModelId = modelId || getDefaultModelId("openai-compatible")
    // Cache the URL type check for performance
    this.isFullUrl = this.isFullEndpointUrl(baseUrl)
    this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
  }

  /**
   * Creates embeddings for the given texts with batching and rate limiting
   * @param texts Array of text strings to embed
   * @param model Optional model identifier
   * @returns Promise resolving to embedding response
   */
  async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
    const modelToUse = model || this.defaultModelId

    // Apply model-specific query prefix if required
    const queryPrefix = getModelQueryPrefix("openai-compatible", modelToUse)
    const processedTexts = queryPrefix
      ? texts.map((text, index) => {
          // Prevent double-prefixing
          if (text.startsWith(queryPrefix)) {
            return text
          }
          const prefixedText = `${queryPrefix}${text}`
          const estimatedTokens = Math.ceil(prefixedText.length / 4)
          if (estimatedTokens > MAX_ITEM_TOKENS) {
            console.warn(
              `Text at index ${index} with prefix exceeds token limit (${estimatedTokens} > ${MAX_ITEM_TOKENS}). Using original text.`,
            )
            // Return original text if adding prefix would exceed limit
            return text
          }
          return prefixedText
        })
      : texts

    const allEmbeddings: number[][] = []
    const usage = { promptTokens: 0, totalTokens: 0 }
    const remainingTexts = [...processedTexts]

    while (remainingTexts.length > 0) {
      const currentBatch: string[] = []
      let currentBatchTokens = 0
      const processedIndices: number[] = []

      for (let i = 0; i < remainingTexts.length; i++) {
        const text = remainingTexts[i]
        const itemTokens = Math.ceil(text.length / 4)

        if (itemTokens > this.maxItemTokens) {
          console.warn(
            `Text at index ${i} exceeds token limit (${itemTokens} > ${this.maxItemTokens}). Skipping.`,
          )
          processedIndices.push(i)
          continue
        }

        if (currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS) {
          currentBatch.push(text)
          currentBatchTokens += itemTokens
          processedIndices.push(i)
        } else {
          break
        }
      }

      // Remove processed items from remainingTexts (in reverse order to maintain correct indices)
      for (let i = processedIndices.length - 1; i >= 0; i--) {
        remainingTexts.splice(processedIndices[i], 1)
      }

      if (currentBatch.length > 0) {
        const batchResult = await this._embedBatchWithRetries(currentBatch, modelToUse)
        allEmbeddings.push(...batchResult.embeddings)
        usage.promptTokens += batchResult.usage.promptTokens
        usage.totalTokens += batchResult.usage.totalTokens
      }
    }

    return { embeddings: allEmbeddings, usage }
  }

  /**
   * Determines if the provided URL is a full endpoint URL or a base URL that needs the endpoint appended by the SDK.
   * Uses smart pattern matching for known providers while accepting we can't cover all possible patterns.
   * @param url The URL to check
   * @returns true if it's a full endpoint URL, false if it's a base URL
   */
  private isFullEndpointUrl(url: string): boolean {
    // Known patterns for major providers
    const patterns = [
      // Azure OpenAI: /deployments/{deployment-name}/embeddings
      /\/deployments\/[^\/]+\/embeddings(\?|$)/,
      // Azure Databricks: /serving-endpoints/{endpoint-name}/invocations
      /\/serving-endpoints\/[^\/]+\/invocations(\?|$)/,
      // Direct endpoints: ends with /embeddings (before query params)
      /\/embeddings(\?|$)/,
      // Some providers use /embed instead of /embeddings
      /\/embed(\?|$)/,
    ]

    return patterns.some((pattern) => pattern.test(url))
  }

  /**
   * Makes a direct HTTP request to the embeddings endpoint
   * Used when the user provides a full endpoint URL (e.g., Azure OpenAI with query parameters)
   * @param url The full endpoint URL
   * @param batchTexts Array of texts to embed
   * @param model Model identifier to use
   * @returns Promise resolving to OpenAI-compatible response
   */
  private async makeDirectEmbeddingRequest(
    url: string,
    batchTexts: string[],
    model: string,
  ): Promise<OpenAIEmbeddingResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Azure OpenAI uses 'api-key' header, while OpenAI uses 'Authorization'
        // We'll try 'api-key' first for Azure compatibility
        "api-key": this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: batchTexts,
        model: model,
        encoding_format: "base64",
      }),
    })

    if (!response || !response.ok) {
      const status = response?.status || 0
      let errorText = "No response"
      try {
        if (response && typeof response.text === "function") {
          errorText = await response.text()
        } else if (response) {
          errorText = `Error ${status}`
        }
      } catch {
        // Ignore text parsing errors
        errorText = `Error ${status}`
      }
      const error = new Error(`HTTP ${status}: ${errorText}`) as HttpError
      error.status = status || response?.status || 0
      throw error
    }

    try {
      const result = await response.json()
      // Ensure the response has the required structure
      if (!result || typeof result !== 'object' || !('data' in result)) {
        const error = new Error(`Invalid response structure: missing 'data' property`) as HttpError
        error.status = response?.status || 0
        throw error
      }
      return result as OpenAIEmbeddingResponse
    } catch (e) {
      const error = new Error(`Failed to parse response JSON`) as HttpError
      error.status = response?.status || 0
      throw error
    }
  }

  /**
   * Helper method to handle batch embedding with retries and exponential backoff
   * @param batchTexts Array of texts to embed in this batch
   * @param model Model identifier to use
   * @returns Promise resolving to embeddings and usage statistics
   */
  private async _embedBatchWithRetries(
    batchTexts: string[],
    model: string,
  ): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
    // Use cached value for performance
    const isFullUrl = this.isFullUrl

    for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
      // Check global rate limit before attempting request
      await this.waitForGlobalRateLimit()

      try {
        let response: OpenAIEmbeddingResponse

        if (isFullUrl) {
          // Use direct HTTP request for full endpoint URLs
          response = await this.makeDirectEmbeddingRequest(this.baseUrl, batchTexts, model)
        } else {
          // Use OpenAI SDK for base URLs
          response = (await this.embeddingsClient.embeddings.create({
            input: batchTexts,
            model: model,
            // OpenAI package (as of v4.78.1) has a parsing issue that truncates embedding dimensions to 256
            // when processing numeric arrays, which breaks compatibility with models using larger dimensions.
            // By requesting base64 encoding, we bypass the package's parser and handle decoding ourselves.
            encoding_format: "base64",
          })) as OpenAIEmbeddingResponse
        }

        // Convert base64 embeddings to float32 arrays
        const processedEmbeddings = response.data.map((item: EmbeddingItem) => {
          if (typeof item.embedding === "string") {
            const buffer = Buffer.from(item.embedding, "base64")

            // Create Float32Array view over the buffer
            const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

            return {
              ...item,
              embedding: Array.from(float32Array),
            }
          }
          return item
        })

        // Replace the original data with processed embeddings
        response.data = processedEmbeddings

        const embeddings = response.data.map((item) => item.embedding as number[])

        return {
          embeddings: embeddings,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
          },
        }
      } catch (error) {
        // TelemetryService calls removed as per requirements

        const hasMoreAttempts = attempts < MAX_RETRIES - 1

        // Check if it's a rate limit error
        const httpError = error as HttpError
        if (httpError?.status === 429) {
          // Update global rate limit state
          await this.updateGlobalRateLimitState(httpError)

          if (hasMoreAttempts) {
            // Calculate delay based on global rate limit state
            const baseDelay = INITIAL_DELAY_MS * Math.pow(2, attempts)
            const globalDelay = await this.getGlobalRateLimitDelay()
            const delayMs = Math.max(baseDelay, globalDelay)

            console.warn(
              `Rate limit hit. Retrying in ${delayMs}ms (attempt ${attempts + 1}/${MAX_RETRIES})`,
            )
            await new Promise((resolve) => setTimeout(resolve, delayMs))
            continue
          }
        }

        // Log the error for debugging
        console.error(`OpenAI Compatible embedder error (attempt ${attempts + 1}/${MAX_RETRIES}):`, error)

        // Format and throw the error
        throw formatEmbeddingError(error, MAX_RETRIES)
      }
    }

    throw new Error(`Failed to generate embeddings after ${MAX_RETRIES} attempts`)
  }

  /**
   * Validates the OpenAI-compatible embedder configuration by testing endpoint connectivity and API key
   * @returns Promise resolving to validation result with success status and optional error message
   */
  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    return withValidationErrorHandling(async () => {
      try {
        // Test with a minimal embedding request
        const testTexts = ["test"]
        const modelToUse = this.defaultModelId

        let response: OpenAIEmbeddingResponse

        if (this.isFullUrl) {
          // Test direct HTTP request for full endpoint URLs
          response = await this.makeDirectEmbeddingRequest(this.baseUrl, testTexts, modelToUse)
        } else {
          // Test using OpenAI SDK for base URLs
          response = (await this.embeddingsClient.embeddings.create({
            input: testTexts,
            model: modelToUse,
            encoding_format: "base64",
          })) as OpenAIEmbeddingResponse
        }

        // Check if we got a valid response
        if (!response?.data || response.data.length === 0) {
          return {
            valid: false,
            error: "Invalid response from embedding service",
          }
        }

        return { valid: true }
      } catch (error) {
        // TelemetryService calls removed as per requirements
        throw error
      }
    }, "openai-compatible")
  }

  /**
   * Returns information about this embedder
   */
  get embedderInfo(): EmbedderInfo {
    return {
      name: "openai-compatible",
    }
  }

  /**
   * Gets the optimal batch size for this OpenAI Compatible embedder
   */
  get optimalBatchSize(): number {
    return this._optimalBatchSize
  }

  get poolingMode(): "late-chunking" | "last-token" {
    return "last-token"
  }

  /**
   * Waits if there's an active global rate limit
   */
  private async waitForGlobalRateLimit(): Promise<void> {
    const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
    let mutexReleased = false

    try {
      const state = OpenAICompatibleEmbedder.globalRateLimitState

      if (state.isRateLimited && state.rateLimitResetTime > Date.now()) {
        const waitTime = state.rateLimitResetTime - Date.now()
        // Silent wait - no logging to prevent flooding
        release()
        mutexReleased = true
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        return
      }

      // Reset rate limit if time has passed
      if (state.isRateLimited && state.rateLimitResetTime <= Date.now()) {
        state.isRateLimited = false
        state.consecutiveRateLimitErrors = 0
      }
    } finally {
      // Only release if we haven't already
      if (!mutexReleased) {
        release()
      }
    }
  }

  /**
   * Updates global rate limit state when a 429 error occurs
   */
  private async updateGlobalRateLimitState(error: HttpError): Promise<void> {
    const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
    try {
      const state = OpenAICompatibleEmbedder.globalRateLimitState
      const now = Date.now()

      // Increment consecutive rate limit errors
      if (now - state.lastRateLimitError < 60000) {
        // Within 1 minute
        state.consecutiveRateLimitErrors++
      } else {
        state.consecutiveRateLimitErrors = 1
      }

      state.lastRateLimitError = now

      // Calculate exponential backoff based on consecutive errors
      const baseDelay = 5000 // 5 seconds base
      const maxDelay = 300000 // 5 minutes max
      const exponentialDelay = Math.min(baseDelay * Math.pow(2, state.consecutiveRateLimitErrors - 1), maxDelay)

      // Set global rate limit
      state.isRateLimited = true
      state.rateLimitResetTime = now + exponentialDelay

      // Silent rate limit activation - no logging to prevent flooding
    } finally {
      release()
    }
  }

  /**
   * Gets the current global rate limit delay
   */
  private async getGlobalRateLimitDelay(): Promise<number> {
    const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
    try {
      const state = OpenAICompatibleEmbedder.globalRateLimitState

      if (state.isRateLimited && state.rateLimitResetTime > Date.now()) {
        return state.rateLimitResetTime - Date.now()
      }

      return 0
    } finally {
      release()
    }
  }
}
