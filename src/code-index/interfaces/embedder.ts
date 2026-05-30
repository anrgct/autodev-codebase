/**
 * Interface for code index embedders.
 * This interface is implemented by all embedder implementations.
 */
export interface IEmbedder {
  /**
   * Creates embeddings for the given texts.
   * @param texts Array of text strings to create embeddings for
   * @param model Optional model ID to use for embeddings
   * @returns Promise resolving to an EmbeddingResponse
   */
  createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse>

  /**
   * Validates the embedder configuration by testing connectivity and credentials.
   * @returns Promise resolving to validation result with success status and optional error message
   */
  validateConfiguration(): Promise<{ valid: boolean; error?: string }>

  get embedderInfo(): EmbedderInfo

  /**
   * Gets the optimal batch size for this embedder
   */
  get optimalBatchSize(): number

  /**
   * Gets the pooling mode for this embedder.
   * "late-chunking" - concatenate all chunks from one file, one forward pass, per-chunk mean pooling
   * "mean" - each chunk individually, mean pooling across all tokens
   * "qr-weighted" - each chunk individually, softmax attention-weighted mean pooling
   * "last-token" - each chunk individually, last-token pooling (default for non-LLM embedders)
   */
  get poolingMode(): "late-chunking" | "last-token" | "mean" | "qr-weighted"

  /**
   * Whether to apply instruction prefix on both query and document sides.
   * Default false. Only effective for LLM-based embedders (llamacpp-llm).
   */
  enableLlmPrefix?: boolean

  /**
   * Optional cleanup of allocated resources (e.g., GPU models, embedding contexts).
   * Called when the embedder is no longer needed to free VRAM and memory.
   */
  dispose?(): Promise<void>
}

export interface EmbeddingResponse {
  embeddings: number[][]
  usage?: {
    promptTokens: number
    totalTokens: number
  }
}

export type AvailableEmbedders =
  | "openai"
  | "ollama"
  | "openai-compatible"
  | "jina"
  | "gemini"
  | "mistral"
  | "vercel-ai-gateway"
  | "openrouter"
  | "llamacpp"
  | "llamacpp-llm"

export interface EmbedderInfo {
  name: AvailableEmbedders
}
