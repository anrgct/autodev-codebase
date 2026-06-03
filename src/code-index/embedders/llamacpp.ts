import { getLlama, LlamaModel, LlamaEmbeddingContext, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/**
 * Implements the IEmbedder interface using a local LlamaCPP model via @realtimex/node-llama-cpp.
 * The model is lazily loaded on the first createEmbeddings() call.
 */
export class LlamaCppEmbedder implements IEmbedder {
  private readonly modelPath: string
  private readonly gpuLayers?: number
  private readonly logger?: LoggerLike
  private _model: LlamaModel | null = null
  private _embeddingContext: LlamaEmbeddingContext | null = null
  private _loadingPromise: Promise<void> | null = null
  private _nextEmbeddingLogTime = 0

  constructor(modelPath: string, gpuLayers?: number, logger?: LoggerLike) {
    this.modelPath = modelPath
    this.gpuLayers = gpuLayers
    this.logger = logger
  }

  /**
   * Lazily initializes the Llama model and embedding context.
   */
  private async _ensureModel(): Promise<void> {
    if (this._embeddingContext) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`Loading LlamaCPP model: ${this.modelPath}`)
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({
        modelPath: this.modelPath,
        gpuLayers: this.gpuLayers,
      })
      this._embeddingContext = await this._model.createEmbeddingContext({
        batchSize: this._model.trainContextSize,
      })
      this.logger?.info(
        `LlamaCPP model loaded, context size: ${this._model.trainContextSize} tokens`
      )
      this.logger?.debug(`LlamaCPP model loaded: ${this.modelPath}`)
    })()

    return this._loadingPromise
  }

  async createEmbeddings(texts: string[], _model?: string): Promise<EmbeddingResponse> {
    await this._ensureModel()
    const embeddings: number[][] = []
    for (const text of texts) {
      const embedding = await this._embeddingContext!.getEmbeddingFor(text)
      const vector = Array.from(embedding.vector)
      // L2 normalize (Jina models output normalized vectors; GGUF inference does not)
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
      if (norm > 0) {
        for (let i = 0; i < vector.length; i++) vector[i] /= norm
      }
      embeddings.push(vector)
    }

    // Debug diagnostics: log dimension and first embedding stats (max once per second)
    if (embeddings.length > 0 && Date.now() >= this._nextEmbeddingLogTime) {
      this._nextEmbeddingLogTime = Date.now() + 1000
      const dim = embeddings[0].length
      const first5 = embeddings[0].slice(0, 5).map(v => v.toFixed(6))
      let nanCount = 0, zeroCount = 0
      for (const emb of embeddings) {
        for (const v of emb) {
          if (isNaN(v)) nanCount++
          else if (v === 0) zeroCount++
        }
      }
      this.logger?.debug(
        `[LlamaCppEmbedder] Embedding stats: texts=${embeddings.length}, dim=${dim}, ` +
        `emb[0][0..4]=[${first5.join(', ')}], ` +
        `NaN count=${nanCount}, zero count=${zeroCount}`
      )
    }

    return { embeddings }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs")
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `LlamaCPP model file not found: ${this.modelPath}` }
      }

      await this._ensureModel()

      const testEmbedding = await this._embeddingContext!.getEmbeddingFor("test")
      if (!testEmbedding || !testEmbedding.vector || testEmbedding.vector.length === 0) {
        return { valid: false, error: "Model loaded but failed to generate test embedding" }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "LlamaCPP validation failed",
      }
    }
  }

  get embedderInfo(): EmbedderInfo {
    return { name: "llamacpp" }
  }

  get optimalBatchSize(): number {
    return 1
  }

  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-weighted" {
    return "last-token"
  }

  async dispose(): Promise<void> {
    if (this._embeddingContext) {
      await this._embeddingContext.dispose().catch(() => {});
      this._embeddingContext = null;
    }
    if (this._model) {
      await this._model.dispose().catch(() => {});
      this._model = null;
    }
    this._loadingPromise = null;
  }
}
