// Import the new configuration interfaces
import {
  CodeIndexConfig,
  EmbedderConfig as NewEmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  OpenAICompatibleEmbedderConfig,
  JinaEmbedderConfig,
  GeminiEmbedderConfig,
  MistralEmbedderConfig,
  VercelAiGatewayEmbedderConfig,
  OpenRouterEmbedderConfig,
  EmbedderProvider
} from '../code-index/interfaces/config'

// Temporary placeholder for ApiHandlerOptions - will be properly defined later
export interface ApiHandlerOptions {
  apiKey?: string
  baseUrl?: string
  timeout?: number
  maxRetries?: number
  openAiNativeApiKey?: string
  ollamaBaseUrl?: string
  ollamaBatchSize?: number // Custom batch size for Ollama embedder
  openaiBatchSize?: number // Custom batch size for OpenAI embedder
  openaiCompatibleBatchSize?: number // Custom batch size for OpenAI Compatible embedder
  jinaBatchSize?: number // Custom batch size for Jina embedder
  geminiBatchSize?: number // Custom batch size for Gemini embedder
  mistralBatchSize?: number // Custom batch size for Mistral embedder
  openrouterBatchSize?: number // Custom batch size for OpenRouter embedder
  [key: string]: any
}

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
 * Embedder configuration (legacy for backwards compatibility)
 * @deprecated Use NewEmbedderConfig from code-index/interfaces/config instead
 */
export interface EmbedderConfig {
  provider: EmbedderProvider
  modelId?: string
  dimension?: number // Added dimension property
  openAiOptions?: ApiHandlerOptions
  ollamaOptions?: ApiHandlerOptions
  openAiCompatibleOptions?: {
    baseUrl: string
    apiKey: string
    modelDimension?: number
  }
  geminiOptions?: { apiKey: string }
  mistralOptions?: { apiKey: string }
  vercelAiGatewayOptions?: { apiKey: string }
  openRouterOptions?: { apiKey: string }
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
  OpenAICompatibleEmbedderConfig,
  JinaEmbedderConfig,
  GeminiEmbedderConfig,
  MistralEmbedderConfig,
  VercelAiGatewayEmbedderConfig,
  OpenRouterEmbedderConfig
}

// Re-export EmbedderProvider for external use
export { EmbedderProvider }

/**
 * Configuration snapshot for restart detection
 * Using legacy format for backwards compatibility during transition
 */
export interface ConfigSnapshot {
  enabled: boolean
  configured: boolean
  embedderProvider: EmbedderProvider
  modelId?: string
  dimension?: number // Add dimension property
  openAiKey?: string
  ollamaBaseUrl?: string
  openAiCompatibleBaseUrl?: string
  openAiCompatibleApiKey?: string
  openAiCompatibleModelDimension?: number
  geminiApiKey?: string
  mistralApiKey?: string
  vercelAiGatewayApiKey?: string
  openRouterApiKey?: string
  qdrantUrl?: string
  qdrantApiKey?: string
}