import { OpenAI } from "openai"
import { ApiHandlerOptions } from "../../shared/api"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import {
  MAX_BATCH_TOKENS,
  MAX_ITEM_TOKENS,
  MAX_BATCH_RETRIES as MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { getModelQueryPrefix } from "../../shared/embeddingModels"
import { withValidationErrorHandling, formatEmbeddingError, HttpError } from "../shared/validation-helpers"
import { handleOpenAIError } from "../shared/openai-error-handler"
import { fetch, ProxyAgent } from "undici"

/**
 * OpenAI implementation of the embedder interface with batching and rate limiting
 */
export class OpenAiEmbedder implements IEmbedder {
  private embeddingsClient: OpenAI
  private readonly defaultModelId: string
  private readonly _optimalBatchSize: number

  /**
   * Creates a new OpenAI embedder
   * @param options API handler options
   */
  constructor(options: ApiHandlerOptions & { openAiEmbeddingModelId?: string }) {
    const apiKey = options.openAiNativeApiKey ?? "not-provided"

    // Initialize optimal batch size for OpenAI (can be customized via options)
    this._optimalBatchSize = options['openaiBatchSize'] || 60

    // Wrap OpenAI client creation to handle invalid API key characters
    try {
      // 检查环境变量中的代理设置
      const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
      const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

      // OpenAI API 使用 HTTPS，所以优先使用 HTTPS 代理
      const proxyUrl = httpsProxy || httpProxy

      let dispatcher: any = undefined
      if (proxyUrl) {
        try {
          dispatcher = new ProxyAgent(proxyUrl)
          console.log('✓ OpenAI Embedding using undici ProxyAgent:', proxyUrl)
        } catch (error) {
          console.error('✗ Failed to create undici ProxyAgent for OpenAI Embedding:', error)
        }
      }

      const clientConfig: any = {
        apiKey,
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
      throw handleOpenAIError(error, "OpenAI")
    }

    this.defaultModelId = options.openAiEmbeddingModelId || "text-embedding-3-small"
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
    const queryPrefix = getModelQueryPrefix("openai", modelToUse)
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

        if (itemTokens > MAX_ITEM_TOKENS) {
          console.warn(
            `Text at index ${i} exceeds token limit (${itemTokens} > ${MAX_ITEM_TOKENS}). Skipping.`,
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
   * Helper method to handle batch embedding with retries and exponential backoff
   * @param batchTexts Array of texts to embed in this batch
   * @param model Model identifier to use
   * @returns Promise resolving to embeddings and usage statistics
   */
  private async _embedBatchWithRetries(
    batchTexts: string[],
    model: string,
  ): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
    for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
      try {
        const response = await this.embeddingsClient.embeddings.create({
          input: batchTexts,
          model: model,
          // OpenAI package (as of v4.78.1) has a parsing issue that truncates embedding dimensions to 256
          // when processing numeric arrays, which breaks compatibility with models using larger dimensions.
          // By requesting base64 encoding, we bypass the package's parser and handle decoding ourselves.
          encoding_format: "base64",
        })

        // Convert base64 embeddings to float32 arrays
        const processedEmbeddings = response.data.map((item) => {
          if (typeof item.embedding === "string") {
            const buffer = Buffer.from(item.embedding, "base64")
            const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
            return Array.from(float32Array)
          }
          return item.embedding
        })

        return {
          embeddings: processedEmbeddings,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
          },
        }
      } catch (error: any) {
        // TelemetryService calls removed as per requirements

        const hasMoreAttempts = attempts < MAX_RETRIES - 1

        // Check if it's a rate limit error
        const httpError = error as HttpError
        if (httpError?.status === 429 && hasMoreAttempts) {
          const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempts)
          console.warn(
            `Rate limit hit. Retrying in ${delayMs}ms (attempt ${attempts + 1}/${MAX_RETRIES})`,
          )
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }

        // Log the error for debugging
        console.error(`OpenAI embedder error (attempt ${attempts + 1}/${MAX_RETRIES}):`, error)

        // Format and throw the error
        throw formatEmbeddingError(error, MAX_RETRIES)
      }
    }

    throw new Error(`Failed to generate embeddings after ${MAX_RETRIES} attempts`)
  }

  /**
   * Validates the OpenAI embedder configuration by attempting a minimal embedding request
   * @returns Promise resolving to validation result with success status and optional error message
   */
  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    return withValidationErrorHandling(async () => {
      try {
        // Test with a minimal embedding request
        const response = await this.embeddingsClient.embeddings.create({
          input: ["test"],
          model: this.defaultModelId,
          encoding_format: "base64",
        })

        // Check if we got a valid response
        if (!response.data || response.data.length === 0) {
          return {
            valid: false,
            error: "Invalid response format from OpenAI API",
          }
        }

        return { valid: true }
      } catch (error) {
        // TelemetryService calls removed as per requirements
        throw error
      }
    }, "openai")
  }

  get embedderInfo(): EmbedderInfo {
    return {
      name: "openai",
    }
  }

  /**
   * Gets the optimal batch size for this OpenAI embedder
   */
  get optimalBatchSize(): number {
    return this._optimalBatchSize
  }

  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-attention" {
    return "last-token"
  }
}
