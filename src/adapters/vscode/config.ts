import * as vscode from 'vscode'
import { IConfigProvider, VectorStoreConfig, SearchConfig, CodeIndexConfig, ConfigSnapshot } from '../../abstractions/config'
import { EmbedderConfig, OllamaEmbedderConfig, OpenAIEmbedderConfig, OpenAICompatibleEmbedderConfig } from '../../code-index/interfaces/config'

/**
 * VSCode configuration adapter implementing IConfigProvider interface
 */
export class VSCodeConfigProvider implements IConfigProvider {
  constructor(
    private readonly workspace: typeof vscode.workspace = vscode.workspace,
    private readonly configSection: string = 'autodev'
  ) {}

  async getEmbedderConfig(): Promise<EmbedderConfig> {
    const config = this.workspace.getConfiguration(this.configSection)
    const provider = config.get<string>('embedder.provider', 'openai')

    switch (provider) {
      case 'ollama':
        return config.get<OllamaEmbedderConfig>('embedder', {
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimension: 768,
          baseUrl: 'http://localhost:11434',
        })
      case 'openai-compatible':
        return config.get<OpenAICompatibleEmbedderConfig>('embedder', {
          provider: 'openai-compatible',
          model: 'text-embedding-3-small',
          dimension: 1536,
          baseUrl: '',
          apiKey: '',
        })
      case 'openai':
      default:
        return config.get<OpenAIEmbedderConfig>('embedder', {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimension: 1536,
          apiKey: '',
        })
    }
  }

  async getVectorStoreConfig(): Promise<VectorStoreConfig> {
    const config = this.workspace.getConfiguration(this.configSection)
    
    return {
      qdrantUrl: config.get<string>('vectorStore.qdrant.url'),
      qdrantApiKey: config.get<string>('vectorStore.qdrant.apiKey')
    }
  }

  isCodeIndexEnabled(): boolean {
    const config = this.workspace.getConfiguration(this.configSection)
    return config.get<boolean>('codeIndex.enabled', false)
  }

  async getSearchConfig(): Promise<SearchConfig> {
    const config = this.workspace.getConfiguration(this.configSection)
    
    return {
      minScore: config.get<number>('search.minScore', 0.5),
      maxResults: config.get<number>('search.maxResults', 10)
    }
  }

  async getConfig(): Promise<CodeIndexConfig> {
    return this.getFullConfig()
  }

  onConfigChange(callback: (config: CodeIndexConfig) => void): () => void {
    const disposable = this.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(this.configSection)) {
        const config = await this.getFullConfig()
        callback(config)
      }
    })

    return () => disposable.dispose()
  }

  /**
   * Get complete configuration object
   */
  async getFullConfig(): Promise<CodeIndexConfig> {
    const [embedderConfig, vectorStoreConfig, searchConfig] = await Promise.all([
      this.getEmbedderConfig(),
      this.getVectorStoreConfig(),
      this.getSearchConfig()
    ])

    const isConfigured = this.isConfigured(embedderConfig, vectorStoreConfig)

      // Convert from specific embedder config to generic CodeIndexConfig structure
    const embedderProvider = embedderConfig.provider
    let configData: any = {
      isEnabled: this.isCodeIndexEnabled(),
      isConfigured,
      embedderProvider,
      modelId: embedderConfig.model,
      modelDimension: embedderConfig.dimension,
      qdrantUrl: vectorStoreConfig.qdrantUrl,
      qdrantApiKey: vectorStoreConfig.qdrantApiKey,
      searchMinScore: searchConfig.minScore
    }

    // Add provider-specific options
    switch (embedderProvider) {
      case 'openai':
        configData.openAiOptions = {
          openAiNativeApiKey: (embedderConfig as OpenAIEmbedderConfig).apiKey
        }
        break
      case 'ollama':
        configData.ollamaOptions = {
          ollamaBaseUrl: (embedderConfig as OllamaEmbedderConfig).baseUrl
        }
        break
      case 'openai-compatible':
        const compatibleConfig = embedderConfig as OpenAICompatibleEmbedderConfig
        configData.openAiCompatibleOptions = {
          baseUrl: compatibleConfig.baseUrl,
          apiKey: compatibleConfig.apiKey
        }
        break
    }

    return configData
  }

  /**
   * Create configuration snapshot for restart detection
   */
  async getConfigSnapshot(): Promise<ConfigSnapshot> {
    const config = await this.getFullConfig()

    const snapshot: ConfigSnapshot = {
      enabled: config.isEnabled,
      configured: config.isConfigured,
      embedderProvider: config.embedderProvider,
      modelId: config.modelId,
      dimension: config.modelDimension,
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey
    }

    if (config.embedderProvider === 'openai') {
      snapshot.openAiKey = config.openAiOptions?.openAiNativeApiKey
    } else if (config.embedderProvider === 'ollama') {
      snapshot.ollamaBaseUrl = config.ollamaOptions?.ollamaBaseUrl
    } else if (config.embedderProvider === 'openai-compatible') {
      snapshot.openAiCompatibleBaseUrl = config.openAiCompatibleOptions?.baseUrl
      snapshot.openAiCompatibleApiKey = config.openAiCompatibleOptions?.apiKey
      snapshot.openAiCompatibleModelDimension = config.modelDimension
    }

    return snapshot
  }

  private isConfigured(embedderConfig: EmbedderConfig, vectorStoreConfig: VectorStoreConfig): boolean {
    // Check if embedder is configured
    const embedderConfigured = this.isEmbedderConfigured(embedderConfig)
    
    // Check if vector store is configured (if using external vector store)
    const vectorStoreConfigured = !!vectorStoreConfig.qdrantUrl
    
    return embedderConfigured && vectorStoreConfigured
  }

  private isEmbedderConfigured(config: EmbedderConfig): boolean {
    switch (config.provider) {
      case 'openai':
        return !!(config as OpenAIEmbedderConfig).apiKey
      case 'ollama':
        return !!(config as OllamaEmbedderConfig).baseUrl
      case 'openai-compatible':
        const compatibleConfig = config as OpenAICompatibleEmbedderConfig
        return !!(compatibleConfig.baseUrl && compatibleConfig.apiKey)
      default:
        return false
    }
  }
}
