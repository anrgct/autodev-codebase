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
	isConfigured: boolean
	embedderProvider: EmbedderProvider
	modelId?: string
	modelDimension?: number // Generic dimension property for all providers
	openAiOptions?: ApiHandlerOptions
	ollamaOptions?: ApiHandlerOptions
	openAiCompatibleOptions?: { baseUrl: string; apiKey: string }
	geminiOptions?: { apiKey: string }
	mistralOptions?: { apiKey: string }
	vercelAiGatewayOptions?: { apiKey: string }
	openRouterOptions?: { apiKey: string }
	qdrantUrl?: string
	qdrantApiKey?: string
	searchMinScore?: number
	searchMaxResults?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	configured: boolean
	embedderProvider: EmbedderProvider
	modelId?: string
	modelDimension?: number // Generic dimension property
	openAiKey?: string
	ollamaBaseUrl?: string
	openAiCompatibleBaseUrl?: string
	openAiCompatibleApiKey?: string
	geminiApiKey?: string
	mistralApiKey?: string
	vercelAiGatewayApiKey?: string
	openRouterApiKey?: string
	qdrantUrl?: string
	qdrantApiKey?: string
}
