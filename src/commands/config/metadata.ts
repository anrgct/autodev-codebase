/**
 * Configuration metadata for CLI commands
 *
 * Centralizes all configuration-related constants and validation rules.
 * This is the single source of truth for configuration key metadata.
 */

import type { CodeIndexConfig } from '../../code-index/interfaces/config'

type ConfigKey = keyof CodeIndexConfig
type ConfigValueType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'union'

export interface ConfigKeyMetadata {
  /** Type of the configuration value */
  type: ConfigValueType
  /** Valid enum values (for enum type) */
  enumValues?: readonly string[]
  /** Union member types (for union type) */
  unionTypes?: readonly string[]
  /** Minimum value (for integer/number types) */
  minValue?: number
  /** Maximum value (for integer/number types) */
  maxValue?: number
  /** Human-readable description */
  description?: string
}

/**
 * Metadata for all configuration keys
 *
 * This object defines:
 * - The type of each configuration value
 * - Valid enum values for enums
 * - Validation constraints (min/max values)
 *
 * IMPORTANT: When adding new configuration keys to CodeIndexConfig,
 * update this metadata as well to maintain consistency.
 */
export const CONFIG_KEY_METADATA: Record<ConfigKey, ConfigKeyMetadata> = {
  // Feature enablement
  isEnabled: { type: 'boolean', description: 'Enable code indexing feature' },

  // Embedder - General
  embedderProvider: {
    type: 'enum',
    enumValues: ['openai', 'ollama', 'openai-compatible', 'jina', 'gemini', 'mistral', 'vercel-ai-gateway', 'openrouter', 'llamacpp', 'llamacpp-llm', 'llm2vec'] as const,
    description: 'Embedding provider to use'
  },
  embedderModelId: { type: 'string', description: 'Model identifier for embeddings' },
  embedderModelDimension: { type: 'integer', minValue: 1, description: 'Dimension of embedding vectors' },

  // Embedder - Jina
  embedderJinaApiKey: { type: 'string', description: 'Jina API key' },
  embedderJinaBaseUrl: { type: 'string', description: 'Jina API base URL (defaults to https://api.jina.ai/v1)' },
  embedderJinaBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Jina embeddings' },

  // Embedder - Ollama
  embedderOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL' },
  embedderOllamaBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Ollama embeddings' },

  // Embedder - OpenAI
  embedderOpenAiApiKey: { type: 'string', description: 'OpenAI API key' },
  embedderOpenAiBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenAI embeddings' },

  // Embedder - OpenAI Compatible
  embedderOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL' },
  embedderOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key' },
  embedderOpenAiCompatibleBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenAI-compatible embeddings' },

  // Embedder - Gemini
  embedderGeminiApiKey: { type: 'string', description: 'Gemini API key' },
  embedderGeminiBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Gemini embeddings' },

  // Embedder - Mistral
  embedderMistralApiKey: { type: 'string', description: 'Mistral API key' },
  embedderMistralBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for Mistral embeddings' },

  // Embedder - Vercel AI Gateway
  embedderVercelAiGatewayApiKey: { type: 'string', description: 'Vercel AI Gateway API key' },

  // Embedder - OpenRouter
  embedderOpenRouterApiKey: { type: 'string', description: 'OpenRouter API key' },
  embedderOpenRouterBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for OpenRouter embeddings' },

  // Embedder - LlamaCPP
  embedderGgufPath: { type: 'string', description: 'Path to LlamaCPP GGUF model file for embeddings' },
  embedderLlamaCppGpuLayers: { type: 'integer', minValue: 0, description: 'Number of GPU layers for LlamaCPP (0 for CPU only)' },

  // Embedder - LlamaCPP LLM
  embedderGgufLlmPath: { type: 'string', description: 'Path to LLM GGUF model file for LLM-based embeddings (llamacpp-llm provider)' },

  // Embedder - LLM2Vec
  embedderGgufLlm2vecPath: { type: 'string', description: 'Path to LLM2Vec GGUF model file (llm2vec provider, e.g. qwen3-06b-llm2vec-unified-q8_0-mlp.gguf)' },

  embedderConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent embedding requests for llamacpp-llm embedder' },
  embedderPoolingMode: {
    type: 'enum',
    enumValues: ['late-chunking', 'last-token', 'mean', 'qr-weighted'] as const,
    description: 'Pooling mode for LLM embedder: late-chunking (file-level), last-token, mean, or qr-weighted (attention-weighted)'
  },
  embedderPoolingLayer: {
    type: 'union',
    unionTypes: ['string', 'integer'] as const,
    description: 'Target transformer layer for embedding extraction: "last" (default) or 0-based layer index (e.g., 15 for mid-layer)'
  },
  embedderQueryPoolingLayer: {
    type: 'union',
    unionTypes: ['string', 'integer'] as const,
    description: 'Target transformer layer for QUERY embedding (falls back to embedderPoolingLayer if not set). Asymmetric layers (e.g., index=22, query=23) can improve MRR by 48%'
  },
  embedderLlmInstructionPrefix: { type: 'boolean', description: 'Enable instruction prefix for llamacpp-llm queries (may not help all models)' },
  embedderUseChatTemplate: { type: 'boolean', description: 'Wrap text in MiniCPM ChatML format (<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n) before embedding extraction. Uses the model with its instruct-tuned distribution.' },
  embedderLateChunkingContextSize: { type: 'integer', minValue: 0, description: 'Late-chunking context window upper limit (tokens). 0 = auto (use model\'s actual context size). Smaller values speed up indexing at the cost of cross-chunk context.' },

  // Vector Store
  qdrantUrl: { type: 'string', description: 'Qdrant server URL' },
  qdrantApiKey: { type: 'string', description: 'Qdrant API key' },
  vectorStoreBackend: {
    type: 'enum',
    enumValues: ['qdrant', 'sqlite'] as const,
    description: 'Vector store backend. "sqlite" is the default (zero-config, embedded in ~/.autodev-cache/); "qdrant" requires a running Qdrant service.'
  },

  // Vector Search
  vectorSearchMinScore: { type: 'number', minValue: 0, maxValue: 1, description: 'Minimum similarity score for search results' },
  vectorSearchMaxResults: { type: 'integer', minValue: 1, description: 'Maximum number of search results to return' },

  // Hybrid Search (Dense + Sparse BM25)
  hybridSearchEnabled: { type: 'boolean', description: 'Enable hybrid search (dense + sparse BM25)' },
  hybridSearchDenseWeight: { type: 'number', minValue: 0, description: 'Weight for dense (semantic) vector scores in hybrid search' },
  hybridSearchSparseWeight: { type: 'number', minValue: 0, description: 'Weight for sparse (BM25 keyword) scores in hybrid search' },

  // Reranker
  rerankerEnabled: { type: 'boolean', description: 'Enable LLM reranking for search results' },
  rerankerProvider: {
    type: 'enum',
    enumValues: ['ollama', 'openai-compatible', 'llamacpp', 'llamacpp-llm'] as const,
    description: 'Reranker provider to use'
  },
  rerankerOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL for reranking' },
  rerankerOllamaModelId: { type: 'string', description: 'Ollama model ID for reranking' },
  rerankerOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL for reranking' },
  rerankerOpenAiCompatibleModelId: { type: 'string', description: 'OpenAI-compatible model ID for reranking' },
  rerankerOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key for reranking' },
  rerankerGgufPath: { type: 'string', description: 'Path to dedicated reranker GGUF model (provider=llamacpp/llamacpp-llm)' },
  rerankerGgufQrrankerPath: { type: 'string', description: 'Path to QRRanker GGUF model for QR attention-based reranking (provider=qrranker)' },
  rerankerGgufLlmPath: { type: 'string', description: 'Path to LLM GGUF model for chat-based reranking (provider=llamacpp-llm)' },
  rerankerLlamaCppServer: { type: 'boolean', description: 'Use llama.cpp server for reranking (auto-starts/stop server)' },
  rerankerLlamaCppServerBinPath: { type: 'string', description: 'Path to llama-server binary (used when rerankerLlamaCppServer is true)' },
  rerankerMinScore: { type: 'number', minValue: 0, maxValue: 1, description: 'Minimum score for reranked results' },
  rerankerBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for reranking' },
  rerankerConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent reranking requests' },
  rerankerMaxRetries: { type: 'integer', minValue: 0, description: 'Maximum number of retries for reranking' },
  rerankerRetryDelayMs: { type: 'integer', minValue: 0, description: 'Delay between reranking retries (ms)' },

  // Summarizer
  summarizerProvider: {
    type: 'enum',
    enumValues: ['ollama', 'openai-compatible', 'llamacpp'] as const,
    description: 'Summarizer provider to use'
  },
  summarizerOllamaBaseUrl: { type: 'string', description: 'Ollama server base URL for summarization' },
  summarizerOllamaModelId: { type: 'string', description: 'Ollama model ID for summarization' },
  summarizerOpenAiCompatibleBaseUrl: { type: 'string', description: 'OpenAI-compatible server base URL for summarization' },
  summarizerOpenAiCompatibleModelId: { type: 'string', description: 'OpenAI-compatible model ID for summarization' },
  summarizerOpenAiCompatibleApiKey: { type: 'string', description: 'OpenAI-compatible API key for summarization' },
  summarizerLlamaCppModelPath: { type: 'string', description: 'Path to LlamaCPP GGUF model for summarization' },
  summarizerLanguage: {
    type: 'enum',
    enumValues: ['English', 'Chinese'] as const,
    description: 'Language for summaries'
  },
  summarizerTemperature: { type: 'number', minValue: 0, maxValue: 2, description: 'Temperature for summarization' },
  summarizerBatchSize: { type: 'integer', minValue: 1, description: 'Batch size for summarization' },
  summarizerConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent summarization requests' },
  summarizerMaxRetries: { type: 'integer', minValue: 0, description: 'Maximum number of retries for summarization' },
  summarizerRetryDelayMs: { type: 'integer', minValue: 0, description: 'Delay between summarization retries (ms)' },

  // Highlighter (semantic highlight / line-level filtering)
  highlighterEnabled: { type: 'boolean', description: 'Enable semantic line-level highlighting for search results' },
  highlighterProvider: {
    type: 'enum',
    enumValues: ['semantic-highlight', 'llamacpp-llm', 'qrranker'] as const,
    description: 'Highlight provider: semantic-highlight (dedicated model), llamacpp-llm (LLM prompt-based), or qrranker (QRRanker attention-based)'
  },
  highlighterGgufPath: { type: 'string', description: 'Path to dedicated semantic-highlight GGUF model (provider=semantic-highlight)' },
  highlighterGgufLlmPath: { type: 'string', description: 'Path to LLM GGUF model for prompt-based highlighting (provider=llamacpp-llm, e.g. 0.6B model)' },
  highlighterGgufQrrankerPath: { type: 'string', description: 'Path to QRRanker GGUF model for attention-based highlighting (provider=qrranker, Qwen3-4B)' },
  highlighterTopK: { type: 'integer', minValue: 1, description: 'Number of top-K lines to keep (topk mode)' },
  highlighterMode: {
    type: 'enum',
    enumValues: ['topk', 'threshold'] as const,
    description: 'Highlight selection mode: topk (fixed count) or threshold (score-based)'
  },
  highlighterThreshold: { type: 'number', minValue: 0, maxValue: 1, description: 'Minimum keep probability for threshold mode (0-1)' },
  highlighterConcurrency: { type: 'integer', minValue: 1, description: 'Maximum concurrent highlight requests (llamacpp-llm provider)' },

  // Escalate proxy
  escalateMode: { type: 'enum', enumValues: ['self-report', 'advisor'] as const, description: 'Escalation mode: "self-report" (inject contract, model emits <<<NEEDS_PRO>>> marker) or "advisor" (virtual advisor tool — flash calls it, proxy routes to pro). Default: advisor' },
  escalateApiBase: { type: 'string', description: 'API base URL for the upstream Anthropic-compatible LLM (default: https://api.deepseek.com/anthropic)' },
  escalateApiKey: { type: 'string', description: 'API key for upstream LLM (optional — if not set, client Authorization header is forwarded)' },
  escalateFlashModel: { type: 'string', description: 'Flash (cheap) model ID used for first attempt (default: deepseek-v4-flash)' },
  escalateProModel: { type: 'string', description: 'Pro (strong) model ID used after <<<NEEDS_PRO>>> escalation (default: deepseek-v4-pro)' },
  escalatePort: { type: 'integer', minValue: 1, maxValue: 65535, description: 'Local proxy server listening port (default: 8080)' },
  escalateHost: { type: 'string', description: 'Local proxy server listening host (default: localhost)' },
  escalateStickyProTtlMs: { type: 'integer', minValue: 0, description: 'Sticky pro TTL in milliseconds (default: 300000 = 5 min). Set 0 to disable.' },

  escalateThinkingBudget: { type: 'integer', minValue: 0, description: 'Anthropic thinking budget tokens (default: 8000). Used when client does not provide thinking.' },
  escalateMaxTokens: { type: 'integer', minValue: 1, description: 'Default max_tokens for Anthropic Messages API (default: 4096). Used when client does not provide max_tokens.' },

  // QRRanker shared tuning: average attention over N decode steps.
  // 0 = default (prefill-only, no decode cost). 20+ = prefill + N decode.
  // See docs/plans/260604-qrranker-highlight-penalty.md.
  qrrankerDecodeSteps: { type: 'integer', minValue: 0, description: 'QRRanker decode steps for attention averaging (0=prefill-only default, 20+=decode-stage, ~2.2x cost at N=20). Shared by highlighter & reranker.' }
}

/**
 * Get all valid configuration keys
 */
export function getValidConfigKeys(): ConfigKey[] {
  return Object.keys(CONFIG_KEY_METADATA) as ConfigKey[]
}

/**
 * Get metadata for a specific configuration key
 */
export function getConfigKeyMetadata(key: string): ConfigKeyMetadata | undefined {
  return CONFIG_KEY_METADATA[key as ConfigKey]
}

/**
 * Check if a configuration key is valid
 */
export function isValidConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_KEY_METADATA
}
