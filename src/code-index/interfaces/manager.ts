import { VectorStoreSearchResult, SearchFilter } from "./vector-store"
import type { IndexingState } from "../state-manager"
import type { HighlightResult, HighlightOptions } from "./highlighter"

// Re-export IndexingState for external use
export { IndexingState }

/**
 * Interface for the code index manager
 */
export interface ICodeIndexManager {
  /**
   * Event emitted when progress is updated
   */
  onProgressUpdate: (handler: (data: {
    systemStatus: IndexingState
    fileStatuses: Record<string, string>
    message?: string
  }) => void) => () => void

  /**
   * Current state of the indexing process
   */
  readonly state: IndexingState

  /**
   * Whether the code indexing feature is enabled
   */
  readonly isFeatureEnabled: boolean

  /**
   * Whether the code indexing feature is configured
   */
  readonly isFeatureConfigured: boolean

  /**
   * Loads configuration from storage
   */
  loadConfiguration(): Promise<void>

  /**
   * Starts the indexing process
   * @param force Force reindex all files, ignoring cache and metadata
   */
  startIndexing(force?: boolean): Promise<void>

  /**
   * Stops the file watcher
   */
  stopWatcher(): void

  /**
   * Clears the index data
   */
  clearIndexData(): Promise<void>

  /**
   * Searches the index
   * @param query Query string
   * @param filter Search filter options
   * @returns Promise resolving to search results
   */
  searchIndex(query: string, filter?: SearchFilter): Promise<VectorStoreSearchResult[]>

  /**
   * Highlights code lines by semantic relevance to a query.
   * This is a standalone pipeline that directly invokes the highlighter,
   * bypassing embed / vector search / rerank.
   * @param query Semantic query for line relevance scoring
   * @param codeChunk Code text to highlight
   * @param startLine Starting line number (1-based)
   * @param options Runtime highlight options (mode, topK, threshold, etc.)
   * @returns Highlight result with scored lines and formatted text
   */
  highlight(query: string, codeChunk: string, startLine: number, options?: HighlightOptions): Promise<HighlightResult>

  /**
   * Gets the current status of the indexing system
   * @returns Current status information
   */
  getCurrentStatus(): { systemStatus: IndexingState; fileStatuses: Record<string, string>; message?: string }

  /**
   * Disposes of resources used by the manager
   */
  dispose(): void
}

export type EmbedderProvider =
  | "openai"
  | "ollama"
  | "openai-compatible"
  | "jina"
  | "gemini"
  | "mistral"
  | "vercel-ai-gateway"
  | "openrouter"
  | "llamacpp"
  | "llamacpp-llm"
  | "llm2vec"

export interface IndexProgressUpdate {
  systemStatus: IndexingState
  message?: string
  processedBlockCount?: number
  totalBlockCount?: number
}
