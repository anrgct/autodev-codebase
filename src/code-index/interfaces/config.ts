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

	// Vector Store
	qdrantUrl?: string
	qdrantApiKey?: string

	// Vector Search
	vectorSearchMinScore?: number
	vectorSearchMaxResults?: number

	// Reranker configuration
	rerankerEnabled?: boolean
	rerankerProvider?: 'ollama' | 'openai-compatible'
	rerankerOllamaBaseUrl?: string
	rerankerOllamaModelId?: string
	rerankerOpenAiCompatibleBaseUrl?: string
	rerankerOpenAiCompatibleModelId?: string
	rerankerOpenAiCompatibleApiKey?: string
	rerankerMinScore?: number
	rerankerBatchSize?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	embedderProvider: EmbedderProvider
	embedderModelId?: string
	embedderModelDimension?: number
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
	qdrantUrl?: string
	qdrantApiKey?: string
	vectorSearchMinScore?: number
	vectorSearchMaxResults?: number
	rerankerEnabled?: boolean
	rerankerProvider?: 'ollama' | 'openai-compatible'
	rerankerOllamaBaseUrl?: string
	rerankerOllamaModelId?: string
	rerankerOpenAiCompatibleBaseUrl?: string
	rerankerOpenAiCompatibleModelId?: string
	rerankerOpenAiCompatibleApiKey?: string
	rerankerMinScore?: number
	rerankerBatchSize?: number
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
	qdrantUrl?: string
	qdrantApiKey?: string
	vectorSearchMinScore?: number
	vectorSearchMaxResults?: number
	rerankerEnabled?: boolean
	rerankerProvider?: 'ollama' | 'openai-compatible'
	rerankerOllamaBaseUrl?: string
	rerankerOllamaModelId?: string
	rerankerOpenAiCompatibleBaseUrl?: string
	rerankerOpenAiCompatibleModelId?: string
	rerankerOpenAiCompatibleApiKey?: string
	rerankerMinScore?: number
	rerankerBatchSize?: number
}
