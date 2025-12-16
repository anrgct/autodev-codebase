// Re-export configuration types from code-index/interfaces/config.ts
import type {
  CodeIndexConfig,
  EmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  OpenAICompatibleEmbedderConfig,
  JinaEmbedderConfig,
  GeminiEmbedderConfig,
  MistralEmbedderConfig,
  VercelAiGatewayEmbedderConfig,
  OpenRouterEmbedderConfig,
  EmbedderProvider,
  VectorStoreConfig,
  SearchConfig,
  ConfigSnapshot
} from '../code-index/interfaces/config'

/**
 * Configuration provider abstraction for platform-agnostic configuration access
 */
export interface IConfigProvider {
  /**
   * Get complete configuration object
   */
  getConfig(): Promise<CodeIndexConfig>

  /**
   * Watch for configuration changes
   */
  onConfigChange(callback: (config: CodeIndexConfig) => void): () => void
}

// Re-export the configuration interfaces for external use
export type {
  CodeIndexConfig,
  EmbedderConfig,
  OllamaEmbedderConfig,
  OpenAIEmbedderConfig,
  OpenAICompatibleEmbedderConfig,
  JinaEmbedderConfig,
  GeminiEmbedderConfig,
  MistralEmbedderConfig,
  VercelAiGatewayEmbedderConfig,
  OpenRouterEmbedderConfig,
  VectorStoreConfig,
  SearchConfig,
  ConfigSnapshot
}

// Re-export EmbedderProvider for external use
export { EmbedderProvider }