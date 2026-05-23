import { getLlama, LlamaModel, LlamaEmbeddingContext, LlamaLogLevel, Token } from "node-llama-cpp"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

/**
 * 使用通用 LLM（非专用 embedding 模型）的隐藏状态生成 embedding 向量。
 *
 * 与 LlamaCppEmbedder（使用专用 embedding 模型如 jina-embeddings-v5）不同，
 * 此类加载任意 GGUF LLM 模型（如 MiniCPM-V-4.6 / Qwen3-4B），通过
 * LlamaEmbeddingContext.getEmbeddingsForTokens() 提取 per-token hidden states，
 * 然后使用指定 pooling 策略得到最终的文本表示。
 *
 * 支持两种池化模式：
 * - "last-token": 每个 chunk 独立 forward pass，取 last-token hidden state
 * - "late-chunking": 拼接同文件所有 chunks，一次 forward pass，按 chunk 边界分别 mean pool
 *
 * Late Chunking 流程：
 * 1. 拼接所有 texts（以 \n\n 分隔）
 * 2. tokenize 全文 + tokenize 各 chunk
 * 3. 子序列匹配找到各 chunk 的 token span
 * 4. 一次 forward pass 获取全文的 per-token hidden states
 * 5. 按 span 对每个 chunk 做 mean pool + L2 normalize
 */
export class LlamaCppLlmEmbedder implements IEmbedder {
  private readonly modelPath: string
  private readonly gpuLayers?: number
  private readonly concurrency: number
  private readonly _poolingMode: "late-chunking" | "last-token"
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _loadingPromise: Promise<void> | null = null

  constructor(
    modelPath: string,
    gpuLayers?: number,
    concurrency?: number,
    logger?: LoggerLike,
    poolingMode?: "late-chunking" | "last-token",
  ) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.concurrency = concurrency && concurrency > 0 ? concurrency : 1
    this._poolingMode = poolingMode ?? "late-chunking"
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
   * 生成 embedding 向量。
   * 当 poolingMode === "late-chunking" 且 texts.length > 1 时使用 late chunking，
   * 否则退化为 last-token pooling。
   */
  async createEmbeddings(texts: string[], _model?: string): Promise<EmbeddingResponse> {
    await this._ensureModel()
    const model = this._model!

    if (this._poolingMode === "late-chunking" && texts.length > 1) {
      try {
        return await this._lateChunkingCreateEmbeddings(model, texts)
      } catch (error) {
        this.logger?.warn(
          `[LlamaCppLlmEmbedder] Late chunking failed, falling back to last-token: ${error}`,
        )
        // Fall through to last-token pooling
      }
    }

    return this._lastTokenCreateEmbeddings(model, texts)
  }

  /**
   * Last-token pooling（现有逻辑）
   */
  private async _lastTokenCreateEmbeddings(
    model: LlamaModel,
    texts: string[],
  ): Promise<EmbeddingResponse> {
    const embeddings: number[][] = new Array(texts.length)

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

            const lastEmb = perTokenEmbs[perTokenEmbs.length - 1]
            return { index: globalIdx, embedding: this._l2Normalize(lastEmb) }
          } finally {
            await embedContext.dispose()
          }
        }),
      )

      for (const { index, embedding } of groupResults) {
        embeddings[index] = embedding
      }
    }

    return { embeddings }
  }

  /**
   * Late chunking：拼接所有 chunks → 一次 forward pass → 按 span mean pool
   */
  private async _lateChunkingCreateEmbeddings(
    model: LlamaModel,
    texts: string[],
  ): Promise<EmbeddingResponse> {
    const SEPARATOR = "\n\n"

    // Step 1: 拼接全文
    const concatText = texts.join(SEPARATOR)

    // Step 2: tokenize 全文和各 chunk
    const fullTokens = this._tokenizeToNumbers(model.tokenize(concatText))
    const chunkTokenSeqs = texts.map((t) => this._tokenizeToNumbers(model.tokenize(t)))

    // Step 3: 子序列匹配找 spans
    const spans = this._findTokenSpans(fullTokens, chunkTokenSeqs)

    // Step 4: 一次 forward pass 获取全文 per-token hidden states
    const embedContext = await model.createEmbeddingContext()
    try {
      const perTokenEmbs = await embedContext.getEmbeddingsForTokens(concatText)

      if (!perTokenEmbs || perTokenEmbs.length === 0) {
        throw new Error("[LlamaCppLlmEmbedder] Late chunking: empty per-token embeddings")
      }

      // Validate: per-token embeddings count should match token count
      if (perTokenEmbs.length !== fullTokens.length) {
        this.logger?.warn(
          `[LlamaCppLlmEmbedder] Late chunking: embedding count (${perTokenEmbs.length}) ` +
            `!= token count (${fullTokens.length}), falling back`,
        )
        // Fallback: treat all as one chunk (last-token)
        return this._lastTokenCreateEmbeddings(model, texts)
      }

      // Step 5: 按 span mean pool + L2 normalize
      const embeddings = spans.map(({ start, end }) => {
        if (start >= end || end > perTokenEmbs.length) {
          // Degenerate span: fall back to last-token of chunk
          const lastIdx = Math.min(start, perTokenEmbs.length - 1)
          return this._l2Normalize(perTokenEmbs[lastIdx])
        }
        return this._meanPoolAndNormalize(perTokenEmbs.slice(start, end))
      })

      return { embeddings }
    } finally {
      await embedContext.dispose()
    }
  }

  /**
   * 将 Token 数组转换为纯数字 token ID 数组。
   * node-llama-cpp 的 Token 类型可能是对象（有 .id 属性）或直接是数字。
   */
  private _tokenizeToNumbers(tokens: (Token | number)[]): number[] {
    return tokens.map((t) => {
      if (typeof t === "number") return t
      // Token object with numeric conversion
      return Number(t)
    })
  }

  /**
   * 在全文中贪婪匹配各 chunk 的 token span。
   * 从左到右顺序搜索，每个 chunk 从上一个 chunk 的结束位置开始找。
   * 无法匹配时使用启发式 fallback。
   */
  private _findTokenSpans(
    fullTokens: number[],
    chunkTokenSeqs: number[][],
  ): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = []
    let searchPos = 0

    for (const chunkTokens of chunkTokenSeqs) {
      if (chunkTokens.length === 0) {
        spans.push({ start: searchPos, end: searchPos })
        continue
      }

      // Greedy match: find chunkTokens in fullTokens starting from searchPos
      let found = false
      for (let i = searchPos; i <= fullTokens.length - chunkTokens.length; i++) {
        let match = true
        for (let j = 0; j < chunkTokens.length; j++) {
          if (fullTokens[i + j] !== chunkTokens[j]) {
            match = false
            break
          }
        }
        if (match) {
          spans.push({ start: i, end: i + chunkTokens.length })
          searchPos = i + chunkTokens.length
          found = true
          break
        }
      }

      if (!found) {
        // Fallback: estimate span position based on previous spans
        this.logger?.warn(
          `[LlamaCppLlmEmbedder] Late chunking: token subsequence match failed for chunk (${chunkTokens.length} tokens), using heuristic position`,
        )
        const start = searchPos
        const end = Math.min(searchPos + chunkTokens.length, fullTokens.length)
        spans.push({ start, end })
        searchPos = end
      }
    }

    return spans
  }

  /**
   * Per-span mean pool + L2 normalize
   */
  private _meanPoolAndNormalize(chunkEmbs: number[][]): number[] {
    if (chunkEmbs.length === 0) return []
    const dim = chunkEmbs[0].length
    const pooled = new Array(dim).fill(0)

    for (const emb of chunkEmbs) {
      for (let i = 0; i < dim; i++) {
        pooled[i] += emb[i]
      }
    }
    for (let i = 0; i < dim; i++) {
      pooled[i] /= chunkEmbs.length
    }

    return this._l2Normalize(pooled)
  }

  /**
   * L2 normalize
   */
  private _l2Normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm
    }
    return vec
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
            error:
              "LLM model loaded but failed to generate test embedding. " +
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

  get poolingMode(): "late-chunking" | "last-token" {
    return this._poolingMode
  }
}
