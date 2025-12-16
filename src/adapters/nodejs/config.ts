/**
 * Node.js Config Provider Adapter
 * Implements IConfigProvider using JSON configuration files
 */
import * as path from 'path'
import * as os from 'os'
import * as jsoncParser from 'jsonc-parser'
import { IConfigProvider, EmbedderConfig, VectorStoreConfig, SearchConfig } from '../../abstractions/config'
import { CodeIndexConfig, OllamaEmbedderConfig } from '../../code-index/interfaces/config'
import { EmbedderProvider } from '../../code-index/interfaces/manager'
import { IFileSystem, IEventBus } from '../../abstractions/core'

export interface NodeConfigOptions {
  configPath?: string
  globalConfigPath?: string
  defaultConfig?: Partial<CodeIndexConfig>
}

// Default configuration constants
const DEFAULT_CONFIG: CodeIndexConfig = {
  isEnabled: true,
  embedderProvider: "ollama",
  embedderModelId: "qwen3-embedding:0.6b",
  embedderModelDimension: 1024,
  embedderOllamaBaseUrl: "http://localhost:11434",
  qdrantUrl: "http://localhost:6333",
  vectorSearchMinScore: 0.1,
  vectorSearchMaxResults: 20,
  rerankerEnabled: false,
  rerankerProvider: "none"
}


export class NodeConfigProvider implements IConfigProvider {
  private configPath: string
  private globalConfigPath: string
  private config: CodeIndexConfig | null = null
  private configLoaded: boolean = false
  private changeCallbacks: Array<(config: CodeIndexConfig) => void> = []

  constructor(
    private fileSystem: IFileSystem,
    private eventBus: IEventBus,
    options: NodeConfigOptions = {}
  ) {
    this.configPath = options.configPath || './autodev-config.json'
    this.globalConfigPath = options.globalConfigPath || path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')

    // Set default configuration
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.defaultConfig
    }
  }

  async getEmbedderConfig(): Promise<EmbedderConfig> {
    const config = await this.ensureConfigLoaded()
    // Convert new config structure to legacy format for compatibility
    if (config.embedderProvider === "openai") {
      return {
        provider: "openai",
        model: config.embedderModelId || "text-embedding-ada-002",
        dimension: config.embedderModelDimension || 1536,
        apiKey: config.embedderOpenAiApiKey || ""
      }
    } else if (config.embedderProvider === "ollama") {
      return {
        provider: "ollama",
        model: config.embedderModelId || "nomic-embed-text",
        dimension: config.embedderModelDimension || 768,
        baseUrl: config.embedderOllamaBaseUrl || "http://localhost:11434"
      }
    } else if (config.embedderProvider === "openai-compatible") {
      return {
        provider: "openai-compatible",
        model: config.embedderModelId || "text-embedding-ada-002",
        dimension: config.embedderModelDimension || 1536,
        baseUrl: config.embedderOpenAiCompatibleBaseUrl || "",
        apiKey: config.embedderOpenAiCompatibleApiKey || ""
      }
    }

    // Fallback
    return {
      provider: "ollama",
      model: DEFAULT_CONFIG.embedderModelId || "nomic-embed-text",
      dimension: DEFAULT_CONFIG.embedderModelDimension || 768,
      baseUrl: DEFAULT_CONFIG.embedderOllamaBaseUrl || "http://localhost:11434"
    }
  }

  async getVectorStoreConfig(): Promise<VectorStoreConfig> {
    const config = await this.ensureConfigLoaded()
    return {
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey
    }
  }

  isCodeIndexEnabled(): boolean {
    return this.config?.isEnabled || false
  }

  async getSearchConfig(): Promise<SearchConfig> {
    const config = await this.ensureConfigLoaded()
    return {
      minScore: config.vectorSearchMinScore,
      maxResults: config.vectorSearchMaxResults ?? 50 // Use config value or default to 50
    }
  }

  async getConfig(): Promise<CodeIndexConfig> {
    return this.ensureConfigLoaded()
  }

  onConfigChange(callback: (config: CodeIndexConfig) => void): () => void {
    this.changeCallbacks.push(callback)

    // Return unsubscribe function
    return () => {
      const index = this.changeCallbacks.indexOf(callback)
      if (index > -1) {
        this.changeCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * Ensure configuration is loaded (with caching)
   */
  private async ensureConfigLoaded(): Promise<CodeIndexConfig> {
    if (!this.configLoaded) {
      await this.loadConfig()
    }
    return this.config!
  }

  /**
   * Force reload configuration from files (bypasses cache)
   */
  async reloadConfig(): Promise<CodeIndexConfig> {
    this.configLoaded = false
    return this.loadConfig()
  }

  /**
   * Load configuration from file with global config support
   */
  async loadConfig(): Promise<CodeIndexConfig> {
    // Start with default configuration
    this.config = { ...DEFAULT_CONFIG }

    // 1. Load global configuration if it exists
    try {
      if (await this.fileSystem.exists(this.globalConfigPath)) {
        const globalContent = await this.fileSystem.readFile(this.globalConfigPath)
        const globalText = new TextDecoder().decode(globalContent)
        const globalConfig = jsoncParser.parse(globalText)

        // Merge global config with defaults
        this.config = {
          ...this.config,
          ...globalConfig
        }
        // console.log(`Global config loaded from: ${this.globalConfigPath}`)
      }
    } catch (error) {
      console.warn(`Failed to load global config from ${this.globalConfigPath}:`, error)
    }

    // 2. Load project configuration if it exists
    try {
      if (await this.fileSystem.exists(this.configPath)) {
        const projectContent = await this.fileSystem.readFile(this.configPath)
        const projectText = new TextDecoder().decode(projectContent)
        const projectConfig = jsoncParser.parse(projectText)

        // Merge project config with global config
        this.config = {
          ...this.config,
          ...projectConfig
        }
        // console.log(`Project config loaded from: ${this.configPath}`)
      }
    } catch (error) {
      console.warn(`Failed to load project config from ${this.configPath}:`, error)
    }

    // Mark as loaded to enable caching
    this.configLoaded = true

    return this.config || { ...DEFAULT_CONFIG }
  }


  /**
   * Save configuration to file
   */
  async saveConfig(config: Partial<CodeIndexConfig>): Promise<void> {
    try {
      const newConfig: CodeIndexConfig = {
        ...DEFAULT_CONFIG,
        ...this.config,
        ...config
      }
      const content = JSON.stringify(newConfig, null, 2)
      const encoded = new TextEncoder().encode(content)

      await this.fileSystem.writeFile(this.configPath, encoded)
      this.config = newConfig
      this.configLoaded = true // Mark as loaded since we just set it

      // Notify listeners
      this.changeCallbacks.forEach(callback => {
        try {
          callback(newConfig)
        } catch (error) {
          console.error('Error in config change callback:', error)
        }
      })

      // Emit event
      this.eventBus.emit('config:changed', newConfig)

    } catch (error) {
      throw new Error(`Failed to save config to ${this.configPath}: ${error}`)
    }
  }

  /**
   * Update a specific configuration value
   */
  async updateConfig<K extends keyof CodeIndexConfig>(
    key: K,
    value: CodeIndexConfig[K]
  ): Promise<void> {
    await this.saveConfig({ [key]: value })
  }

  /**
   * Reset configuration to defaults
   */
  async resetConfig(): Promise<void> {
    await this.saveConfig({ ...DEFAULT_CONFIG })
  }

  /**
   * Get the current configuration without reloading
   */
  getCurrentConfig(): CodeIndexConfig | null {
    return this.config
  }

  /**
   * Check if the configuration is complete based on the embedder provider
   */
  private isConfigured(): boolean {
    if (!this.config) {
      return false
    }

    const { embedderProvider, qdrantUrl } = this.config

    // Check embedder configuration
    if (embedderProvider === "openai") {
      if (!this.config.embedderOpenAiApiKey || !this.config.embedderModelId) {
        return false
      }
    } else if (embedderProvider === "ollama") {
      if (!this.config.embedderOllamaBaseUrl || !this.config.embedderModelId) {
        return false
      }
    } else if (embedderProvider === "openai-compatible") {
      if (!this.config.embedderOpenAiCompatibleBaseUrl ||
          !this.config.embedderOpenAiCompatibleApiKey ||
          !this.config.embedderModelId) {
        return false
      }
    }

    // Check Qdrant configuration
    if (!qdrantUrl) {
      return false
    }

    return true
  }

  /**
   * Validate configuration completeness
   */
  async validateConfig(): Promise<{ isValid: boolean; errors: string[] }> {
    const config = await this.ensureConfigLoaded()
    const errors: string[] = []

    if (!config.isEnabled) {
      return { isValid: true, errors: [] } // Disabled config is valid
    }

    // Validate embedder configuration
    const { embedderProvider } = config
    switch (embedderProvider) {
      case "openai":
        if (!config.embedderOpenAiApiKey) {
          errors.push('OpenAI API key is required')
        }
        if (!config.embedderModelId) {
          errors.push('OpenAI model is required')
        }
        if (!config.embedderModelDimension || config.embedderModelDimension <= 0) {
          errors.push('OpenAI model dimension is required and must be positive')
        }
        break
      case "ollama":
        if (!config.embedderOllamaBaseUrl) {
          errors.push('Ollama base URL is required')
        }
        if (!config.embedderModelId) {
          errors.push('Ollama model is required')
        }
        if (!config.embedderModelDimension || config.embedderModelDimension <= 0) {
          errors.push('Ollama model dimension is required and must be positive')
        }
        break
      case "openai-compatible":
        if (!config.embedderOpenAiCompatibleBaseUrl) {
          errors.push('OpenAI Compatible base URL is required')
        }
        if (!config.embedderOpenAiCompatibleApiKey) {
          errors.push('OpenAI Compatible API key is required')
        }
        if (!config.embedderModelId) {
          errors.push('OpenAI Compatible model is required')
        }
        if (!config.embedderModelDimension || config.embedderModelDimension <= 0) {
          errors.push('OpenAI Compatible model dimension is required and must be positive')
        }
        break
    }

    // Validate vector store configuration
    if (!config.qdrantUrl) {
      errors.push('Qdrant URL is required')
    }

    return {
      isValid: errors.length === 0,
      errors
    }
  }
}
