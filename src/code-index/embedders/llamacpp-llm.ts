import { getLlama, LlamaModel, LlamaEmbeddingContext, LlamaLogLevel } from "node-llama-cpp"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

/**
 * 使用通用 LLM（非专用 embedding 模型）的隐藏状态生成 embedding 向量。
 *
 * 与 LlamaCppEmbedder（使用专用 embedding 模型如 jina-embeddings-v5）不同，
 * 此类加载任意 GGUF LLM 模型（如 MiniCPM-V-4.6 / Qwen3-4B），通过
 * LlamaEmbeddingContext.getEmbeddingsForTokens() 提取 per-token hidden states，
 * 然后使用 last-token pooling 得到最终的文本表示。
 *
 * 这是"潜在推理检索"方案的第一步：验证 LLM 的隐藏状态可以作为检索查询向量。
 * 后续步骤将引入潜在空间自回归思考（LatentMAS）和对比学习投影层。
 *
 * 池化策略：last-token pooling
 * 对于 decoder-only LLM，最后一个 token 的 hidden state 包含了整个序列的上下文信息。
 */
export class LlamaCppLlmEmbedder implements IEmbedder {
  private readonly modelPath: string
  private readonly gpuLayers?: number
  private readonly concurrency: number
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _loadingPromise: Promise<void> | null = null

  constructor(modelPath: string, gpuLayers?: number, concurrency?: number, logger?: LoggerLike) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.concurrency = concurrency && concurrency > 0 ? concurrency : 1
    this.logger = logger
  }

  /**
   * 延迟加载 GGUF LLM 模型
   */
  private async _ensureModel(): Promise<void> {
    if (this._model) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppLlmEmbedder] Loading LLM model: ${this.modelPath}`)
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({
        modelPath: this.modelPath,
        gpuLayers: this.gpuLayers,
      })
      this.logger?.debug(`[LlamaCppLlmEmbedder] LLM model loaded: ${this.modelPath}`)
    })()

    return this._loadingPromise
  }

  /**
   * 用 LLM 的 last-token hidden state 生成 embedding。
   *
   * 流程：
   * 1. 加载模型
   * 2. 对每个 text，创建 LlamaEmbeddingContext（内部用 _embeddings: true）
   * 3. 调用 getEmbeddingsForTokens() 获取 per-token hidden states
   * 4. 取最后一个 token 的 hidden state
   * 5. L2 normalize
   */
  async createEmbeddings(texts: string[], _model?: string): Promise<EmbeddingResponse> {
    await this._ensureModel()
    const model = this._model!
    const embeddings: number[][] = new Array(texts.length)

    // Process texts in parallel groups with concurrency control
    // Each text creates its own LlamaEmbeddingContext, verified thread-safe.
    for (let i = 0; i < texts.length; i += this.concurrency) {
      const group = texts.slice(i, i + this.concurrency)
      const groupResults = await Promise.all(
        group.map(async (text, groupIdx) => {
          const globalIdx = i + groupIdx
          const embedContext = await model.createEmbeddingContext()
          try {
            const perTokenEmbs = await embedContext.getEmbeddingsForTokens(text)

            if (!perTokenEmbs || perTokenEmbs.length === 0) {
              throw new Error(
                `[LlamaCppLlmEmbedder] getEmbeddingsForTokens returned empty for text: "${text.slice(0, 50)}"`,
              )
            }

            // Last-token pooling
            const lastEmb = perTokenEmbs[perTokenEmbs.length - 1]

            // L2 normalize
            const norm = Math.sqrt(lastEmb.reduce((sum, v) => sum + v * v, 0))
            if (norm > 0) {
              for (let j = 0; j < lastEmb.length; j++) lastEmb[j] /= norm
            }

            return { index: globalIdx, embedding: lastEmb }
          } finally {
            await embedContext.dispose()
          }
        }),
      )

      // Place results at correct positions to preserve input order
      for (const { index, embedding } of groupResults) {
        embeddings[index] = embedding
      }
    }

    return { embeddings }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs")
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `LLM model file not found: ${this.modelPath}` }
      }

      await this._ensureModel()
      if (!this._model) {
        return { valid: false, error: "Failed to load LLM model" }
      }

      // 尝试生成测试 embedding
      const embedContext = await this._model.createEmbeddingContext()
      try {
        const perTokenEmbs = await embedContext.getEmbeddingsForTokens("test")
        if (!perTokenEmbs || perTokenEmbs.length === 0) {
          return {
            valid: false,
            error: "LLM model loaded but failed to generate test embedding. " +
              "The model may not support hidden state extraction. " +
              "Try a different model or verify GGUF metadata.",
          }
        }
      } finally {
        await embedContext.dispose()
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "LlamaCppLlmEmbedder validation failed",
      }
    }
  }

  get embedderInfo(): EmbedderInfo {
    return { name: "llamacpp-llm" }
  }

  get optimalBatchSize(): number {
    return 1
  }
}
