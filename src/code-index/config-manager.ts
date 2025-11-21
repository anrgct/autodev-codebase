import { EmbedderProvider } from "./interfaces/manager"
import { CodeIndexConfig, EmbedderConfig as NewEmbedderConfig } from "./interfaces/config"
import { SEARCH_MIN_SCORE } from "./constants"
import { getDefaultModelId, getModelDimension } from "../shared/embeddingModels"
import {
	IConfigProvider,
	EmbedderConfig,
	VectorStoreConfig,
	SearchConfig,
	ConfigSnapshot,
	ApiHandlerOptions
} from "../abstractions/config"

/**
 * Manages configuration state and validation for the code indexing feature.
 * Handles loading, validating, and providing access to configuration values.
 */
export class CodeIndexConfigManager {
	private isEnabled: boolean = false
	private embedderProvider: EmbedderProvider = "openai"
	private modelId?: string
	private openAiOptions?: ApiHandlerOptions
	private ollamaOptions?: ApiHandlerOptions
	private ollamaApiKey?: string
	private openAiCompatibleOptions?: { baseUrl: string; apiKey: string; modelDimension?: number }
	private qdrantUrl?: string = "http://localhost:6333"
	private qdrantApiKey?: string
	private searchMinScore?: number

	constructor(private readonly configProvider: IConfigProvider) {
		// Initialize with current configuration to avoid false restart triggers
		// Note: initialization will be done async via initialize() method
	}

	/**
	 * Initialize the configuration manager asynchronously
	 */
	public async initialize(): Promise<void> {
		await this._loadAndSetConfiguration()
	}

	/**
	 * Private method that handles loading configuration from storage and updating instance variables.
	 * Now uses the new unified configuration structure.
	 */
	private async _loadAndSetConfiguration(): Promise<void> {
		// Load configuration using the new unified config structure
		const config = await this.configProvider.getConfig()

		// Update instance variables with configuration
		this.isEnabled = config.isEnabled
		
		// Convert new embedder config to legacy internal state for compatibility
		if (config.embedder.provider === "openai") {
			this.embedderProvider = "openai"
			this.modelId = config.embedder.model
			this.openAiOptions = {
				apiKey: config.embedder.apiKey,
				openAiNativeApiKey: config.embedder.apiKey
			}
			this.ollamaOptions = undefined
			this.openAiCompatibleOptions = undefined
		} else if (config.embedder.provider === "ollama") {
			this.embedderProvider = "ollama"
			this.modelId = config.embedder.model
			this.ollamaOptions = {
				ollamaBaseUrl: config.embedder.baseUrl
			}
			// Store the API key separately for Ollama
			this.ollamaApiKey = config.embedder.apiKey
			this.openAiOptions = undefined
			this.openAiCompatibleOptions = undefined
		} else if (config.embedder.provider === "openai-compatible") {
			this.embedderProvider = "openai-compatible"
			this.modelId = config.embedder.model
			this.openAiCompatibleOptions = {
				baseUrl: config.embedder.baseUrl,
				apiKey: config.embedder.apiKey,
				modelDimension: config.embedder.dimension
			}
			this.openAiOptions = undefined
			this.ollamaOptions = undefined
		}

		// Vector store configuration
		this.qdrantUrl = config.qdrantUrl ?? "http://localhost:6333"
		this.qdrantApiKey = config.qdrantApiKey ?? ""

		// Search configuration
		this.searchMinScore = config.searchMinScore ?? SEARCH_MIN_SCORE
	}

	/**
	 * Loads persisted configuration from globalState.
	 */
	public async loadConfiguration(): Promise<{
		configSnapshot: ConfigSnapshot
		currentConfig: {
			isEnabled: boolean
			isConfigured: boolean
			embedderProvider: EmbedderProvider
			modelId?: string
			openAiOptions?: ApiHandlerOptions
			ollamaOptions?: ApiHandlerOptions
			openAiCompatibleOptions?: { baseUrl: string; apiKey: string }
			qdrantUrl?: string
			qdrantApiKey?: string
			searchMinScore?: number
		}
		requiresRestart: boolean
	}> {
		// Capture the ACTUAL previous state before loading new configuration
		const previousConfigSnapshot: ConfigSnapshot = {
			enabled: this.isEnabled,
			configured: this.isConfigured(),
			embedderProvider: this.embedderProvider,
			modelId: this.modelId,
			openAiKey: this.openAiOptions?.apiKey ?? "",
			ollamaBaseUrl: this.ollamaOptions?.ollamaBaseUrl ?? "",
			ollamaApiKey: this.ollamaApiKey ?? "",
			openAiCompatibleBaseUrl: this.openAiCompatibleOptions?.baseUrl ?? "",
			openAiCompatibleApiKey: this.openAiCompatibleOptions?.apiKey ?? "",
			openAiCompatibleModelDimension: this.openAiCompatibleOptions?.modelDimension,
			qdrantUrl: this.qdrantUrl ?? "",
			qdrantApiKey: this.qdrantApiKey ?? "",
		}

		// Load new configuration from storage and update instance variables
		await this._loadAndSetConfiguration()

		const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)

		return {
			configSnapshot: previousConfigSnapshot,
			currentConfig: {
				isEnabled: this.isEnabled,
				isConfigured: this.isConfigured(),
				embedderProvider: this.embedderProvider,
				modelId: this.modelId,
				openAiOptions: this.openAiOptions,
				ollamaOptions: this.ollamaOptions,
				openAiCompatibleOptions: this.openAiCompatibleOptions,
				qdrantUrl: this.qdrantUrl,
				qdrantApiKey: this.qdrantApiKey,
				searchMinScore: this.searchMinScore,
			},
			requiresRestart,
		}
	}

	/**
	 * Checks if the service is properly configured based on the embedder type.
	 */
	public isConfigured(): boolean {
		if (this.embedderProvider === "openai") {
			const openAiKey = this.openAiOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(openAiKey && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "ollama") {
			// Ollama model ID has a default, and we may have an API key
			const ollamaBaseUrl = this.ollamaOptions?.ollamaBaseUrl
			const qdrantUrl = this.qdrantUrl
			// API key is optional for Ollama, so only base URL and qdrant URL are required
			const isConfigured = !!(ollamaBaseUrl && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "openai-compatible") {
			const baseUrl = this.openAiCompatibleOptions?.baseUrl
			const apiKey = this.openAiCompatibleOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			return !!(baseUrl && apiKey && qdrantUrl)
		}
		return false // Should not happen if embedderProvider is always set correctly
	}

	/**
	 * Determines if a configuration change requires restarting the indexing process.
	 */
	doesConfigChangeRequireRestart(prev: ConfigSnapshot): boolean {
		const nowConfigured = this.isConfigured()

		// Handle null/undefined values safely - use empty strings for consistency with loaded config
		const prevEnabled = prev?.enabled ?? false
		const prevConfigured = prev?.configured ?? false
		const prevProvider = prev?.embedderProvider ?? "openai"
		const prevModelId = prev?.modelId ?? undefined
		const prevOpenAiKey = prev?.openAiKey ?? ""
		const prevOllamaBaseUrl = prev?.ollamaBaseUrl ?? ""
		const prevOpenAiCompatibleBaseUrl = prev?.openAiCompatibleBaseUrl ?? ""
		const prevOpenAiCompatibleApiKey = prev?.openAiCompatibleApiKey ?? ""
		const prevOpenAiCompatibleModelDimension = prev?.openAiCompatibleModelDimension
		const prevQdrantUrl = prev?.qdrantUrl ?? ""
		const prevQdrantApiKey = prev?.qdrantApiKey ?? ""

		// 1. Transition from disabled/unconfigured to enabled+configured
		if ((!prevEnabled || !prevConfigured) && this.isEnabled && nowConfigured) {
			return true
		}

		// 2. If was disabled and still is, no restart needed
		if (!prevEnabled && !this.isEnabled) {
			return false
		}

		// 3. If wasn't ready before and isn't ready now, no restart needed
		if (!prevConfigured && !nowConfigured) {
			return false
		}

		// 4. Check for changes in relevant settings if the feature is enabled (or was enabled)
		if (this.isEnabled || prevEnabled) {
			// Provider change
			if (prevProvider !== this.embedderProvider) {
				return true
			}

			if (this._hasVectorDimensionChanged(prevProvider, prevModelId)) {
				return true
			}

			// Authentication changes
			if (this.embedderProvider === "openai") {
				const currentOpenAiKey = this.openAiOptions?.apiKey ?? ""
				if (prevOpenAiKey !== currentOpenAiKey) {
					return true
				}
			}

			if (this.embedderProvider === "ollama") {
				const currentOllamaBaseUrl = this.ollamaOptions?.ollamaBaseUrl ?? ""
				const currentOllamaApiKey = this.ollamaApiKey ?? ""
				if (
					prevOllamaBaseUrl !== currentOllamaBaseUrl ||
					prev.ollamaApiKey !== currentOllamaApiKey
				) {
					return true
				}
			}

			if (this.embedderProvider === "openai-compatible") {
				const currentOpenAiCompatibleBaseUrl = this.openAiCompatibleOptions?.baseUrl ?? ""
				const currentOpenAiCompatibleApiKey = this.openAiCompatibleOptions?.apiKey ?? ""
				const currentOpenAiCompatibleModelDimension = this.openAiCompatibleOptions?.modelDimension
				if (
					prevOpenAiCompatibleBaseUrl !== currentOpenAiCompatibleBaseUrl ||
					prevOpenAiCompatibleApiKey !== currentOpenAiCompatibleApiKey ||
					prevOpenAiCompatibleModelDimension !== currentOpenAiCompatibleModelDimension
				) {
					return true
				}
			}

			// Qdrant configuration changes
			const currentQdrantUrl = this.qdrantUrl ?? ""
			const currentQdrantApiKey = this.qdrantApiKey ?? ""

			if (prevQdrantUrl !== currentQdrantUrl || prevQdrantApiKey !== currentQdrantApiKey) {
				return true
			}
		}

		return false
	}

	/**
	 * Checks if model changes result in vector dimension changes that require restart.
	 */
	private _hasVectorDimensionChanged(prevProvider: EmbedderProvider, prevModelId?: string): boolean {
		const currentProvider = this.embedderProvider
		const currentModelId = this.modelId ?? getDefaultModelId(currentProvider)
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
	public async getConfig(): Promise<CodeIndexConfig> {
		// Load the latest configuration from the provider to get accurate dimension values
		const config = await this.configProvider.getConfig()
		return config
	}

	/**
	 * Gets whether the code indexing feature is enabled
	 */
	public get isFeatureEnabled(): boolean {
		return this.isEnabled
	}

	/**
	 * Gets whether the code indexing feature is properly configured
	 */
	public get isFeatureConfigured(): boolean {
		return this.isConfigured()
	}

	/**
	 * Gets the current embedder type (openai or ollama)
	 */
	public get currentEmbedderProvider(): EmbedderProvider {
		return this.embedderProvider
	}

	/**
	 * Gets the current Qdrant configuration
	 */
	public get qdrantConfig(): { url?: string; apiKey?: string } {
		return {
			url: this.qdrantUrl,
			apiKey: this.qdrantApiKey,
		}
	}

	/**
	 * Gets the current model ID being used for embeddings.
	 */
	public get currentModelId(): string | undefined {
		return this.modelId
	}

	/**
	 * Gets the configured minimum search score.
	 */
	public get currentSearchMinScore(): number | undefined {
		return this.searchMinScore
	}
}
