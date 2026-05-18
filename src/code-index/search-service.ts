import * as path from "path"
import { VectorStoreSearchResult, SearchFilter, IReranker, RerankerCandidate, IHighlighter } from "./interfaces"
import { IEmbedder } from "./interfaces/embedder"
import { IVectorStore } from "./interfaces/vector-store"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { applyQueryPrefill } from "./search/query-prefill"
import { getDefaultModelId, getModelQueryPrefix } from "../shared/embeddingModels"
import { validateLimit, validateMinScore } from "./validate-search-params"

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
		private readonly highlighter?: IHighlighter,
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
		const configMinScore = this.configManager.currentSearchMinScore
		const configMaxResults = this.configManager.currentSearchMaxResults

		const currentState = this.stateManager.getCurrentStatus().systemStatus
		if (currentState !== "Indexed" && currentState !== "Indexing") {
			// Allow search during Indexing too
			throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
		}

		// 使用统一的filter对象，不再单独处理directoryPrefix
		// 所有过滤条件都通过pathFilters参数传递

		try {
			// Apply query prefill for embedding generation
			const embedderProvider = this.configManager.currentEmbedderProvider
			// Get modelId with fallback to default if not configured
			const modelId = this.configManager.currentModelId ?? getDefaultModelId(embedderProvider)
			let prefillQuery = applyQueryPrefill(query, embedderProvider, modelId)

			// Apply model-specific query prefix (e.g., "Query: " for jina retrieval models)
			const queryPrefix = getModelQueryPrefix(embedderProvider, modelId)
			if (queryPrefix && !prefillQuery.startsWith(queryPrefix)) {
				prefillQuery = `${queryPrefix}${prefillQuery}`
			}

			// Generate embedding for query (with prefill if applicable)
			const embeddingResponse = await this.embedder.createEmbeddings([prefillQuery])
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			// Perform search - 防止调用方传入未验证的参数
			const finalLimit = validateLimit(filter?.limit ?? configMaxResults)
			const finalMinScore = validateMinScore(filter?.minScore ?? configMinScore)
		
			// Build hybrid search options from config
			const hybridOptions = {
				rawQuery: query, // Pass original query for BM25 sparse encoding
				enabled: this.configManager.hybridSearchEnabled,
				denseWeight: this.configManager.hybridSearchDenseWeight,
				sparseWeight: this.configManager.hybridSearchSparseWeight,
			}
		
			let results = await this.vectorStore.search(vector, {
				...filter,
				minScore: finalMinScore,
				limit: finalLimit
			}, hybridOptions)

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

				// 按 reranker 分数降序重新排序
				results.sort((a, b) => b.score - a.score)
				}

				// If highlighter is enabled, apply line-level semantic highlighting
				if (this.highlighter && results.length > 0) {
					const highlighterConfig = this.configManager.highlighterConfig
					if (highlighterConfig.enabled) {
						const concurrency = highlighterConfig.concurrency ?? 2
						const highlightable = results.filter(
							(r): r is typeof r & { payload: { codeChunk: string; startLine: number } } =>
								!!r.payload?.codeChunk && r.payload?.startLine != null,
						)

						// Process with concurrency control — each highlight() call
						// creates its own LlamaContext, verified thread-safe.
						for (let i = 0; i < highlightable.length; i += concurrency) {
							const batch = highlightable.slice(i, i + concurrency)
							await Promise.all(
								batch.map(async (result) => {
									try {
										const highlightResult = await this.highlighter!.highlight(
											query,
											result.payload.codeChunk,
											result.payload.startLine,
										)
										if (result.payload) {
											result.payload["highlightedText"] =
												highlightResult.formattedText
											result.payload["highlightLines"] =
												highlightResult.lines
										}
									} catch (err) {
										console.warn(
											"[CodeIndexSearchService] Highlighter error for",
											result.payload?.filePath,
											":",
											err,
										)
									}
								}),
							)
						}
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
