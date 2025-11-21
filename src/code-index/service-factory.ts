import { OpenAiEmbedder } from "./embedders/openai"
import { CodeIndexOllamaEmbedder } from "./embedders/ollama"
import { OpenAICompatibleEmbedder } from "./embedders/openai-compatible"
import { EmbedderProvider, getDefaultModelId, getModelDimension } from "../shared/embeddingModels"
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "./processors"
import { ICodeParser, IEmbedder, ICodeFileWatcher, IVectorStore } from "./interfaces"
import { CodeIndexConfigManager } from "./config-manager"
import { CacheManager } from "./cache-manager"
import { Ignore } from "ignore"
import { IEventBus, IFileSystem, ILogger } from "../abstractions/core"
import { IWorkspace, IPathUtils } from "../abstractions/workspace"

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
	public async createEmbedder(): Promise<IEmbedder> {
		const config = await this.configManager.getConfig()
		const embedderConfig = config.embedder

		if (embedderConfig.provider === "openai") {
			if (!embedderConfig.apiKey) {
				throw new Error("OpenAI API key missing for embedder creation")
			}
			return new OpenAiEmbedder({
				openAiNativeApiKey: embedderConfig.apiKey,
				openAiEmbeddingModelId: embedderConfig.model,
			})
		} else if (embedderConfig.provider === "ollama") {
			if (!embedderConfig.baseUrl) {
				throw new Error("Ollama base URL missing for embedder creation")
			}
			return new CodeIndexOllamaEmbedder({
				ollamaBaseUrl: embedderConfig.baseUrl,
				ollamaModelId: embedderConfig.model,
				apiKey: embedderConfig.apiKey,  // Pass the API key if available
			})
		} else if (embedderConfig.provider === "openai-compatible") {
			if (!embedderConfig.baseUrl || !embedderConfig.apiKey) {
				throw new Error("OpenAI Compatible base URL and API key missing for embedder creation")
			}
			return new OpenAICompatibleEmbedder(
				embedderConfig.baseUrl,
				embedderConfig.apiKey,
				embedderConfig.model,
			)
		}

		throw new Error(`Invalid embedder provider configured: ${(embedderConfig as any)?.provider}`)
	}

	/**
	 * Creates a vector store instance using the current configuration.
	 */
	public async createVectorStore(): Promise<IVectorStore> {
		const config = await this.configManager.getConfig()
		this.debug(`Debug createVectorStore config:`, JSON.stringify(config, null, 2))

		const embedderConfig = config.embedder
		const vectorSize = embedderConfig.dimension

		this.debug(`Debug: provider=${embedderConfig.provider}, model=${embedderConfig.model}, dimension=${vectorSize}`)

		if (!vectorSize || vectorSize <= 0) {
			throw new Error(`Invalid vector dimension '${vectorSize}' for model '${embedderConfig.model}' with provider '${embedderConfig.provider}'. Please specify a valid dimension in the configuration.`)
		}

		if (!config.qdrantUrl) {
			// This check remains important
			throw new Error("Qdrant URL missing for vector store creation")
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
			throw new Error("Cannot create services: Code indexing is not properly configured")
		}

		const embedder = await this.createEmbedder()
		const vectorStore = await this.createVectorStore()
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
