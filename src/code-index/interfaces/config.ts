import { ApiHandlerOptions } from "../../shared/api"

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

/**
 * Ollama embedder configuration
 */
export interface OllamaEmbedderConfig {
  provider: "ollama"
  baseUrl: string
  model: string
  dimension: number
}

/**
 * OpenAI embedder configuration
 */
export interface OpenAIEmbedderConfig {
  provider: "openai"
  apiKey: string
  model: string
  dimension: number
}

/**
 * OpenAI Compatible embedder configuration
 */
export interface OpenAICompatibleEmbedderConfig {
  provider: "openai-compatible"
  baseUrl: string
  apiKey: string
  model: string
  dimension: number
}

/**
 * Jina embedder configuration
 */
export interface JinaEmbedderConfig {
  provider: "jina"
  apiKey: string
  baseUrl?: string
  model: string
  dimension: number
}

/**
 * Gemini embedder configuration
 */
export interface GeminiEmbedderConfig {
  provider: "gemini"
  apiKey: string
  model: string
  dimension: number
}

/**
 * Mistral embedder configuration
 */
export interface MistralEmbedderConfig {
  provider: "mistral"
  apiKey: string
  model: string
  dimension: number
}

/**
 * Vercel AI Gateway embedder configuration
 */
export interface VercelAiGatewayEmbedderConfig {
  provider: "vercel-ai-gateway"
  apiKey: string
  model: string
  dimension: number
}

/**
 * OpenRouter embedder configuration
 */
export interface OpenRouterEmbedderConfig {
  provider: "openrouter"
  apiKey: string
  model: string
  dimension: number
}

/**
 * Union type for all embedder configurations
 */
export type EmbedderConfig =
  | OllamaEmbedderConfig
  | OpenAIEmbedderConfig
  | OpenAICompatibleEmbedderConfig
  | JinaEmbedderConfig
  | GeminiEmbedderConfig
  | MistralEmbedderConfig
  | VercelAiGatewayEmbedderConfig
  | OpenRouterEmbedderConfig

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
  isEnabled: boolean
  // Embedder - 通用参数
  embedderProvider: EmbedderProvider
  embedderModelId?: string
  embedderModelDimension?: number

  // Embedder - Jina 特定参数
  embedderJinaApiKey?: string
  embedderJinaBaseUrl?: string
  embedderJinaBatchSize?: number

  // Embedder - Ollama 特定参数
  embedderOllamaBaseUrl?: string
  embedderOllamaBatchSize?: number

  // Embedder - OpenAI 特定参数
  embedderOpenAiApiKey?: string
  embedderOpenAiBatchSize?: number

  // Embedder - OpenAI Compatible 特定参数
  embedderOpenAiCompatibleBaseUrl?: string
  embedderOpenAiCompatibleApiKey?: string
  embedderOpenAiCompatibleBatchSize?: number

  // Embedder - Gemini 特定参数
  embedderGeminiApiKey?: string
  embedderGeminiBatchSize?: number

  // Embedder - Mistral 特定参数
  embedderMistralApiKey?: string
  embedderMistralBatchSize?: number

  // Embedder - Vercel AI Gateway 特定参数
  embedderVercelAiGatewayApiKey?: string

  // Embedder - OpenRouter 特定参数
  embedderOpenRouterApiKey?: string
  embedderOpenRouterBatchSize?: number

  // Embedder - LlamaCPP 特定参数
  embedderLlamaCppModelPath?: string
  embedderLlamaCppGpuLayers?: number

  // Vector Store
  qdrantUrl?: string
  qdrantApiKey?: string

  // Vector Search
  vectorSearchMinScore?: number
  vectorSearchMaxResults?: number

  // Hybrid Search (Dense + Sparse BM25)
  hybridSearchEnabled?: boolean
  hybridSearchDenseWeight?: number
  hybridSearchSparseWeight?: number

  // Reranker configuration
  rerankerEnabled?: boolean
  rerankerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  rerankerOllamaBaseUrl?: string
  rerankerOllamaModelId?: string
  rerankerOpenAiCompatibleBaseUrl?: string
  rerankerOpenAiCompatibleModelId?: string
  rerankerOpenAiCompatibleApiKey?: string
  rerankerLlamaCppModelPath?: string
  rerankerLlamaCppRerankerModelPath?: string
  rerankerLlamaCppServer?: boolean
  rerankerLlamaCppServerBinPath?: string
  rerankerMinScore?: number
  rerankerBatchSize?: number
  rerankerConcurrency?: number
  rerankerMaxRetries?: number
  rerankerRetryDelayMs?: number

  // Summarizer configuration
  summarizerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  summarizerOllamaBaseUrl?: string
  summarizerOllamaModelId?: string
  summarizerOpenAiCompatibleBaseUrl?: string
  summarizerOpenAiCompatibleModelId?: string
  summarizerOpenAiCompatibleApiKey?: string
  summarizerLlamaCppModelPath?: string
  summarizerLanguage?: 'English' | 'Chinese'
  summarizerTemperature?: number
  summarizerBatchSize?: number
  summarizerConcurrency?: number
  summarizerMaxRetries?: number
  summarizerRetryDelayMs?: number

  // Highlighter configuration (semantic highlight / line-level filtering)
  highlighterEnabled?: boolean
  highlighterProvider?: "llamacpp" | "llamacpp-llm"
  highlighterGgufPath?: string
  highlighterGgufLlmPath?: string
  highlighterTopK?: number
  highlighterMode?: "topk" | "threshold"
  highlighterThreshold?: number
  highlighterConcurrency?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
  enabled: boolean
  embedderProvider: EmbedderProvider
  embedderModelId?: string
  embedderModelDimension?: number
  embedderJinaApiKey?: string
  embedderJinaBaseUrl?: string
  embedderJinaBatchSize?: number
  embedderOllamaBaseUrl?: string
  embedderOllamaBatchSize?: number
  embedderOpenAiApiKey?: string
  embedderOpenAiBatchSize?: number
  embedderOpenAiCompatibleBaseUrl?: string
  embedderOpenAiCompatibleApiKey?: string
  embedderOpenAiCompatibleBatchSize?: number
  embedderGeminiApiKey?: string
  embedderGeminiBatchSize?: number
  embedderMistralApiKey?: string
  embedderMistralBatchSize?: number
  embedderVercelAiGatewayApiKey?: string
  embedderOpenRouterApiKey?: string
  embedderOpenRouterBatchSize?: number
  embedderLlamaCppModelPath?: string
  embedderLlamaCppGpuLayers?: number
  qdrantUrl?: string
  qdrantApiKey?: string
  vectorSearchMinScore?: number
  vectorSearchMaxResults?: number
  hybridSearchEnabled?: boolean
  hybridSearchDenseWeight?: number
  hybridSearchSparseWeight?: number
  rerankerEnabled?: boolean
  rerankerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  rerankerOllamaBaseUrl?: string
  rerankerOllamaModelId?: string
  rerankerOpenAiCompatibleBaseUrl?: string
  rerankerOpenAiCompatibleModelId?: string
  rerankerOpenAiCompatibleApiKey?: string
  rerankerLlamaCppModelPath?: string
  rerankerLlamaCppRerankerModelPath?: string
  rerankerLlamaCppServer?: boolean
  rerankerLlamaCppServerBinPath?: string
  rerankerMinScore?: number
  rerankerBatchSize?: number
  rerankerConcurrency?: number
  rerankerMaxRetries?: number
  rerankerRetryDelayMs?: number
  summarizerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  summarizerOllamaBaseUrl?: string
  summarizerOllamaModelId?: string
  summarizerOpenAiCompatibleBaseUrl?: string
  summarizerOpenAiCompatibleModelId?: string
  summarizerOpenAiCompatibleApiKey?: string
  summarizerLlamaCppModelPath?: string
  summarizerLanguage?: 'English' | 'Chinese'
  summarizerTemperature?: number
  summarizerBatchSize?: number
  summarizerConcurrency?: number
  summarizerMaxRetries?: number
  summarizerRetryDelayMs?: number

  // Highlighter
  highlighterEnabled?: boolean
  highlighterProvider?: "llamacpp" | "llamacpp-llm"
  highlighterGgufPath?: string
  highlighterGgufLlmPath?: string
  highlighterTopK?: number
  highlighterMode?: "topk" | "threshold"
  highlighterThreshold?: number
  highlighterConcurrency?: number
}

/**
 * Vector store configuration
 */
export interface VectorStoreConfig {
  qdrantUrl?: string
  qdrantApiKey?: string
}

/**
 * Search configuration
 */
export interface SearchConfig {
  minScore?: number
  maxResults?: number
}

/**
 * Configuration snapshot for restart detection
 * Using legacy format for backwards compatibility during transition
 */
export interface ConfigSnapshot {
  enabled: boolean
  embedderProvider: EmbedderProvider
  embedderModelId?: string
  embedderModelDimension?: number
  embedderJinaApiKey?: string
  embedderJinaBaseUrl?: string
  embedderJinaBatchSize?: number
  embedderOllamaBaseUrl?: string
  embedderOllamaBatchSize?: number
  embedderOpenAiApiKey?: string
  embedderOpenAiBatchSize?: number
  embedderOpenAiCompatibleBaseUrl?: string
  embedderOpenAiCompatibleApiKey?: string
  embedderOpenAiCompatibleBatchSize?: number
  embedderGeminiApiKey?: string
  embedderGeminiBatchSize?: number
  embedderMistralApiKey?: string
  embedderMistralBatchSize?: number
  embedderVercelAiGatewayApiKey?: string
  embedderOpenRouterApiKey?: string
  embedderOpenRouterBatchSize?: number
  embedderLlamaCppModelPath?: string
  embedderLlamaCppGpuLayers?: number
  qdrantUrl?: string
  qdrantApiKey?: string
  vectorSearchMinScore?: number
  vectorSearchMaxResults?: number
  hybridSearchEnabled?: boolean
  hybridSearchDenseWeight?: number
  hybridSearchSparseWeight?: number
  rerankerEnabled?: boolean
  rerankerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  rerankerOllamaBaseUrl?: string
  rerankerOllamaModelId?: string
  rerankerOpenAiCompatibleBaseUrl?: string
  rerankerOpenAiCompatibleModelId?: string
  rerankerOpenAiCompatibleApiKey?: string
  rerankerLlamaCppModelPath?: string
  rerankerLlamaCppRerankerModelPath?: string
  rerankerLlamaCppServer?: boolean
  rerankerLlamaCppServerBinPath?: string
  rerankerMinScore?: number
  rerankerBatchSize?: number
  rerankerConcurrency?: number
  rerankerMaxRetries?: number
  rerankerRetryDelayMs?: number
  summarizerProvider?: 'ollama' | 'openai-compatible' | 'llamacpp'
  summarizerOllamaBaseUrl?: string
  summarizerOllamaModelId?: string
  summarizerOpenAiCompatibleBaseUrl?: string
  summarizerOpenAiCompatibleModelId?: string
  summarizerOpenAiCompatibleApiKey?: string
  summarizerLlamaCppModelPath?: string
  summarizerLanguage?: 'English' | 'Chinese'
  summarizerTemperature?: number
  summarizerBatchSize?: number
  summarizerConcurrency?: number
  summarizerMaxRetries?: number
  summarizerRetryDelayMs?: number

  // Highlighter configuration
  highlighterEnabled?: boolean
  highlighterProvider?: "llamacpp" | "llamacpp-llm"
  highlighterGgufPath?: string
  highlighterGgufLlmPath?: string
  highlighterTopK?: number
  highlighterMode?: "topk" | "threshold"
  highlighterThreshold?: number
  highlighterConcurrency?: number
}
