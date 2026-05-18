import { EmbedderProvider } from "../interfaces/manager"

/**
 * Query prefill template for Qwen3 embedding models.
 * This template helps guide the model to produce better embeddings for code search queries.
 */
export const QWEN_PREFILL_TEMPLATE = "Instruct: Given a codebase search query, retrieve relevant code snippets or document that answer the query.\nQuery: "

/**
 * Applies query prefill for qwen3-embedding models.
 * Only applies to ollama provider with qwen3-embedding models.
 *
 * @param query The original search query
 * @param provider The embedder provider
 * @param modelId The model ID
 * @returns The query with prefill applied if applicable, otherwise the original query
 */
export function applyQueryPrefill(query: string, provider: EmbedderProvider, modelId?: string): string {
  // Only apply to ollama provider with qwen3-embedding models
  if (provider !== "ollama" || !modelId) {
    return query
  }

  // Check if modelId matches qwen3-embedding pattern
  const qwenModelRegex = /^qwen3-embedding:/
  if (!qwenModelRegex.test(modelId)) {
    return query
  }

  // Prevent duplicate prefill - check if query already starts with the template
  if (query.startsWith(QWEN_PREFILL_TEMPLATE)) {
    return query
  }

  // Apply prefill template
  return QWEN_PREFILL_TEMPLATE + query
}
