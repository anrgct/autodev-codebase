import { IEmbedder } from "../interfaces"
import { getModelDocumentPrefix } from "../../shared/embeddingModels"

/**
 * Resolve model-specific document prefix for index-time embedding.
 * Extracts the model identifier from the embedder instance and checks
 * if a "Document:" prefix is required (e.g., for jina-embeddings-v5 retrieval models).
 *
 * @param embedder 嵌入器实例
 * @returns 文档前缀字符串（如 "Document: "），如果不需要则返回 undefined
 */
export function resolveDocumentPrefix(embedder: IEmbedder): string | undefined {
  const provider = embedder.embedderInfo.name

  // Try to extract model identifier via common field names across different embedder implementations
  const embedderAny = embedder as any
  const modelId: string | undefined =
    embedderAny.modelPath  // LlamaCppEmbedder has modelPath
    || embedderAny.defaultModelId
    || embedderAny.modelId

  if (!modelId) return undefined

  // Match against the raw modelId first (may contain full path like
  // ".../jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0.gguf"),
  // then fallback to extracted filename (e.g., "v5-nano-retrieval-Q8_0")
  const prefix = getModelDocumentPrefix(provider, modelId)
  if (prefix) return prefix

  const modelFileName = modelId.split("/").pop()?.split(".")[0] || modelId
  return getModelDocumentPrefix(provider, modelFileName) || undefined
}
