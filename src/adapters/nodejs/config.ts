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
    model?: string
    qdrantUrl?: string
  }
}

// Default configuration constants
const DEFAULT_CONFIG: CodeIndexConfig = {
  isEnabled: true,
  isConfigured: true,
  embedderProvider: "ollama",
  modelId: "nomic-embed-text",
  modelDimension: 768,
  ollamaOptions: {
    ollamaBaseUrl: "http://localhost:11434",
  }
}


export class NodeConfigProvider implements IConfigProvider {
  private configPath: string
  private globalConfigPath: string
  private config: CodeIndexConfig | null = null
  private configLoaded: boolean = false
  private changeCallbacks: Array<(config: CodeIndexConfig) => void> = []
  private cliOverrides: NodeConfigOptions['cliOverrides']
  // Global state storage for CodeIndexConfigManager compatibility
  private globalState: Map<string, any> = new Map()
  // Secrets storage for CodeIndexConfigManager compatibility
  private secrets: Map<string, string> = new Map()

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

  /**
   * Get global state value (for CodeIndexConfigManager compatibility)
   * Maps to the loaded configuration
   */
  getGlobalState(key: string): any {
    // Return from globalState if explicitly set
    if (this.globalState.has(key)) {
      return this.globalState.get(key)
    }

    // For codebaseIndexConfig, return a compatible format
    if (key === "codebaseIndexConfig" && this.config) {
      return {
        codebaseIndexEnabled: this.config.isEnabled ?? true,
        codebaseIndexQdrantUrl: this.config.qdrantUrl ?? "http://localhost:6333",
        codebaseIndexEmbedderProvider: this.config.embedderProvider ?? "ollama",
        codebaseIndexEmbedderBaseUrl: this.config.ollamaOptions?.ollamaBaseUrl ?? "",
        codebaseIndexEmbedderModelId: this.config.modelId ?? "",
        codebaseIndexEmbedderModelDimension: this.config.modelDimension,
        codebaseIndexSearchMinScore: this.config.searchMinScore,
        codebaseIndexSearchMaxResults: undefined,
        codebaseIndexOpenAiCompatibleBaseUrl: this.config.openAiCompatibleOptions?.baseUrl ?? "",
      }
    }

    return undefined
  }

  /**
   * Set global state value (for CodeIndexConfigManager compatibility)
   */
  setGlobalState(key: string, value: any): void {
    this.globalState.set(key, value)
  }

  /**
   * Get secret value (for CodeIndexConfigManager compatibility)
   * Returns empty string for secrets in Node.js environment
   */
  async getSecret(key: string): Promise<string> {
    // Return from secrets if explicitly set
    if (this.secrets.has(key)) {
      return this.secrets.get(key) ?? ""
    }

    // Map secrets to config values where applicable
    if (this.config) {
      switch (key) {
        case "codeIndexOpenAiKey":
          return this.config.openAiOptions?.openAiNativeApiKey ?? ""
        case "codeIndexQdrantApiKey":
          return this.config.qdrantApiKey ?? ""
        case "codebaseIndexOpenAiCompatibleApiKey":
          return this.config.openAiCompatibleOptions?.apiKey ?? ""
        case "codebaseIndexGeminiApiKey":
          return this.config.geminiOptions?.apiKey ?? ""
        case "codebaseIndexMistralApiKey":
          return this.config.mistralOptions?.apiKey ?? ""
        case "codebaseIndexVercelAiGatewayApiKey":
          return this.config.vercelAiGatewayOptions?.apiKey ?? ""
        case "codebaseIndexOpenRouterApiKey":
          return this.config.openRouterOptions?.apiKey ?? ""
      }
    }

    return ""
  }

  /**
   * Set secret value (for CodeIndexConfigManager compatibility)
   */
  setSecret(key: string, value: string): void {
    this.secrets.set(key, value)
  }

  /**
   * Refresh secrets from storage (for CodeIndexConfigManager compatibility)
   * In Node.js environment, this reloads config from file
   */
  async refreshSecrets(): Promise<void> {
    await this.reloadConfig()
  }

  async getEmbedderConfig(): Promise<EmbedderConfig> {
    const config = await this.ensureConfigLoaded()
    // Convert new config structure to legacy format for compatibility
    if (config.embedderProvider === "openai") {
      return {
        provider: "openai",
        modelId: config.modelId,
        dimension: config.modelDimension,
        openAiOptions: config.openAiOptions
      }
    } else if (config.embedderProvider === "ollama") {
      return {
        provider: "ollama",
        modelId: config.modelId,
        dimension: config.modelDimension,
        ollamaOptions: config.ollamaOptions
      }
    } else if (config.embedderProvider === "openai-compatible") {
      return {
        provider: "openai-compatible",
        modelId: config.modelId,
        dimension: config.modelDimension,
        openAiCompatibleOptions: config.openAiCompatibleOptions
      }
    }

    // Fallback
    return {
      provider: "ollama",
      modelId: DEFAULT_CONFIG.modelId,
      dimension: DEFAULT_CONFIG.modelDimension,
      ollamaOptions: DEFAULT_CONFIG.ollamaOptions
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
      if (this.cliOverrides.ollamaUrl && this.config.ollamaOptions) {
        this.config.ollamaOptions.ollamaBaseUrl = this.cliOverrides.ollamaUrl
      }
      if (this.cliOverrides.model && this.cliOverrides.model.trim()) {
        this.config.modelId = this.cliOverrides.model
      }
      if (this.cliOverrides.qdrantUrl) {
        this.config.qdrantUrl = this.cliOverrides.qdrantUrl
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

    const { embedderProvider, qdrantUrl } = this.config

    // Check embedder configuration
    if (embedderProvider === "openai") {
      if (!this.config.openAiOptions?.openAiNativeApiKey || !this.config.modelId) {
        return false
      }
    } else if (embedderProvider === "ollama") {
      if (!this.config.ollamaOptions?.ollamaBaseUrl || !this.config.modelId) {
        return false
      }
    } else if (embedderProvider === "openai-compatible") {
      if (!this.config.openAiCompatibleOptions?.baseUrl ||
          !this.config.openAiCompatibleOptions?.apiKey ||
          !this.config.modelId) {
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
        if (!config.openAiOptions?.openAiNativeApiKey) {
          errors.push('OpenAI API key is required')
        }
        if (!config.modelId) {
          errors.push('OpenAI model is required')
        }
        if (!config.modelDimension || config.modelDimension <= 0) {
          errors.push('OpenAI model dimension is required and must be positive')
        }
        break
      case "ollama":
        if (!config.ollamaOptions?.ollamaBaseUrl) {
          errors.push('Ollama base URL is required')
        }
        if (!config.modelId) {
          errors.push('Ollama model is required')
        }
        if (!config.modelDimension || config.modelDimension <= 0) {
          errors.push('Ollama model dimension is required and must be positive')
        }
        break
      case "openai-compatible":
        if (!config.openAiCompatibleOptions?.baseUrl) {
          errors.push('OpenAI Compatible base URL is required')
        }
        if (!config.openAiCompatibleOptions?.apiKey) {
          errors.push('OpenAI Compatible API key is required')
        }
        if (!config.modelId) {
          errors.push('OpenAI Compatible model is required')
        }
        if (!config.modelDimension || config.modelDimension <= 0) {
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
