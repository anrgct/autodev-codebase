import { EmbedderProvider } from "./manager"

/**
 * Ollama embedder configuration
 */
export interface OllamaEmbedderConfig {
	provider: "ollama"
	baseUrl: string
	model: string
	dimension: number
	apiKey?: string
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
 * Union type for all embedder configurations
 */
export type EmbedderConfig = OllamaEmbedderConfig | OpenAIEmbedderConfig | OpenAICompatibleEmbedderConfig

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
	isEnabled: boolean
	isConfigured: boolean
	embedder: EmbedderConfig
	qdrantUrl?: string
	qdrantApiKey?: string
	searchMinScore?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	configured: boolean
	embedderProvider: EmbedderProvider
	embedderConfig: string // JSON string of embedder config for comparison
	qdrantUrl?: string
	qdrantApiKey?: string
}
