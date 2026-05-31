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
  provider: 'ollama' | 'openai-compatible' | 'llamacpp' | 'llamacpp-llm' | 'qrranker' | 'semantic-highlight'
  ollamaBaseUrl?: string
  ollamaModelId?: string
  openAiCompatibleBaseUrl?: string
  openAiCompatibleModelId?: string
  openAiCompatibleApiKey?: string
  ggufPath?: string
  ggufQrrankerPath?: string
  ggufLlmPath?: string
  llamaCppServer?: boolean
  llamaCppServerBinPath?: string
  minScore?: number
  batchSize?: number  // 批次大小，默认10
  concurrency?: number  // 最大并发批次数，默认3
  maxRetries?: number  // 最大重试次数，默认3
  retryDelayMs?: number  // 重试初始延迟(毫秒)，默认1000
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

  /**
   * 释放 reranker 占用的 GPU/资源
   */
  dispose?(): Promise<void>
}
