import { EmbedderProvider } from "./interfaces/manager"
import { CodeIndexConfig, PreviousConfigSnapshot } from "./interfaces/config"
import { DEFAULT_SEARCH_MIN_SCORE, DEFAULT_MAX_SEARCH_RESULTS } from "./constants"
import { getDefaultModelId, getModelDimension, getModelScoreThreshold } from "../shared/embeddingModels"

/**
 * Local configuration provider interface for CodeIndexConfigManager.
 * This is different from the IConfigProvider in abstractions/config.ts.
 * It provides lower-level access to global state and secrets storage.
 */
export interface ICodeIndexConfigProvider {
  getGlobalState(key: string): any
  getSecret(key: string): Promise<string>
  refreshSecrets(): Promise<void>
}

/**
 * Manages configuration state and validation for the code indexing feature.
 * Handles loading, validating, and providing access to configuration values.
 */
export class CodeIndexConfigManager {
	private codebaseIndexEnabled: boolean = true
	private embedderProvider: EmbedderProvider = "openai"
	private modelId?: string
	private modelDimension?: number
	private openAiOptions?: { openAiNativeApiKey: string }
	private ollamaOptions?: { ollamaBaseUrl: string }
	private openAiCompatibleOptions?: { baseUrl: string; apiKey: string }
	private geminiOptions?: { apiKey: string }
	private mistralOptions?: { apiKey: string }
	private vercelAiGatewayOptions?: { apiKey: string }
	private openRouterOptions?: { apiKey: string }
	private qdrantUrl?: string = "http://localhost:6333"
	private qdrantApiKey?: string
	private searchMinScore?: number
	private searchMaxResults?: number

	constructor(private readonly configProvider: ICodeIndexConfigProvider) {
		// Initialize with current configuration to avoid false restart triggers
		// Note: This is async but constructor can't be async, so we'll initialize asynchronously
		this._loadAndSetConfiguration().catch(console.error)
	}

	/**
	 * Gets the context proxy instance
	 */
	public getConfigProvider(): ICodeIndexConfigProvider {
		return this.configProvider
	}

	/**
	 * Private method that handles loading configuration from storage and updating instance variables.
	 * This eliminates code duplication between initializeWithCurrentConfig() and loadConfiguration().
	 */
	private async _loadAndSetConfiguration(): Promise<void> {
		// Load configuration from storage
		const codebaseIndexConfig = this.configProvider.getGlobalState("codebaseIndexConfig") ?? {
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai",
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMinScore: undefined,
			codebaseIndexSearchMaxResults: undefined,
		}

		const {
			codebaseIndexEnabled,
			codebaseIndexQdrantUrl,
			codebaseIndexEmbedderProvider,
			codebaseIndexEmbedderBaseUrl,
			codebaseIndexEmbedderModelId,
			codebaseIndexSearchMinScore,
			codebaseIndexSearchMaxResults,
		} = codebaseIndexConfig

		const openAiKey = (await this.configProvider.getSecret("codeIndexOpenAiKey")) ?? ""
		const qdrantApiKey = (await this.configProvider.getSecret("codeIndexQdrantApiKey")) ?? ""
		// Fix: Read OpenAI Compatible settings from the correct location within codebaseIndexConfig
		const openAiCompatibleBaseUrl = codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl ?? ""
		const openAiCompatibleApiKey =
			(await this.configProvider.getSecret("codebaseIndexOpenAiCompatibleApiKey")) ?? ""
		const geminiApiKey = (await this.configProvider.getSecret("codebaseIndexGeminiApiKey")) ?? ""
		const mistralApiKey = (await this.configProvider.getSecret("codebaseIndexMistralApiKey")) ?? ""
		const vercelAiGatewayApiKey =
			(await this.configProvider.getSecret("codebaseIndexVercelAiGatewayApiKey")) ?? ""
		const openRouterApiKey = (await this.configProvider.getSecret("codebaseIndexOpenRouterApiKey")) ?? ""

		// Update instance variables with configuration
		this.codebaseIndexEnabled = codebaseIndexEnabled ?? true
		this.qdrantUrl = codebaseIndexQdrantUrl
		this.qdrantApiKey = qdrantApiKey ?? ""
		this.searchMinScore = codebaseIndexSearchMinScore
		this.searchMaxResults = codebaseIndexSearchMaxResults

		// Validate and set model dimension
		const rawDimension = codebaseIndexConfig.codebaseIndexEmbedderModelDimension
		if (rawDimension !== undefined && rawDimension != null) {
			const dimension = Number(rawDimension)
			if (!isNaN(dimension) && dimension > 0) {
				this.modelDimension = dimension
			} else {
				console.warn(
					`Invalid codebaseIndexEmbedderModelDimension value: ${rawDimension}. Must be a positive number.`,
				)
				this.modelDimension = undefined
			}
		} else {
			this.modelDimension = undefined
		}

		this.openAiOptions = { openAiNativeApiKey: openAiKey }

		// Set embedder provider with support for openai-compatible
		if (codebaseIndexEmbedderProvider === "ollama") {
			this.embedderProvider = "ollama"
		} else if (codebaseIndexEmbedderProvider === "openai-compatible") {
			this.embedderProvider = "openai-compatible"
		} else if (codebaseIndexEmbedderProvider === "gemini") {
			this.embedderProvider = "gemini"
		} else if (codebaseIndexEmbedderProvider === "mistral") {
			this.embedderProvider = "mistral"
		} else if (codebaseIndexEmbedderProvider === "vercel-ai-gateway") {
			this.embedderProvider = "vercel-ai-gateway"
		} else if (codebaseIndexEmbedderProvider === "openrouter") {
			this.embedderProvider = "openrouter"
		} else {
			this.embedderProvider = "openai"
		}

		// Set model ID
		this.modelId = codebaseIndexEmbedderModelId || undefined

		if (this.embedderProvider === "ollama") {
			this.ollamaOptions = codebaseIndexEmbedderBaseUrl
				? { ollamaBaseUrl: codebaseIndexEmbedderBaseUrl }
				: undefined
			this.openAiCompatibleOptions = undefined
		} else if (this.embedderProvider === "openai-compatible") {
			this.ollamaOptions = undefined
			this.openAiCompatibleOptions = openAiCompatibleBaseUrl
				? {
						baseUrl: openAiCompatibleBaseUrl,
						apiKey: openAiCompatibleApiKey,
					}
				: undefined

			this.geminiOptions = geminiApiKey ? { apiKey: geminiApiKey } : undefined
			this.mistralOptions = mistralApiKey ? { apiKey: mistralApiKey } : undefined
			this.vercelAiGatewayOptions = vercelAiGatewayApiKey ? { apiKey: vercelAiGatewayApiKey } : undefined
			this.openRouterOptions = openRouterApiKey ? { apiKey: openRouterApiKey } : undefined
		}
	}

	/**
	 * Initialize the config manager and load initial configuration
	 */
	public async initialize(): Promise<void> {
		await this.loadConfiguration()
	}

	/**
	 * Loads persisted configuration from globalState.
	 */
	public async loadConfiguration(): Promise<{
		configSnapshot: PreviousConfigSnapshot
		currentConfig: {
			isEnabled: boolean
			isConfigured: boolean
			embedderProvider: EmbedderProvider
			modelId?: string
			modelDimension?: number
			openAiOptions?: { openAiNativeApiKey: string }
			ollamaOptions?: { ollamaBaseUrl: string }
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
		requiresRestart: boolean
	}> {
		// Capture the ACTUAL previous state before loading new configuration
		const previousConfigSnapshot: PreviousConfigSnapshot = {
			enabled: this.codebaseIndexEnabled,
			configured: this.isConfigured(),
			embedderProvider: this.embedderProvider,
			modelId: this.modelId,
			modelDimension: this.modelDimension,
			openAiKey: this.openAiOptions?.openAiNativeApiKey ?? "",
			ollamaBaseUrl: this.ollamaOptions?.ollamaBaseUrl ?? "",
			openAiCompatibleBaseUrl: this.openAiCompatibleOptions?.baseUrl ?? "",
			openAiCompatibleApiKey: this.openAiCompatibleOptions?.apiKey ?? "",
			geminiApiKey: this.geminiOptions?.apiKey ?? "",
			mistralApiKey: this.mistralOptions?.apiKey ?? "",
			vercelAiGatewayApiKey: this.vercelAiGatewayOptions?.apiKey ?? "",
			openRouterApiKey: this.openRouterOptions?.apiKey ?? "",
			qdrantUrl: this.qdrantUrl ?? "",
			qdrantApiKey: this.qdrantApiKey ?? "",
		}

		// Refresh secrets from VSCode storage to ensure we have the latest values
		// await this.configProvider.refreshSecrets()

		// Load new configuration from storage and update instance variables
		await this._loadAndSetConfiguration()

		const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)

		return {
			configSnapshot: previousConfigSnapshot,
			currentConfig: {
				isEnabled: this.codebaseIndexEnabled,
				isConfigured: this.isConfigured(),
				embedderProvider: this.embedderProvider,
				modelId: this.modelId,
				modelDimension: this.modelDimension,
				openAiOptions: this.openAiOptions,
				ollamaOptions: this.ollamaOptions,
				openAiCompatibleOptions: this.openAiCompatibleOptions,
				geminiOptions: this.geminiOptions,
				mistralOptions: this.mistralOptions,
				vercelAiGatewayOptions: this.vercelAiGatewayOptions,
				openRouterOptions: this.openRouterOptions,
				qdrantUrl: this.qdrantUrl,
				qdrantApiKey: this.qdrantApiKey,
				searchMinScore: this.currentSearchMinScore,
				searchMaxResults: this.currentSearchMaxResults,
			},
			requiresRestart,
		}
	}

	/**
	 * Checks if the service is properly configured based on the embedder type.
	 */
	public isConfigured(): boolean {
		if (this.embedderProvider === "openai") {
			const openAiKey = this.openAiOptions?.openAiNativeApiKey
			const qdrantUrl = this.qdrantUrl
			return !!(openAiKey && qdrantUrl)
		} else if (this.embedderProvider === "ollama") {
			// Ollama model ID has a default, so only base URL is strictly required for config
			const ollamaBaseUrl = this.ollamaOptions?.ollamaBaseUrl
			const qdrantUrl = this.qdrantUrl
			return !!(ollamaBaseUrl && qdrantUrl)
		} else if (this.embedderProvider === "openai-compatible") {
			const baseUrl = this.openAiCompatibleOptions?.baseUrl
			const apiKey = this.openAiCompatibleOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(baseUrl && apiKey && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "gemini") {
			const apiKey = this.geminiOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(apiKey && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "mistral") {
			const apiKey = this.mistralOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(apiKey && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "vercel-ai-gateway") {
			const apiKey = this.vercelAiGatewayOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(apiKey && qdrantUrl)
			return isConfigured
		} else if (this.embedderProvider === "openrouter") {
			const apiKey = this.openRouterOptions?.apiKey
			const qdrantUrl = this.qdrantUrl
			const isConfigured = !!(apiKey && qdrantUrl)
			return isConfigured
		}
		return false // Should not happen if embedderProvider is always set correctly
	}

	/**
	 * Determines if a configuration change requires restarting the indexing process.
	 * Simplified logic: only restart for critical changes that affect service functionality.
	 *
	 * CRITICAL CHANGES (require restart):
	 * - Provider changes (openai -> ollama, etc.)
	 * - Authentication changes (API keys, base URLs)
	 * - Vector dimension changes (model changes that affect embedding size)
	 * - Qdrant connection changes (URL, API key)
	 * - Feature enable/disable transitions
	 *
	 * MINOR CHANGES (no restart needed):
	 * - Search minimum score adjustments
	 * - UI-only settings
	 * - Non-functional configuration tweaks
	 */
	doesConfigChangeRequireRestart(prev: PreviousConfigSnapshot): boolean {
		const nowConfigured = this.isConfigured()

		// Handle null/undefined values safely
		const prevEnabled = prev?.enabled ?? false
		const prevConfigured = prev?.configured ?? false
		const prevProvider = prev?.embedderProvider ?? "openai"
		const prevModelId = prev?.modelId ?? undefined
		const prevOpenAiKey = prev?.openAiKey ?? ""
		const prevOllamaBaseUrl = prev?.ollamaBaseUrl ?? ""
		const prevOpenAiCompatibleBaseUrl = prev?.openAiCompatibleBaseUrl ?? ""
		const prevOpenAiCompatibleApiKey = prev?.openAiCompatibleApiKey ?? ""
		const prevModelDimension = prev?.modelDimension
		const prevGeminiApiKey = prev?.geminiApiKey ?? ""
		const prevMistralApiKey = prev?.mistralApiKey ?? ""
		const prevVercelAiGatewayApiKey = prev?.vercelAiGatewayApiKey ?? ""
		const prevOpenRouterApiKey = prev?.openRouterApiKey ?? ""
		const prevQdrantUrl = prev?.qdrantUrl ?? ""
		const prevQdrantApiKey = prev?.qdrantApiKey ?? ""

		// 1. Transition from disabled/unconfigured to enabled/configured
		if ((!prevEnabled || !prevConfigured) && this.codebaseIndexEnabled && nowConfigured) {
			return true
		}

		// 2. Transition from enabled to disabled
		if (prevEnabled && !this.codebaseIndexEnabled) {
			return true
		}

		// 3. If wasn't ready before and isn't ready now, no restart needed
		if ((!prevEnabled || !prevConfigured) && (!this.codebaseIndexEnabled || !nowConfigured)) {
			return false
		}

		// 4. CRITICAL CHANGES - Always restart for these
		// Only check for critical changes if feature is enabled
		if (!this.codebaseIndexEnabled) {
			return false
		}

		// Provider change
		if (prevProvider !== this.embedderProvider) {
			return true
		}

		// Authentication changes (API keys)
		const currentOpenAiKey = this.openAiOptions?.openAiNativeApiKey ?? ""
		const currentOllamaBaseUrl = this.ollamaOptions?.ollamaBaseUrl ?? ""
		const currentOpenAiCompatibleBaseUrl = this.openAiCompatibleOptions?.baseUrl ?? ""
		const currentOpenAiCompatibleApiKey = this.openAiCompatibleOptions?.apiKey ?? ""
		const currentModelDimension = this.modelDimension
		const currentGeminiApiKey = this.geminiOptions?.apiKey ?? ""
		const currentMistralApiKey = this.mistralOptions?.apiKey ?? ""
		const currentVercelAiGatewayApiKey = this.vercelAiGatewayOptions?.apiKey ?? ""
		const currentOpenRouterApiKey = this.openRouterOptions?.apiKey ?? ""
		const currentQdrantUrl = this.qdrantUrl ?? ""
		const currentQdrantApiKey = this.qdrantApiKey ?? ""

		if (prevOpenAiKey !== currentOpenAiKey) {
			return true
		}

		if (prevOllamaBaseUrl !== currentOllamaBaseUrl) {
			return true
		}

		if (
			prevOpenAiCompatibleBaseUrl !== currentOpenAiCompatibleBaseUrl ||
			prevOpenAiCompatibleApiKey !== currentOpenAiCompatibleApiKey
		) {
			return true
		}

		if (prevGeminiApiKey !== currentGeminiApiKey) {
			return true
		}

		if (prevMistralApiKey !== currentMistralApiKey) {
			return true
		}

		if (prevVercelAiGatewayApiKey !== currentVercelAiGatewayApiKey) {
			return true
		}

		if (prevOpenRouterApiKey !== currentOpenRouterApiKey) {
			return true
		}

		// Check for model dimension changes (generic for all providers)
		if (prevModelDimension !== currentModelDimension) {
			return true
		}

		if (prevQdrantUrl !== currentQdrantUrl || prevQdrantApiKey !== currentQdrantApiKey) {
			return true
		}

		// Vector dimension changes (still important for compatibility)
		if (this._hasVectorDimensionChanged(prevProvider, prev?.modelId)) {
			return true
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
	public getConfig(): CodeIndexConfig {
		return {
			isEnabled: this.codebaseIndexEnabled,
			isConfigured: this.isConfigured(),
			embedderProvider: this.embedderProvider,
			modelId: this.modelId,
			modelDimension: this.modelDimension,
			openAiOptions: this.openAiOptions,
			ollamaOptions: this.ollamaOptions,
			openAiCompatibleOptions: this.openAiCompatibleOptions,
			geminiOptions: this.geminiOptions,
			mistralOptions: this.mistralOptions,
			vercelAiGatewayOptions: this.vercelAiGatewayOptions,
			openRouterOptions: this.openRouterOptions,
			qdrantUrl: this.qdrantUrl,
			qdrantApiKey: this.qdrantApiKey,
			searchMinScore: this.currentSearchMinScore,
			searchMaxResults: this.currentSearchMaxResults,
		}
	}

	/**
	 * Gets whether the code indexing feature is enabled
	 */
	public get isFeatureEnabled(): boolean {
		return this.codebaseIndexEnabled
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
		return this.embedderProvider
	}

	/**
	 * Gets the current model ID being used for embeddings.
	 */
	public get currentModelId(): string | undefined {
		return this.modelId
	}

	/**
	 * Gets the current model dimension being used for embeddings.
	 * Returns the model's built-in dimension if available, otherwise falls back to custom dimension.
	 */
	public get currentModelDimension(): number | undefined {
		// First try to get the model-specific dimension
		const modelId = this.modelId ?? getDefaultModelId(this.embedderProvider)
		const modelDimension = getModelDimension(this.embedderProvider, modelId)

		// Only use custom dimension if model doesn't have a built-in dimension
		if (!modelDimension && this.modelDimension && this.modelDimension > 0) {
			return this.modelDimension
		}

		return modelDimension
	}

	/**
	 * Gets the configured minimum search score based on user setting, model-specific threshold, or fallback.
	 * Priority: 1) User setting, 2) Model-specific threshold, 3) Default DEFAULT_SEARCH_MIN_SCORE constant.
	 */
	public get currentSearchMinScore(): number {
		// First check if user has configured a custom score threshold
		if (this.searchMinScore !== undefined) {
			return this.searchMinScore
		}

		// Fall back to model-specific threshold
		const currentModelId = this.modelId ?? getDefaultModelId(this.embedderProvider)
		const modelSpecificThreshold = getModelScoreThreshold(this.embedderProvider, currentModelId)
		return modelSpecificThreshold ?? DEFAULT_SEARCH_MIN_SCORE
	}

	/**
	 * Gets the configured maximum search results.
	 * Returns user setting if configured, otherwise returns default.
	 */
	public get currentSearchMaxResults(): number {
		return this.searchMaxResults ?? DEFAULT_MAX_SEARCH_RESULTS
	}
}
