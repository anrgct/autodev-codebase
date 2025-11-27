/**
 * Defines profiles for different embedding models, including their dimensions.
 */

export type EmbedderProvider = "openai" | "ollama" | "openai-compatible" | "jina" | "gemini" | "mistral" | "openrouter" | "vercel-ai-gateway"

export interface EmbeddingModelProfile {
	dimension: number
	// Add other model-specific properties if needed, e.g., context window size
}

export type EmbeddingModelProfiles = {
	[provider in EmbedderProvider]?: {
		[modelId: string]: EmbeddingModelProfile
	}
}

// Example profiles - expand this list as needed
export const EMBEDDING_MODEL_PROFILES: EmbeddingModelProfiles = {
	openai: {
		"text-embedding-3-small": { dimension: 1536 },
		"text-embedding-3-large": { dimension: 3072 },
		"text-embedding-ada-002": { dimension: 1536 },
	},
	ollama: {
		"nomic-embed-text": { dimension: 768 },
		"nomic-embed-text:latest": { dimension: 768 },
		"mxbai-embed-large": { dimension: 1024 },
		"all-minilm": { dimension: 384 },
		"qwen3-embedding:0.6b": { dimension: 1024 },
		"qwen3-embedding:4b": { dimension: 4096 },
		"qwen3-embedding:8b": { dimension: 2560 },
		// Add default Ollama model if applicable, e.g.:
		// 'default': { dimension: 768 } // Assuming a default dimension
	},
	"openai-compatible": {
		"text-embedding-3-small": { dimension: 1536 },
		"text-embedding-3-large": { dimension: 3072 },
		"text-embedding-ada-002": { dimension: 1536 },
	},
	jina: {
		"jina-embeddings-v2-base-code": { dimension: 768 },
		"jina-code-embeddings-0.5b": { dimension: 896 },
		"jina-code-embeddings-1.5b": { dimension: 1536 },
		"jina-embeddings-v4": { dimension: 2048 },
	},
	gemini: {
		"text-embedding-004": { dimension: 768 },
		"gemini-embedding-001": { dimension: 2048 },
	},
	mistral: {
		"codestral-embed-2505": { dimension: 1536 },
	},
	openrouter: {
		"openai/text-embedding-3-small": { dimension: 1536 },
		"openai/text-embedding-3-large": { dimension: 3072 },
		"openai/text-embedding-ada-002": { dimension: 1536 },
	},
	"vercel-ai-gateway": {
		"text-embedding-3-small": { dimension: 1536 },
		"text-embedding-3-large": { dimension: 3072 },
		"text-embedding-ada-002": { dimension: 1536 },
	},
}

/**
 * Retrieves the embedding dimension for a given provider and model ID.
 * @param provider The embedder provider (e.g., "openai").
 * @param modelId The specific model ID (e.g., "text-embedding-3-small").
 * @returns The dimension size or undefined if the model is not found.
 */
export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
	const providerProfiles = EMBEDDING_MODEL_PROFILES[provider]

	if (!providerProfiles) {
		console.warn(`Provider not found in profiles: ${provider}`)
		return undefined
	}

	const modelProfile = providerProfiles[modelId]

	if (!modelProfile) {
		console.warn(`Model not found for provider ${provider}: ${modelId}`)
		return undefined // Or potentially return a default/fallback dimension?
	}

	return modelProfile.dimension
}

/**
 * Gets the default *specific* embedding model ID based on the provider.
 * Does not include the provider prefix.
 * Currently defaults to OpenAI's 'text-embedding-3-small'.
 * TODO: Make this configurable or more sophisticated.
 * @param provider The embedder provider.
 * @returns The default specific model ID for the provider (e.g., "text-embedding-3-small").
 */
export function getDefaultModelId(provider: EmbedderProvider): string {
	switch (provider) {
		case "openai":
		case "openai-compatible":
			return "text-embedding-3-small"

		case "ollama": {
			// Choose a sensible default for Ollama, e.g., the first one listed or a specific one
			const ollamaModels = EMBEDDING_MODEL_PROFILES.ollama
			const defaultOllamaModel = ollamaModels && Object.keys(ollamaModels)[0]
			if (defaultOllamaModel) {
				return defaultOllamaModel
			}
			// Fallback if no Ollama models are defined (shouldn't happen with the constant)
			console.warn("No default Ollama model found in profiles.")
			// Return a placeholder or throw an error, depending on desired behavior
			return "unknown-default" // Placeholder specific model ID
		}
		case "jina": {
			const jinaModels = EMBEDDING_MODEL_PROFILES.jina
			const defaultJinaModel = jinaModels && Object.keys(jinaModels)[0]
			if (defaultJinaModel) {
				return defaultJinaModel
			}
			console.warn("No default Jina model found in profiles.")
			return "jina-embeddings-v2-base-code"
		}
		case "gemini":
			return "gemini-embedding-001"
		case "mistral":
			return "codestral-embed-2505"
		case "openrouter":
			return "openai/text-embedding-3-large"
		case "vercel-ai-gateway":
			return "text-embedding-3-small"
		default:
			// Fallback for unknown providers
			console.warn(`Unknown provider for default model ID: ${provider}. Falling back to OpenAI default.`)
			return "text-embedding-3-small"
	}
}

/**
 * Gets model-specific query prefix for embedding models that require it
 * Currently, no models require prefixes, but this function is kept for future extensibility
 * @param provider The embedder provider
 * @param modelId The model ID
 * @returns Query prefix string or null if no prefix is required
 */
export function getModelQueryPrefix(provider: EmbedderProvider, modelId: string): string | null {
	// Currently no models require prefixes
	// This function is kept for future compatibility
	return null
}

/**
 * Gets model-specific score threshold for semantic search
 * Returns undefined if no specific threshold is defined for the model
 * @param provider The embedder provider
 * @param modelId The model ID
 * @returns Model-specific score threshold or undefined
 */
export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
	// Define model-specific thresholds based on empirical testing
	// These values represent the minimum similarity score for reliable matches
	const modelThresholds: { [key: string]: number } = {
		// OpenAI models - generally high quality, can use lower threshold
		"text-embedding-3-small": 0.35,
		"text-embedding-3-large": 0.30,
		"text-embedding-ada-002": 0.40,

		// Ollama models - vary in quality, generally need higher threshold
		"nomic-embed-text": 0.45,
		"mxbai-embed-large": 0.40,
		"all-minilm": 0.50,

		// Gemini models
		"text-embedding-004": 0.45,
		"gemini-embedding-001": 0.40,

		// Mistral
		"codestral-embed-2505": 0.35,

		// Jina models - generally good for code
		"jina-embeddings-v2-base-code": 0.40,
		"jina-code-embeddings-0.5b": 0.45,
		"jina-code-embeddings-1.5b": 0.35,
		"jina-embeddings-v4": 0.30,
	}

	return modelThresholds[modelId]
}
