/**
 * Interface for vector database clients
 */
export type PointStruct = {
	id: string
	vector: number[]
	payload: Record<string, any>
}

export interface HybridSearchOptions {
	/** Original raw query string for BM25 sparse vector encoding */
	rawQuery?: string
	/** Whether hybrid search is enabled */
	enabled?: boolean
	/** Weight for dense (semantic) vector scores */
	denseWeight?: number
	/** Weight for sparse (BM25 keyword) scores */
	sparseWeight?: number
}

export interface IVectorStore {
	/**
	 * Initializes the vector store
	 * @returns Promise resolving to boolean indicating if a new collection was created
	 */
	initialize(): Promise<boolean>

	/**
	 * Upserts points into the vector store
	 * @param points Array of points to upsert
	 */
	upsertPoints(points: PointStruct[]): Promise<void>

	/**
	 * Searches for similar vectors
	 * @param queryVector Vector to search for
	 * @param filter Optional search filter options
	 * @param hybridOptions Optional hybrid search options (BM25 sparse vector)
	 * @returns Promise resolving to search results
	 */
	search(
		queryVector: number[],
		filter?: SearchFilter,
		hybridOptions?: HybridSearchOptions,
	): Promise<VectorStoreSearchResult[]>

	/**
	 * Deletes points by file path
	 * @param filePath Path of the file to delete points for
	 */
	deletePointsByFilePath(filePath: string): Promise<void>

	/**
	 * Deletes points by multiple file paths
	 * @param filePaths Array of file paths to delete points for
	 */
	deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void>

	/**
	 * Clears all points from the collection
	 */
	clearCollection(): Promise<void>

	/**
	 * Deletes the entire collection.
	 */
	deleteCollection(): Promise<void>

	/**
	 * Checks if the collection exists
	 * @returns Promise resolving to boolean indicating if the collection exists
	 */
	collectionExists(): Promise<boolean>

	/**
	 * Gets all file paths from the vector store
	 * @returns Promise resolving to an array of file paths
	 */
	getAllFilePaths(): Promise<string[]>
	/**
	 * Checks if the collection exists and has indexed points
	 * @returns Promise resolving to boolean indicating if the collection exists and has points
	 */
	hasIndexedData(): Promise<boolean>
	/**
	 * Marks the indexing process as complete by storing metadata
	 * Should be called after a successful full workspace scan or incremental scan
	 */
	markIndexingComplete(): Promise<void>
	/**
	 * Marks the indexing process as incomplete by storing metadata
	 * Should be called at the start of indexing to indicate work in progress
	 */
	markIndexingIncomplete(): Promise<void>
}

export interface SearchFilter {
	pathFilters?: string[]
	minScore?: number
	limit?: number
}

export interface VectorStoreSearchResult {
	id: string | number
	score: number
	payload?: Payload | null
}

export interface Payload {
	filePath: string
	codeChunk: string
	startLine: number
	endLine: number
	[key: string]: any
}
