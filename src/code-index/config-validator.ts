import { CodeIndexConfig, EmbedderProvider } from "./interfaces/config"

/**
 * Configuration validation issue with structured error information
 */
export interface ValidationIssue {
	/**
	 * Field path using dot notation (e.g., "embedderOpenAiApiKey", "rerankerOllamaBaseUrl")
	 */
	path: string

	/**
	 * Error code for programmatic handling
	 * Examples: "required", "invalid_format", "missing_dependency"
	 */
	code: string

	/**
	 * Human-readable error message
	 */
	message: string
}

/**
 * Result of configuration validation
 */
export interface ValidationResult {
	/**
	 * Whether the configuration is valid (no issues)
	 */
	valid: boolean

	/**
	 * List of validation issues
	 */
	issues: ValidationIssue[]
}

/**
 * Configuration validator that centralizes all validation logic
 */
export class ConfigValidator {
	/**
	 * Validate a complete CodeIndexConfig
	 * @param config The configuration to validate
	 * @returns Validation result with issues if any
	 */
	static validate(config: CodeIndexConfig): ValidationResult {
		const issues: ValidationIssue[] = []

		// Validate embedder configuration
		ConfigValidator.validateEmbedder(config, issues)

		// Validate Qdrant configuration
		ConfigValidator.validateQdrant(config, issues)

		// Validate reranker configuration
		ConfigValidator.validateReranker(config, issues)

		// Validate summarizer configuration (optional - only when --summarize flag is used)
		ConfigValidator.validateSummarizer(config, issues)

		// Validate basic configuration consistency
		ConfigValidator.validateBasicConsistency(config, issues)

		return {
			valid: issues.length === 0,
			issues
		}
	}

	/**
	 * Validate embedder configuration based on provider
	 */
	private static validateEmbedder(config: CodeIndexConfig, issues: ValidationIssue[]): void {
		const provider = config.embedderProvider

		switch (provider) {
			case 'openai':
				if (!config.embedderOpenAiApiKey) {
					issues.push({
						path: 'embedderOpenAiApiKey',
						code: 'required',
						message: 'OpenAI API key is required for OpenAI embedder'
					})
				}
				break

			case 'ollama':
				if (!config.embedderOllamaBaseUrl) {
					issues.push({
						path: 'embedderOllamaBaseUrl',
						code: 'required',
						message: 'Ollama base URL is required for Ollama embedder'
					})
				}
				break

			case 'openai-compatible':
				if (!config.embedderOpenAiCompatibleBaseUrl) {
					issues.push({
						path: 'embedderOpenAiCompatibleBaseUrl',
						code: 'required',
						message: 'Base URL is required for OpenAI Compatible embedder'
					})
				}
				if (!config.embedderOpenAiCompatibleApiKey) {
					issues.push({
						path: 'embedderOpenAiCompatibleApiKey',
						code: 'required',
						message: 'API key is required for OpenAI Compatible embedder'
					})
				}
				break

			case 'jina':
				if (!config.embedderGeminiApiKey) {
					issues.push({
						path: 'embedderJinaApiKey',
						code: 'required',
						message: 'Jina API key is required for Jina embedder'
					})
				}
				break

			case 'gemini':
				if (!config.embedderGeminiApiKey) {
					issues.push({
						path: 'embedderGeminiApiKey',
						code: 'required',
						message: 'Gemini API key is required for Gemini embedder'
					})
				}
				break

			case 'mistral':
				if (!config.embedderMistralApiKey) {
					issues.push({
						path: 'embedderMistralApiKey',
						code: 'required',
						message: 'Mistral API key is required for Mistral embedder'
					})
				}
				break

			case 'vercel-ai-gateway':
				if (!config.embedderVercelAiGatewayApiKey) {
					issues.push({
						path: 'embedderVercelAiGatewayApiKey',
						code: 'required',
						message: 'Vercel AI Gateway API key is required for Vercel AI Gateway embedder'
					})
				}
				break

			case 'openrouter':
				if (!config.embedderOpenRouterApiKey) {
					issues.push({
						path: 'embedderOpenRouterApiKey',
						code: 'required',
						message: 'OpenRouter API key is required for OpenRouter embedder'
					})
				}
				break

			default:
				// Type safety: should never happen with TypeScript
				issues.push({
					path: 'embedderProvider',
					code: 'invalid_value',
					message: `Unknown embedder provider: ${provider}`
				})
		}
	}

	/**
	 * Validate Qdrant vector store configuration
	 */
	private static validateQdrant(config: CodeIndexConfig, issues: ValidationIssue[]): void {
		if (!config.qdrantUrl) {
			issues.push({
				path: 'qdrantUrl',
				code: 'required',
				message: 'Qdrant URL is required for vector storage'
			})
		}
	}

	/**
	 * Validate reranker configuration
	 */
	private static validateReranker(config: CodeIndexConfig, issues: ValidationIssue[]): void {
		if (config.rerankerEnabled) {
			if (!config.rerankerProvider) {
				issues.push({
					path: 'rerankerProvider',
					code: 'required',
					message: 'Reranker provider is required when reranker is enabled'
				})
				return
			}

			if (config.rerankerProvider === 'ollama') {
				if (!config.rerankerOllamaBaseUrl) {
					issues.push({
						path: 'rerankerOllamaBaseUrl',
						code: 'required',
						message: 'Ollama base URL is required for ollama reranker'
					})
				}
				if (!config.rerankerOllamaModelId) {
					issues.push({
						path: 'rerankerOllamaModelId',
						code: 'required',
						message: 'Ollama model ID is required for ollama reranker'
					})
				}
				return
			}

			if (config.rerankerProvider === 'openai-compatible') {
				if (!config.rerankerOpenAiCompatibleBaseUrl) {
					issues.push({
						path: 'rerankerOpenAiCompatibleBaseUrl',
						code: 'required',
						message: 'OpenAI-compatible base URL is required for openai-compatible reranker'
					})
				}
				if (!config.rerankerOpenAiCompatibleModelId) {
					issues.push({
						path: 'rerankerOpenAiCompatibleModelId',
						code: 'required',
						message: 'OpenAI-compatible model ID is required for openai-compatible reranker'
					})
				}
				// Note: API key may be optional for local servers
				return
			}

			// Unknown provider
			issues.push({
				path: 'rerankerProvider',
				code: 'invalid',
				message: `Unknown reranker provider: ${config.rerankerProvider}`
			})
		}
	}

	/**
	 * Validate summarizer configuration
	 * Note: This validation is optional and only performed when --summarize flag is actually used.
	 * It doesn't block other operations if summarizer config is incomplete.
	 */
	private static validateSummarizer(config: CodeIndexConfig, issues: ValidationIssue[]): void {
		// Only validate if summarizer provider is specified
		if (!config.summarizerProvider) {
			return
		}

		// Validate provider is supported
		if (config.summarizerProvider !== 'ollama') {
			issues.push({
				path: 'summarizerProvider',
				code: 'invalid_value',
				message: `Unsupported summarizer provider: ${config.summarizerProvider}. Only 'ollama' is supported in v1.`
			})
			return
		}

		// For ollama provider, validate required fields
		if (config.summarizerProvider === 'ollama') {
			if (!config.summarizerOllamaBaseUrl) {
				issues.push({
					path: 'summarizerOllamaBaseUrl',
					code: 'required',
					message: 'Ollama base URL is required for summarizer when provider is ollama'
				})
			}

			if (!config.summarizerOllamaModelId) {
				issues.push({
					path: 'summarizerOllamaModelId',
					code: 'required',
					message: 'Ollama model ID is required for summarizer when provider is ollama'
				})
			}
		}

		// Validate language if specified
		if (config.summarizerLanguage) {
			if (config.summarizerLanguage !== 'English' && config.summarizerLanguage !== 'Chinese') {
				issues.push({
					path: 'summarizerLanguage',
					code: 'invalid_value',
					message: `Invalid language: ${config.summarizerLanguage}. Must be 'English' or 'Chinese'.`
				})
			}
		}
	}

	/**
	 * Validate basic configuration consistency
	 */
	private static validateBasicConsistency(config: CodeIndexConfig, issues: ValidationIssue[]): void {
		// Validate score ranges
		if (config.vectorSearchMinScore !== undefined && (config.vectorSearchMinScore < 0 || config.vectorSearchMinScore > 1)) {
			issues.push({
				path: 'vectorSearchMinScore',
				code: 'invalid_range',
				message: 'Search minimum score must be between 0 and 1'
			})
		}

		if (config.rerankerMinScore !== undefined && config.rerankerMinScore < 0) {
			issues.push({
				path: 'rerankerMinScore',
				code: 'invalid_range',
				message: 'Reranker minimum score must be non-negative'
			})
		}

		// Validate batch sizes
		if (config.rerankerBatchSize !== undefined && config.rerankerBatchSize <= 0) {
			issues.push({
				path: 'rerankerBatchSize',
				code: 'invalid_range',
				message: 'Reranker batch size must be positive'
			})
		}

		if (config.vectorSearchMaxResults !== undefined && config.vectorSearchMaxResults <= 0) {
			issues.push({
				path: 'vectorSearchMaxResults',
				code: 'invalid_range',
				message: 'Search maximum results must be positive'
			})
		}

		// Validate embedder batch sizes
		if (config.embedderOllamaBatchSize !== undefined && config.embedderOllamaBatchSize <= 0) {
			issues.push({
				path: 'embedderOllamaBatchSize',
				code: 'invalid_range',
				message: 'Embedder Ollama batch size must be positive'
			})
		}

		if (config.embedderOpenAiBatchSize !== undefined && config.embedderOpenAiBatchSize <= 0) {
			issues.push({
				path: 'embedderOpenAiBatchSize',
				code: 'invalid_range',
				message: 'Embedder OpenAI batch size must be positive'
			})
		}

		if (config.embedderOpenAiCompatibleBatchSize !== undefined && config.embedderOpenAiCompatibleBatchSize <= 0) {
			issues.push({
				path: 'embedderOpenAiCompatibleBatchSize',
				code: 'invalid_range',
				message: 'Embedder OpenAI Compatible batch size must be positive'
			})
		}

		if (config.embedderGeminiBatchSize !== undefined && config.embedderGeminiBatchSize <= 0) {
			issues.push({
				path: 'embedderGeminiBatchSize',
				code: 'invalid_range',
				message: 'Embedder Gemini batch size must be positive'
			})
		}

		if (config.embedderMistralBatchSize !== undefined && config.embedderMistralBatchSize <= 0) {
			issues.push({
				path: 'embedderMistralBatchSize',
				code: 'invalid_range',
				message: 'Embedder Mistral batch size must be positive'
			})
		}

		if (config.embedderOpenRouterBatchSize !== undefined && config.embedderOpenRouterBatchSize <= 0) {
			issues.push({
				path: 'embedderOpenRouterBatchSize',
				code: 'invalid_range',
				message: 'Embedder OpenRouter batch size must be positive'
			})
		}
	}
}
