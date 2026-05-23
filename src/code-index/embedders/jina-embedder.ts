import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import {
  MAX_BATCH_TOKENS,
  MAX_ITEM_TOKENS,
  MAX_BATCH_RETRIES as MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { fetch, ProxyAgent } from "undici"

interface JinaEmbeddingResponse {
  model: string
  object: string
  usage: {
    total_tokens: number
    prompt_tokens: number
  }
  data: Array<{
    object: string
    index: number
    embedding: number[]
  }>
}

/**
 * Jina AI implementation of the embedder interface with batching and rate limiting.
 */
export class JinaEmbedder implements IEmbedder {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly modelId: string
  private readonly _optimalBatchSize: number

  constructor(apiKey: string, modelId: string = 'jina-embeddings-v2-base-code', options?: { jinaBatchSize?: number, jinaBaseUrl?: string }) {
    if (!apiKey) {
      throw new Error("API key is required for Jina embedder")
    }

    this.baseUrl = options?.jinaBaseUrl || 'https://api.jina.ai/v1'
    this.apiKey = apiKey
    this.modelId = modelId
    // Initialize optimal batch size for Jina (can be customized via options)
    this._optimalBatchSize = options?.jinaBatchSize || 30
  }

  /**
   * Creates a ProxyAgent from environment variables if configured.
   * Follows the same pattern as Ollama embedder's proxy support.
   */
  private _createProxyDispatcher(targetUrl: string): any | undefined {
    const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
    const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

    // 根据目标 URL 协议选择合适的代理
    const proxyUrl = targetUrl.startsWith('https:') ? httpsProxy : httpProxy

    if (proxyUrl) {
      try {
        console.log('✓ Jina Embedding using undici ProxyAgent:', proxyUrl)
        return new ProxyAgent(proxyUrl)
      } catch (error) {
        console.error('✗ Failed to create undici ProxyAgent for Jina:', error)
      }
    }

    return undefined
  }

  /**
   * Creates embeddings for the given texts with batching and rate limiting
   */
  async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
    const modelToUse = model || this.modelId
    const allEmbeddings: number[][] = []
    const usage = { promptTokens: 0, totalTokens: 0 }
    const remainingTexts = [...texts]

    while (remainingTexts.length > 0) {
      const currentBatch: string[] = []
      let currentBatchTokens = 0
      const processedIndices: number[] = []

      for (let i = 0; i < remainingTexts.length; i++) {
        const text = remainingTexts[i]
        const itemTokens = Math.ceil(text.length / 4)

        if (itemTokens > MAX_ITEM_TOKENS) {
          console.warn(
            `Text at index ${i} exceeds maximum token limit (${itemTokens} > ${MAX_ITEM_TOKENS}). Skipping.`,
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
        try {
          const batchResult = await this._embedBatchWithRetries(currentBatch, modelToUse)
          allEmbeddings.push(...batchResult.embeddings)
          usage.promptTokens += batchResult.usage.promptTokens
          usage.totalTokens += batchResult.usage.totalTokens
        } catch (error) {
          console.error("Failed to process batch:", error)
          throw new Error("Failed to create embeddings: batch processing error")
        }
      }
    }

    return { embeddings: allEmbeddings, usage }
  }

  /**
   * Helper method to handle batch embedding with retries and exponential backoff
   */
  private async _embedBatchWithRetries(
    batchTexts: string[],
    model: string,
  ): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
    for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
      try {
        const requestData = {
          model: model,
          input: batchTexts,
        }

        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestData),
          dispatcher: this._createProxyDispatcher(this.baseUrl),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const result = await response.json() as JinaEmbeddingResponse
        const embeddings = result.data.map(item => item.embedding)

        return {
          embeddings,
          usage: {
            promptTokens: result.usage.prompt_tokens,
            totalTokens: result.usage.total_tokens,
          },
        }
      } catch (error: any) {
        const isRateLimitError = error.message?.includes('429')
        const hasMoreAttempts = attempts < MAX_RETRIES - 1

        if (isRateLimitError && hasMoreAttempts) {
          const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempts)
          console.warn(`Rate limit hit, retrying in ${delayMs}ms (attempt ${attempts + 1}/${MAX_RETRIES})`)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }

        console.error(`Jina embedder error (attempt ${attempts + 1}/${MAX_RETRIES}):`, error)

        if (!hasMoreAttempts) {
          throw new Error(
            `Failed to create embeddings after ${MAX_RETRIES} attempts: ${error.message || error}`,
          )
        }

        throw error
      }
    }

    throw new Error(`Failed to create embeddings after ${MAX_RETRIES} attempts`)
  }

  /**
   * Validates the embedder configuration by testing API connectivity
   */
  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const testText = "test"
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          input: [testText],
        }),
        dispatcher: this._createProxyDispatcher(this.baseUrl),
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          valid: false,
          error: `HTTP ${response.status}: ${errorText}`
        }
      }

      const result = await response.json() as JinaEmbeddingResponse
      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        return {
          valid: false,
          error: 'Invalid response format from Jina API'
        }
      }

      return { valid: true }
    } catch (error: any) {
      return {
        valid: false,
        error: error.message || 'Failed to connect to Jina API'
      }
    }
  }

  /**
   * Returns information about this embedder
   */
  get embedderInfo(): EmbedderInfo {
    return {
      name: "jina",
    }
  }

  /**
   * Gets the optimal batch size for this Jina embedder
   */
  get optimalBatchSize(): number {
    return this._optimalBatchSize
  }

  get poolingMode(): "late-chunking" | "last-token" {
    return "last-token"
  }
}
