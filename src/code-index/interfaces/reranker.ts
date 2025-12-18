/**
 * Interface for code index rerankers.
 * This interface is implemented by all reranker implementations.
 */
export interface RerankerCandidate {
	id: string | number
	content: string
	score?: number  // 原始向量搜索分数
	payload?: any
}

export interface RerankerResult {
	id: string | number
	score: number      // LLM评分 (0-10)
	originalScore?: number
	payload?: any
}

export interface RerankerInfo {
	name: string
	model: string
}

export interface RerankerConfig {
	enabled: boolean
	provider: 'ollama-llm' | 'openai-compatible'
	ollamaBaseUrl?: string
	ollamaModelId?: string
	openAiCompatibleBaseUrl?: string
	openAiCompatibleModelId?: string
	openAiCompatibleApiKey?: string
	minScore?: number
	batchSize?: number  // 新增：批次大小，默认10
}

export interface IReranker {
	/**
	 * Reranks the given candidates based on their relevance to the query.
	 * @param query The search query
	 * @param candidates Array of candidates to rerank
	 * @returns Promise resolving to an array of reranked results with scores
	 */
	rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]>

	/**
	 * Validates the reranker configuration by testing connectivity and model availability.
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	validateConfiguration(): Promise<{ valid: boolean; error?: string }>

	get rerankerInfo(): RerankerInfo
}