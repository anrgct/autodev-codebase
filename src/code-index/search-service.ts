import * as path from "path"
import { VectorStoreSearchResult, SearchFilter, IReranker, RerankerCandidate, IHighlighter } from "./interfaces"
import { IEmbedder } from "./interfaces/embedder"
import { IVectorStore } from "./interfaces/vector-store"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { resolveQueryPrefix } from "./search/instruction-prefix"
import { getDefaultModelId } from "../shared/embeddingModels"
import { validateLimit, validateMinScore } from "./validate-search-params"

/**
 * Service responsible for searching the code index.
 */
export class CodeIndexSearchService {
  constructor(
    private readonly configManager: CodeIndexConfigManager,
    private readonly stateManager: CodeIndexStateManager,
    private readonly embedder: IEmbedder,
    private readonly vectorStore: IVectorStore,
    private readonly reranker?: IReranker,
    private readonly highlighter?: IHighlighter,
  ) {}

  /**
   * Highlights code lines by semantic relevance to a query.
   * Standalone pipeline that directly invokes the highlighter,
   * bypassing embed / vector search / rerank.
   * @param query Semantic query for line relevance scoring
   * @param codeChunk Code text to highlight
   * @param startLine Starting line number (1-based)
   * @param options Runtime highlight options
   * @returns Highlight result
   * @throws Error if the highlighter is not configured
   */
  public async highlight(
    query: string,
    codeChunk: string,
    startLine: number,
    options?: import("./interfaces/highlighter").HighlightOptions,
  ): Promise<import("./interfaces/highlighter").HighlightResult> {
    if (!this.highlighter) {
      throw new Error("Highlighter is not configured or not available. Check highlighter.enabled in config.")
    }
    return this.highlighter.highlight(query, codeChunk, startLine, options)
  }

  /**
   * Searches the code index for relevant content.
   * @param query The search query
   * @param filter Search filter options
   * @returns Array of search results
   * @throws Error if the service is not properly configured or ready
   */
  public async searchIndex(query: string, filter?: SearchFilter): Promise<VectorStoreSearchResult[]> {
    if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
      throw new Error("Code index feature is disabled or not configured.")
    }

    // Get configuration values
    const configMinScore = this.configManager.currentSearchMinScore
    const configMaxResults = this.configManager.currentSearchMaxResults

    const currentState = this.stateManager.getCurrentStatus().systemStatus
    if (currentState !== "Indexed" && currentState !== "Indexing") {
      // Allow search during Indexing too
      throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
    }

    // 使用统一的filter对象，不再单独处理directoryPrefix
    // 所有过滤条件都通过pathFilters参数传递

    try {
      // 统一 prefix 解析：一次调用覆盖所有 provider
      const embedderProvider = this.configManager.currentEmbedderProvider
      const modelId = this.configManager.currentModelId ?? getDefaultModelId(embedderProvider)
      const prefillQuery = resolveQueryPrefix(
        query,
        embedderProvider,
        modelId,
        this.configManager.getConfig().embedderLlmInstructionPrefix,
      )

      // Generate embedding for query (with prefill if applicable)
      const embeddingResponse = await this.embedder.createEmbeddings([prefillQuery])
      const vector = embeddingResponse?.embeddings[0]
      if (!vector) {
        throw new Error("Failed to generate embedding for query.")
      }

      // Query 嵌入完成后立即释放 embedder 的 GPU 显存，
      // 让 reranker/highlighter 有更多空间。
      // embedder 是惰性加载的，后续如需重新嵌入会自动重载。
      await this.embedder.dispose?.().catch(() => {})

      // Perform search - 防止调用方传入未验证的参数
      const finalLimit = validateLimit(filter?.limit ?? configMaxResults)
      const finalMinScore = validateMinScore(filter?.minScore ?? configMinScore)

      // Build hybrid search options from config
      const hybridOptions = {
        rawQuery: query, // Pass original query for BM25 sparse encoding
        enabled: this.configManager.hybridSearchEnabled,
        denseWeight: this.configManager.hybridSearchDenseWeight,
        sparseWeight: this.configManager.hybridSearchSparseWeight,
      }

      let results = await this.vectorStore.search(vector, {
        ...filter,
        minScore: finalMinScore,
        limit: finalLimit
      }, hybridOptions)

      // 确保结果按分数降序排序
      results.sort((a, b) => b.score - a.score)

      // If reranker is enabled, rerank the results
      if (this.reranker && results.length > 0) {
        const candidates = results.map(r => ({
          id: r.id,
          content: r.payload?.codeChunk || '',
          score: r.score,
          payload: r.payload
        }))

        const reranked = await this.reranker.rerank(query, candidates)

        // Convert back to VectorStoreSearchResult format, preserving original payload
        results = reranked.map(r => ({
          id: r.id,
          score: r.score, // Use LLM score
          payload: r.payload
        }))

        // Optional: Filter low-score results
        const rerankerMinScore = this.configManager.rerankerConfig?.minScore
        if (rerankerMinScore !== undefined) {
          results = results.filter(r => r.score >= rerankerMinScore)
        }

        // 按 reranker 分数降序重新排序
        results.sort((a, b) => b.score - a.score)
        }

        // If highlighter is enabled, apply line-level semantic highlighting
        if (this.highlighter && results.length > 0) {
          const highlighterConfig = this.configManager.highlighterConfig
          if (highlighterConfig.enabled) {
            const concurrency = highlighterConfig.concurrency ?? 2
            const highlightable = results.filter(
              (r): r is typeof r & { payload: { codeChunk: string; startLine: number } } =>
                !!r.payload?.codeChunk && r.payload?.startLine != null,
            )

            // Process with concurrency control — each highlight() call
            // creates its own LlamaContext, verified thread-safe.
            for (let i = 0; i < highlightable.length; i += concurrency) {
              const batch = highlightable.slice(i, i + concurrency)
              await Promise.all(
                batch.map(async (result) => {
                  try {
                    // Pass precomputed QR ranker scores if available (optimization for qrranker provider)
                    const highlightOptions: import("./interfaces/highlighter").HighlightOptions = {};
                    if (filter?.debugHighlight) {
                      highlightOptions.debugHighlight = true;
                    }
                    const payload = result.payload as Record<string, unknown> | undefined;
                    if (payload?.["_qrrankerPerTokenScores"] && payload?.["_qrrankerCodeText"]) {
                      highlightOptions._qrrankerPerTokenScores = payload["_qrrankerPerTokenScores"] as Float32Array;
                      highlightOptions._qrrankerCodeText = payload["_qrrankerCodeText"] as string;
                      if (payload["_qrrankerTokenTexts"]) {
                        highlightOptions._qrrankerTokenTexts = payload["_qrrankerTokenTexts"] as string[];
                      }
                      highlightOptions._qrrankerChunkScore = result.score;
                    }
                    // Pass precomputed semantic-highlight PruningHead probs (optimization for semantic-highlight provider)
                    if (payload?.["_semanticHighlightTokenProbs"] && payload?.["_semanticHighlightCodeText"]) {
                      highlightOptions._semanticHighlightTokenProbs = payload["_semanticHighlightTokenProbs"] as Float32Array;
                      highlightOptions._semanticHighlightCodeText = payload["_semanticHighlightCodeText"] as string;
                      if (payload["_semanticHighlightTokenTexts"]) {
                        highlightOptions._semanticHighlightTokenTexts = payload["_semanticHighlightTokenTexts"] as string[];
                      }
                      if (payload["_semanticHighlightInput"]) {
                        highlightOptions._semanticHighlightInput = payload["_semanticHighlightInput"] as string;
                      }
                      highlightOptions._semanticHighlightChunkScore = result.score;
                    }
                    const highlightResult = await this.highlighter!.highlight(
                      query,
                      result.payload.codeChunk,
                      result.payload.startLine,
                      highlightOptions,
                    )
                    if (result.payload) {
                      result.payload["highlightedText"] =
                        highlightResult.formattedText
                      result.payload["highlightLines"] =
                        highlightResult.lines
                      if (highlightResult.debugTokenView) {
                        result.payload["debugTokenView"] =
                          highlightResult.debugTokenView
                      }
                    }
                  } catch (err) {
                    console.warn(
                      "[CodeIndexSearchService] Highlighter error for",
                      result.payload?.filePath,
                      ":",
                      err,
                    )
                  }
                }),
              )
            }
          }
        }

        return results
    } catch (error) {
      console.error("[CodeIndexSearchService] Error during search:", error)
      this.stateManager.setSystemState("Error", `Search failed: ${(error as Error).message}`)
      throw error // Re-throw the error after setting state
    }
  }

  /**
   * 释放 reranker 和 highlighter 占用的 GPU/资源。
   * embedder 和 vectorStore 可能被其他组件共享，不由此处释放。
   */
  async dispose(): Promise<void> {
    await this.reranker?.dispose?.()
    await this.highlighter?.dispose?.()
  }
}
