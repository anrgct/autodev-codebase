/**
 * Semantic-Highlight Reranker — 使用 Unified GGUF 的 BGE-M3 RerankHead 做 cross-encoder 打分。
 *
 * 架构：
 * 1. 从 GGUF metadata 读取 RerankHead 权重（Dense + OutProj）
 * 2. 对每个候选：XLM-RoBERTa text pair → getEmbeddingsForTokens() → hidden[0] → RerankHead → score
 * 3. [Step 3] 同时计算 PruningHead keep probs，存入 payload 供 highlighter 复用
 */

import { getLlama, LlamaModel, LlamaEmbeddingContext, LlamaLogLevel, readGgufFileInfo } from "node-llama-cpp"
import type { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import type { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

export class SemanticHighlightReranker implements IReranker {
  private readonly modelPath: string
  private readonly logger?: LoggerLike

  private _model: LlamaModel | null = null
  private _embeddingContext: LlamaEmbeddingContext | null = null
  private _loadingPromise: Promise<void> | null = null

  // RerankHead: Dense(1024→1024) → tanh → OutProj(1024→1) → sigmoid
  private _denseW: Float32Array | null = null   // [1024, 1024]
  private _denseB: Float32Array | null = null   // [1024]
  private _outW: Float32Array | null = null     // [1, 1024]
  private _outB: Float32Array | null = null     // [1]

  // PruningHead (for Step 3 reuse): Linear(1024→2) → softmax
  private _pruneW: Float32Array | null = null   // [2, 1024]
  private _pruneB: Float32Array | null = null   // [2]

  constructor(modelPath: string, logger?: LoggerLike) {
    this.modelPath = modelPath
    this.logger = logger
  }

  // ─── GGUF Metadata 解析 ───────────────────────────────────────────────

  /**
   * 从 GGUF metadata 读取 head 权重。
   */
  private async _loadHeadWeights(): Promise<void> {
    if (this._denseW) return // already loaded

    this.logger?.debug(`[SemanticHighlightReranker] Reading head weights from GGUF: ${this.modelPath}`)
    const info = await readGgufFileInfo(this.modelPath, { readTensorInfo: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = info.metadata as any

    // 提取 RerankHead 权重
    const rh = meta["open_provence"]?.["rerank_head"]
    if (!rh?.dense?.weight || !rh?.dense?.bias || !rh?.out_proj?.weight || !rh?.out_proj?.bias) {
      throw new Error("RerankHead weights not found in GGUF metadata")
    }
    this._denseW = new Float32Array(rh.dense.weight as number[])  // [1024*1024]
    this._denseB = new Float32Array(rh.dense.bias as number[])    // [1024]
    this._outW = new Float32Array(rh.out_proj.weight as number[]) // [1024]
    this._outB = new Float32Array(rh.out_proj.bias as number[])   // [1]

    // 提取 PruningHead 权重 (for Step 3)
    const ph = meta["open_provence"]?.["pruning_head"]
    if (ph?.weight && ph?.bias) {
      this._pruneW = new Float32Array(ph.weight as number[])
      this._pruneB = new Float32Array(ph.bias as number[])
    }

    this.logger?.debug(
      `[SemanticHighlightReranker] Heads loaded: dense[${this._denseW.length}], out[${this._outW.length}], prune[${this._pruneW?.length ?? 0}]`,
    )
  }

  // ─── 模型加载 ─────────────────────────────────────────────────────────

  private async _ensureModel(): Promise<void> {
    if (this._embeddingContext) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[SemanticHighlightReranker] Loading model: ${this.modelPath}`)
      await Promise.all([
        this._loadHeadWeights(),
        (async () => {
          const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
          this._model = await llama.loadModel({ modelPath: this.modelPath })
          const embedContextSize = this._model.trainContextSize
          this._embeddingContext = await this._model.createEmbeddingContext({
            batchSize: embedContextSize,
          })
        })(),
      ])
      this.logger?.debug(`[SemanticHighlightReranker] Model loaded`)
    })()

    return this._loadingPromise
  }

  // ─── RerankHead 推理 ──────────────────────────────────────────────────

  /**
   * BGE-M3 RerankHead: hidden_cls [1024] → Dense → tanh → OutProj → sigmoid
   */
  private _applyRerankHead(hiddenCls: number[]): number {
    const DW = this._denseW!   // [1024*1024] row-major
    const DB = this._denseB!   // [1024]
    const OW = this._outW!     // [1024]
    const OB = this._outB!     // [1]
    const D = 1024

    // Dense: x = tanh(hiddenCls @ W.T + b)
    const denseOut = new Float32Array(D)
    for (let j = 0; j < D; j++) {
      let sum = DB[j]
      for (let i = 0; i < D && i < hiddenCls.length; i++) {
        sum += hiddenCls[i] * DW[j * D + i] // W[j][i] = row j, col i
      }
      denseOut[j] = Math.tanh(sum)
    }

    // OutProj: logit = denseOut @ OW.T + OB
    let logit = OB[0]
    for (let i = 0; i < D; i++) {
      logit += denseOut[i] * OW[i]
    }

    // Sigmoid
    return 1.0 / (1.0 + Math.exp(-logit))
  }

  // ─── PruningHead 推理 (for Step 3) ────────────────────────────────────

  /**
   * PruningHead: hidden [N, 1024] → Linear(1024→2) → softmax → keep_probs
   */
  private _applyPruningHeadBatch(hiddenBatch: number[][]): Float32Array {
    const W = this._pruneW!   // [2*1024]
    const B = this._pruneB!   // [2]
    const D = 1024
    const N = hiddenBatch.length
    const probs = new Float32Array(N)

    for (let n = 0; n < N; n++) {
      const h = hiddenBatch[n]
      let logit0 = B[0]
      let logit1 = B[1]
      for (let i = 0; i < D && i < h.length; i++) {
        logit0 += h[i] * W[i]       // W[0][i]
        logit1 += h[i] * W[D + i]   // W[1][i]
      }
      const maxL = Math.max(logit0, logit1)
      const exp0 = Math.exp(logit0 - maxL)
      const exp1 = Math.exp(logit1 - maxL)
      probs[n] = exp1 / (exp0 + exp1)
    }

    return probs
  }

  // ─── IReranker 接口 ────────────────────────────────────────────────────

  async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
    if (candidates.length === 0) return []

    await this._ensureModel()

    // XLM-RoBERTa text pair: <s> query </s></s> code </s>
    // llama.cpp 自动加 BOS (=<s>) 和 EOS (=</s>)
    const buildInput = (code: string) => `${query} </s></s> ${code}`

    const results: RerankerResult[] = []
    for (const candidate of candidates) {
      try {
        const input = buildInput(candidate.content)
        const tokenEmbeddings = await this._embeddingContext!.getEmbeddingsForTokens(input)

        if (tokenEmbeddings.length === 0) {
          results.push({
            id: candidate.id,
            score: 0,
            originalScore: candidate.score,
            payload: candidate.payload,
          })
          continue
        }

        // RerankHead: hidden[0] (CLS token) → score
        const score = this._applyRerankHead(tokenEmbeddings[0])

        // PruningHead: token keep probs → store in payload for highlighter reuse
        const tokenProbs = this._applyPruningHeadBatch(tokenEmbeddings)

        const result: RerankerResult = {
          id: candidate.id,
          score,
          originalScore: candidate.score,
          payload: candidate.payload ?? {},
        }

        // Step 3: 存入预计算数据供 highlighter 复用
        if (result.payload && typeof result.payload === "object") {
          ;(result.payload as Record<string, unknown>)["_semanticHighlightTokenProbs"] = tokenProbs
          ;(result.payload as Record<string, unknown>)["_semanticHighlightCodeText"] = candidate.content
        }

        results.push(result)
      } catch (err) {
        this.logger?.warn(`[SemanticHighlightReranker] Error processing candidate ${candidate.id}: ${err}`)
        results.push({
          id: candidate.id,
          score: 0,
          originalScore: candidate.score,
          payload: candidate.payload,
        })
      }
    }

    this.logger?.debug(
      `[SemanticHighlightReranker] Scores: ${results.map((r) => r.score.toFixed(4)).join(", ")}`,
    )

    return results
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs")
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `Model file not found: ${this.modelPath}` }
      }
      await this._ensureModel()
      // Test: quick forward pass
      const tokenEmbeddings = await this._embeddingContext!.getEmbeddingsForTokens("test")
      if (!tokenEmbeddings || tokenEmbeddings.length === 0) {
        return { valid: false, error: "Model loaded but failed to generate token embeddings" }
      }
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "SemanticHighlight reranker validation failed",
      }
    }
  }

  get rerankerInfo(): RerankerInfo {
    return {
      name: "semantic-highlight",
      model: this.modelPath,
    }
  }
}
