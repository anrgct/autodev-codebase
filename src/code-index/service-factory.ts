import { OpenAiEmbedder } from "./embedders/openai"
import { CodeIndexOllamaEmbedder } from "./embedders/ollama"
import { OpenAICompatibleEmbedder } from "./embedders/openai-compatible"
import { GeminiEmbedder } from "./embedders/gemini"
import { MistralEmbedder } from "./embedders/mistral"
import { VercelAiGatewayEmbedder } from "./embedders/vercel-ai-gateway"
import { OpenRouterEmbedder } from "./embedders/openrouter"
import { EmbedderProvider, getDefaultModelId, getModelDimension } from "../shared/embeddingModels"
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "./processors"
import { ICodeParser, IEmbedder, ICodeFileWatcher, IVectorStore } from "./interfaces"
import { CodeIndexConfigManager } from "./config-manager"
import { CacheManager } from "./cache-manager"
import { Ignore } from "ignore"
import { IEventBus, IFileSystem, ILogger } from "../abstractions/core"
import { IWorkspace, IPathUtils } from "../abstractions/workspace"

// Hardcoded internationalization functions (replacing t() calls)
const t = (key: string, params?: Record<string, string>): string => {
	const translations: Record<string, string> = {
		"embeddings:serviceFactory.openAiConfigMissing": "OpenAI API key missing for embedder creation",
		"embeddings:serviceFactory.ollamaConfigMissing": "Ollama base URL missing for embedder creation",
		"embeddings:serviceFactory.openAiCompatibleConfigMissing": "OpenAI Compatible base URL and API key missing for embedder creation",
		"embeddings:serviceFactory.geminiConfigMissing": "Gemini API key missing for embedder creation",
		"embeddings:serviceFactory.mistralConfigMissing": "Mistral API key missing for embedder creation",
		"embeddings:serviceFactory.vercelAiGatewayConfigMissing": "Vercel AI Gateway API key missing for embedder creation",
		"embeddings:serviceFactory.openRouterConfigMissing": "OpenRouter API key missing for embedder creation",
		"embeddings:serviceFactory.invalidEmbedderType": "Invalid embedder type configured: {embedderProvider}",
		"embeddings:serviceFactory.vectorDimensionNotDetermined": "Could not determine vector dimension for model '{modelId}' with provider '{provider}'. Check model profiles or configuration.",
		"embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible": "Could not determine vector dimension for model '{modelId}' with provider '{provider}'. Please ensure the 'Embedding Dimension' is correctly set in the OpenAI-Compatible provider settings.",
		"embeddings:serviceFactory.qdrantUrlMissing": "Qdrant URL missing for vector store creation",
		"embeddings:serviceFactory.codeIndexingNotConfigured": "Cannot create services: Code indexing is not properly configured",
		"embeddings:validation.configurationError": "Embedder configuration validation failed",
	}

	let message = translations[key] || key
	if (params) {
		for (const [param, value] of Object.entries(params)) {
			message = message.replace(`{${param}}`, value)
		}
	}
	return message
}

/**
 * Factory class responsible for creating and configuring code indexing service dependencies.
 */
export class CodeIndexServiceFactory {
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly logger?: ILogger,
	) {}

	/**
	 * Logging helper methods - only log if logger is available
	 */
	private debug(message: string, ...args: any[]): void {
		this.logger?.debug(message, ...args)
	}

	private info(message: string, ...args: any[]): void {
		this.logger?.info(message, ...args)
	}

	private warn(message: string, ...args: any[]): void {
		this.logger?.warn(message, ...args)
	}

	private error(message: string, ...args: any[]): void {
		this.logger?.error(message, ...args)
	}

	/**
	 * Creates an embedder instance based on the current configuration.
	 */
	public createEmbedder(): IEmbedder {
		const config = this.configManager.getConfig()
		const provider = config.embedderProvider as EmbedderProvider

		if (provider === "openai") {
			const apiKey = config.openAiOptions?.openAiNativeApiKey

			if (!apiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiConfigMissing"))
			}
			return new OpenAiEmbedder({
				...config.openAiOptions,
				openAiEmbeddingModelId: config.modelId,
			})
		} else if (provider === "ollama") {
			if (!config.ollamaOptions?.ollamaBaseUrl) {
				throw new Error(t("embeddings:serviceFactory.ollamaConfigMissing"))
			}
			return new CodeIndexOllamaEmbedder({
				...config.ollamaOptions,
				ollamaModelId: config.modelId,
			})
		} else if (provider === "openai-compatible") {
			if (!config.openAiCompatibleOptions?.baseUrl || !config.openAiCompatibleOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiCompatibleConfigMissing"))
			}
			return new OpenAICompatibleEmbedder(
				config.openAiCompatibleOptions.baseUrl,
				config.openAiCompatibleOptions.apiKey,
				config.modelId,
			)
		} else if (provider === "gemini") {
			if (!config.geminiOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.geminiConfigMissing"))
			}
			return new GeminiEmbedder(config.geminiOptions.apiKey, config.modelId)
		} else if (provider === "mistral") {
			if (!config.mistralOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.mistralConfigMissing"))
			}
			return new MistralEmbedder(config.mistralOptions.apiKey, config.modelId)
		} else if (provider === "vercel-ai-gateway") {
			if (!config.vercelAiGatewayOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.vercelAiGatewayConfigMissing"))
			}
			return new VercelAiGatewayEmbedder(config.vercelAiGatewayOptions.apiKey, config.modelId)
		} else if (provider === "openrouter") {
			if (!config.openRouterOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.openRouterConfigMissing"))
			}
			return new OpenRouterEmbedder(config.openRouterOptions.apiKey, config.modelId)
		}

		throw new Error(
			t("embeddings:serviceFactory.invalidEmbedderType", { embedderProvider: config.embedderProvider }),
		)
	}

	/**
	 * Validates an embedder instance to ensure it's properly configured.
	 * @param embedder The embedder instance to validate
	 * @returns Promise resolving to validation result
	 */
	public async validateEmbedder(embedder: IEmbedder): Promise<{ valid: boolean; error?: string }> {
		try {
			return await embedder.validateConfiguration()
		} catch (error) {
			// If validation throws an exception, preserve the original error message
			return {
				valid: false,
				error: error instanceof Error ? error.message : t("embeddings:validation.configurationError"),
			}
		}
	}

	/**
	 * Creates a vector store instance using the current configuration.
	 */
	public createVectorStore(): IVectorStore {
		const config = this.configManager.getConfig()
		this.debug(`Debug createVectorStore config:`, JSON.stringify(config, null, 2))

		const provider = config.embedderProvider as EmbedderProvider
		const modelId = config.modelId ?? getDefaultModelId(provider)

		let vectorSize: number | undefined

		// First try to get the model-specific dimension from profiles
		vectorSize = getModelDimension(provider, modelId)

		// Only use manual dimension if model doesn't have a built-in dimension
		if (!vectorSize && config.modelDimension && config.modelDimension > 0) {
			vectorSize = config.modelDimension
		}

		if (vectorSize === undefined || vectorSize <= 0) {
			if (provider === "openai-compatible") {
				throw new Error(
					t("embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible", { modelId, provider }),
				)
			} else {
				throw new Error(t("embeddings:serviceFactory.vectorDimensionNotDetermined", { modelId, provider }))
			}
		}

		if (!config.qdrantUrl) {
			// This check remains important
			throw new Error(t("embeddings:serviceFactory.qdrantUrlMissing"))
		}

		// Assuming constructor is updated: new QdrantVectorStore(workspacePath, url, vectorSize, apiKey?)
		return new QdrantVectorStore(this.workspacePath, config.qdrantUrl, vectorSize, config.qdrantApiKey)
	}

	/**
	 * Creates a directory scanner instance with its required dependencies.
	 */
	public createDirectoryScanner(
		embedder: IEmbedder,
		vectorStore: IVectorStore,
		parser: ICodeParser,
		ignoreInstance: Ignore,
		fileSystem: IFileSystem,
		workspace: IWorkspace,
		pathUtils: IPathUtils
	): DirectoryScanner {
		return new DirectoryScanner({
			embedder,
			qdrantClient: vectorStore,
			codeParser: parser,
			cacheManager: this.cacheManager,
			ignoreInstance,
			fileSystem,
			workspace,
			pathUtils,
			logger: this.logger
		})
	}

	/**
	 * Creates a file watcher instance with its required dependencies.
	 */
	public createFileWatcher(
		fileSystem: IFileSystem,
		eventBus: IEventBus,
		workspace: IWorkspace,
		pathUtils: IPathUtils,
		embedder: IEmbedder,
		vectorStore: IVectorStore,
		cacheManager: CacheManager,
		ignoreInstance: Ignore,
	): ICodeFileWatcher {
		return new FileWatcher(this.workspacePath, fileSystem, eventBus, workspace, pathUtils, cacheManager, embedder, vectorStore, ignoreInstance)
	}

	/**
	 * Creates all required service dependencies if the service is properly configured.
	 * @throws Error if the service is not properly configured
	 */
	public async createServices(
		fileSystem: IFileSystem,
		eventBus: IEventBus,
		cacheManager: CacheManager,
		ignoreInstance: Ignore,
		workspace: IWorkspace,
		pathUtils: IPathUtils
	): Promise<{
		embedder: IEmbedder
		vectorStore: IVectorStore
		parser: ICodeParser
		scanner: DirectoryScanner
		fileWatcher: ICodeFileWatcher
	}> {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error(t("embeddings:serviceFactory.codeIndexingNotConfigured"))
		}

		const embedder = this.createEmbedder()
		const vectorStore = this.createVectorStore()
		const parser = codeParser
		const scanner = this.createDirectoryScanner(embedder, vectorStore, parser, ignoreInstance, fileSystem, workspace, pathUtils)
		const fileWatcher = this.createFileWatcher(fileSystem, eventBus, workspace, pathUtils, embedder, vectorStore, cacheManager, ignoreInstance)

		return {
			embedder,
			vectorStore,
			parser,
			scanner,
			fileWatcher,
		}
	}
}