/**
 * Local copy of the core Roo Code defaults we rely on for this library.
 * In Roo Code proper these come from `@roo-code/types` as `CODEBASE_INDEX_DEFAULTS`.
 */
const CODEBASE_INDEX_DEFAULTS = {
	DEFAULT_SEARCH_MIN_SCORE: 0.4,
	DEFAULT_SEARCH_RESULTS: 50,
} as const

/**
 * Default configuration for the code index
 */
import { CodeIndexConfig } from '../interfaces/config'

export const DEFAULT_CONFIG: CodeIndexConfig = {
	isEnabled: true,
	embedderProvider: "ollama",
	embedderModelId: "nomic-embed-text",
	embedderModelDimension: 768,
	embedderOllamaBaseUrl: "http://localhost:11434",
	qdrantUrl: "http://localhost:6333",
	vectorSearchMinScore: 0.1,
	vectorSearchMaxResults: 20,
	rerankerEnabled: false,
	summarizerProvider: 'ollama',
	summarizerOllamaBaseUrl: 'http://localhost:11434',
	summarizerOllamaModelId: 'qwen3-vl:4b-instruct',
	summarizerOpenAiCompatibleBaseUrl: 'http://localhost:8080/v1',
	summarizerOpenAiCompatibleModelId: 'gpt-4',
	summarizerOpenAiCompatibleApiKey: '',
	summarizerLanguage: 'English',
	summarizerBatchSize: 2,
	summarizerConcurrency: 2,
	summarizerMaxRetries: 3,
	summarizerRetryDelayMs: 1000
}

/**Parser */
export const MAX_BLOCK_CHARS = 2000
export const MIN_BLOCK_CHARS = 100
export const MIN_CHUNK_REMAINDER_CHARS = 200 // Minimum characters for the *next* chunk after a split
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15 // 15% tolerance for max chars

/**Search */
/**
 * @deprecated Use SEARCH_CONFIG from './search-config' instead
 */
export const DEFAULT_SEARCH_MIN_SCORE = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
/**
 * @deprecated Use SEARCH_CONFIG from './search-config' instead
 */
export const DEFAULT_MAX_SEARCH_RESULTS = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS

/**File Watcher */
export const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB

/**Directory Scanner */
export const MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000
export const BATCH_SEGMENT_THRESHOLD = 60 // Number of code segments to batch for embeddings/upserts (default for OpenAI)
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500

// Dynamic batch sizes for different embedder types
export const EMBEDDER_BATCH_SIZES: { [key: string]: number } = {
    "openai": 60,
    "openai-compatible": 60,
    "jina": 30,
    "gemini": 40,
    "mistral": 30,
    "vercel-ai-gateway": 60,
    "openrouter": 60,
    "ollama": 20, // Smaller batch size for Ollama to prevent timeouts with large local models
}

/**
 * Gets the optimal batch size for a specific embedder type or embedder instance
 * @param embedderType The embedder provider type, or an embedder instance with optimalBatchSize property
 * @returns The optimal batch size for the embedder
 */
export function getBatchSizeForEmbedder(embedder: any): number {
    // Check if embedder has an optimalBatchSize property
    if (embedder && typeof embedder.optimalBatchSize === 'number') {
        return embedder.optimalBatchSize
    }

    // Check if embedder has an embedderInfo property with name
    const embedderType = embedder?.embedderInfo?.name || embedder
    return EMBEDDER_BATCH_SIZES[embedderType] || BATCH_SEGMENT_THRESHOLD
}
export const PARSING_CONCURRENCY = 10
export const MAX_PENDING_BATCHES = 20 // Maximum number of batches to accumulate before waiting

/**OpenAI Embedder */
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const BATCH_PROCESSING_CONCURRENCY = 10

/**Gemini Embedder */
export const GEMINI_MAX_ITEM_TOKENS = 2048

/**BatchProcessor Truncation - 截断降级功能用于处理超长文本 */
export const TRUNCATION_INITIAL_THRESHOLD = 800      // 初始截断阈值（chars）
export const TRUNCATION_REDUCTION_FACTOR = 0.7       // 每次降低 30%
export const MIN_TRUNCATION_THRESHOLD = 200          // 最小阈值
export const MAX_TRUNCATION_ATTEMPTS = 3             // 最大重试次数
export const INDIVIDUAL_PROCESSING_TIMEOUT_MS = 60000 // 降级处理超时（1分钟）

/**Feature Flags - 功能开关 */
export const ENABLE_TRUNCATION_FALLBACK = true       // 是否启用截断降级功能
