import { EmbedderProvider } from "./interfaces/manager"
import { CodeIndexConfig, PreviousConfigSnapshot } from "./interfaces/config"
import { RerankerConfig } from "./interfaces/reranker"
import { SummarizerConfig } from "./interfaces/summarizer"
import { DEFAULT_SEARCH_MIN_SCORE, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_CONFIG } from "./constants"
import { getDefaultModelId, getModelDimension, getModelScoreThreshold } from "../shared/embeddingModels"
import { IConfigProvider } from "../abstractions/config"
import { ConfigValidator } from "./config-validator"
import { validateLimit, validateMinScore } from "./validate-search-params"
import { SEARCH_CONFIG } from "./constants/search-config"

/**
 * Keys that require a restart when changed
 * These are critical configuration changes that affect the core embedding and storage system
 */
const REQUIRES_RESTART_KEYS: (keyof CodeIndexConfig)[] = [
	'isEnabled',                           // Feature enable/disable
	'embedderProvider',                    // Core provider change
	'embedderModelId',                     // Model change
	'embedderModelDimension',              // Vector dimension change
	'embedderOllamaBaseUrl',               // Ollama configuration
	'embedderOpenAiApiKey',                // OpenAI configuration
	'embedderOpenAiCompatibleBaseUrl',     // OpenAI Compatible configuration
	'embedderOpenAiCompatibleApiKey',      // OpenAI Compatible configuration
	'embedderGeminiApiKey',                // Gemini configuration
	'embedderMistralApiKey',               // Mistral configuration
	'embedderVercelAiGatewayApiKey',       // Vercel AI Gateway configuration
	'embedderOpenRouterApiKey',            // OpenRouter configuration
	'qdrantUrl',                          // Vector store location
	'qdrantApiKey',                       // Vector store authentication
]

/**
 * Keys that can be hot-reloaded without restarting
 * These are typically search parameters and non-critical settings
 */
const HOT_RELOADABLE_KEYS: (keyof CodeIndexConfig)[] = [
	'vectorSearchMinScore',                // Search threshold
	'vectorSearchMaxResults',              // Search result limit
	'rerankerEnabled',                    // Reranker toggle
	'rerankerProvider',                   // Reranker provider change
	'rerankerOllamaBaseUrl',              // Reranker Ollama URL
	'rerankerOllamaModelId',              // Reranker Ollama model
	'rerankerOpenAiCompatibleBaseUrl',    // Reranker OpenAI Compatible URL
	'rerankerOpenAiCompatibleModelId',    // Reranker OpenAI Compatible model
	'rerankerOpenAiCompatibleApiKey',     // Reranker OpenAI Compatible API key
	'rerankerMinScore',                   // Reranker threshold
	'rerankerBatchSize',                  // Reranker batch size
	'summarizerProvider',                 // Summarizer provider
	'summarizerOllamaBaseUrl',            // Summarizer Ollama URL
	'summarizerOllamaModelId',            // Summarizer Ollama model
	'summarizerOpenAiCompatibleBaseUrl',  // Summarizer OpenAI Compatible URL
	'summarizerOpenAiCompatibleModelId',  // Summarizer OpenAI Compatible model
	'summarizerOpenAiCompatibleApiKey',   // Summarizer OpenAI Compatible API key
	'summarizerLanguage',                 // Summarizer language
	'summarizerTemperature',              // Summarizer temperature
	'embedderOllamaBatchSize',            // Batch sizes can be hot-reloaded
	'embedderOpenAiBatchSize',
	'embedderOpenAiCompatibleBatchSize',
	'embedderGeminiBatchSize',
	'embedderMistralBatchSize',
	'embedderOpenRouterBatchSize',
]

/**
 * Safely get a nested value from an object using a key path
 * Returns a string representation for comparison
 */
function getConfigValue(config: CodeIndexConfig | null | undefined, key: keyof CodeIndexConfig): string {
	if (!config) return ''

	const value = config[key]

	// Handle nested objects by converting to JSON string for stable comparison
	if (value && typeof value === 'object') {
		return JSON.stringify(value, Object.keys(value).sort())
	}

	// Handle primitive values
	return String(value ?? '')
}

/**
 * Manages configuration state and validation for the code indexing feature.
 * Handles loading, validating, and providing access to configuration values.
 */
export class CodeIndexConfigManager {
	private config: CodeIndexConfig | null = null

	constructor(private readonly configProvider: IConfigProvider) {
		// Initialize with current configuration to avoid false restart triggers
		// Note: This is async but constructor can't be async, so we'll initialize asynchronously
		this._loadAndSetConfiguration().catch(console.error)
	}

	/**
	 * Gets the config provider instance
	 */
	public getConfigProvider(): IConfigProvider {
		return this.configProvider
	}

	/**
	 * Private method that handles loading configuration from storage and updating instance variables.
	 */
	private async _loadAndSetConfiguration(): Promise<void> {
		this.config = await this.configProvider.getConfig()
	}

	/**
	 * Initialize the config manager and load initial configuration
	 */
	public async initialize(): Promise<void> {
		await this.loadConfiguration()
	}

	/**
	 * Loads persisted configuration from config provider.
	 */
	public async loadConfiguration(): Promise<{
		configSnapshot: PreviousConfigSnapshot
		currentConfig: CodeIndexConfig
		requiresRestart: boolean
	}> {
		// Capture the ACTUAL previous state before loading new configuration
		const previousConfigSnapshot = this._createConfigSnapshot(this.config)

		// Load new configuration from storage and update instance variables
		await this._loadAndSetConfiguration()

		const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)

		return {
			configSnapshot: previousConfigSnapshot,
			currentConfig: this.config!,
			requiresRestart,
		}
	}

	/**
	 * Checks if the service is properly configured based on the embedder type.
	 */
	public isConfigured(): boolean {
		if (!this.config) return false

		const { embedderProvider, qdrantUrl } = this.config

		if (embedderProvider === "openai") {
			const openAiKey = this.config.embedderOpenAiApiKey
			return !!(openAiKey && qdrantUrl)
		} else if (embedderProvider === "ollama") {
			const ollamaBaseUrl = this.config.embedderOllamaBaseUrl
			return !!(ollamaBaseUrl && qdrantUrl)
		} else if (embedderProvider === "openai-compatible") {
			const baseUrl = this.config.embedderOpenAiCompatibleBaseUrl
			const apiKey = this.config.embedderOpenAiCompatibleApiKey
			return !!(baseUrl && apiKey && qdrantUrl)
		} else if (embedderProvider === "gemini") {
			const apiKey = this.config.embedderGeminiApiKey
			return !!(apiKey && qdrantUrl)
		} else if (embedderProvider === "mistral") {
			const apiKey = this.config.embedderMistralApiKey
			return !!(apiKey && qdrantUrl)
		} else if (embedderProvider === "vercel-ai-gateway") {
			const apiKey = this.config.embedderVercelAiGatewayApiKey
			return !!(apiKey && qdrantUrl)
		} else if (embedderProvider === "openrouter") {
			const apiKey = this.config.embedderOpenRouterApiKey
			return !!(apiKey && qdrantUrl)
		}
		return false
	}

	/**
	 * Create a config snapshot from the current config for restart detection
	 */
	private _createConfigSnapshot(config: CodeIndexConfig | null): PreviousConfigSnapshot {
		if (!config) {
			return {
				enabled: false,
				embedderProvider: "openai",
				qdrantUrl: "",
			}
		}

		return {
			enabled: config.isEnabled,
			embedderProvider: config.embedderProvider,
			embedderModelId: config.embedderModelId,
			embedderModelDimension: config.embedderModelDimension,
			embedderOllamaBaseUrl: config.embedderOllamaBaseUrl,
			embedderOllamaBatchSize: config.embedderOllamaBatchSize,
			embedderOpenAiApiKey: config.embedderOpenAiApiKey,
			embedderOpenAiBatchSize: config.embedderOpenAiBatchSize,
			embedderOpenAiCompatibleBaseUrl: config.embedderOpenAiCompatibleBaseUrl,
			embedderOpenAiCompatibleApiKey: config.embedderOpenAiCompatibleApiKey,
			embedderOpenAiCompatibleBatchSize: config.embedderOpenAiCompatibleBatchSize,
			embedderGeminiApiKey: config.embedderGeminiApiKey,
			embedderGeminiBatchSize: config.embedderGeminiBatchSize,
			embedderMistralApiKey: config.embedderMistralApiKey,
			embedderMistralBatchSize: config.embedderMistralBatchSize,
			embedderVercelAiGatewayApiKey: config.embedderVercelAiGatewayApiKey,
			embedderOpenRouterApiKey: config.embedderOpenRouterApiKey,
			embedderOpenRouterBatchSize: config.embedderOpenRouterBatchSize,
			qdrantUrl: config.qdrantUrl ?? "",
			qdrantApiKey: config.qdrantApiKey ?? "",
			vectorSearchMinScore: config.vectorSearchMinScore,
			vectorSearchMaxResults: config.vectorSearchMaxResults,
			rerankerEnabled: config.rerankerEnabled,
			rerankerProvider: config.rerankerProvider,
			rerankerOllamaBaseUrl: config.rerankerOllamaBaseUrl,
			rerankerOllamaModelId: config.rerankerOllamaModelId,
			rerankerOpenAiCompatibleBaseUrl: config.rerankerOpenAiCompatibleBaseUrl,
			rerankerOpenAiCompatibleModelId: config.rerankerOpenAiCompatibleModelId,
			rerankerOpenAiCompatibleApiKey: config.rerankerOpenAiCompatibleApiKey,
			rerankerMinScore: config.rerankerMinScore,
			rerankerBatchSize: config.rerankerBatchSize,
			summarizerProvider: config.summarizerProvider,
			summarizerOllamaBaseUrl: config.summarizerOllamaBaseUrl,
			summarizerOllamaModelId: config.summarizerOllamaModelId,
			summarizerOpenAiCompatibleBaseUrl: config.summarizerOpenAiCompatibleBaseUrl,
			summarizerOpenAiCompatibleModelId: config.summarizerOpenAiCompatibleModelId,
			summarizerOpenAiCompatibleApiKey: config.summarizerOpenAiCompatibleApiKey,
			summarizerLanguage: config.summarizerLanguage,
			summarizerTemperature: config.summarizerTemperature,
		}
	}

	/**
	 * Determines if a configuration change requires restarting the indexing process.
	 */
	doesConfigChangeRequireRestart(prev: PreviousConfigSnapshot): boolean {
		if (!this.config) return false

		const nowConfigured = this.isConfigured()

		// Handle null/undefined values safely
		const prevEnabled = prev?.enabled ?? false
		const prevProvider = prev?.embedderProvider ?? "openai"

		// 1. Transition from disabled/unconfigured to enabled/configured
		if (!prevEnabled && this.config.isEnabled && nowConfigured) {
			return true
		}

		// 2. Transition from enabled to disabled
		if (prevEnabled && !this.config.isEnabled) {
			return true
		}

		// 3. If wasn't ready before and isn't ready now, no restart needed
		if (!prevEnabled && !this.config.isEnabled) {
			return false
		}

		// 4. CRITICAL CHANGES - Only check for critical changes if feature is enabled
		if (!this.config.isEnabled) {
			return false
		}

		// Provider change
		if (prevProvider !== this.config.embedderProvider) {
			return true
		}

		// Authentication changes (API keys)
		const currentOpenAiKey = this.config.embedderOpenAiApiKey ?? ""
		const currentOllamaBaseUrl = this.config.embedderOllamaBaseUrl ?? ""
		const currentOpenAiCompatibleBaseUrl = this.config.embedderOpenAiCompatibleBaseUrl ?? ""
		const currentOpenAiCompatibleApiKey = this.config.embedderOpenAiCompatibleApiKey ?? ""
		const currentModelDimension = this.config.embedderModelDimension
		const currentGeminiApiKey = this.config.embedderGeminiApiKey ?? ""
		const currentMistralApiKey = this.config.embedderMistralApiKey ?? ""
		const currentVercelAiGatewayApiKey = this.config.embedderVercelAiGatewayApiKey ?? ""
		const currentOpenRouterApiKey = this.config.embedderOpenRouterApiKey ?? ""
		const currentQdrantUrl = this.config.qdrantUrl ?? ""
		const currentQdrantApiKey = this.config.qdrantApiKey ?? ""

		if ((prev?.embedderOpenAiApiKey ?? "") !== currentOpenAiKey) {
			return true
		}

		if ((prev?.embedderOllamaBaseUrl ?? "") !== currentOllamaBaseUrl) {
			return true
		}

		if (
			(prev?.embedderOpenAiCompatibleBaseUrl ?? "") !== currentOpenAiCompatibleBaseUrl ||
			(prev?.embedderOpenAiCompatibleApiKey ?? "") !== currentOpenAiCompatibleApiKey
		) {
			return true
		}

		if ((prev?.embedderGeminiApiKey ?? "") !== currentGeminiApiKey) {
			return true
		}

		if ((prev?.embedderMistralApiKey ?? "") !== currentMistralApiKey) {
			return true
		}

		if ((prev?.embedderVercelAiGatewayApiKey ?? "") !== currentVercelAiGatewayApiKey) {
			return true
		}

		if ((prev?.embedderOpenRouterApiKey ?? "") !== currentOpenRouterApiKey) {
			return true
		}

		// Check for model dimension changes (generic for all providers)
		if ((prev?.embedderModelDimension) !== currentModelDimension) {
			return true
		}

		if ((prev?.qdrantUrl ?? "") !== currentQdrantUrl || (prev?.qdrantApiKey ?? "") !== currentQdrantApiKey) {
			return true
		}

		// Vector dimension changes (still important for compatibility)
		if (this._hasVectorDimensionChanged(prevProvider, prev?.embedderModelId)) {
			return true
		}

		return false
	}

	/**
	 * Checks if model changes result in vector dimension changes that require restart.
	 */
	private _hasVectorDimensionChanged(prevProvider: EmbedderProvider, prevModelId?: string): boolean {
		if (!this.config) return true

		const currentProvider = this.config.embedderProvider
		const currentModelId = this.config.embedderModelId ?? getDefaultModelId(currentProvider)
		const resolvedPrevModelId = prevModelId ?? getDefaultModelId(prevProvider)

		// If model IDs are the same and provider is the same, no dimension change
		if (prevProvider === currentProvider && resolvedPrevModelId === currentModelId) {
			return false
		}

		// Get vector dimensions for both models
		const prevDimension = getModelDimension(prevProvider, resolvedPrevModelId)
		const currentDimension = getModelDimension(currentProvider, currentModelId)

		// If we can't determine dimensions, be safe and restart
		if (prevDimension === undefined || currentDimension === undefined) {
			return true
		}

		// Only restart if dimensions actually changed
		return prevDimension !== currentDimension
	}

	/**
	 * Gets the current configuration state.
	 */
	public getConfig(): CodeIndexConfig {
		return this.config ?? {
			isEnabled: false,
			embedderProvider: "openai",
		}
	}

	/**
	 * Gets whether the code indexing feature is enabled
	 */
	public get isFeatureEnabled(): boolean {
		return this.config?.isEnabled ?? false
	}

	/**
	 * Gets whether the code indexing feature is configured
	 */
	public get isFeatureConfigured(): boolean {
		return this.isConfigured()
	}

	/**
	 * Gets the current embedder type (openai or ollama)
	 */
	public get currentEmbedderProvider(): EmbedderProvider {
		return this.config?.embedderProvider ?? "ollama"
	}

	/**
	 * Gets the current model ID being used for embeddings.
	 */
	public get currentModelId(): string | undefined {
		return this.config?.embedderModelId
	}

	/**
	 * Gets the current model dimension being used for embeddings.
	 * Returns the model's built-in dimension if available, otherwise falls back to custom dimension.
	 */
	public get currentModelDimension(): number | undefined {
		if (!this.config) return undefined

		// First try to get the model-specific dimension
		const modelId = this.config.embedderModelId ?? getDefaultModelId(this.config.embedderProvider)
		const modelDimension = getModelDimension(this.config.embedderProvider, modelId)

		// Only use custom dimension if model doesn't have a built-in dimension
		if (!modelDimension && this.config.embedderModelDimension && this.config.embedderModelDimension > 0) {
			return this.config.embedderModelDimension
		}

		return modelDimension
	}

	/**
	 * Gets the configured minimum search score based on user setting, model-specific threshold, or fallback.
	 * Priority: 1) User setting, 2) Model-specific threshold, 3) Default DEFAULT_SEARCH_MIN_SCORE constant.
	 * Uses unified validation to ensure [0,1] range.
	 */
	public get currentSearchMinScore(): number {
		if (!this.config) return validateMinScore(DEFAULT_SEARCH_MIN_SCORE)

		// First check if user has configured a custom score threshold
		if (this.config.vectorSearchMinScore !== undefined) {
			return validateMinScore(this.config.vectorSearchMinScore)
		}

		// Fall back to model-specific threshold
		const currentModelId = this.config.embedderModelId ?? getDefaultModelId(this.config.embedderProvider)
		const modelSpecificThreshold = getModelScoreThreshold(this.config.embedderProvider, currentModelId)
		return validateMinScore(modelSpecificThreshold ?? DEFAULT_SEARCH_MIN_SCORE)
	}

	/**
	 * Gets the configured maximum search results.
	 * Returns user setting if configured, otherwise returns default.
	 * Uses unified validation to ensure [1, MAX_LIMIT] range.
	 */
	public get currentSearchMaxResults(): number {
		const raw = this.config?.vectorSearchMaxResults
		return validateLimit(raw ?? SEARCH_CONFIG.DEFAULT_LIMIT)
	}

	  /**
	   * Gets whether the reranker is enabled
	   */
	  public get isRerankerEnabled(): boolean {
	    return this.config?.rerankerEnabled === true && !!this.config?.rerankerProvider
	  }

	  /**
	   * Gets the reranker configuration
	   */
	  public get rerankerConfig(): RerankerConfig | undefined {
	    if (!this.config?.rerankerEnabled) {
	      return undefined
	    }

	    // When enabled, provider should be specified (required by validator)
	    const provider = this.config.rerankerProvider
	    if (!provider) {
	      return undefined
	    }

	    return {
	      enabled: this.config.rerankerEnabled,
	      provider: provider,
	      ollamaBaseUrl: this.config.rerankerOllamaBaseUrl,
	      ollamaModelId: this.config.rerankerOllamaModelId,
	      openAiCompatibleBaseUrl: this.config.rerankerOpenAiCompatibleBaseUrl,
	      openAiCompatibleModelId: this.config.rerankerOpenAiCompatibleModelId,
	      openAiCompatibleApiKey: this.config.rerankerOpenAiCompatibleApiKey,
	      minScore: this.config.rerankerMinScore,
	      batchSize: this.config.rerankerBatchSize || 10
	    }
	  }

	/**
	 * Gets the summarizer configuration.
	 * Always returns config (never undefined) since summarizer is only used when --summarize flag is present.
	 * Missing values are filled with defaults.
	 */
	public get summarizerConfig(): SummarizerConfig {
		const provider = this.config?.summarizerProvider || 'ollama';

		return {
			provider: provider,
			ollamaBaseUrl: this.config?.summarizerOllamaBaseUrl || 'http://localhost:11434',
			ollamaModelId: this.config?.summarizerOllamaModelId || 'qwen3-vl:4b-instruct',
			openAiCompatibleBaseUrl: this.config?.summarizerOpenAiCompatibleBaseUrl || 'http://localhost:8080/v1',
			openAiCompatibleModelId: this.config?.summarizerOpenAiCompatibleModelId || 'gpt-4',
			openAiCompatibleApiKey: this.config?.summarizerOpenAiCompatibleApiKey || '',
			language: this.config?.summarizerLanguage || 'English',
			temperature: this.config?.summarizerTemperature,
			batchSize: this.config?.summarizerBatchSize ?? DEFAULT_CONFIG.summarizerBatchSize,
			concurrency: this.config?.summarizerConcurrency ?? DEFAULT_CONFIG.summarizerConcurrency,
			maxRetries: this.config?.summarizerMaxRetries ?? DEFAULT_CONFIG.summarizerMaxRetries,
			retryDelayMs: this.config?.summarizerRetryDelayMs ?? DEFAULT_CONFIG.summarizerRetryDelayMs
		};
	}

	/**
	 * Gets the current configuration status including validation issues
	 * @returns Object with ready status and validation issues
	 */
	public getStatus(): { ready: boolean; issues: import("./config-validator").ValidationIssue[] } {
		if (!this.config) {
			return {
				ready: false,
				issues: [
					{
						path: 'config',
						code: 'not_loaded',
						message: 'Configuration has not been loaded'
					}
				]
			}
		}

		const validationResult = ConfigValidator.validate(this.config)
		return {
			ready: validationResult.valid,
			issues: validationResult.issues
		}
	}
}
