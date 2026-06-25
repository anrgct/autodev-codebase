import {
  getLlama,
  LlamaModel,
  LlamaEmbeddingContext,
  LlamaContext,
  LlamaContextSequence,
  LlamaCompletion,
  LlamaLogLevel,
  readGgufFileInfo,
} from "@realtimex/node-llama-cpp"
import * as fs from "fs"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

/**
 * LLM2Vec 嵌入器：加载 LLM2Vec-Gen 统一 GGUF。
 *
 * 两个 MLP 串联（对齐 modeling_encoder_decoder.py:547-556 的 encode()，
 * 详见 llm2vec_gen_flow.md §1/§2.1）：
 *   text + 10 question token → encoder → 最后10 token隐状态
 *     → reconstruction_mlp → recon
 *     → alignment_mlp      → mean pool → L2 normalize → 1024-dim 可索引向量
 *
 * alignment_mlp 的输入是 reconstruction_mlp 的输出（recon），不是原始隐藏状态——
 * 两者串联而非平行分叉。索引/检索走完整的 recon→align 串联；recon 同时是
 * debug 解释路径的 decoder 软提示来源（见 _interpretHiddenStates）。
 *
 * 模型要求：统一 GGUF（encoder+decoder 合一），
 *   如 qwen3-06b-llm2vec-unified-q8_0-mlp.gguf
 * 嵌入维度：1024
 */

// ── 10 个 question 特殊 token 文本 ──────────────────────────────────────
const QUESTION_TOKENS_STR = Array.from({ length: 10 }, (_, i) => `<question${i + 1}>`).join("")

// ── GGUF tensor 数据读取工具 ────────────────────────────────────────────
const GGML_TYPE_F16 = 1
const GGML_TYPE_Q8_0 = 8
const GGUF_MAGIC = 0x46554747 // "GGUF" little-endian

/** GGUF tensor 入口信息 */
interface GgufTensorEntry {
  name: string
  offset: number   // relative to data section start
  ggmlType: number
  dims: number[]   // ne[] 数组，GGUF 反序
}

/** 扫描 GGUF tensor info 区，返回 {name: GgufTensorEntry} */
function scanGgufTensors(ggufPath: string): Map<string, GgufTensorEntry> {
  const buf = fs.readFileSync(ggufPath)
  let pos = 0
  const readU32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v }
  const readU64 = () => { const v = buf.readBigUInt64LE(pos); pos += 8; return v }
  const readI64 = () => { const v = buf.readBigInt64LE(pos); pos += 8; return v }

  // Header
  const magic = readU32()
  if (magic !== GGUF_MAGIC) throw new Error("Not a valid GGUF file")
  const version = readU32()
  const nTensor = Number(readU64())
  const nKv = Number(readU64())

  // Skip KV 区
  for (let i = 0; i < nKv; i++) {
    const kl = Number(readU64())
    pos += kl // key string
    const vt = readU32()
    if (vt === 9 /* ARRAY */) {
      const et = readU32()
      const ne = Number(readU64())
      if (et === 8 /* STRING */) {
        for (let j = 0; j < ne; j++) {
          const sl = Number(readU64())
          pos += sl
        }
      } else {
        const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8 }
        pos += ne * (sizes[et] ?? 4)
      }
    } else if (vt === 8 /* STRING */) {
      const sl = Number(readU64())
      pos += sl
    } else {
      const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8 }
      pos += sizes[vt] ?? 4
    }
  }

  // Tensor info 区
  const tensors = new Map<string, GgufTensorEntry>()
  for (let i = 0; i < nTensor; i++) {
    const nl = Number(readU64())
    const name = buf.toString("utf8", pos, pos + nl)
    pos += nl
    const nDims = readU32()
    const dims: number[] = []
    for (let j = 0; j < nDims; j++) dims.push(Number(readU64()))
    const dtype = readU32()
    const offset = Number(readU64())
    tensors.set(name, { name, offset, ggmlType: dtype, dims })
  }
  // data_section_start = pos（GGUF 规范：tensor info 之后紧接着 data section）
  // 但 offset 已经是 relative to data_start，这里返回 data_start 作为基准
  // 实际上 GGUF tensor offset 是从 data section 开头算起的，我们需要 data_start = pos
  const dataStart = pos
  ;(tensors as any)._dataStart = dataStart
  return tensors
}

/** 16-bit float (bfloat16 or IEEE fp16) → 32-bit float */
function fp16ToF32(b0: number, b1: number): number {
  // IEEE 754 half-precision: sign(1) | exp(5) | mantissa(10)
  const sign = (b1 & 0x80) ? -1 : 1
  const exp = ((b1 & 0x7C) >> 2)
  const mant = ((b1 & 0x03) << 8) | b0
  if (exp === 0) {
    // subnormal or zero
    return sign * Math.pow(2, -14) * (mant / 1024)
  }
  if (exp === 31) {
    // Inf/NaN
    return mant === 0 ? sign * Infinity : NaN
  }
  return sign * Math.pow(2, exp - 15) * (1 + mant / 1024)
}

/** 从 Q8_0 GGUF tensor 读取并反量化为 float32 数组。仅用于 token_embd.weight 的 debug 解释 */
function loadQ8_0Tensor(ggufPath: string, entry: GgufTensorEntry, dataStart: number, limitRows?: number): Float32Array {
  const [nEmb, vocab] = entry.dims // GGUF ne[]: [n_embd, vocab_size]
  const totalRows = vocab
  const actualRows = limitRows && limitRows < totalRows ? limitRows : totalRows
  const QK = 32 // Q8_0 block size
  const blockSize = 2 + QK // f16 scale (2B) + int8 values (32B)
  const blocksPerRow = Math.ceil(nEmb / QK)

  const result = new Float32Array(actualRows * nEmb)

  const fd = fs.openSync(ggufPath, "r")
  try {
    // 逐行读取：每行 = blocksPerRow 个 Q8_0 block
    const blockBuf = Buffer.alloc(blockSize)
    for (let row = 0; row < actualRows; row++) {
      for (let blk = 0; blk < blocksPerRow; blk++) {
        const fileOff = dataStart + entry.offset + (row * blocksPerRow + blk) * blockSize
        fs.readSync(fd, blockBuf, 0, blockSize, fileOff)
        // f16 scale (2 bytes LE)
        const scale = fp16ToF32(blockBuf[0], blockBuf[1])
        const rowBase = row * nEmb + blk * QK
        const end = Math.min(rowBase + QK, (row + 1) * nEmb, result.length)
        for (let j = rowBase; j < end; j++) {
          result[j] = blockBuf[2 + (j - rowBase)] * scale
        }
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return result
}

// ── embedder 实现 ────────────────────────────────────────────────────────

export class LlamaCppLlm2VecEmbedder implements IEmbedder {
  private readonly modelPath: string
  private readonly gpuLayers?: number
  private readonly _enableLlmPrefix: boolean
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _embeddingContext: LlamaEmbeddingContext | null = null
  private _loadingPromise: Promise<void> | null = null

  // Alignment MLP（索引管道 recon→align 串联的第二级，必需）
  private _aW: number[] | null = null   // [1024 * 1024] flat row-major
  private _ab: number[] | null = null   // [1024]
  private _nEmbd: number = 0

  // Reconstruction MLP（索引管道 recon→align 串联的第一级，必需；其输出 recon 也作 debug decoder 软提示）
  private _rW: number[] | null = null
  private _rb: number[] | null = null

  // debug 解释用：词表 token 字符串 + 前 32K token embeddings
  private _vocabTokens: string[] | null = null
  private _tokenEmbs: Float32Array | null = null // [vocabSubset * nEmb]
  private _tokenEmbVocabSize: number = 0

  // debug 解释用：decoder 生成上下文（lazy）
  private _genContext: LlamaContext | null = null
  private _genSequence: LlamaContextSequence | null = null

  constructor(
    modelPath: string,
    gpuLayers?: number,
    logger?: LoggerLike,
    enableLlmPrefix?: boolean,
  ) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.logger = logger
    this._enableLlmPrefix = enableLlmPrefix ?? false
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────

  private async _ensureModel(): Promise<void> {
    if (this._model) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Loading model: ${this.modelPath}`)

      // Step 1: 从 GGUF metadata 读取 MLP 权重
      this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Reading MLP weights from GGUF metadata...`)
      const fileInfo = await readGgufFileInfo(this.modelPath, {
        readTensorInfo: false,
        logWarnings: false,
      })
      const meta = fileInfo.metadata as any
      const llm2vecGen = meta?.llm2vec_gen

      // alignment_mlp（必须）
      if (!llm2vecGen?.alignment_mlp?.weight || !llm2vecGen?.alignment_mlp?.bias) {
        throw new Error(
          `LLM2Vec GGUF metadata missing alignment_mlp. ` +
          `Ensure the GGUF was built with embed_mlps_to_gguf.py --unified-bf16`,
        )
      }
      this._aW = llm2vecGen.alignment_mlp.weight as number[]
      this._ab = llm2vecGen.alignment_mlp.bias as number[]

      // reconstruction_mlp（必需：索引路径 recon→align 串联的第一级；其输出 recon 也作 debug decoder 软提示）
      if (!llm2vecGen?.reconstruction_mlp?.weight || !llm2vecGen?.reconstruction_mlp?.bias) {
        throw new Error(
          `LLM2Vec GGUF metadata missing reconstruction_mlp. ` +
          `Index path requires reconstruction_mlp → alignment_mlp in series. ` +
          `Ensure the GGUF was built with embed_mlps_to_gguf.py --unified-bf16`,
        )
      }
      this._rW = llm2vecGen.reconstruction_mlp.weight as number[]
      this._rb = llm2vecGen.reconstruction_mlp.bias as number[]

	      const DIM = this._ab.length  // derive from bias (DIM-dim vector)
	      if (this._aW.length !== DIM * DIM) {
	        throw new Error(`Unexpected alignment_mlp weight shape: ${this._aW.length} vs ${DIM}×${DIM}=${DIM*DIM}`)
      }
      if (this._rW.length !== DIM * DIM || this._rb.length !== DIM) {
        throw new Error(`Unexpected reconstruction_mlp shape`)
      }

      // Step 2: 加载模型
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({
        modelPath: this.modelPath,
        gpuLayers: this.gpuLayers,
      })

      const modelMeta = this._model.fileInfo?.metadata as any
      const arch = modelMeta?.general?.architecture
      this._nEmbd = arch ? (modelMeta[arch]?.embedding_length ?? DIM) : DIM

      // 保存词表 token 字符串（debug 解释用）
      const tokenStrings = modelMeta?.tokenizer?.ggml?.tokens as string[] | undefined
      if (tokenStrings && tokenStrings.length > 0) {
        this._vocabTokens = tokenStrings
      }

      this.logger?.info(
        `[LlamaCppLlm2VecEmbedder] Model loaded, n_embd=${this._nEmbd}, ` +
        `context_size=${this._model.trainContextSize}`,
      )

      // Step 3: 创建 embedding context
      this._embeddingContext = await this._model.createEmbeddingContext({
        embdLayer: -1,
        batchSize: this._model.trainContextSize,
      } as any)
      this.logger?.info(`[LlamaCppLlm2VecEmbedder] Embedding context created`)
    })()

    return this._loadingPromise
  }

  /** lazy 加载 token embeddings 子集（debug 解释用），最多前 32K 个 token */
  private _ensureTokenEmbs(): void {
    if (this._tokenEmbs || !this._vocabTokens) return
    this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Loading token embeddings for debug interpretation...`)

    try {
      const tensors = scanGgufTensors(this.modelPath)
      const dataStart = (tensors as any)._dataStart as number
      const entry = tensors.get("token_embd.weight")
      if (!entry) {
        this.logger?.debug(`[LlamaCppLlm2VecEmbedder] token_embd.weight not found in tensor info`)
        return
      }

      const LIMIT = Math.min(32768, entry.dims[1]) // 最多 32K token
      this._tokenEmbs = loadQ8_0Tensor(this.modelPath, entry, dataStart, LIMIT)
      this._tokenEmbVocabSize = LIMIT
      this.logger?.debug(
        `[LlamaCppLlm2VecEmbedder] Loaded ${LIMIT}/${entry.dims[1]} token embeddings ` +
        `(${(this._tokenEmbs.length * 4 / 1024 / 1024).toFixed(1)} MB)`,
      )
    } catch (e) {
      this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Failed to load token embeddings: ${e}`)
    }
  }

  // ── 嵌入接口 ────────────────────────────────────────────────────────────

  async createEmbeddings(texts: string[], _model?: string): Promise<EmbeddingResponse> {
    await this._ensureModel()

    if (!this._model || !this._embeddingContext || !this._aW || !this._ab || !this._rW || !this._rb) {
      throw new Error("[LlamaCppLlm2VecEmbedder] Model not initialized")
    }

    const embeddings: number[][] = []

    for (const text of texts) {
      const { embedding } = await this._encode(text)
      embeddings.push(embedding)
    }

    if (embeddings.length > 0) {
      const dim = embeddings[0].length
      const first5 = embeddings[0].slice(0, 5).map(v => v.toFixed(6))
      this.logger?.debug(
        `[LlamaCppLlm2VecEmbedder] texts=${embeddings.length}, dim=${dim}, ` +
        `emb[0][0..4]=[${first5.join(", ")}]`,
      )
    }

    return { embeddings }
  }

  /**
   * 索引/查询嵌入管道：text + 10 question token → encode → 最后10 token隐状态
   * → reconstruction_mlp → recon → alignment_mlp → mean pool → L2 normalize
   *
   * 两 MLP 串联（对齐 modeling_encoder_decoder.py:547-556）：alignment_mlp 的输入是
   * reconstruction_mlp 的输出（recon），不是原始隐藏状态。详见 llm2vec_gen_flow.md §1/§2.1。
   *
   * 返回 { embedding, hiddenStates }  —— hiddenStates（raw last10）供 debug 解释。
   */
  private async _encode(text: string): Promise<{ embedding: number[]; hiddenStates: number[][] }> {
    const model = this._model!
    const ctx = this._embeddingContext!
    const rW = this._rW!
    const rb = this._rb!
    const aW = this._aW!
    const ab = this._ab!

    const content = text + QUESTION_TOKENS_STR
    const tokens = model.tokenize(content, true)

    if (tokens.length < 10) {
      throw new Error(`Text too short after tokenization: ${tokens.length} tokens`)
    }

    const perTokenEmbs = await ctx.getEmbeddingsForTokens(tokens)
    if (!perTokenEmbs || perTokenEmbs.length === 0) {
      throw new Error(`getEmbeddingsForTokens returned empty`)
    }

    const nTokens = perTokenEmbs.length
    const last10Count = Math.min(10, nTokens)
    const last10 = perTokenEmbs.slice(nTokens - last10Count)

    const dim = this._nEmbd
    // 先对 raw last10 取平均（mean pool），再走 recon→align 串联。
    // 数学等价：reconstruction_mlp 与 alignment_mlp 均为 nn.Linear（无激活函数），
    // mean 是线性算子，故 mean(align(recon(h_i))) == align(recon(mean(h_i)))。
    // 避免逐 token 做 20 次 1024² matmul（MLP 部分 5.9× 加速，cos=1.0 已验证）。
    const pooled = new Array(dim).fill(0)
    for (const vec of last10) {
      for (let j = 0; j < dim; j++) pooled[j] += vec[j]
    }
    for (let j = 0; j < dim; j++) pooled[j] /= last10Count

    const recon = this._applyLinear(pooled, rW, rb, dim)
    const aligned = this._applyLinear(recon, aW, ab, dim)

    return {
      embedding: this._l2Normalize(aligned),
      hiddenStates: last10, // raw hidden states（供 debug）
    }
  }

  /**
   * recon 历史拼接 forward：生成下一跳的推理状态 recon（用户公式的核心实现）。
   *
   * [recon×10@1] + ... + [recon×10@n-1] + [query] + [新answer] + [prompt]
   *   → embd 注入 forward → 取最后 10 位置 hidden state → recon_mlp → [recon×10@n]
   *
   * 与 encodeForSearch(文本融合) 的区别：这里拼接的是 recon **向量链**（推理记忆），
   * 不是 passage 正文。forward 让 transformer attention 主动融合历史推理 + query + 
   * 新线索，避免正文拼接的噪声稀释。新 recon 同时作为下一跳历史与检索向量。
   *
   * @param reconHistory  历史 recon 列表，每个 [10, dim]（推理记忆链，首跳传 []）
   * @param queryText     原始 query
   * @param newAnswerText 本跳新出现的检索结果文本（去重后；首跳传 ""）
   * @param prompt        推理引导提示（如 "找出材料中新出现的相关线索"）
   * @returns newRecon[10, dim]（加入历史链）+ embedding（检索向量）
   */
  async reconForward(
    reconHistory: number[][][],
    queryText: string,
    newAnswerText: string,
    prompt: string,
  ): Promise<{ newRecon: number[][]; embedding: number[] }> {
    await this._ensureModel()
    if (!this._model || !this._rW || !this._rb || !this._aW || !this._ab || !this._embeddingContext) {
      throw new Error("[LlamaCppLlm2VecEmbedder] Model not initialized")
    }
    const model = this._model
    const embCtx = this._embeddingContext
    // embedding context 的 addon context：支持 embd 注入 + getEmbedding 取 hidden state
    const ctx = (embCtx as any)._llamaContext._ctx
    const dim = this._nEmbd
    const rW = this._rW, rb = this._rb, aW = this._aW, ab = this._ab

    // 1. tokenize + token embd 查表
    const queryIds = Array.from(model.tokenize(queryText, true))
    const answerIds = newAnswerText ? Array.from(model.tokenize(newAnswerText, true)) : []
    const promptIds = prompt ? Array.from(model.tokenize(prompt, true)) : []
    // question tokens：recon_mlp 为 question token 位置的 hidden state 训练，必须末尾拼上
    const questionIds = Array.from(model.tokenize(QUESTION_TOKENS_STR, true))
    const queryEmbd: Float32Array = ctx.getTokenEmbeddings(Uint32Array.from(queryIds))
    const answerEmbd: Float32Array = answerIds.length ? ctx.getTokenEmbeddings(Uint32Array.from(answerIds)) : new Float32Array(0)
    const promptEmbd: Float32Array = promptIds.length ? ctx.getTokenEmbeddings(Uint32Array.from(promptIds)) : new Float32Array(0)
    const questionEmbd: Float32Array = ctx.getTokenEmbeddings(Uint32Array.from(questionIds))

    // 2. 拼 embd: [recon历史链] + [query] + [answer] + [prompt] + [question×N]
    //    causal attention 下 question tokens 能 attend 到全部前缀（历史+query+answer+prompt）
    const reconFlatLen = reconHistory.reduce((s, r) => s + r.length, 0)
    const total = reconFlatLen + queryIds.length + answerIds.length + promptIds.length + questionIds.length
    if (total === 0) throw new Error("reconForward: empty input")
    const mixed = new Float32Array(total * dim)
    let off = 0
    for (const recon of reconHistory) {
      for (const vec of recon) { mixed.set(vec, off * dim); off++ }
    }
    mixed.set(queryEmbd, off * dim); off += queryIds.length
    if (answerIds.length) { mixed.set(answerEmbd, off * dim); off += answerIds.length }
    if (promptIds.length) { mixed.set(promptEmbd, off * dim); off += promptIds.length }
    mixed.set(questionEmbd, off * dim); off += questionIds.length
    const questionStart = total - questionIds.length  // question tokens 起始位置（0-based）

    // 3. embd 注入 forward（清累积 buffer + KV cache 后 forward）
    ctx.clearAccumulatedEmbeddings()
    ctx.disposeSequence(0)
    ctx.initBatchEmbd(total)
    ctx.addToBatchEmbd(0, 0, mixed, total, Uint32Array.from([]))
    await ctx.decodeBatch()

    // 4. 取 question tokens 位置的 hidden state（getEmbedding 索引 1..total）
    const lastHidden: number[][] = []
    for (let i = questionStart + 1; i <= total; i++) {
      const h = ctx.getEmbedding(i)
      lastHidden.push(Array.from(h))
    }

    // 5. 新 recon[10, dim]：逐 token recon_mlp（与 generateWithPrompt 的 recon 计算一致）
    const newRecon = lastHidden.map(h => this._applyLinear(h, rW, rb, dim))

    // 6. 检索 embedding：mean pool lastHidden → recon → align → l2norm（与 _encode 一致）
    const pooled = new Array(dim).fill(0)
    for (const v of lastHidden) for (let j = 0; j < dim; j++) pooled[j] += v[j]
    for (let j = 0; j < dim; j++) pooled[j] /= lastHidden.length
    const reconVec = this._applyLinear(pooled, rW, rb, dim)
    const aligned = this._applyLinear(reconVec, aW, ab, dim)

    return { newRecon, embedding: this._l2Normalize(aligned) }
  }

  // ── Debug: 隐藏状态解释 ────────────────────────────────────────────────

  /**
   * Teacher-forcing oracle：reconstruction_mlp 投影 → 最近 token
   * → 拼接原始 query text → decoder 采样生成解释性文本。
   */
  private async _interpretHiddenStates(query: string, hiddenStates: number[][]): Promise<void> {
    const model = this._model!
    const rW = this._rW!
    const rb = this._rb!
    const dim = this._nEmbd

    this._ensureTokenEmbs()

    const log = this.logger!

    // 1. 重建投影，找每个 position 的最近 token ID
    const reconVecs = hiddenStates.map(h => this._applyLinear(h, rW, rb, dim))
    const l2n = (v: number[]) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); if (s > 1e-8) for (let i = 0; i < v.length; i++) v[i] /= s; return v }
    const reconNorm = reconVecs.map(v => l2n([...v]))
    const reconIds = reconNorm.map(v => this._findNearestTokens(v, 1)[0]?.id ?? 0)

    // 2. Tokenize 原始 query
    const queryTokens = model.tokenize(query, false)

    // 3. Teacher-forcing: [recon_tokens] + [query_tokens] → decoder 采样生成
    const teacherForcingInput = [...reconIds, ...queryTokens.map(t => Number(t))]

    // 提取纯 query 文本（去除 instruction prefix）
    const queryClean = query
      .replace(/^Instruct:.*?\nQuery:\s*/, "")

    log.debug(`\n── LLM2Vec Hidden State ───────────────────────────────────`)
    log.debug(`  查询 : "${queryClean}"`)
    log.debug(`  ↓ tokenize + 10个<question> → encoder → 最后10隐状态`)
    log.debug(`  ↓ reconstruction_mlp → token空间投影 → 最近token ← 解码器可读`)
    log.debug(`  ↓ teacher-forcing: [recon_token] + [原始query] → decoder续写`)
    log.debug(``)
    // Recon tokens: 两行紧凑表格，列=第i个question token编码的语义token
    if (this._vocabTokens) {
      const tokenNames = reconIds.map(id => (this._vocabTokens![id] ?? `[${id}]`).replace(/[\x00-\x1f]/g, "").slice(0, 10))
      const ids = reconIds.map(id => String(id))
      log.debug(`  投影token  ${tokenNames.map(t => t.padEnd(10)).join("")}`)
      log.debug(`  token_id   ${ids.map(i => i.padEnd(10)).join("")}`)
    }

    if (this._tokenEmbs && this._vocabTokens) {
      const generated = await this._generateFromTokens(teacherForcingInput, 24, 0.6)
      log.debug(`  ── decoder续写(T=0.6) ──`)
      log.debug(`  ${generated.replace(/\n/g, " ").replace(/\s+/g, " ").trim()}`)
    }
  }

  /** lazy 创建 decoder 生成上下文（debug only） */
  private async _ensureGenContext(): Promise<void> {
    if (this._genContext) return
    const model = this._model!
    this._genContext = await model.createContext({
      contextSize: { min: 512, max: 4096 },
    })
    this._genSequence = this._genContext.getSequence()
  }

  /** 从 token IDs 用 decoder 采样生成文本 */
  private async _generateFromTokens(tokenIds: number[], maxTokens: number, temperature: number): Promise<string> {
    await this._ensureGenContext()
    const seq = this._genSequence!
    const completion = new LlamaCompletion({
      contextSequence: seq,
      autoDisposeSequence: false,
    })
    const result = await completion.generateCompletion(tokenIds as any, {
      maxTokens,
      temperature,
      topP: 0.9,
    })
    return result
  }
	// -- mixed injection generation (recon + prompt -> KV cache -> greedy continuation) ----------

	/**
	 * recon soft prompt + text prompt mixed injection -> decoder decode -> greedy continuation.
	 *
	 * Flow:
	 *   1. query -> encode -> last10 hidden -> reconstruction_mlp -> recon[10, n_embd]
	 *   2. prompt -> tokenize -> getTokenEmbeddings -> promptEmbd[T, n_embd]
	 *   3. [recon*10 + promptEmbd*T] -> mixed embd
	 *   4. initBatchEmbd + addToBatchEmbd -> decode (build KV cache, last position outputs logits)
	 *   5. greedy sampling continuation (switch to token path), until EOS / maxTokens
	 *
	 * @param queryText  original query text (without instruction prefix, question tokens added automatically)
	 * @param prompt     mixed injection text prompt (e.g. "Query: find relevant clues"), gives decoder direction
	 * @param maxTokens  max continuation tokens
	 * @returns generated text
	 */
	async generateWithPrompt(
	    queryText: string,
	    prompt: string,
	    maxTokens: number = 30,
	    options?: { includeQuery?: boolean; context?: string },
	): Promise<string> {
	    await this._ensureModel()
	    await this._ensureGenContext()

	    const includeQuery = options?.includeQuery ?? true  // 默认注入 query（修复：原设计未注入导致 decoder 读不到题目）
	    const context = options?.context ?? ""  // 累积检索结果：融入 recon 计算，形成递归推理状态

	    const ctx = (this._genContext as any)._ctx
	    const model = this._model!
	    const rW = this._rW!
	    const rb = this._rb!
	    const dim = this._nEmbd

	    // -- 1. compute recon soft prompt [10, dim] --
	    //    recon 从 query + context 算（融入检索结果 → 多跳递归推理状态）
	    const reconSource = context ? `${queryText}\n${context}` : queryText
	    const prefixedQuery = reconSource + QUESTION_TOKENS_STR
	    const queryTokens = model.tokenize(prefixedQuery, true)
	    const perTokenEmbs = await this._embeddingContext!.getEmbeddingsForTokens(queryTokens)
	    const nQt = perTokenEmbs.length
	    const last10 = perTokenEmbs.slice(nQt - 10)
	    const recon = last10.map(h => this._applyLinear(h, rW, rb, dim))

	    // -- 2. query text -> tokenize -> token_embd lookup (可选注入) --
	    let queryEmbdFlat: Float32Array | null = null
	    let Q = 0
	    if (includeQuery) {
	      const queryTextIds = model.tokenize(queryText, true)
	      Q = queryTextIds.length
	      queryEmbdFlat = ctx.getTokenEmbeddings(Uint32Array.from(queryTextIds.map(t => Number(t))))
	    }

	    // -- 3. prompt -> tokenize -> token_embd lookup --
	    const promptIds = model.tokenize(prompt, true)
	    if (promptIds.length === 0) {
	      throw new Error("Prompt tokenization returned empty")
	    }
	    const promptTokenIds = Uint32Array.from(promptIds.map(t => Number(t)))
	    const promptEmbdFlat: Float32Array = ctx.getTokenEmbeddings(promptTokenIds)
	    const K = recon.length   // 10
	    const T = promptIds.length

	    // -- 4. build mixed embd: [recon×K] + [query_embd×Q] + [prompt_embd×T] --
	    const total = K + Q + T
	    const mixedFlat = new Float32Array(total * dim)
	    for (let i = 0; i < K; i++) {
	      mixedFlat.set(recon[i], i * dim)
	    }
	    if (queryEmbdFlat) {
	      mixedFlat.set(queryEmbdFlat, K * dim)
	    }
	    mixedFlat.set(promptEmbdFlat, (K + Q) * dim)

	    // -- 5. KV cache 用 addon 层 disposeSequence 清（clearHistory 是高层 sequence 方法，
	    //    与 embd 注入路径的 addon 直接操作不兼容）--
	    ctx.disposeSequence(0)

	    // -- 6. Step 0: embd injection decode, build KV cache (last position outputs logits) --
	    ctx.initBatchEmbd(total)
	    ctx.addToBatchEmbd(
	      /*seqId*/ 0,
	      /*firstPos*/ 0,
	      mixedFlat,
	      total,
	      Uint32Array.from([total - 1]), // only last position gets logits
	    )
	    await ctx.decodeBatch()

	    // -- 7. create greedy sampler --
	    const bindingsAddonSampler = (model as any)._llama._bindings.AddonSampler
	    const addonModel = (model as any)._model
	    const addonSampler = new bindingsAddonSampler(addonModel)
	    addonSampler.applyConfig({})  // configure greedy (applyConfig with no temperature → greedySampler)

	    // -- 8. Step 1+: greedy continuation (switch to token path) --
	    const EOS = (model as any).tokenEos?.() ?? (model as any).tokens?.eos ?? 151645
	    const generated: number[] = []
	    let curPos = total

	    // get first token from step0 last position logit -> argmax
	    // NOTE: sampleToken 3rd arg must be omitted (passing boolean false makes it return [tokenId, probs] array instead of number)
	    let curToken: number = await ctx.sampleToken(total - 1, addonSampler)

	    for (let step = 0; step < maxTokens; step++) {
	      if (curToken === EOS || curToken < 0) break
	      generated.push(curToken)

	      ctx.initBatch(1)
	      ctx.addToBatch(
	        /*seqId*/ 0,
	        curPos,
	        Uint32Array.from([curToken]),
	        Uint32Array.from([0]), // output logits for this token
	      )
	      await ctx.decodeBatch()
	      curToken = await ctx.sampleToken(0, addonSampler)
	      curPos++
	    }

	    addonSampler.dispose()

	    // -- 9. detokenize --
	    const text = model.detokenize(generated as any, false)
	    this.logger?.debug(`[generateWithPrompt] recon=${K} query=${Q} prompt="${prompt}" tokens=${generated.length} text="${text.slice(0, 200)}"`)
	    return text
	}

	/**
	 * Pure free-running (recon only, no prompt): [recon*10] -> KV cache -> greedy continuation.
	 * Comparison baseline only. Pure recon injection is known to collapse.
	 */
	async generateFreeRunning(
	    queryText: string,
	    maxTokens: number = 30,
	): Promise<string> {
	    await this._ensureModel()
	    await this._ensureGenContext()

	    const ctx = (this._genContext as any)._ctx
	    const model = this._model!
	    const rW = this._rW!
	    const rb = this._rb!
	    const dim = this._nEmbd

	    // 1. Compute recon [10, dim]
	    const prefixedQuery = queryText + QUESTION_TOKENS_STR
	    const queryTokens = model.tokenize(prefixedQuery, true)
	    const perTokenEmbs = await this._embeddingContext!.getEmbeddingsForTokens(queryTokens)
	    const nQt = perTokenEmbs.length
	    const last10 = perTokenEmbs.slice(nQt - 10)
	    const recon = last10.map(h => this._applyLinear(h, rW, rb, dim))

	    // 2. Build flat embd
	    const K = recon.length
	    const mixedFlat = new Float32Array(K * dim)
	    for (let i = 0; i < K; i++) {
	      mixedFlat.set(recon[i], i * dim)
	    }

	    // 3. KV cache 用 addon 层 disposeSequence 清
	    ctx.disposeSequence(0)

	    // 4. Step 0: embd decode
	    ctx.initBatchEmbd(K)
	    ctx.addToBatchEmbd(0, 0, mixedFlat, K, Uint32Array.from([K - 1]))
	    await ctx.decodeBatch()

	    // 5. Greedy sampler
	    const bindingsAddonSampler = (model as any)._llama._bindings.AddonSampler
	    const addonSampler = new bindingsAddonSampler((model as any)._model)
	    addonSampler.applyConfig({})  // configure greedy

	    // 6. Greedy generation
	    const EOS = (model as any).tokenEos?.() ?? (model as any).tokens?.eos ?? 151645
	    const generated: number[] = []
	    let curPos = K
	    let curToken: number = await ctx.sampleToken(K - 1, addonSampler)

	    for (let step = 0; step < maxTokens; step++) {
	      if (curToken === EOS || curToken < 0) break
	      generated.push(curToken)
	      ctx.initBatch(1)
	      ctx.addToBatch(0, curPos, Uint32Array.from([curToken]), Uint32Array.from([0]))
	      await ctx.decodeBatch()
	      curToken = await ctx.sampleToken(0, addonSampler)
	      curPos++
	    }

	    addonSampler.dispose()
	    const text = model.detokenize(generated as any, false)
	    this.logger?.debug(`[generateFreeRunning] tokens=${generated.length} text="${text.slice(0, 200)}"`)
	    return text
	}

  /** 在 token embeddings 子集中找最近 neighbor（余弦相似度 = dot after L2 norm） */
  private _findNearestTokens(vec: number[], k: number): Array<{ token: string; id: number; score: number; native: boolean }> {
    const embs = this._tokenEmbs!
    const vocab = this._vocabTokens!
    const nEmb = this._nEmbd
    const nTokens = this._tokenEmbVocabSize

    // 对每个 token embedding 做 L2 归一化后计算 cosine similarity (= dot)
    const scores: Array<{ id: number; score: number }> = []
    for (let i = 0; i < nTokens; i++) {
      let dot = 0, embNormSq = 0
      const base = i * nEmb
      for (let j = 0; j < nEmb; j++) {
        const e = embs[base + j]
        dot += vec[j] * e
        embNormSq += e * e
      }
      const embNorm = Math.sqrt(embNormSq)
      if (embNorm > 1e-8) {
        dot /= embNorm
      } else {
        dot = 0 // zero-norm token, not meaningful
      }
      scores.push({ id: i, score: dot })
    }

    // Top-K
    scores.sort((a, b) => b.score - a.score)
    const topK = scores.slice(0, k)

    // Qwen3 special token IDs 范围: 151665+ 是特殊 token，151936 个 token 总共
    // 在本子集（<32K）中的 token 都是普通文本 token
    return topK.map(s => {
      const rawToken = vocab[s.id] ?? `[${s.id}]`
      const display = rawToken
        .replace(/\n/g, "")
        .replace(/\r/g, "")
        .replace(/\t/g, "")
      return {
        token: display.length > 24 ? display.slice(0, 22) + ".." : display,
        id: s.id,
        score: s.score,
        native: true,
      }
    })
  }

  // ── 线性代数工具 ────────────────────────────────────────────────────────

  private _applyLinear(x: number[], w: number[], b: number[], dim: number): number[] {
    const y = new Array(dim)
    for (let j = 0; j < dim; j++) {
      let sum = 0
      for (let k = 0; k < dim; k++) {
        sum += x[k] * w[j * dim + k]
      }
      y[j] = sum + (b[j] ?? 0)
    }
    return y
  }

  private _l2Normalize(vec: number[]): number[] {
    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm)
    if (norm > 1e-12) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm
    }
    return vec
  }

  // ── IEmbedder 接口 ──────────────────────────────────────────────────────

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `LLM2Vec model file not found: ${this.modelPath}` }
      }
      await this._ensureModel()
      if (!this._model || !this._embeddingContext) {
        return { valid: false, error: "Failed to load LLM2Vec model" }
      }
      const { embedding } = await this._encode("test")
      if (!embedding || embedding.length === 0) {
        return { valid: false, error: "Model loaded but failed to generate test embedding" }
      }
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "LlamaCppLlm2VecEmbedder validation failed",
      }
    }
  }

  get embedderInfo(): EmbedderInfo { return { name: "llm2vec" } }
  get optimalBatchSize(): number { return 1 }
  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-weighted" { return "mean" }
  get enableLlmPrefix(): boolean { return this._enableLlmPrefix }

  async dispose(): Promise<void> {
    this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Disposing...`)
    this._genSequence = null
    if (this._genContext) {
      await this._genContext.dispose().catch(() => {})
      this._genContext = null
    }
    if (this._embeddingContext) {
      await this._embeddingContext.dispose().catch(() => {})
      this._embeddingContext = null
    }
    if (this._model) {
      await this._model.dispose().catch(() => {})
      this._model = null
    }
    this._loadingPromise = null
    this._aW = null; this._ab = null
    this._rW = null; this._rb = null
    this._tokenEmbs = null; this._vocabTokens = null
    this.logger?.debug(`[LlamaCppLlm2VecEmbedder] Disposed`)
  }
}
