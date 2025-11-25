import * as path from "path"
import { VectorStoreSearchResult, SearchFilter } from "./interfaces"
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

		query = "search_code: " + query // Prefix query for better context

		// Handle directory prefix from filter
		let normalizedPrefix = ""
		if (filter?.directoryPrefix) {
			normalizedPrefix = filter.directoryPrefix
			// Ensure prefix ends with path separator
			if (!normalizedPrefix.endsWith(path.sep)) {
				normalizedPrefix += path.sep
			}
			// Remove leading separator to ensure consistent matching
			if (normalizedPrefix.startsWith(path.sep)) {
				normalizedPrefix = normalizedPrefix.slice(1)
			}
		}

		try {
			// Generate embedding for query
			const embeddingResponse = await this.embedder.createEmbeddings([query])
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			// Perform search
			const results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
			return results
		} catch (error) {
			console.error("[CodeIndexSearchService] Error during search:", error)
			this.stateManager.setSystemState("Error", `Search failed: ${(error as Error).message}`)
			throw error // Re-throw the error after setting state
		}
	}
}
