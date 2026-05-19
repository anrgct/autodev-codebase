import { getLlama, LlamaModel, LlamaContext, LlamaLogLevel, Token } from "node-llama-cpp";
import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces";
import { Logger } from "../../utils/logger";

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">;

// QR head configuration from QRRanker config.json (qr_head_list_mapped)
// Each entry is [layer, head] (0-indexed)
const QR_HEADS: Array<{ layer: number; head: number }> = [
  { layer: 20, head: 15 }, { layer: 21, head: 11 }, { layer: 17, head: 27 },
  { layer: 23, head: 10 }, { layer: 22, head:  4 }, { layer: 21, head: 10 },
  { layer: 21, head:  8 }, { layer: 21, head: 18 }, { layer: 18, head: 15 },
  { layer: 18, head: 19 }, { layer: 17, head: 25 }, { layer: 17, head: 17 },
  { layer: 24, head: 13 }, { layer: 17, head:  4 }, { layer: 19, head: 12 },
  { layer: 21, head: 31 },
];

const QR_START_LAYER = 17;
const QR_END_LAYER = 25; // exclusive

/**
 * QRRanker: listwise document reranker using QR attention heads.
 *
 * Loads a QRRanker GGUF model and scores candidates by extracting attention weights
 * from specific (layer, head) pairs during a single forward pass.
 *
 * The model must be converted from MindscapeRAG/QRRanker using the conversion script
 * at vendor/llama-addon/ (see docs/plans/260519-qrranker-gguf-convert.md).
 */
export class QRRankerReranker implements IReranker {
  private readonly modelPath: string;
  private readonly logger?: LoggerLike;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private _model: LlamaModel | null = null;
  private _loadingPromise: Promise<LlamaModel> | null = null;

  constructor(
    modelPath: string,
    logger?: LoggerLike,
    batchSize: number = 5,
    concurrency: number = 1,
    maxRetries: number = 2,
    retryDelayMs: number = 1000,
  ) {
    this.modelPath = modelPath;
    this.logger = logger;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  // ─── Model Loading ──────────────────────────────────────────────────

  private async _ensureModel(): Promise<LlamaModel> {
    if (this._model) return this._model;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      this.logger?.info(`[QRRanker] Loading model: ${this.modelPath}`);
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled, gpu: "metal" });
      this._model = await llama.loadModel({ modelPath: this.modelPath });
      this.logger?.info(`[QRRanker] Model loaded`);
      return this._model;
    })();

    return this._loadingPromise;
  }

  // ─── Prompt Construction ────────────────────────────────────────────

  /** Build the title label for a candidate: "filePath > hierarchyDisplay" when both present. */
  private candidateTitle(c: RerankerCandidate, index: number): string {
    const file = (c.payload?.filePath as string) ?? (c.payload?.title as string) ?? "";
    const hierarchy = (c.payload?.hierarchyDisplay as string) ?? "";
    if (file && hierarchy) return `${file} > ${hierarchy}`;
    if (hierarchy) return hierarchy;
    if (file) return file;
    return `Document ${index + 1}`;
  }

  /** Build the formatted chunk text for prompt insertion: "[N] Title: content\n\n" */
  private chunkText(c: RerankerCandidate, index: number): string {
    return `[${index + 1}] Title: ${this.candidateTitle(c, index)}: ${c.content}\n\n`;
  }

  /**
   * Build the QRRanker input prompt in the same format as the Python/C++ demo.
   */
  private buildPrompt(query: string, candidates: RerankerCandidate[]): string {
    let prompt = "<|im_start|>user\nHere are some retrieved chunks:\n\n";

    for (let i = 0; i < candidates.length; i++) {
      prompt += this.chunkText(candidates[i], i);
    }

    prompt += `Use the retrieved chunks to answer the user's query.\n\nQuery: ${query}`;
    return prompt;
  }

  // ─── Tokenization & Chunk Ranges ────────────────────────────────────

  /**
   * Tokenize the full prompt and compute token ranges for each candidate chunk.
   */
  private tokenizeWithChunkRanges(
    model: LlamaModel,
    query: string,
    candidates: RerankerCandidate[],
  ): {
    tokens: Token[];
    chunkRanges: Array<{ start: number; end: number }>;
    queryStart: number;
    queryEnd: number;
  } {
    const promptPrefix = "<|im_start|>user\nHere are some retrieved chunks:\n\n";

    // Tokenize prefix to find starting offset
    const prefixTokens = model.tokenize(promptPrefix);
    let tokenOffset = prefixTokens.length;

    const chunkRanges: Array<{ start: number; end: number }> = [];

    // Tokenize each chunk individually to compute ranges
    for (let i = 0; i < candidates.length; i++) {
      const chunkTokens = model.tokenize(this.chunkText(candidates[i], i));
      chunkRanges.push({ start: tokenOffset, end: tokenOffset + chunkTokens.length });
      tokenOffset += chunkTokens.length;
    }

    // Tokenize the query closing part
    const queryPart = `Use the retrieved chunks to answer the user's query.\n\nQuery: ${query}`;
    const queryTokens = model.tokenize(queryPart);
    const queryStart = tokenOffset;
    const queryEnd = tokenOffset + queryTokens.length;

    // Build the full token sequence
    const fullPrompt = this.buildPrompt(query, candidates);
    const tokens = model.tokenize(fullPrompt);

    this.logger?.debug(
      `[QRRanker] Tokenized: ${tokens.length} tokens, ${chunkRanges.length} chunks, ` +
      `query [${queryStart}, ${queryEnd})`,
    );

    return { tokens, chunkRanges, queryStart, queryEnd };
  }

  // ─── QR Score Computation ───────────────────────────────────────────

  /**
   * Compute QR relevance scores from collected kq_soft_max attention data.
   *
   * kq_soft_max tensor layout (row-major):
   *   ne[0] = n_kv    (KV cache dimension)
   *   ne[1] = n_tokens (query tokens dimension)
   *   ne[2] = n_head   (attention heads dimension)
   *   ne[3] = 1
   *
   * Element access: data[head * n_tokens * n_kv + tok * n_kv + kv]
   */
  private computeQRScores(
    context: LlamaContext,
    chunkRanges: Array<{ start: number; end: number }>,
    queryStart: number,
    queryEnd: number,
  ): number[] {
    const shape = context.getKqSoftMaxShape();
    const nKv = shape.nKv;
    const nTokens = shape.nTokens;
    const nHead = shape.nHead;
    const nChunks = chunkRanges.length;
    const nQueryTokens = queryEnd - queryStart;

    this.logger?.debug(
      `[QRRanker] kq_soft_max shape: nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, ` +
      `nLayers=${shape.nLayers}, layers=[${shape.layers.join(",")}]`,
    );

    const chunkScores = new Array<number>(nChunks).fill(0);

    for (const { layer, head } of QR_HEADS) {
      const layerData = context.getKqSoftMax(layer);
      if (!layerData) {
        this.logger?.warn(`[QRRanker] Layer ${layer} kq_soft_max data missing, skipping head (${layer}, ${head})`);
        continue;
      }

      // Mean attention over query tokens for this head
      const attnPerKv = new Float32Array(nKv);
      for (let q = queryStart; q < queryEnd; q++) {
        for (let kv = 0; kv < nKv; kv++) {
          attnPerKv[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
        }
      }
      for (let kv = 0; kv < nKv; kv++) {
        attnPerKv[kv] /= nQueryTokens;
      }

      // Sum over each chunk's token range
      for (let ci = 0; ci < nChunks; ci++) {
        const { start, end } = chunkRanges[ci];
        let sum = 0;
        for (let kv = start; kv < end && kv < nKv; kv++) {
          sum += attnPerKv[kv];
        }
        chunkScores[ci] += sum;
      }
    }

    return chunkScores;
  }

  // ─── IReranker Interface ────────────────────────────────────────────

  async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
    if (candidates.length === 0) return [];

    const model = await this._ensureModel();
    const t0 = Date.now();

    // Single batch — fast path
    if (candidates.length <= this.batchSize) {
      const results = await this._rerankBatch(model, query, candidates);
      this._logResults(results, candidates, Date.now() - t0);
      return results;
    }

    // Split into batches and process with concurrency
    const batches: RerankerCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += this.batchSize) {
      batches.push(candidates.slice(i, i + this.batchSize));
    }

    const allResults: RerankerResult[] = [];
    for (let i = 0; i < batches.length; i += this.concurrency) {
      const group = batches.slice(i, i + this.concurrency);
      const groupResults = await Promise.all(
        group.map((batch) => this._rerankBatchWithRetry(model, query, batch)),
      );
      for (const results of groupResults) {
        allResults.push(...results);
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    this._logResults(allResults, candidates, Date.now() - t0);
    return allResults;
  }

  /** Run QRRanker on a single batch of candidates. */
  private async _rerankBatch(
    model: LlamaModel,
    query: string,
    batch: RerankerCandidate[],
  ): Promise<RerankerResult[]> {
    // Tokenize and compute chunk ranges
    const { tokens, chunkRanges, queryStart, queryEnd } =
      this.tokenizeWithChunkRanges(model, query, batch);

    // Create context with kq_soft_max collection enabled
    const ubatch = Math.min(tokens.length, 8192);
    if (tokens.length > 8192) {
      this.logger?.warn(
        `[QRRanker] Input (${tokens.length} tokens) exceeds max batch (8192). ` +
        `Results may be incomplete.`,
      );
    }
    const context = await model.createContext({
      contextSize: Math.max(32768, tokens.length + 256),
      batchSize: ubatch,
      sequences: 1,
      flashAttention: false,
      collectKqSoftMax: true,
    }) as LlamaContext;

    try {
      const sequence = context.getSequence();
      await sequence.evaluateWithoutGeneratingNewTokens(tokens);
      this.logger?.debug(
        `[QRRanker] Batch done: ${tokens.length} tokens, ${batch.length} docs`,
      );

      const scores = this.computeQRScores(context, chunkRanges, queryStart, queryEnd);

      const results: RerankerResult[] = batch.map((candidate, i) => ({
        id: candidate.id,
        score: scores[i] ?? 0,
        originalScore: candidate.score,
        payload: candidate.payload,
      }));

      results.sort((a, b) => b.score - a.score);
      return results;
    } finally {
      await context.dispose();
    }
  }

  private async _rerankBatchWithRetry(
    model: LlamaModel,
    query: string,
    batch: RerankerCandidate[],
  ): Promise<RerankerResult[]> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._rerankBatch(model, query, batch);
      } catch (err) {
        if (attempt >= this.maxRetries) {
          this.logger?.warn(
            `[QRRanker] Batch failed after ${attempt} attempts: ${(err as Error).message}`,
          );
          return batch.map((c) => ({
            id: c.id,
            score: 0,
            originalScore: c.score,
            payload: c.payload,
          }));
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }
    return [];
  }

  private _logResults(
    results: RerankerResult[],
    candidates: RerankerCandidate[],
    elapsed: number,
  ): void {
    if (!this.logger?.debug) return;
    const parts: string[] = [`[QRRanker] ${results.length} docs in ${elapsed}ms, Scores:`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const c = candidates.find((c) => c.id === r.id);
      const file = (r.payload?.filePath as string) ?? (r.payload?.title as string) ?? `#${r.id}`;
      const preview = (c?.payload?.hierarchyDisplay ?? "").slice(0, 50).replace(/\n/g, " ");
      parts.push(`#${i + 1} ${r.score.toFixed(4)} ${file} "${preview}"`);
    }
    this.logger.debug(parts.join("  "));
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs");
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `QRRanker model file not found: ${this.modelPath}` };
      }
      const model = await this._ensureModel();
      if (!model) {
        return { valid: false, error: "Failed to load QRRanker model" };
      }
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "QRRanker validation failed",
      };
    }
  }

  get rerankerInfo(): RerankerInfo {
    return {
      name: "qrranker",
      model: this.modelPath,
    };
  }

  /** Clean up resources */
  async dispose(): Promise<void> {
    if (this._model) {
      await this._model.dispose();
      this._model = null;
      this._loadingPromise = null;
    }
  }
}
