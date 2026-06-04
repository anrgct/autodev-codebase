import { getLlama, LlamaModel, LlamaEmbeddingContext, LlamaLogLevel, Token } from "@realtimex/node-llama-cpp"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { Logger } from "../../utils/logger"
import { wrapInChatTemplate } from "../search/instruction-prefix"

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
 * - "qr-weighted": 每个 chunk 独立 forward pass，用最后 token 与各 token 的
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
  private readonly _poolingMode: "late-chunking" | "last-token" | "mean" | "qr-weighted"
  private readonly _rawPoolingLayer: "last" | number | string  // raw spec: "last", 22, -1, -2, "2/3"
  private readonly _enableLlmPrefix: boolean
  private readonly _useChatTemplate: boolean
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _embeddingContexts: LlamaEmbeddingContext[] = []
  private _loadingPromise: Promise<void> | null = null
  private _resolvedPoolingLayer: number | null = null  // cached resolved layer index
  private _lateChunkingNoopDetected = false  // detected that per-token embeddings are all identical (pooling_type != NONE)

  /**
   * 模型的最大 context size（token 数），在 _ensureModel() 中从模型元数据自动获取。
   * 用于 createEmbeddingContext 的 batchSize，确保能一次性处理所有输入 token。
   */
  private _contextSize: number = 0  // model.trainContextSize, from GGUF metadata
  private _embeddingContextSize: number = 0  // actual context size allocated in the embedding context
  private readonly _lateChunkingContextSize: number  // 0 = auto (use actual context size)

  constructor(
    modelPath: string,
    gpuLayers?: number,
    concurrency?: number,
    logger?: LoggerLike,
    poolingMode?: "late-chunking" | "last-token" | "mean" | "qr-weighted",
    enableLlmPrefix?: boolean,
    poolingLayer?: "last" | number | string,
    useChatTemplate?: boolean,
    lateChunkingContextSize?: number,
  ) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.concurrency = concurrency && concurrency > 0 ? concurrency : 1
    this._poolingMode = poolingMode ?? "mean"
    this._rawPoolingLayer = poolingLayer ?? "last"
    this._enableLlmPrefix = enableLlmPrefix ?? false
    this._useChatTemplate = useChatTemplate ?? false
    this._lateChunkingContextSize = lateChunkingContextSize ?? 0
    this.logger = logger
  }

  /**
   * Resolve the pooling layer spec to an actual layer index,
   * using model metadata (total layer count) for fractions and negative indices.
   *
   * Returns -1 for "last" layer (llama.cpp convention: extract final norm output).
   */
  private _resolveLayer(model: LlamaModel): number {
    if (this._resolvedPoolingLayer !== null) return this._resolvedPoolingLayer

    const raw = this._rawPoolingLayer
    let resolved: number

    if (raw === "last") {
      resolved = model.fileInsights.totalLayers - 1 - 1  // last transformer layer
    } else if (typeof raw === "number") {
      if (raw >= 0) {
        resolved = raw  // positive: direct layer index
      } else {
        // negative: relative from end, -1 = last transformer, -2 = second-to-last
        const transformerLayers = model.fileInsights.totalLayers - 1
        resolved = Math.max(transformerLayers + raw, 0)
      }
    } else if (typeof raw === "string" && raw.includes("/")) {
      // fraction: "2/3" → transformerLayers * 2 / 3
      const [numStr, denStr] = raw.split("/")
      const num = parseInt(numStr, 10)
      const den = parseInt(denStr, 10)
      if (den === 0) {
        throw new Error(`Invalid pooling layer fraction "${raw}": denominator cannot be zero`)
      }
      const transformerLayers = model.fileInsights.totalLayers - 1
      resolved = Math.max(Math.floor(transformerLayers * num / den), 0)
      this.logger?.info(
        `[LlamaCppLlmEmbedder] Pooling layer fraction ${raw} = ${resolved} ` +
        `(${transformerLayers} transformer layers)`
      )
    } else {
      throw new Error(`Invalid pooling layer value: ${raw}`)
    }

    this._resolvedPoolingLayer = resolved
    const label = resolved === -1
      ? `layer ${model.fileInsights.totalLayers - 1} (last, final output norm)`
      : `layer index ${resolved} (第${resolved + 1}层, of ${model.fileInsights.totalLayers - 1} transformer layers)`
    this.logger?.info(`[LlamaCppLlmEmbedder] Pooling layer: raw=${JSON.stringify(raw)} → ${label}`)
    return resolved
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
      this._contextSize = this._model.trainContextSize ?? 4096
      const embdLayer = this._resolveLayer(this._model)

      // batchSize 控制单次 llama_decode 的 token 数。
      // ⚠️ Metal GPU attention kernel 在 batch > 5500 时，对 context position
      // ≥ 24576 的 token 产出 NaN（CPU 正常）。设为 5500 绕过此 Metal bug。
      // 更多细节见 docs/plans/260531-nan-root-fix.md 和 260601-nan-root-analysis.md
      const BATCH_SIZE = 5500
      const batchSize = Math.min(this._contextSize, BATCH_SIZE)

      this._embeddingContexts = await Promise.all(
        Array.from({ length: this.concurrency }, () =>
          this._model!.createEmbeddingContext({
            embdLayer,
            batchSize,
          } as any)
        )
      )
      // 读取实际分配到的 context size（库自动按显存适配）
      this._embeddingContextSize = (this._embeddingContexts[0] as any)?._llamaContext?.contextSize ?? this._contextSize
      // 如果配置了 lateChunkingContextSize > 0，覆盖实际分配值以控制子批次切分上限
      if (this._lateChunkingContextSize > 0) {
        this._embeddingContextSize = this._lateChunkingContextSize
      }
      this.logger?.info(
        `[LlamaCppLlmEmbedder] Created ${this.concurrency} embedding context(s) for pool, layer=${embdLayer}` +
        ` (ctx=${this._embeddingContextSize}, batchSize=${batchSize})` +
        (this._lateChunkingContextSize > 0 ? `, context size=${this._lateChunkingContextSize}` : ''),
      )
      this.logger?.info(
        `[LlamaCppLlmEmbedder] Model loaded`
      )
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

    // 聊天模板包装：将每段文本包装为 MiniCPM ChatML 用户消息格式
    const wrappedTexts = this._useChatTemplate
      ? texts.map((t) => {
          if (!(this as any)._chatTemplateLogged) {
            ;(this as any)._chatTemplateLogged = true
            const wrapped = wrapInChatTemplate(t)
            this.logger?.debug(`[LlamaCppLlmEmbedder] Chat template wrap (first 300 chars):\n${wrapped.slice(0, 300)}`)
          }
          return wrapInChatTemplate(t)
        })
      : texts

    if (this._poolingMode === "late-chunking" && wrappedTexts.length > 1) {
      try {
        return await this._lateChunkingCreateEmbeddings(model, wrappedTexts)
      } catch (error) {
        this.logger?.warn(
          `[LlamaCppLlmEmbedder] Late chunking failed, falling back to ${this._poolingMode}: ${error}`,
        )
      }
    }

    if (this._poolingMode === "mean" || this._poolingMode === "qr-weighted") {
      return this._poolingMode === "qr-weighted"
        ? this._qrAttentionCreateEmbeddings(model, wrappedTexts)
        : this._meanPoolingCreateEmbeddings(model, wrappedTexts)
    }

    return this._lastTokenCreateEmbeddings(model, wrappedTexts)
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
          const ctx = this._embeddingContexts[groupIdx % this._embeddingContexts.length]
          const perTokenEmbs = await ctx.getEmbeddingsForTokens(text)

          if (!perTokenEmbs || perTokenEmbs.length === 0) {
            throw new Error(
              `[LlamaCppLlmEmbedder] getEmbeddingsForTokens returned empty for text: "${text.slice(0, 50)}"`,
            )
          }

          const lastEmb = perTokenEmbs[perTokenEmbs.length - 1]
          return { index: globalIdx, embedding: this._l2Normalize(lastEmb) }
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

    // 如果已经检测到模型不支持 per-token embedding（所有 hidden state 全同），
    // 直接走 last-token 逐块嵌入，避免浪费子批次拆分和批量 forward pass。
    if (this._lateChunkingNoopDetected) {
      return this._lastTokenCreateEmbeddings(model, texts)
    }

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
      const contextSize = this._embeddingContextSize > 0 ? this._embeddingContextSize : this._contextSize

      // 用宽松的安全余量做初始估算，Phase 2 的精确 tokenize 验证会兜底
      const maxBatchTokens = Math.max(Math.floor(contextSize * 0.95), 512)

      if (totalTokens <= maxBatchTokens) {
        // All chunks fit in one pass
        const embeddings = await this._singlePassLateChunking(
          model, texts, SEPARATOR, documentPrefix,
        )
        return { embeddings }
      }

      // ── 子批次拆分（精确验证版）────────────────────────────────────
      // 策略：
      // 1. 用独立 tokenize 估算做贪心分组（快速得候选边界）
      // 2. 对每个候选，实际 tokenize 拼接全文验证（精确检查）
      // 3. 超标则收缩批次，直到精确适配
      // 4. 前面的子批次即使后面的失败也不受影响
      this.logger?.info(
        `[LlamaCppLlmEmbedder] Splitting ${texts.length} chunks (${totalTokens} tokens) ` +
        `into sub-batches (ctx=${contextSize})`,
      )

      const allEmbeddings: number[][] = []
      let cursor = 0

      while (cursor < texts.length) {
        // Phase 1: 贪心估算候选子批次
        let batchTokens = prefixTokens.length
        let batchEnd = cursor

        while (batchEnd < texts.length) {
          const chunkTokens = chunkTokenSeqs[batchEnd].length +
            (batchEnd > cursor ? sepTokens.length : 0)
          if (batchTokens + chunkTokens > maxBatchTokens && batchEnd > cursor) break
          batchTokens += chunkTokens
          batchEnd++
        }

        if (batchEnd === cursor) {
          // 单块超标 → 对剩余 chunks 回退到 last-token
          this.logger?.warn(
            `[LlamaCppLlmEmbedder] Chunk at index ${cursor} (${chunkTokenSeqs[cursor].length} tokens) ` +
            `exceeds context (${contextSize}), falling back to last-token for remaining`,
          )
          const remaining = await this._lastTokenCreateEmbeddings(model, texts.slice(cursor))
          allEmbeddings.push(...remaining.embeddings)
          break
        }

        // Phase 2: 精确验证——实际 tokenize 拼接文本
        // 如果 BPE 边界合并导致超标，则从尾部收缩批次
        while (batchEnd > cursor + 1) {
          const candidateTexts = texts.slice(cursor, batchEnd)
          const joined = documentPrefix
            ? documentPrefix + candidateTexts.join(SEPARATOR)
            : candidateTexts.join(SEPARATOR)

          if (model.tokenize(joined).length <= contextSize) break

          batchEnd--
        }

        if (batchEnd === cursor) {
          // 收缩到单块仍超标（极少见，超大 chunk）
          this.logger?.warn(
            `[LlamaCppLlmEmbedder] Single chunk at ${cursor} exceeds context, ` +
            `falling back to last-token for remaining`,
          )
          const remaining = await this._lastTokenCreateEmbeddings(model, texts.slice(cursor))
          allEmbeddings.push(...remaining.embeddings)
          break
        }

        // Phase 3: 处理已验证的子批次（保证不超标）
        const batchTexts = texts.slice(cursor, batchEnd)
        const batchResult = await this._singlePassLateChunking(
          model, batchTexts, SEPARATOR, documentPrefix,
        )
        allEmbeddings.push(...batchResult)
        cursor = batchEnd
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

    // Step 2: tokenize 全文
    const fullTokens = this._tokenizeToNumbers(model.tokenize(bodyText))

    // Step 3: 用逐步前缀 tokenize 计算精确 span。
    // BPE 分词器不满足加法性：tokenize(A) + tokenize(sep) + tokenize(B) ≠ tokenize(A+sep+B)
    // 因为边界处的相邻 token 可能合并（如 "," + "\n" → ",\n" token）。
    // 每多一个 chunk 边界就累积一次偏移，计数推断法对非首个 chunk 全是错的。
    //
    // 修复：每次 tokenize 完整的渐进前缀（包含 BPE 边界合并），然后相减得 span。
    //   span[0] = tokenize(chunk0)                                       → [0, t0)
    //   span[1] = tokenize(chunk0 + sep + chunk1)                        → [t0, t1)
    //   span[2] = tokenize(chunk0 + sep + chunk1 + sep + chunk2)         → [t1, t2)
    //   ...
    // 每个前缀都准确反映了 BPE 合并结果，相减消除了边界效应。
    const prefixLen = documentPrefix
      ? this._tokenizeToNumbers(model.tokenize(documentPrefix)).length
      : 0
    const spans: { start: number; end: number }[] = []
    let prevEnd = prefixLen
    for (let i = 0; i < texts.length; i++) {
      const prefix = documentPrefix
        ? documentPrefix + texts.slice(0, i + 1).join(separator)
        : texts.slice(0, i + 1).join(separator)
      const currEnd = this._tokenizeToNumbers(model.tokenize(prefix)).length
      spans.push({ start: prevEnd, end: currEnd })
      prevEnd = currEnd
    }

    // Step 4: forward pass 获取 per-token hidden states
    let perTokenEmbs = await this._embeddingContexts[0].getEmbeddingsForTokens(bodyText)

    // Check if per-token embeddings are unique (late-chunking prerequisite).
    // If the model's GGUF pooling_type is not NONE (e.g. MEAN, the default for BERT
    // embedding models like jina-v5), llama.cpp returns the same pooled vector for
    // every token position, making late-chunking a no-op.
    if (!this._lateChunkingNoopDetected) {
      this._checkPerTokenUniqueness(perTokenEmbs)
    }

    if (!perTokenEmbs || perTokenEmbs.length === 0) {
      throw new Error("[LlamaCppLlmEmbedder] Late chunking: empty per-token embeddings")
    }

    if (perTokenEmbs.length !== fullTokens.length) {
      // getEmbeddingsForTokens() 内部会对 BERT 模型（WPM vocab）自动 prepend [CLS] token，
      // 而 model.tokenize() 默认不加特殊 token。这导致 embedding 数比 token 数多 1。
      // 此时跳过第一个 embedding（CLS）即可对齐。
      if (perTokenEmbs.length === fullTokens.length + 1) {
        perTokenEmbs = perTokenEmbs.slice(1)
      } else {
        throw new Error(
          `[LlamaCppLlmEmbedder] Late chunking: embedding count (${perTokenEmbs.length}) ` +
            `!= token count (${fullTokens.length})`,
        )
      }
    }

    // Per-sequence centering to suppress DC offset
    // Note: disabled by default as it causes query/document embedding space mismatch.
    // Uncomment to enable if queries also use mean pooling.
    // this._centerPerSequence(perTokenEmbs)

    // Step 5: 按 span mean pool + L2 normalize。
    // Mean pool 对 BPE span 偏移更鲁棒，且降低了后续 chunk 对当前 chunk
    // 的 attention 影响——每个 token 平等投票，last-token 不再被后续内容"收割"。
    return spans.map(({ start, end }) => {
      const clampedEnd = Math.min(end, perTokenEmbs.length)
      const clampedStart = Math.max(start, 0)
      if (clampedEnd <= clampedStart) return this._l2Normalize(perTokenEmbs[0])
      const dim = perTokenEmbs[0].length
      const pooled = new Array(dim).fill(0)
      for (let i = clampedStart; i < clampedEnd; i++) {
        for (let d = 0; d < dim; d++) pooled[d] += perTokenEmbs[i][d]
      }
      for (let d = 0; d < dim; d++) pooled[d] /= (clampedEnd - clampedStart)
      return this._l2Normalize(pooled)
    })
  }

  /**
   * Check that per-token embeddings are actually distinct (not just the same pooled
   * vector replicated N times). This is required for late-chunking to be meaningful.
   *
   * Root cause: BERT embedding models (like jina-v5) default to pooling_type=MEAN
   * in GGUF metadata. When pooling_type != NONE, llama.cpp's llama_get_embeddings_ith()
   * returns the same pooled vector for every token position.
   *
   * Throws if all token embeddings are identical, triggering a fallback to last-token
   * pooling in the caller.
   */
  private _checkPerTokenUniqueness(perTokenEmbs: number[][]): void {
    if (perTokenEmbs.length < 2) return  // need at least 2 tokens to compare

    // Find the first valid (non-NaN) reference token to use for comparison
    let refIdx = 0
    for (let i = 0; i < perTokenEmbs.length; i++) {
      if (perTokenEmbs[i].length > 0 && perTokenEmbs[i].some(v => Number.isFinite(v))) {
        refIdx = i
        break
      }
    }
    const dim = perTokenEmbs[refIdx].length

    // Debug: log the reference and last vector values
    const first5 = perTokenEmbs[refIdx].slice(0, 5).map(v => v.toFixed(6))
    const last5 = perTokenEmbs[perTokenEmbs.length - 1].slice(0, 5).map(v => v.toFixed(6))
    const nanCount = perTokenEmbs.reduce((sum, t) => sum + t.filter(v => !Number.isFinite(v)).length, 0)
    const zeroCount = perTokenEmbs.reduce((sum, t) => sum + t.filter(v => v === 0).length, 0)
    this.logger?.debug(
      `[LlamaCppLlmEmbedder] Per-token uniqueness check: ` +
      `nTokens=${perTokenEmbs.length}, dim=${dim}, refIdx=${refIdx}, ` +
      `ref[0..4]=[${first5.join(', ')}], ` +
      `last[0..4]=[${last5.join(', ')}], ` +
      `NaN count=${nanCount}, zero count=${zeroCount}`
    )

    // Check if all embeddings are (nearly) identical, ignoring NaN positions
    const allSame = perTokenEmbs.every((t) => {
      if (t.length === 0) return true
      for (let d = 0; d < Math.min(dim, t.length); d++) {
        const a = t[d]
        const b = perTokenEmbs[refIdx][d]
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue  // skip NaN/inf
        if (Math.abs(a - b) > 1e-6) return false
      }
      return true
    })

    if (!allSame) return  // per-token embeddings are distinct — late-chunking is viable
    this.logger?.warn(
      `\n` +
      `╔══════════════════════════════════════════════════════════════════╗\n` +
      `║  ⚠️  Late-chunking 检测到所有 token hidden state 完全相同       ║\n` +
      `╠══════════════════════════════════════════════════════════════════╣\n` +
      `║  检测到 per-token hidden states 全部相同                        ║\n` +
      `║  （模型 GGUF pooling_type 可能不是 NONE）。                    ║\n` +
      `║                                                               ║\n` +
      `║  Late-chunking 将回退到 last-token 逐块嵌入。                  ║\n` +
      `╚══════════════════════════════════════════════════════════════════╝\n`,
    )
    throw new Error(
      "Late chunking disabled: model GGUF pooling_type is not NONE. " +
      "Per-token embeddings are identical (mean-pooled vector replicated N times). " +
      "Falling back to last-token pooling.",
    )
  }

  /**
   * 将 Token 数组转换为纯数字 token ID 数组。
   * @realtimex/node-llama-cpp 的 Token 类型可能是对象（有 .id 属性）或直接是数字。
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
          const ctx = this._embeddingContexts[groupIdx % this._embeddingContexts.length]
          const perTokenEmbs = await ctx.getEmbeddingsForTokens(text)

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
        }),
      )

      for (const { index, embedding } of groupResults) {
        embeddings[index] = embedding
      }
    }

    return { embeddings }
  }

  /**
   * QR-weighted pooling：单次前向传播，用最后 token hidden state 与所有
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
    // 温度参数：控制 softmax 锐度。1.0 为标准 QR-weighted，
    // 较低值（如 0.5）更接近 last-token，较高值（如 2.0）更接近 mean-pooling
    // 可通过环境变量 QR_TEMPERATURE 覆盖（如 QR_TEMPERATURE=0.5）
    const QR_TEMPERATURE = (() => {
      if (typeof process !== "undefined" && process.env["QR_TEMPERATURE"]) {
        const v = parseFloat(process.env["QR_TEMPERATURE"])
        if (!isNaN(v) && v > 0) {
          this.logger?.info(`[qr-weighted] Using QR_TEMPERATURE=${v} from env`)
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
          const ctx = this._embeddingContexts[groupIdx % this._embeddingContexts.length]
          const perTokenEmbs = await ctx.getEmbeddingsForTokens(text)

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
      if (!this._model || this._embeddingContexts.length === 0) {
        return { valid: false, error: "Failed to load LLM model" }
      }

      // 尝试生成测试 embedding
      const perTokenEmbs = await this._embeddingContexts[0].getEmbeddingsForTokens("test")
      if (!perTokenEmbs || perTokenEmbs.length === 0) {
        return {
          valid: false,
          error:
            "LLM model loaded but failed to generate test embedding. " +
            "The model may not support hidden state extraction. " +
            "Try a different model or verify GGUF metadata.",
        }
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
    // For mean / qr-weighted pooling, batch multiple independent chunks for efficiency
    if (this._poolingMode === "mean" || this._poolingMode === "qr-weighted") {
      return 32
    }
    return 1
  }

  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-weighted" {
    return this._poolingMode
  }

  /** 指令前缀开关：query 和 document 两端联动 */
  get enableLlmPrefix(): boolean {
    return this._enableLlmPrefix
  }

  /** 聊天模板开关：将文本包装为 MiniCPM ChatML 格式 */
  get useChatTemplate(): boolean {
    return this._useChatTemplate
  }

  /** 释放 GPU 显存和模型资源 */
  async dispose(): Promise<void> {
    this.logger?.debug(`[LlamaCppLlmEmbedder] Disposing...`)
    for (const ctx of this._embeddingContexts) {
      await ctx.dispose().catch(() => {})
    }
    this._embeddingContexts = []
    if (this._model) {
      await this._model.dispose().catch(() => {})
      this._model = null
    }
    this._loadingPromise = null
    this.logger?.debug(`[LlamaCppLlmEmbedder] Disposed`)
  }


}
