import { getLlama, LlamaModel, LlamaRankingContext } from "node-llama-cpp"
import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/**
 * Implements the IReranker interface using a dedicated LlamaCPP reranker model.
 * Uses node-llama-cpp's createRankingContext + rank() for cross-encoder reranking.
 */
export class LlamaCppReranker implements IReranker {
	private readonly modelPath: string
	private readonly logger?: LoggerLike
	private _model: LlamaModel | null = null
	private _rankingContext: LlamaRankingContext | null = null
	private _loadingPromise: Promise<void> | null = null

	constructor(modelPath: string, logger?: LoggerLike) {
		this.modelPath = modelPath
		this.logger = logger
	}

	private async _ensureModel(): Promise<void> {
		if (this._rankingContext) return
		if (this._loadingPromise) return this._loadingPromise

		this._loadingPromise = (async () => {
			this.logger?.debug(`Loading LlamaCPP reranker model: ${this.modelPath}`)
			const llama = await getLlama()
			this._model = await llama.loadModel({ modelPath: this.modelPath })
			this._rankingContext = await this._model.createRankingContext()
			this.logger?.debug(`LlamaCPP reranker model loaded`)
		})()

		return this._loadingPromise
	}

	async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
		if (candidates.length === 0) return []
		await this._ensureModel()

		const docs = candidates.map((c) => c.content)
		const ranked = await this._rankingContext!.rankAll(query, docs)

		return candidates.map((candidate, index) => ({
			id: candidate.id,
			score: (ranked[index] ?? 0) * 10,
			originalScore: candidate.score,
			payload: candidate.payload,
		}))
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			const fs = await import("fs")
			if (!fs.existsSync(this.modelPath)) {
				return { valid: false, error: `LlamaCPP reranker model file not found: ${this.modelPath}` }
			}
			await this._ensureModel()
			return { valid: true }
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : "LlamaCPP reranker validation failed",
			}
		}
	}

	get rerankerInfo(): RerankerInfo {
		return { name: "llamacpp", model: this.modelPath }
	}
}
