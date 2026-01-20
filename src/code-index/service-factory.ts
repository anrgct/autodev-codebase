import { OpenAiEmbedder } from "./embedders/openai"
import { CodeIndexOllamaEmbedder } from "./embedders/ollama"
import { OpenAICompatibleEmbedder } from "./embedders/openai-compatible"
import { GeminiEmbedder } from "./embedders/gemini"
import { MistralEmbedder } from "./embedders/mistral"
import { VercelAiGatewayEmbedder } from "./embedders/vercel-ai-gateway"
import { OpenRouterEmbedder } from "./embedders/openrouter"
import { OllamaLLMReranker } from "./rerankers/ollama"
import { OpenAICompatibleReranker } from "./rerankers/openai-compatible"
import { OllamaSummarizer } from "./summarizers/ollama"
import { OpenAICompatibleSummarizer } from "./summarizers/openai-compatible"
import { EmbedderProvider, getDefaultModelId, getModelDimension } from "../shared/embeddingModels"
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "./processors"
import { ICodeParser, IEmbedder, ICodeFileWatcher, IVectorStore, IReranker, ISummarizer } from "./interfaces"
import { CodeIndexConfigManager } from "./config-manager"
import { CacheManager } from "./cache-manager"
import { IEventBus, IFileSystem } from "../abstractions/core"
import { IWorkspace, IPathUtils } from "../abstractions/workspace"
import { Logger } from "../utils/logger"
import { t } from "./i18n"

// Type-compatible logger interface using Pick to extract only required methods from Logger
type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/**
 * Factory class responsible for creating and configuring code indexing service dependencies.
 */
export class CodeIndexServiceFactory {
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly logger?: LoggerLike,
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
			const apiKey = config.embedderOpenAiApiKey

			if (!apiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiConfigMissing"))
			}
			return new OpenAiEmbedder({
				openAiNativeApiKey: apiKey,
				openAiEmbeddingModelId: config.embedderModelId,
				openAiBatchSize: config.embedderOpenAiBatchSize,
			})
		} else if (provider === "ollama") {
			if (!config.embedderOllamaBaseUrl) {
				throw new Error(t("embeddings:serviceFactory.ollamaConfigMissing"))
			}
			return new CodeIndexOllamaEmbedder({
				ollamaBaseUrl: config.embedderOllamaBaseUrl,
				ollamaModelId: config.embedderModelId,
				ollamaBatchSize: config.embedderOllamaBatchSize,
			})
		} else if (provider === "openai-compatible") {
			if (!config.embedderOpenAiCompatibleBaseUrl || !config.embedderOpenAiCompatibleApiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiCompatibleConfigMissing"))
			}
			return new OpenAICompatibleEmbedder(
				config.embedderOpenAiCompatibleBaseUrl,
				config.embedderOpenAiCompatibleApiKey,
				config.embedderModelId,
			)
		} else if (provider === "gemini") {
			if (!config.embedderGeminiApiKey) {
				throw new Error(t("embeddings:serviceFactory.geminiConfigMissing"))
			}
			return new GeminiEmbedder(config.embedderGeminiApiKey, config.embedderModelId)
		} else if (provider === "mistral") {
			if (!config.embedderMistralApiKey) {
				throw new Error(t("embeddings:serviceFactory.mistralConfigMissing"))
			}
			return new MistralEmbedder(config.embedderMistralApiKey, config.embedderModelId)
		} else if (provider === "vercel-ai-gateway") {
			if (!config.embedderVercelAiGatewayApiKey) {
				throw new Error(t("embeddings:serviceFactory.vercelAiGatewayConfigMissing"))
			}
			return new VercelAiGatewayEmbedder(config.embedderVercelAiGatewayApiKey, config.embedderModelId)
		} else if (provider === "openrouter") {
			if (!config.embedderOpenRouterApiKey) {
				throw new Error(t("embeddings:serviceFactory.openRouterConfigMissing"))
			}
			return new OpenRouterEmbedder(config.embedderOpenRouterApiKey, config.embedderModelId)
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
		const modelId = config.embedderModelId ?? getDefaultModelId(provider)

		let vectorSize: number | undefined

		// First try to get the model-specific dimension from profiles
		vectorSize = getModelDimension(provider, modelId)

		// Only use manual dimension if model doesn't have a built-in dimension
		if (!vectorSize && config.embedderModelDimension && config.embedderModelDimension > 0) {
			vectorSize = config.embedderModelDimension
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
		fileSystem: IFileSystem,
		workspace: IWorkspace,
		pathUtils: IPathUtils
	): DirectoryScanner {
		return new DirectoryScanner({
			embedder,
			qdrantClient: vectorStore,
			codeParser: parser,
			cacheManager: this.cacheManager,
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
	): ICodeFileWatcher {
		return new FileWatcher(this.workspacePath, fileSystem, eventBus, workspace, pathUtils, cacheManager, embedder, vectorStore)
	}

	/**
	 * Creates all required service dependencies if the service is properly configured.
	 * @throws Error if the service is not properly configured
	 */
	public async createServices(
		fileSystem: IFileSystem,
		eventBus: IEventBus,
		cacheManager: CacheManager,
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
		const scanner = this.createDirectoryScanner(embedder, vectorStore, parser, fileSystem, workspace, pathUtils)
		const fileWatcher = this.createFileWatcher(fileSystem, eventBus, workspace, pathUtils, embedder, vectorStore, cacheManager)

		return {
			embedder,
			vectorStore,
			parser,
			scanner,
			fileWatcher,
		}
	}

	/**
	 * Creates a reranker instance based on the current configuration.
	 * @returns IReranker instance or undefined if reranker is disabled
	 */
	public createReranker(): IReranker | undefined {
		const config = this.configManager.rerankerConfig
		if (!config || !config.enabled) {
			return undefined
		}

		if (config.provider === 'ollama') {
			return new OllamaLLMReranker(
				config.ollamaBaseUrl || 'http://localhost:11434',
				config.ollamaModelId || 'qwen3-vl:4b-instruct',
				config.batchSize || 10,
				config.concurrency || 3,
				config.maxRetries || 3,
				config.retryDelayMs || 1000
			)
		}

		if (config.provider === 'openai-compatible') {
			return new OpenAICompatibleReranker(
				config.openAiCompatibleBaseUrl || 'http://localhost:8080/v1',
				config.openAiCompatibleModelId || 'gpt-4',
				config.openAiCompatibleApiKey || '',
				config.batchSize || 10,
				config.concurrency || 3,
				config.maxRetries || 3,
				config.retryDelayMs || 1000
			)
		}

		// If provider is undefined or unknown, return undefined
		return undefined
	}

	/**
	 * Validates a reranker instance to ensure it's properly configured.
	 * @param reranker The reranker instance to validate
	 * @returns Promise resolving to validation result
	 */
	public async validateReranker(reranker: IReranker): Promise<{ valid: boolean; error?: string }> {
		try {
			return await reranker.validateConfiguration()
		} catch (error) {
			// If validation throws an exception, preserve the original error message
			return {
				valid: false,
				error: error instanceof Error ? error.message : t("embeddings:serviceFactory.rerankerValidationError"),
			}
		}
	}

	/**
	 * Creates a summarizer instance based on the current configuration.
	 * @returns ISummarizer instance (always returns an instance, configuration is validated when used)
	 */
	public createSummarizer(): ISummarizer {
		const config = this.configManager.summarizerConfig;

		if (config.provider === 'ollama') {
			return new OllamaSummarizer(
				config.ollamaBaseUrl || 'http://localhost:11434',
				config.ollamaModelId || 'qwen3-vl:4b-instruct',
				config.language || 'English',
				config.temperature ?? 0
			)
		}

		if (config.provider === 'openai-compatible') {
			return new OpenAICompatibleSummarizer(
				config.openAiCompatibleBaseUrl || 'http://localhost:8080/v1',
				config.openAiCompatibleModelId || 'gpt-4',
				config.openAiCompatibleApiKey || '',
				config.language || 'English',
				config.temperature ?? 0
			)
		}

		// Fallback to ollama if provider unknown
		return new OllamaSummarizer(
			'http://localhost:11434',
			'qwen3-vl:4b-instruct',
			'English'
		);
	}

	/**
	 * Validates a summarizer instance
	 * @param summarizer The summarizer instance to validate
	 * @returns Promise resolving to validation result
	 */
	public async validateSummarizer(summarizer: ISummarizer): Promise<{ valid: boolean; error?: string }> {
		try {
			return await summarizer.validateConfiguration()
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : 'Summarizer validation failed'
			}
		}
	}
}
