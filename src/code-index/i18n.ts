const translations: Record<string, string> = {
  "embeddings:serviceFactory.openAiConfigMissing": "OpenAI API key missing for embedder creation",
  "embeddings:serviceFactory.ollamaConfigMissing": "Ollama base URL missing for embedder creation",
  "embeddings:serviceFactory.openAiCompatibleConfigMissing": "OpenAI Compatible base URL and API key missing for embedder creation",
  "embeddings:serviceFactory.geminiConfigMissing": "Gemini API key missing for embedder creation",
  "embeddings:serviceFactory.mistralConfigMissing": "Mistral API key missing for embedder creation",
  "embeddings:serviceFactory.vercelAiGatewayConfigMissing": "Vercel AI Gateway API key missing for embedder creation",
  "embeddings:serviceFactory.openRouterConfigMissing": "OpenRouter API key missing for embedder creation",
  "embeddings:serviceFactory.jinaConfigMissing": "Jina API key missing for embedder creation",
  "embeddings:serviceFactory.invalidEmbedderType": "Invalid embedder type configured: {embedderProvider}",
  "embeddings:serviceFactory.vectorDimensionNotDetermined": "Could not determine vector dimension for model '{modelId}' with provider '{provider}'. Check model profiles or configuration.",
  "embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible": "Could not determine vector dimension for model '{modelId}' with provider '{provider}'. Please ensure the 'Embedding Dimension' is correctly set in the OpenAI-Compatible provider settings.",
  "embeddings:serviceFactory.vectorDimensionConflict": "Vector dimension mismatch: existing collection has dimension {existingSize}, but the current model produces dimension {newSize}. Please use --force to rebuild the index.",
  "embeddings:serviceFactory.qdrantUrlMissing": "Qdrant URL missing for vector store creation",
  "embeddings:serviceFactory.codeIndexingNotConfigured": "Cannot create services: Code indexing is not properly configured",
  "embeddings:validation.configurationError": "Embedder configuration validation failed",
  "embeddings:serviceFactory.invalidRerankerType": "Invalid reranker provider configured: {provider}",
  "embeddings:serviceFactory.rerankerValidationError": "Reranker configuration validation failed",
}

export function t(key: string, params?: Record<string, string>): string {
  let message = translations[key] || key
  if (params) {
    for (const [param, value] of Object.entries(params)) {
      message = message.replace(`{${param}}`, value)
    }
  }
  return message
}
