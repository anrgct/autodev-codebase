/**
 * Configuration metadata for CLI commands
 *
 * Centralizes all configuration-related constants and validation rules.
 * This is the single source of truth for configuration key metadata.
 */

import type { CodeIndexConfig } from '../../code-index/interfaces/config'

type ConfigKey = keyof CodeIndexConfig
type ConfigValueType = 'boolean' | 'integer' | 'number' | 'string' | 'enum'

export interface ConfigKeyMetadata {
	/** Type of the configuration value */
	type: ConfigValueType
	/** Valid enum values (for enum type) */
	enumValues?: readonly string[]
	/** Minimum value (for integer/number types) */
	minValue?: number
	/** Maximum value (for integer/number types) */
	maxValue?: number
	/** Human-readable description */
	description?: string
}

/**
 * Metadata for all configuration keys
 *
 * This object defines:
 * - The type of each configuration value
 * - Valid enum values for enums
 * - Validation constraints (min/max values)
 *
 * IMPORTANT: When adding new configuration keys to CodeIndexConfig,
 * update this metadata as well to maintain consistency.
 */
export const CONFIG_KEY_METADATA: Record<ConfigKey, ConfigKeyMetadata> = {
	// Feature enablement
	isEnabled: { type: 'boolean', description: 'Enable code indexing feature' },

	// Embedder - General
	embedderProvider: {
		type: 'enum',
		enumValues: ['openai', 'ollama', 'openai-compatible', 'jina', 'gemini', 'mistral', 'vercel-ai-gateway', 'openrouter'] as const,
		description: 'Embedding provider to use'
	},
	embedderModelId: { type: 'string', description: 'Model identifier for embeddings' },
	embedderModelDimension: { type: 'integer', minValue: 1, description: 'Dimension of embedding vectors' },

	// Embedder - Ollama
	embedderOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL' },
	embedderOllamaBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Ollama embeddings' },

	// Embedder - OpenAI
	embedderOpenAiApiKey: { type: 'string', description: 'OpenAI API key' },
	embedderOpenAiBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenAI embeddings' },

	// Embedder - OpenAI Compatible
	embedderOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL' },
	embedderOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key' },
	embedderOpenAiCompatibleBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenAI-compatible embeddings' },

	// Embedder - Gemini
	embedderGeminiApiKey: { type: 'string', description: 'Gemini API key' },
	embedderGeminiBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Gemini embeddings' },

	// Embedder - Mistral
	embedderMistralApiKey: { type: 'string', description: 'Mistral API key' },
	embedderMistralBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Mistral embeddings' },

	// Embedder - Vercel AI Gateway
	embedderVercelAiGatewayApiKey: { type: 'string', description: 'Vercel AI Gateway API key' },

	// Embedder - OpenRouter
	embedderOpenRouterApiKey: { type: 'string', description: 'OpenRouter API key' },
	embedderOpenRouterBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenRouter embeddings' },

	// Vector Store
	qdrantUrl: { type: 'string', description: 'Qdrant server URL' },
	qdrantApiKey: { type: 'string', description: 'Qdrant API key' },

	// Vector Search
	vectorSearchMinScore: { type: 'number', minValue: 0, maxValue: 1, description: 'Minimum similarity score for search results' },
	vectorSearchMaxResults: { type: 'integer', minValue: 1, description: 'Maximum number of search results to return' },

	// Reranker
	rerankerEnabled: { type: 'boolean', description: 'Enable LLM reranking for search results' },
	rerankerProvider: {
		type: 'enum',
		enumValues: ['ollama', 'openai-compatible'] as const,
		description: 'Reranker provider to use'
	},
	rerankerOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL for reranking' },
	rerankerOllamaModelId: { type: 'string', description: 'Ollama model ID for reranking' },
	rerankerOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL for reranking' },
	rerankerOpenAiCompatibleModelId: { type: 'string', description: 'OpenAI-compatible model ID for reranking' },
	rerankerOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key for reranking' },
	rerankerMinScore: { type: 'number', minValue: 0, maxValue: 1, description: 'Minimum score for reranked results' },
	rerankerBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for reranking' },
	rerankerConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent reranking requests' },
	rerankerMaxRetries: { type: 'integer', minValue: 0, description: 'Maximum number of retries for reranking' },
	rerankerRetryDelayMs: { type: 'integer', minValue: 0, description: 'Delay between reranking retries (ms)' },

	// Summarizer
	summarizerProvider: {
		type: 'enum',
		enumValues: ['ollama', 'openai-compatible'] as const,
		description: 'Summarizer provider to use'
	},
	summarizerOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL for summarization' },
	summarizerOllamaModelId: { type: 'string', description: 'Ollama model ID for summarization' },
	summarizerOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL for summarization' },
	summarizerOpenAiCompatibleModelId: { type: 'string', description: 'OpenAI-compatible model ID for summarization' },
	summarizerOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key for summarization' },
	summarizerLanguage: {
		type: 'enum',
		enumValues: ['English', 'Chinese'] as const,
		description: 'Language for summaries'
	},
	summarizerTemperature: { type: 'number', minValue: 0, maxValue: 2, description: 'Temperature for summarization' },
	summarizerBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for summarization' },
	summarizerConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent summarization requests' },
	summarizerMaxRetries: { type: 'integer', minValue: 0, description: 'Maximum number of retries for summarization' },
	summarizerRetryDelayMs: { type: 'integer', minValue: 0, description: 'Delay between summarization retries (ms)' },
}

/**
 * Get all valid configuration keys
 */
export function getValidConfigKeys(): ConfigKey[] {
	return Object.keys(CONFIG_KEY_METADATA) as ConfigKey[]
}

/**
 * Get metadata for a specific configuration key
 */
export function getConfigKeyMetadata(key: string): ConfigKeyMetadata | undefined {
	return CONFIG_KEY_METADATA[key as ConfigKey]
}

/**
 * Check if a configuration key is valid
 */
export function isValidConfigKey(key: string): key is ConfigKey {
	return key in CONFIG_KEY_METADATA
}
