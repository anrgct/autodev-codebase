// Import the new configuration interfaces
import { 
  CodeIndexConfig,
  EmbedderConfig as NewEmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  OpenAICompatibleEmbedderConfig
} from '../code-index/interfaces/config'

// Temporary placeholder for ApiHandlerOptions - will be properly defined later
export interface ApiHandlerOptions {
  apiKey?: string
  baseUrl?: string
  timeout?: number
  maxRetries?: number
  openAiNativeApiKey?: string
  ollamaBaseUrl?: string
  [key: string]: any
}
import { EmbedderProvider } from "../code-index/interfaces/manager"

/**
 * Configuration provider abstraction for platform-agnostic configuration access
 */
export interface IConfigProvider {
  /**
   * Get embedder configuration
   */
  getEmbedderConfig(): Promise<EmbedderConfig>
  
  /**
   * Get vector store configuration
   */
  getVectorStoreConfig(): Promise<VectorStoreConfig>
  
  /**
   * Check if code index is enabled
   */
  isCodeIndexEnabled(): boolean
  
  /**
   * Get search configuration
   */
  getSearchConfig(): Promise<SearchConfig>
  
  /**
   * Get complete configuration object
   */
  getConfig(): Promise<CodeIndexConfig>
  
  /**
   * Watch for configuration changes
   */
  onConfigChange(callback: (config: CodeIndexConfig) => void): () => void
}

/**
 * Embedder configuration
 */
export interface EmbedderConfig {
  provider: EmbedderProvider
  modelId?: string
  openAiOptions?: ApiHandlerOptions
  ollamaOptions?: ApiHandlerOptions
  openAiCompatibleOptions?: {
    baseUrl: string
    apiKey: string
    modelDimension?: number
  }
}

/**
 * Vector store configuration
 */
export interface VectorStoreConfig {
  qdrantUrl?: string
  qdrantApiKey?: string
}

/**
 * Search configuration
 */
export interface SearchConfig {
  minScore?: number
  maxResults?: number
}

// Re-export the new configuration interfaces for external use
export type { 
  CodeIndexConfig,
  NewEmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  OpenAICompatibleEmbedderConfig
}

/**
 * Configuration snapshot for restart detection
 * Using legacy format for backwards compatibility during transition
 */
export interface ConfigSnapshot {
  enabled: boolean
  configured: boolean
  embedderProvider: EmbedderProvider
  modelId?: string
  openAiKey?: string
  ollamaBaseUrl?: string
  ollamaApiKey?: string
  openAiCompatibleBaseUrl?: string
  openAiCompatibleApiKey?: string
  openAiCompatibleModelDimension?: number
  qdrantUrl?: string
  qdrantApiKey?: string
}