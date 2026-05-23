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
 * 支持三种池化模式：
 * - "last-token": 每个 chunk 独立 forward pass，取 last-token hidden state
 * - "mean": 每个 chunk 独立 forward pass，对所有 token 做 mean pooling
 * - "qr-attention": 每个 chunk 独立 forward pass，用最后 token 与各 token 的
 *   隐藏状态相似度（近似 attention 重要性权重）做加权 mean pooling
 * - "late-chunking": 拼接同文件所有 chunks，一次 forward pass，按 chunk 边界分别 pool
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
  private readonly _poolingMode: "late-chunking" | "last-token" | "mean" | "qr-attention"
  private readonly _enableLlmPrefix: boolean
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _loadingPromise: Promise<void> | null = null

  constructor(
    modelPath: string,
    gpuLayers?: number,
    concurrency?: number,
    logger?: LoggerLike,
    poolingMode?: "late-chunking" | "last-token" | "mean" | "qr-attention",
    enableLlmPrefix?: boolean,
  ) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.concurrency = concurrency && concurrency > 0 ? concurrency : 1
    this._poolingMode = poolingMode ?? "late-chunking"
    this._enableLlmPrefix = enableLlmPrefix ?? false
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
          `[LlamaCppLlmEmbedder] Late chunking failed, falling back to ${this._poolingMode}: ${error}`,
        )
      }
    }

    if (this._poolingMode === "mean" || this._poolingMode === "qr-attention") {
      return this._poolingMode === "qr-attention"
        ? this._qrAttentionCreateEmbeddings(model, texts)
        : this._meanPoolingCreateEmbeddings(model, texts)
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
    const documentPrefix: string | undefined = undefined  // instruction prefixes ineffective for MiniCPM hidden states

    try {
      // Tokenize each chunk to estimate total token count
      const sepTokens = this._tokenizeToNumbers(model.tokenize(SEPARATOR))
      const prefixTokens = documentPrefix
        ? this._tokenizeToNumbers(model.tokenize(documentPrefix))
        : []
      const chunkTokenSeqs = texts.map((t) => this._tokenizeToNumbers(model.tokenize(t)))

      // Calculate total tokens and compare with model context window
      const totalTokens = prefixTokens.length +
        chunkTokenSeqs.reduce((sum, t) => sum + t.length, 0) +
        sepTokens.length * (texts.length - 1)
      const contextSize = (model as any).trainContextSize ?? 4096

      // Safety margin: reserve 128 tokens for separator/prefix boundary effects
      const maxBatchTokens = Math.max(contextSize - 128, 512)

      if (totalTokens <= maxBatchTokens) {
        // All chunks fit in one pass
        const embeddings = await this._singlePassLateChunking(
          model, texts, SEPARATOR, documentPrefix,
        )
        return { embeddings }
      }

      // Split into sub-batches that fit within context window
      this.logger?.info(
        `[LlamaCppLlmEmbedder] Splitting ${texts.length} chunks (${totalTokens} tokens) ` +
        `into sub-batches (context=${contextSize})`,
      )
      const allEmbeddings: number[][] = []
      let batchTexts: string[] = []
      let batchTokens = prefixTokens.length

      for (let i = 0; i < texts.length; i++) {
        const chunkTokens = chunkTokenSeqs[i].length + (batchTexts.length > 0 ? sepTokens.length : 0)

        if (batchTokens + chunkTokens > maxBatchTokens && batchTexts.length > 0) {
          // Process current sub-batch
          const batchResult = await this._singlePassLateChunking(
            model, batchTexts, SEPARATOR, documentPrefix,
          )
          allEmbeddings.push(...batchResult)
          batchTexts = []
          batchTokens = prefixTokens.length
        }

        batchTexts.push(texts[i])
        batchTokens += chunkTokens
      }

      // Process final sub-batch
      if (batchTexts.length > 0) {
        const batchResult = await this._singlePassLateChunking(
          model, batchTexts, SEPARATOR, documentPrefix,
        )
        allEmbeddings.push(...batchResult)
      }

      return { embeddings: allEmbeddings }
    } catch (error) {
      this.logger?.warn(
        `[LlamaCppLlmEmbedder] Late chunking failed, falling back to last-token: ${error}`,
      )
      return this._lastTokenCreateEmbeddings(model, texts)
    }
  }

  /**
   * 单次 late-chunking forward pass：拼接 texts → tokenize → 找 span → forward pass → centering → mean pool
   */
  private async _singlePassLateChunking(
    model: LlamaModel,
    texts: string[],
    separator: string,
    documentPrefix?: string,
  ): Promise<number[][]> {
    // Step 1: 拼接全文
    const bodyText = documentPrefix
      ? documentPrefix + texts.join(separator)
      : texts.join(separator)

    // Step 2: tokenize 全文和各 chunk
    const fullTokens = this._tokenizeToNumbers(model.tokenize(bodyText))
    const chunkTokenSeqs = texts.map((t) => this._tokenizeToNumbers(model.tokenize(t)))

    // Step 3: 按 token 计数计算 spans（不依赖子序列匹配，避免 separator 边界错位）
    const prefixLen = documentPrefix
      ? this._tokenizeToNumbers(model.tokenize(documentPrefix)).length
      : 0
    const sepLen = this._tokenizeToNumbers(model.tokenize(separator)).length
    const spans = this._computeTokenSpans(prefixLen, sepLen, chunkTokenSeqs)

    // Step 4: forward pass 获取 per-token hidden states
    const embedContext = await model.createEmbeddingContext()
    try {
      const perTokenEmbs = await embedContext.getEmbeddingsForTokens(bodyText)

      if (!perTokenEmbs || perTokenEmbs.length === 0) {
        throw new Error("[LlamaCppLlmEmbedder] Late chunking: empty per-token embeddings")
      }

      if (perTokenEmbs.length !== fullTokens.length) {
        throw new Error(
          `[LlamaCppLlmEmbedder] Late chunking: embedding count (${perTokenEmbs.length}) ` +
            `!= token count (${fullTokens.length})`,
        )
      }

      // Per-sequence centering to suppress DC offset
      // Note: disabled by default as it causes query/document embedding space mismatch.
      // Uncomment to enable if queries also use mean pooling.
      // this._centerPerSequence(perTokenEmbs)

      // Step 5: 按 span 取 last token + L2 normalize（与查询端 last-token 保持一致）
      return spans.map(({ start, end }) => {
        const lastIdx = Math.min(end - 1, perTokenEmbs.length - 1)
        if (lastIdx < start || lastIdx >= perTokenEmbs.length) {
          return this._l2Normalize(perTokenEmbs[Math.min(start, perTokenEmbs.length - 1)])
        }
        return this._l2Normalize(perTokenEmbs[lastIdx])
      })
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
   * 按独立 token 计数计算每个 chunk 在大序列中的 span。
   * 不依赖子序列匹配，避免 separator/prefix 导致的 token 边界错位问题。
   */
  private _computeTokenSpans(
    prefixLen: number,
    sepLen: number,
    chunkTokenSeqs: number[][],
  ): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = []
    let offset = prefixLen
    for (let i = 0; i < chunkTokenSeqs.length; i++) {
      const chunkLen = chunkTokenSeqs[i].length
      spans.push({ start: offset, end: offset + chunkLen })
      offset += chunkLen + (i < chunkTokenSeqs.length - 1 ? sepLen : 0)
    }
    return spans
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
   * Mean pooling：每个 chunk 独立 forward pass，对全部 per-token hidden states
   * 做 mean pooling + L2 normalize。相比 last-token 能更好地捕获整体语义。
   */
  private async _meanPoolingCreateEmbeddings(
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

            // Mean pool across all tokens
            const dim = perTokenEmbs[0].length
            const pooled = new Array(dim).fill(0)
            for (const emb of perTokenEmbs) {
              for (let j = 0; j < dim; j++) {
                pooled[j] += emb[j]
              }
            }
            for (let j = 0; j < dim; j++) {
              pooled[j] /= perTokenEmbs.length
            }

            return { index: globalIdx, embedding: this._l2Normalize(pooled) }
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
   * QR-attention pooling：单次前向传播，用最后 token hidden state 与所有
   * token hidden states 的相似度（softmax 归一化）作为注意力权重，做加权
   * mean pooling。
   *
   * 原理：
   * 在因果自注意力 transformer 中，最后位置的 hidden state 编码了来自
   * 所有前序位置的上下文信息。最后位置对各位置的相似度近似了注意力重要性——
   * 相似度越高的 token，其信息在最终理解中保留得越多。
   *
   * 这与 QRRanker 的 cross-attention 机制精神一致：用 "查询态"（最后 token）
   * 对 "文档态"（所有 token）的亲和度决定各 token 的贡献权重。
   *
   * 温度参数 temperature 控制 softmax 的锐度：
   * - temperature < 1：更集中（接近 last-token）
   * - temperature = 1：标准 softmax
   * - temperature > 1：更平滑（接近 mean pooling）
   */
  private async _qrAttentionCreateEmbeddings(
    model: LlamaModel,
    texts: string[],
  ): Promise<EmbeddingResponse> {
    const embeddings: number[][] = new Array(texts.length)
    // 温度参数：控制 softmax 锐度。1.0 为标准 QR-attention，
    // 较低值（如 0.5）更接近 last-token，较高值（如 2.0）更接近 mean-pooling
    // 可通过环境变量 QR_TEMPERATURE 覆盖（如 QR_TEMPERATURE=0.5）
    const QR_TEMPERATURE = (() => {
      if (typeof process !== "undefined" && process.env.QR_TEMPERATURE) {
        const v = parseFloat(process.env.QR_TEMPERATURE)
        if (!isNaN(v) && v > 0) {
          this.logger?.info(`[qr-attention] Using QR_TEMPERATURE=${v} from env`)
          return v
        }
      }
      return 1.0
    })()

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
                `[LlamaCppLlmEmbedder] getEmbeddingsForTokens returned empty`,
              )
            }

            const nTokens = perTokenEmbs.length
            const dim = perTokenEmbs[0].length

            // 单 token 场景：退化为 last-token（与自身相似度无意义）
            if (nTokens <= 1) {
              return {
                index: globalIdx,
                embedding: this._l2Normalize([...perTokenEmbs[0]]),
              }
            }

            // Step 1: L2 归一化所有 token hidden states（使相似度计算稳定）
            const normalized: number[][] = perTokenEmbs.map((emb) => {
              const v = [...emb]
              return this._l2Normalize(v)
            })

            // Step 2: 计算最后 token 与所有 token 的余弦相似度（已 L2 归一化，直接点积）
            const lastEmb = normalized[nTokens - 1]
            const similarities = new Array(nTokens)
            for (let t = 0; t < nTokens; t++) {
              let dot = 0
              for (let d = 0; d < dim; d++) {
                dot += lastEmb[d] * normalized[t][d]
              }
              similarities[t] = dot
            }

            // Step 3: Softmax + temperature 得到注意力权重
            const maxSim = Math.max(...similarities)
            const expWeights = similarities.map((s) =>
              Math.exp((s - maxSim) / QR_TEMPERATURE),
            )
            const expSum = expWeights.reduce((a, b) => a + b, 0)
            const weights = expWeights.map((w) => w / expSum)

            // Step 4: 加权 mean pool（使用原始未归一化的 hidden states）
            const pooled = new Array(dim).fill(0)
            for (let t = 0; t < nTokens; t++) {
              const w = weights[t]
              const emb = perTokenEmbs[t]
              for (let d = 0; d < dim; d++) {
                pooled[d] += emb[d] * w
              }
            }

            return { index: globalIdx, embedding: this._l2Normalize(pooled) }
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
   * Per-sequence centering（在线，零外部状态文件）。
   *
   * 对 per-token hidden states，跨所有 token 计算每个维度的均值，
   * 然后做 x - mean，消除单次 forward pass 内的 DC 偏移分量。
   *
   * 相比 z-score（除 std），centering 仅移除 DC 偏移，不改变各维度的
   * 相对方差结构，更保守，适合 token 数较少的场景。
   *
   * 修改是 in-place 的。当 token 数 ≤ 1 时跳过。
   */
  private _centerPerSequence(perTokenEmbs: number[][]): void {
    const N = perTokenEmbs.length
    if (N <= 1) return

    const D = perTokenEmbs[0].length

    // per-dimension mean
    const mean = new Array(D).fill(0)
    for (const emb of perTokenEmbs) {
      for (let j = 0; j < D; j++) mean[j] += emb[j]
    }
    for (let j = 0; j < D; j++) mean[j] /= N

    // subtract mean
    for (const emb of perTokenEmbs) {
      for (let j = 0; j < D; j++) emb[j] -= mean[j]
    }
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
    // In late-chunking mode, all chunks from a file must be processed together
    // in a single forward pass. The Scanner already dispatches per-file.
    if (this._poolingMode === "late-chunking") {
      return 1024
    }
    // For mean / qr-attention pooling, batch multiple independent chunks for efficiency
    if (this._poolingMode === "mean" || this._poolingMode === "qr-attention") {
      return 32
    }
    return 1
  }

  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-attention" {
    return this._poolingMode
  }

  /** 指令前缀开关：query 和 document 两端联动 */
  get enableLlmPrefix(): boolean {
    return this._enableLlmPrefix
  }
}
