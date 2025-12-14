import * as path from "path"
import { VectorStoreSearchResult, SearchFilter, IReranker, RerankerCandidate } from "./interfaces"
import { IEmbedder } from "./interfaces/embedder"
import { IVectorStore } from "./interfaces/vector-store"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"

/**
 * Service responsible for searching the code index.
 */
export class CodeIndexSearchService {
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly reranker?: IReranker,
	) {}

	/**
	 * Searches the code index for relevant content.
	 * @param query The search query
	 * @param filter Search filter options
	 * @returns Array of search results
	 * @throws Error if the service is not properly configured or ready
	 */
	public async searchIndex(query: string, filter?: SearchFilter): Promise<VectorStoreSearchResult[]> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}

		// Get configuration values
		const minScore = this.configManager.currentSearchMinScore
		const maxResults = this.configManager.currentSearchMaxResults

		const currentState = this.stateManager.getCurrentStatus().systemStatus
		if (currentState !== "Indexed" && currentState !== "Indexing") {
			// Allow search during Indexing too
			throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
		}

		// 使用统一的filter对象，不再单独处理directoryPrefix
		// 所有过滤条件都通过pathFilters参数传递

		try {
			// Generate embedding for query
			const embeddingResponse = await this.embedder.createEmbeddings([query])
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			// Perform search - 直接传递filter对象
			let results = await this.vectorStore.search(vector, {
				...filter,
				minScore: filter?.minScore ?? minScore,
				limit: filter?.limit ?? maxResults
			})

			// 确保结果按分数降序排序
			results.sort((a, b) => b.score - a.score)

			// If reranker is enabled, rerank the results
			if (this.reranker && results.length > 0) {
				const candidates = results.map(r => ({
					id: r.id,
					content: r.payload?.codeChunk || '',
					score: r.score,
					payload: r.payload
				}))

				const reranked = await this.reranker.rerank(query, candidates)

				// Convert back to VectorStoreSearchResult format, preserving original payload
				results = reranked.map(r => ({
					id: r.id,
					score: r.score, // Use LLM score
					payload: r.payload
				}))

				// Optional: Filter low-score results
				const rerankerMinScore = this.configManager.rerankerConfig?.minScore
				if (rerankerMinScore !== undefined) {
					results = results.filter(r => r.score >= rerankerMinScore)
				}
			}

			return results
		} catch (error) {
			console.error("[CodeIndexSearchService] Error during search:", error)
			this.stateManager.setSystemState("Error", `Search failed: ${(error as Error).message}`)
			throw error // Re-throw the error after setting state
		}
	}
}
