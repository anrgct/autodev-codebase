import { OpenAiEmbedder } from "./embedders/openai"
import { CodeIndexOllamaEmbedder } from "./embedders/ollama"
import { OpenAICompatibleEmbedder } from "./embedders/openai-compatible"
import { GeminiEmbedder } from "./embedders/gemini"
import { MistralEmbedder } from "./embedders/mistral"
import { VercelAiGatewayEmbedder } from "./embedders/vercel-ai-gateway"
import { OpenRouterEmbedder } from "./embedders/openrouter"
import { JinaEmbedder } from "./embedders/jina-embedder"
import { LlamaCppEmbedder } from "./embedders/llamacpp"
import { LlamaCppLlmEmbedder } from "./embedders/llamacpp-llm"
import { OllamaLLMReranker } from "./rerankers/ollama"
import { OpenAICompatibleReranker } from "./rerankers/openai-compatible"
import { LlamaCppReranker } from "./rerankers/llamacpp-rerank"
import { LlamaCppLLMReranker } from "./rerankers/llamacpp-llm-rerank"
import { QRRankerReranker } from "./rerankers/qrranker"
import { SemanticHighlightReranker } from "./rerankers/semantic-highlight"
import { OllamaSummarizer } from "./summarizers/ollama"
import { OpenAICompatibleSummarizer } from "./summarizers/openai-compatible"
import { LlamaCppSummarizer } from "./summarizers/llamacpp"
import { SemanticHighlightHighlighter } from "./highlighters/semantic-highlight"
import { LlamaCppLLMHighlighter } from "./highlighters/llamacpp-llm"
import { QRRankerHighlighter } from "./highlighters/qrranker"
import { createHash } from "crypto"
import { QdrantClient } from "@qdrant/js-client-rest"
import { getLlama, LlamaModel, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import { EmbedderProvider, getDefaultModelId, getModelDimension } from "../shared/embeddingModels"
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "./processors"
import { ICodeParser, IEmbedder, ICodeFileWatcher, IVectorStore, IReranker, ISummarizer, IHighlighter } from "./interfaces"
import { CodeIndexConfig } from "./interfaces/config"
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
   * Shared LlamaCPP LLM model instance for reranker and summarizer.
   * Lazily loaded on first access, reused across the factory lifetime.
   */
  private _llamaCppLlmModel: LlamaModel | null = null

  private async _getOrCreateLlamaCppLlmModel(modelPath: string): Promise<LlamaModel> {
    if (this._llamaCppLlmModel) return this._llamaCppLlmModel
    const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
    this._llamaCppLlmModel = await llama.loadModel({ modelPath })
    return this._llamaCppLlmModel
  }

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
  } else if (provider === "jina") {
    const apiKey = config.embedderJinaApiKey
    if (!apiKey) {
      throw new Error(t("embeddings:serviceFactory.jinaConfigMissing"))
    }
    return new JinaEmbedder(
      apiKey,
      config.embedderModelId,
      { jinaBatchSize: config.embedderJinaBatchSize, jinaBaseUrl: config.embedderJinaBaseUrl },
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
    } else if (provider === "llamacpp") {
      if (!config.embedderGgufPath) {
        throw new Error("LlamaCPP model path missing for embedder creation")
      }
      return new LlamaCppEmbedder(
        config.embedderGgufPath,
        config.embedderLlamaCppGpuLayers,
        this.logger,
      )
    } else if (provider === "llamacpp-llm") {
      if (!config.embedderGgufLlmPath) {
        throw new Error("LLM GGUF model path missing for llamacpp-llm embedder creation")
      }
      return new LlamaCppLlmEmbedder(
        config.embedderGgufLlmPath,
        config.embedderLlamaCppGpuLayers,
        config.embedderConcurrency ?? 1,
        this.logger,
        config.embedderPoolingMode,
        config.embedderLlmInstructionPrefix,
        this._resolveIndexLayer(config),
        config.embedderUseChatTemplate,
      )
    }

    throw new Error(
      t("embeddings:serviceFactory.invalidEmbedderType", { embedderProvider: config.embedderProvider }),
    )
  }

  /**
   * Resolve index pooling layer: POOLING_LAYER env var > config.embedderPoolingLayer > "last"
   */
  private _resolveIndexLayer(config: Record<string, any>): "last" | number | string {
    return this._resolveLayerFromEnv("POOLING_LAYER") ?? config["embedderPoolingLayer"] ?? "last"
  }

  /**
   * Resolve query pooling layer: QUERY_POOLING_LAYER env var > config.embedderQueryPoolingLayer > config.embedderPoolingLayer > "last"
   */
  private _resolveQueryLayer(config: Record<string, any>): "last" | number | string {
    return this._resolveLayerFromEnv("QUERY_POOLING_LAYER") ?? config["embedderQueryPoolingLayer"] ?? config["embedderPoolingLayer"] ?? "last"
  }

  /**
   * Parse layer value from environment variable.
   * Supports: "last", "15", "-1", "2/3"
   */
  private _resolveLayerFromEnv(envName: string): "last" | number | string | null {
    if (typeof process === "undefined") return null
    const v = process.env[envName]
    if (!v) return null
    if (v === "last") return "last"
    const n = parseInt(v, 10)
    if (!isNaN(n)) return n
    if (/^\d+\/\d+$/.test(v)) return v
    return null
  }

  /**
   * Creates a query embedder instance with potentially different pooling layer.
   * For llamacpp-llm, uses _resolveQueryLayer() (QUERY_POOLING_LAYER env > config).
   * For all other providers, returns the same as createEmbedder().
   */
  public createQueryEmbedder(): IEmbedder {
    const config = this.configManager.getConfig()
    const provider = config.embedderProvider

    if (provider !== "llamacpp-llm") {
      return this.createEmbedder()
    }

    if (!config.embedderGgufLlmPath) {
      throw new Error("LLM GGUF model path missing for llamacpp-llm query embedder creation")
    }

    return new LlamaCppLlmEmbedder(
      config.embedderGgufLlmPath,
      config.embedderLlamaCppGpuLayers,
      config.embedderConcurrency ?? 1,
      this.logger,
      config.embedderPoolingMode,
      config.embedderLlmInstructionPrefix,
      this._resolveQueryLayer(config),
      config.embedderUseChatTemplate,
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
   * Vector dimension is determined via 3-layer fallback:
   * 1. Profile: EMBEDDING_MODEL_PROFILES
   * 2. Historical: existing Qdrant collection vector_size
   * 3. Auto-detect: embedder.createEmbeddings(["test"]) → length
   */
  /**
   * Derives a model ID from a GGUF file path by extracting the filename without extension.
   * This allows auto-matching against EMBEDDING_MODEL_PROFILES without manual config.
   * Example: "/path/to/bge-m3-Q8_0.gguf" → "bge-m3-Q8_0"
   */
  private _deriveModelIdFromGgufPath(modelPath: string): string | null {
    const basename = modelPath.split("/").pop() || modelPath
    const name = basename.replace(/\.gguf$/i, "")
    return name && name !== basename ? name : null
  }

  public async createVectorStore(existingEmbedder?: IEmbedder): Promise<IVectorStore> {
    const config = this.configManager.getConfig()
    this.debug(`Debug createVectorStore config:`, JSON.stringify(config, null, 2))

    const provider = config.embedderProvider as EmbedderProvider

    // For llamacpp/llamacpp-llm, derive modelId from GGUF path (it's the source of truth)
    // This avoids global config leaking embedderModelId from a different provider
    const modelId = provider === "llamacpp" && config.embedderGgufPath
      ? (this._deriveModelIdFromGgufPath(config.embedderGgufPath) ?? getDefaultModelId(provider))
      : provider === "llamacpp-llm" && config.embedderGgufLlmPath
        ? (this._deriveModelIdFromGgufPath(config.embedderGgufLlmPath) ?? getDefaultModelId(provider))
        : (config.embedderModelId ?? getDefaultModelId(provider))

    // Layer 1: Profile (zero overhead, from EMBEDDING_MODEL_PROFILES)
    let vectorSize = getModelDimension(provider, modelId)

    if (vectorSize === undefined || vectorSize <= 0) {
      // Get existing collection info once (used for Layer 2 and conflict check)
      const existingVectorSize = await this._getExistingVectorSize(config)

      // Layer 2: Historical from existing Qdrant collection
      if (existingVectorSize && existingVectorSize > 0) {
        // Verify the existing dimension matches what the embedder actually produces
        // This catches cases where the model was changed (e.g., different GGUF file)
        // but the Qdrant collection still has the old dimension
        const embedder = existingEmbedder ?? this.createEmbedder()
        const needDispose = !existingEmbedder
        try {
          const detectedSize = await this._detectVectorDimension(embedder)

          if (detectedSize && detectedSize > 0 && detectedSize !== existingVectorSize) {
            this.warn(
              `[VectorStore] Existing collection has dimension ${existingVectorSize}, but current model produces ${detectedSize}. ` +
              `Using ${detectedSize} (collection will be recreated on initialize).`,
            )
            vectorSize = detectedSize
          } else {
            vectorSize = existingVectorSize
            this.info(`[VectorStore] Using existing collection vector size: ${vectorSize}`)
          }
        } finally {
          if (needDispose) await embedder.dispose?.()
        }
      } else {
        // Layer 3: Auto-detect via embedder
        const embedder = existingEmbedder ?? this.createEmbedder()
        const needDispose = !existingEmbedder
        try {
          vectorSize = await this._detectVectorDimension(embedder)
        } finally {
          if (needDispose) await embedder.dispose?.()
        }

        // Check for dimension conflict if collection exists with different size
        if (vectorSize && vectorSize > 0 && existingVectorSize && existingVectorSize > 0
          && existingVectorSize !== vectorSize) {
          throw new Error(
            t("embeddings:serviceFactory.vectorDimensionConflict", {
              existingSize: String(existingVectorSize),
              newSize: String(vectorSize),
            }),
          )
        }
      }
    }

    // Manual override (kept for backward compatibility)
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
      throw new Error(t("embeddings:serviceFactory.qdrantUrlMissing"))
    }

    return new QdrantVectorStore(this.workspacePath, config.qdrantUrl, vectorSize, config.qdrantApiKey, this.logger)
  }

  /**
   * Layer 2: Check existing Qdrant collection for vector dimension.
   */
  private async _getExistingVectorSize(config: CodeIndexConfig): Promise<number | undefined> {
    if (!config.qdrantUrl) return undefined

    try {
      const client = new QdrantClient({ url: config.qdrantUrl, apiKey: config.qdrantApiKey })
      const hash = createHash("sha256").update(this.workspacePath).digest("hex")
      const collectionName = `ws-${hash.substring(0, 16)}`

      const collectionInfo = await client.getCollection(collectionName)
      if (!collectionInfo) return undefined

      const vectorsConfig = collectionInfo.config?.params?.vectors
      let existingSize: number | undefined

      if (typeof vectorsConfig === "number") {
        existingSize = vectorsConfig
      } else if (vectorsConfig && typeof vectorsConfig === "object" && "size" in vectorsConfig) {
        existingSize = (vectorsConfig as any).size as number
      }

      return existingSize && existingSize > 0 ? existingSize : undefined
    } catch (error) {
      this.debug(`[VectorStore] Could not get existing collection info:`, error)
      return undefined
    }
  }

  /**
   * Layer 3: Auto-detect vector dimension by embedding a test text.
   */
  private async _detectVectorDimension(embedder: IEmbedder): Promise<number | undefined> {
    try {
      this.info(`[VectorStore] Auto-detecting vector dimension...`)
      const response = await embedder.createEmbeddings(["test dimension detection"])
      if (!response) return undefined
      const embeddings = response.embeddings

      if (embeddings && embeddings.length > 0 && embeddings[0].length > 0) {
        const dimension = embeddings[0].length
        this.info(`[VectorStore] Auto-detected vector dimension: ${dimension}`)
        return dimension
      }
    } catch (error) {
      this.warn(`[VectorStore] Could not auto-detect vector dimension:`, error)
    }

    return undefined
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
    queryEmbedder: IEmbedder
    vectorStore: IVectorStore
    parser: ICodeParser
    scanner: DirectoryScanner
    fileWatcher: ICodeFileWatcher
  }> {
    if (!this.configManager.isFeatureConfigured) {
      throw new Error(t("embeddings:serviceFactory.codeIndexingNotConfigured"))
    }

    const provider = this.configManager.getConfig().embedderProvider

    // 先创建 embedder，这样 createVectorStore() 做维度检测时可以直接复用，
    // 避免本地模型（llamacpp/llamacpp-llm）重复加载多份实例。
    const embedder = this.createEmbedder()
    const vectorStore = await this.createVectorStore(embedder)

    // 所有使用本地 GGUF 模型的 provider，query embedder 直接复用文档 embedder。
    // createQueryEmbedder() 对非 llamacpp-llm 会再调一次 createEmbedder() 新建实例，
    // 对于本地模型是纯浪费（即使模型很小）。API 类 provider（ollama/openai 等）没有
    // 本地资源消耗，想一视同仁复用也行，语义上它们本就是同一个接口。
    const localProviders = ["llamacpp", "llamacpp-llm"]
    const queryEmbedder = localProviders.includes(provider) ? embedder : this.createQueryEmbedder()
    const parser = codeParser
    const scanner = this.createDirectoryScanner(embedder, vectorStore, parser, fileSystem, workspace, pathUtils)
    const fileWatcher = this.createFileWatcher(fileSystem, eventBus, workspace, pathUtils, embedder, vectorStore, cacheManager)

    return {
      embedder,
      queryEmbedder,
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
  public async createReranker(): Promise<IReranker | undefined> {
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

    if (config.provider === 'qrranker') {
      const qrrankerPath = config.ggufQrrankerPath || config.ggufPath
      if (!qrrankerPath) {
        this.warn("Reranker is enabled with qrranker provider but rerankerGgufQrrankerPath is not configured")
        return undefined
      }
      return new QRRankerReranker(
        qrrankerPath,
        this.logger,
        config.batchSize || 10,
        config.concurrency || 2,
        config.maxRetries || 2,
        config.retryDelayMs || 1000,
      )
    }

    if (config.provider === 'semantic-highlight' && config.ggufPath) {
      return new SemanticHighlightReranker(
        config.ggufPath,
        this.logger,
      )
    }

    if (config.provider === 'llamacpp') {
      // Dedicated reranker model path → cross-encoder rerank mode (or server mode)
      if (config.ggufPath) {
        return new LlamaCppReranker(
          config.ggufPath,
          config.llamaCppServer === true,
          config.llamaCppServerBinPath || "",
          this.logger
        )
      }

      this.warn("Reranker is enabled with llamacpp provider but rerankerGgufPath is not configured")
      return undefined
    }

    if (config.provider === 'llamacpp-llm') {
      // LLM model path → chat-based rerank mode
      if (!config.ggufLlmPath) {
        this.warn("Reranker is enabled with llamacpp-llm provider but rerankerGgufLlmPath is not configured")
        return undefined
      }
      const model = await this._getOrCreateLlamaCppLlmModel(config.ggufLlmPath)
      return new LlamaCppLLMReranker(
        model,
        this.logger,
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
  public async createSummarizer(): Promise<ISummarizer> {
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

    if (config.provider === 'llamacpp') {
      if (!config.llamaCppModelPath) {
        throw new Error("LlamaCPP model path missing for summarizer creation")
      }
      const model = await this._getOrCreateLlamaCppLlmModel(config.llamaCppModelPath)
      return new LlamaCppSummarizer(
        model,
        config.language || 'English',
        config.temperature ?? 0,
        this.logger,
        config.concurrency ?? 2,
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

  /**
   * Creates a highlighter instance based on the current configuration.
   * @returns IHighlighter instance or undefined if highlighter is disabled
   */
  public createHighlighter(): IHighlighter | undefined {
    const config = this.configManager.highlighterConfig
    if (!config.enabled) {
      return undefined
    }

    const provider = config.provider ?? "semantic-highlight"

    if (provider === "llamacpp-llm") {
      if (!config.ggufLlmPath) {
        this.warn("Highlighter is enabled with llamacpp-llm provider but highlighterGgufLlmPath is not configured")
        return undefined
      }
      // Model is loaded lazily on first highlight() call
      return new LlamaCppLLMHighlighter(
        config.ggufLlmPath,
        config.topK ?? 20,
        this.logger,
        config.mode ?? "topk",
        config.threshold ?? 0.5,
      )
    }

    if (provider === "qrranker") {
      if (!config.ggufQrrankerPath) {
        this.warn("Highlighter is enabled with qrranker provider but highlighterGgufQrrankerPath is not configured")
        return undefined
      }
      // Model is loaded lazily on first highlight() call (independent of reranker)
      return new QRRankerHighlighter(
        config.ggufQrrankerPath,
        config.topK ?? 20,
        this.logger,
        config.mode ?? "topk",
        config.threshold ?? 0.5,
      )
    }

    // Default: semantic-highlight (dedicated model)
    if (!config.ggufPath) {
      this.warn("Highlighter is enabled but highlighterGgufPath is not configured")
      return undefined
    }

    return new SemanticHighlightHighlighter(
      config.ggufPath,
      config.topK ?? 20,
      this.logger,
      config.mode ?? "topk",
      config.threshold ?? 0.5,
    )
  }

  /**
   * Validates the highlighter configuration.
   */
  public async validateHighlighter(highlighter: IHighlighter): Promise<{ valid: boolean; error?: string }> {
    try {
      return await highlighter.validateConfiguration()
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Highlighter validation failed'
      }
    }
  }
}
