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
   *
   * @returns { chunkScores, perChunkTokenScores }
   *   chunkScores: aggregate score per chunk
   *   perChunkTokenScores: per-KV-token scores for each chunk's token range
   */
  private computeQRScores(
    context: LlamaContext,
    chunkRanges: Array<{ start: number; end: number }>,
    queryStart: number,
    queryEnd: number,
  ): { chunkScores: number[]; perChunkTokenScores: Float32Array[] } {
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

    // Per-KV-position scores aggregated across all QR heads
    const perKvScores = new Float32Array(nKv);

    for (const { layer, head } of QR_HEADS) {
      const layerData = context.getKqSoftMax(layer);
      if (!layerData) {
        this.logger?.warn(`[QRRanker] Layer ${layer} kq_soft_max data missing, skipping head (${layer}, ${head})`);
        continue;
      }

      // Sum attention from each query token to each KV position
      for (let q = queryStart; q < queryEnd; q++) {
        for (let kv = 0; kv < nKv; kv++) {
          perKvScores[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
        }
      }
    }

    // Normalize by (heads × query tokens) so scores are in [0, 1]
    const normalizer = QR_HEADS.length * nQueryTokens;
    if (normalizer > 0) {
      for (let kv = 0; kv < nKv; kv++) {
        perKvScores[kv] /= normalizer;
      }
    }

    // Sum per-chunk aggregate scores and extract per-token slices
    const chunkScores = new Array<number>(nChunks).fill(0);
    const perChunkTokenScores: Float32Array[] = [];

    for (let ci = 0; ci < nChunks; ci++) {
      const { start, end } = chunkRanges[ci];
      const chunkLen = Math.min(end, nKv) - start;
      const tokenScores = new Float32Array(chunkLen);
      let sum = 0;
      for (let kv = start; kv < start + chunkLen; kv++) {
        tokenScores[kv - start] = perKvScores[kv];
        sum += perKvScores[kv];
      }
      chunkScores[ci] = sum;
      perChunkTokenScores.push(tokenScores);
    }

    return { chunkScores, perChunkTokenScores };
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
    this.logger?.info(
      `[QRRanker] Processing ${tokens.length} tokens with batchSize=${ubatch}`,
    );
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

      const { chunkScores, perChunkTokenScores } = this.computeQRScores(context, chunkRanges, queryStart, queryEnd);

      const results: RerankerResult[] = batch.map((candidate, i) => {
        // Slice per-token scores to code region only, so the highlighter can
        // map directly from code tokens to lines without needing to know the
        // chunk's prefix/suffix format (which varies per chunk by title/hierarchy).
        let codeScores = perChunkTokenScores[i];
    let codeTokenIds: number[] = [];
        if (codeScores.length > 0) {
          const chunkStr = this.chunkText(candidate, i);
          const chunkTok = model.tokenize(chunkStr);
          const contentTok = model.tokenize(candidate.content);
          if (contentTok.length > 0 && contentTok.length <= chunkTok.length) {
            const firstId = Number(contentTok[0]);
            const maxStart = chunkTok.length - contentTok.length;
            let codeStart = -1;
            for (let j = 0; j <= maxStart; j++) {
              if (Number(chunkTok[j]) !== firstId) continue;
              let match = true;
              for (let k = 1; k < contentTok.length; k++) {
                if (Number(chunkTok[j + k]) !== Number(contentTok[k])) { match = false; break; }
              }
              if (match) { codeStart = j; break; }
            }
            if (codeStart >= 0) {
              const codeLen = Math.min(contentTok.length, codeScores.length - codeStart);
              if (codeLen > 0 && codeLen < codeScores.length) {
                const sliced = new Float32Array(codeLen);
                for (let j = 0; j < codeLen; j++) sliced[j] = codeScores[codeStart + j];
                codeScores = sliced;
              }
              const chunkStart = chunkRanges[i].start;
              codeTokenIds = Array.from(
                { length: codeLen },
                (_, j) => Number(tokens[chunkStart + codeStart + j]),
              );
            } else {
              // Use CONTEXTUAL token positions to find code start within chunk.
              // perChunkTokenScores[i] is indexed at [chunkRanges[i].start, chunkRanges[i].end),
              // but these ranges were computed from isolated tokenization. BPE boundary merging
              // means the contextual token count and IDs may differ from isolated tokenization.
              // Strategy: group-detokenize the contextual chunk tokens, find the code content's
              // exact character position in the reconstructed text, then map back to token index
              // by re-detokenizing individually and accumulating character lengths.
              const chunkStart = chunkRanges[i].start;
              const chunkEnd = chunkRanges[i].end;
              const contextualChunkTokens = tokens.slice(chunkStart, chunkEnd);
              const detokFull = model.detokenize(contextualChunkTokens);
              const codeCharOffset = detokFull.indexOf(candidate.content.trim());
              let codeStart = -1;
              if (codeCharOffset >= 0) {
                let charPos = 0;
                for (let ti = 0; ti < contextualChunkTokens.length; ti++) {
                  const text = model.detokenize([contextualChunkTokens[ti]]);
                  charPos += text.length;
                  if (charPos >= codeCharOffset) {
                    codeStart = ti;
                    break;
                  }
                }
              }
              if (codeStart < 0) codeStart = 0;
              if (codeStart < codeScores.length) {
                const codeLen = Math.min(contentTok.length, codeScores.length - codeStart);
                if (codeLen > 0) {
                  const sliced = new Float32Array(codeLen);
                  for (let j = 0; j < codeLen; j++) sliced[j] = codeScores[codeStart + j];
                  codeScores = sliced;
                  codeTokenIds = Array.from(
                    { length: codeLen },
                    (_, j) => Number(tokens[chunkStart + codeStart + j]),
                  );
                }
              }
            }
          }
        }
        return {
          id: candidate.id,
          score: chunkScores[i] ?? 0,
          originalScore: candidate.score,
          payload: {
            ...candidate.payload,
            _qrrankerPerTokenScores: codeScores,
            _qrrankerCodeText: candidate.content,
            _qrrankerCodeTokenIds: codeTokenIds,
          },
        };
      });

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
