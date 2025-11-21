/**
 * Node.js Config Provider Adapter
 * Implements IConfigProvider using JSON configuration files
 */
import * as path from 'path'
import * as os from 'os'
import { IConfigProvider, EmbedderConfig, VectorStoreConfig, SearchConfig } from '../../abstractions/config'
import { CodeIndexConfig, OllamaEmbedderConfig } from '../../code-index/interfaces/config'
import { EmbedderProvider } from '../../code-index/interfaces/manager'
import { IFileSystem, IEventBus } from '../../abstractions/core'

export interface NodeConfigOptions {
  configPath?: string
  globalConfigPath?: string
  defaultConfig?: Partial<CodeIndexConfig>
  cliOverrides?: {
    ollamaUrl?: string
    ollamaApiKey?: string
    model?: string
    qdrantUrl?: string
    qdrantApiKey?: string
  }
}

// Default configuration constants
const DEFAULT_CONFIG: CodeIndexConfig = {
  isEnabled: true,
  isConfigured: true,
  embedder: {
    provider: "ollama",
    model: "dengcao/Qwen3-Embedding-0.6B:Q8_0",
    dimension: 1024,
    baseUrl: "http://localhost:11434",
  }
}


export class NodeConfigProvider implements IConfigProvider {
  private configPath: string
  private globalConfigPath: string
  private config: CodeIndexConfig | null = null
  private configLoaded: boolean = false
  private changeCallbacks: Array<(config: CodeIndexConfig) => void> = []
  private cliOverrides: NodeConfigOptions['cliOverrides']

  constructor(
    private fileSystem: IFileSystem,
    private eventBus: IEventBus,
    options: NodeConfigOptions = {}
  ) {
    this.configPath = options.configPath || './autodev-config.json'
    this.globalConfigPath = options.globalConfigPath || path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')
    this.cliOverrides = options.cliOverrides

    // Set default configuration
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.defaultConfig
    }
  }

  async getEmbedderConfig(): Promise<EmbedderConfig> {
    const config = await this.ensureConfigLoaded()
    // Convert new config structure to legacy format for compatibility
    if (config.embedder.provider === "openai") {
      return {
        provider: "openai",
        modelId: config.embedder.model,
        openAiOptions: {
          apiKey: config.embedder.apiKey,
          openAiNativeApiKey: config.embedder.apiKey
        }
      }
    } else if (config.embedder.provider === "ollama") {
      return {
        provider: "ollama",
        modelId: config.embedder.model,
        ollamaOptions: {
          ollamaBaseUrl: config.embedder.baseUrl,
          apiKey: config.embedder.apiKey
        }
      }
    } else if (config.embedder.provider === "openai-compatible") {
      return {
        provider: "openai-compatible",
        modelId: config.embedder.model,
        openAiCompatibleOptions: {
          baseUrl: config.embedder.baseUrl,
          apiKey: config.embedder.apiKey,
          modelDimension: config.embedder.dimension
        }
      }
    }
    
    // Fallback
    return {
      provider: "ollama",
      modelId: DEFAULT_CONFIG.embedder.model
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
      minScore: config.searchMinScore,
      maxResults: 50 // Default max results
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
        const globalConfig = JSON.parse(globalText)
        
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
        const projectConfig = JSON.parse(projectText)

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

    // 3. Apply CLI overrides (highest priority)
    if (this.cliOverrides && this.config) {
      if (this.cliOverrides.ollamaUrl && 'baseUrl' in this.config.embedder) {
        this.config.embedder.baseUrl = this.cliOverrides.ollamaUrl
      }
      if (this.cliOverrides.ollamaApiKey !== undefined && 'apiKey' in this.config.embedder) {
        this.config.embedder.apiKey = this.cliOverrides.ollamaApiKey
      }
      if (this.cliOverrides.model && this.cliOverrides.model.trim()) {
        this.config.embedder.model = this.cliOverrides.model
      }
      if (this.cliOverrides.qdrantUrl) {
        this.config.qdrantUrl = this.cliOverrides.qdrantUrl
      }
      if (this.cliOverrides.qdrantApiKey !== undefined) {
        this.config.qdrantApiKey = this.cliOverrides.qdrantApiKey
      }
    }

    // Auto-determine isConfigured based on provider requirements
    this.config!.isConfigured = this.isConfigured()

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

    const { embedder, qdrantUrl } = this.config

    // Check embedder configuration
    if (embedder.provider === "openai") {
      if (!embedder.apiKey || !embedder.model || !embedder.dimension) {
        return false
      }
    } else if (embedder.provider === "ollama") {
      if (!embedder.baseUrl || !embedder.model || !embedder.dimension) {
        return false
      }
    } else if (embedder.provider === "openai-compatible") {
      if (!embedder.baseUrl || !embedder.apiKey || !embedder.model || !embedder.dimension) {
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
    const { embedder } = config
    switch (embedder.provider) {
      case "openai":
        if (!embedder.apiKey) {
          errors.push('OpenAI API key is required')
        }
        if (!embedder.model) {
          errors.push('OpenAI model is required')
        }
        if (!embedder.dimension || embedder.dimension <= 0) {
          errors.push('OpenAI model dimension is required and must be positive')
        }
        break
      case "ollama":
        if (!embedder.baseUrl) {
          errors.push('Ollama base URL is required')
        }
        if (!embedder.model) {
          errors.push('Ollama model is required')
        }
        if (!embedder.dimension || embedder.dimension <= 0) {
          errors.push('Ollama model dimension is required and must be positive')
        }
        break
      case "openai-compatible":
        if (!embedder.baseUrl) {
          errors.push('OpenAI Compatible base URL is required')
        }
        if (!embedder.apiKey) {
          errors.push('OpenAI Compatible API key is required')
        }
        if (!embedder.model) {
          errors.push('OpenAI Compatible model is required')
        }
        if (!embedder.dimension || embedder.dimension <= 0) {
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
