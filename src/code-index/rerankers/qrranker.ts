import { getLlama, LlamaModel, LlamaContext, LlamaLogLevel, Token } from "@realtimex/node-llama-cpp";
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

// Source layer count for proportional scaling: the original (uncropped)
// Qwen3-4B has 36 transformer blocks. QRRanker was trained on a cropped version
// (keeping only layers 0-24), so QR heads at layers 17-24 correspond to the
// 47%-67% depth range of the full 36-layer architecture.
// When applying to an uncropped model (like MiniCPM), scale relative to 36.
// The QRRanker cropped model (25 blocks) is handled as a special case:
// its layers map 1:1 to the original, so no scaling is needed.
// See docs/plans/260601-qrranker-dynamic-layer-range.md
const QR_ORIGINAL_NLAYER = 36;  // original Qwen3-4B blocks (before cropping)
const QR_QRRANKER_NLAYER = 25;  // QRRanker cropped model blocks

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
  private readonly decodeSteps: number;
  private _model: LlamaModel | null = null;
  private _loadingPromise: Promise<LlamaModel> | null = null;
  private _contexts: LlamaContext[] = [];
  private _contextPoolPromise: Promise<void> | null = null;

  constructor(
    modelPath: string,
    logger?: LoggerLike,
    batchSize: number = 5,
    concurrency: number = 1,
    maxRetries: number = 2,
    retryDelayMs: number = 1000,
    decodeSteps: number = 0,
  ) {
    this.modelPath = modelPath;
    this.logger = logger;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.decodeSteps = Math.max(0, Math.floor(decodeSteps));
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

  // ─── Context Pool ───────────────────────────────────────────────────

  private async _ensureContexts(): Promise<LlamaContext[]> {
    if (this._contexts.length > 0) return this._contexts;
    if (this._contextPoolPromise) {
      await this._contextPoolPromise;
      return this._contexts;
    }

    this._contextPoolPromise = (async () => {
      const model = await this._ensureModel();
      const rawSize = model.trainContextSize ?? 32768;
      const contextSize = Math.min(rawSize, 32768);
      this.logger?.info(
        `[QRRanker] Context pool: contextSize=${contextSize}, batchSize=4096`,
      );
      // Create contexts sequentially to avoid simultaneous VRAM spikes.
      // If some fail due to VRAM pressure, we still get partial pool.
      for (let i = 0; i < this.concurrency; i++) {
        try {
          const ctx = await model.createContext({
            contextSize,
            batchSize: 4096,
            sequences: 1,
            flashAttention: false,
            collectKqSoftMax: true,
          });
          this._contexts.push(ctx);
        } catch (err) {
          this.logger?.warn(
            `[QRRanker] Failed to create context ${i + 1}/${this.concurrency}: ${(err as Error).message}`,
          );
          break;
        }
      }
      this.logger?.info(`[QRRanker] Created ${this._contexts.length} context(s) for pool`);
    })();

    await this._contextPoolPromise;
    return this._contexts;
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

  // ─── Prompt Template ──────────────────────────────────────────────

  /**
   * Return the chat-template components for the current model.
   * Different model families use different turn-delimiter tokens:
   *   - ChatML (Qwen, original QRRanker): <|im_start|> / <|im_end|>
   *   - Gemma:  <start_of_turn> / <end_of_turn>
   */
  private _getPromptTemplate(model: LlamaModel) {
    // Detect the chat template by probing the tokenizer for model-specific
    // turn-delimiter tokens. Gemma models have <start_of_turn> in their
    // vocabulary; ChatML models have <|im_start|>.
    // We check this at the tokenizer level because GGUF metadata paths
    // vary across node-llama-cpp versions.
    const gemmaToken = model.tokenize("<start_of_turn>")[0];
    const isGemma = gemmaToken !== undefined && Number(gemmaToken) > 0;
    const tmpl = isGemma ? {
      userTurn:    "<start_of_turn>user\n",
      userEnd:     "<end_of_turn>\n",
      assistantTurn: "<start_of_turn>model\n",
      assistantPrefix: "Based on the retrieved chunks, the answer is:",
      prefix: "Here are some retrieved chunks:\n\n",
      suffix: "Use the retrieved chunks to answer the user's query.\n\nQuery: ",
    } : {
      userTurn:    "<|im_start|>user\n",
      userEnd:     "<|im_end|>\n",
      assistantTurn: "<|im_start|>assistant\n",
      assistantPrefix: "<think>\n\n</think>\n\n",
      prefix: "Here are some retrieved chunks:\n\n",
      suffix: "Use the retrieved chunks to answer the user's query.\n\nQuery: ",
    };
    return { ...tmpl, isGemma };
  }

  /** Build the formatted chunk text for prompt insertion: "[N] Title: content\n\n" */
  private chunkText(c: RerankerCandidate, index: number): string {
    return `[${index + 1}] Title: ${this.candidateTitle(c, index)}: ${c.content}\n\n`;
  }

  /**
   * Build the QRRanker input prompt using the model-appropriate chat template.
   *
   * The trailing assistant turn prefix triggers the model to enter "answer"
   * mode. For ChatML models a `<think>` block is prepended to encourage the
   * model to reason about the chunks before producing an answer; Gemma models
   * do this internally without explicit think tags.
   * See docs/plans/260605-decode-attention-comparison.md.
   */
  private buildPrompt(query: string, candidates: RerankerCandidate[], model: LlamaModel): string {
    const t = this._getPromptTemplate(model);
    let prompt = t.userTurn + t.prefix;

    for (let i = 0; i < candidates.length; i++) {
      prompt += this.chunkText(candidates[i], i);
    }

    prompt += t.suffix + query + t.userEnd + t.assistantTurn + t.assistantPrefix;

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
    const t = this._getPromptTemplate(model);
    const promptPrefix = t.userTurn + t.prefix;

    // Build the full prompt first
    const fullPrompt = this.buildPrompt(query, candidates, model);
    const tokens = model.tokenize(fullPrompt);

    // Compute chunk ranges using incremental prefix tokenization.
    // This is necessary because BPE tokenizers can merge tokens across
    // adjacent chunk boundaries when the full prompt is tokenized together.
    // Tokenizing each chunk independently and summing their lengths would
    // overcount tokens, producing chunk ranges that exceed the actual
    // token count and cause Float32Array out-of-range errors.
    let cumulativeText = promptPrefix;
    const chunkRanges: Array<{ start: number; end: number }> = [];
    let prevEnd = model.tokenize(promptPrefix).length;

    for (let i = 0; i < candidates.length; i++) {
      cumulativeText += this.chunkText(candidates[i], i);
      const currentEnd = model.tokenize(cumulativeText).length;
      chunkRanges.push({ start: prevEnd, end: currentEnd });
      prevEnd = currentEnd;
    }

    const queryStart = prevEnd;
    const queryEnd = tokens.length;

    this.logger?.debug(
      `[QRRanker] Tokenized: ${tokens.length} tokens, ${chunkRanges.length} chunks, ` +
      `query [${queryStart}, ${queryEnd})`,
    );

    return { tokens, chunkRanges, queryStart, queryEnd };
  }

  // ─── QR Score Computation ───────────────────────────────────────────

  /**
   * Aggregate QR-head attention from the current kq_soft_max state into a
   * single per-KV-position score vector. Each position is the mean attention
   * received across all valid QR heads × query rows in the slice.
   *
   * Used by both prefill (one call after evaluate) and decode (one call per
   * decode step, then averaged). Callers must have set the kq_soft_max query
   * range and run the appropriate evaluate/decode step beforehand.
   */
  private _extractPerKvScoresFromKq(
    context: LlamaContext,
    queryStart: number,
    queryEnd: number,
  ): Float32Array {
    const shape = context.getKqSoftMaxShape();
    const nKv = shape.nKv;
    const nTokens = shape.nTokens;
    const nHead = shape.nHead;
    const nQueryTokens = queryEnd - queryStart;

    const kqShapeInfo = `nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, nLayers=${shape.nLayers}, layers=[${shape.layers.join(",")}]`;

    // Per-KV-position scores aggregated across all QR heads
    const perKvScores = new Float32Array(nKv);
    let validHeads = 0;
    // QR_HEADS was designed for 32-head models. Map proportionally to the
    // actual model's head count so relative positions (low/mid/high) are preserved.
    const QR_SOURCE_NHEAD = 32;

    const mappedHeads: string[] = [];
    // Accumulate missing layer counts so we can emit a single summary log
    // instead of one line per skipped head.
    const missingLayerCounts = new Map<number, number>();
    // totalLayers includes the output layer (+1). Subtract 1 to get actual transformer
    // block count for proportional layer mapping.
    // See docs/plans/260601-qrranker-dynamic-layer-range.md
    const nModelLayerBlocks = context.model.fileInsights.totalLayers - 1;
    for (const { layer: rawLayer, head: rawHead } of QR_HEADS) {
      const head = nHead === QR_SOURCE_NHEAD
        ? rawHead
        : Math.min(Math.round(rawHead * nHead / QR_SOURCE_NHEAD), nHead - 1);
      // Scale layer index proportionally to target model's transformer block count.
      // For the QRRanker cropped model (25 blocks), layers map 1:1 (no scaling).
      // For other models, scale relative to the original 36-layer architecture.
      const layer = nModelLayerBlocks === QR_QRRANKER_NLAYER
        ? rawLayer
        : Math.min(Math.round(rawLayer * nModelLayerBlocks / QR_ORIGINAL_NLAYER), nModelLayerBlocks - 1);
      const layerData = context.getKqSoftMax(layer);
      if (!layerData) {
        missingLayerCounts.set(layer, (missingLayerCounts.get(layer) ?? 0) + 1);
        continue;
      }
      mappedHeads.push(`${layer}:${head}`);

      // Sum attention from each query token to each KV position.
      // After C++ slice filtering, nTokens = nQueryTokens and data layout
      // is [head][0..nQueryTokens)[kv] instead of the full token range.
      // q indices are now 0-relative (0 = first query token).
      for (let q = 0; q < nQueryTokens; q++) {
        for (let kv = 0; kv < nKv; kv++) {
          perKvScores[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
        }
      }
      validHeads++;
    }

    const headsLog = `[QRRanker] QR heads (nHead=${nHead}): ${mappedHeads.join(" ")}`;
    if (missingLayerCounts.size > 0) {
      const summary = [...missingLayerCounts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([layer, count]) => `Layer ${layer} (×${count})`)
        .join(", ");
      this.logger?.debug(`${headsLog}  |  skipped: ${summary}  |  kq: ${kqShapeInfo}`);
    } else {
      this.logger?.debug(`${headsLog}  |  kq: ${kqShapeInfo}`);
    }

    // Normalize by (validHeads × query tokens) so scores are in [0, 1]
    const normalizer = validHeads * nQueryTokens;
    if (normalizer > 0) {
      for (let kv = 0; kv < nKv; kv++) {
        perKvScores[kv] /= normalizer;
      }
    }

    return perKvScores;
  }

  /**
   * Slice the aggregated per-KV scores into per-chunk score totals and
   * per-chunk per-token slices (used to feed the highlighter).
   */
  private computeChunkScores(
    perKvScores: Float32Array,
    chunkRanges: Array<{ start: number; end: number }>,
  ): { chunkScores: number[]; perChunkTokenScores: Float32Array[] } {
    const nKv = perKvScores.length;
    const nChunks = chunkRanges.length;
    const chunkScores = new Array<number>(nChunks).fill(0);
    const perChunkTokenScores: Float32Array[] = [];

    // Track which chunks get zero scores due to exceed the model's
    // kq_soft_max KV limit (nKv < chunk start).
    let skippedChunks = 0;

    for (let ci = 0; ci < nChunks; ci++) {
      const { start, end } = chunkRanges[ci];
      const chunkLen = Math.min(end, nKv) - start;
      if (chunkLen <= 0) {
        skippedChunks++;
        // Chunk is beyond the KV cache — give it zero score.
        perChunkTokenScores.push(new Float32Array(0));
        continue;
      }
      const tokenScores = new Float32Array(chunkLen);
      let sum = 0;
      for (let kv = start; kv < start + chunkLen; kv++) {
        tokenScores[kv - start] = perKvScores[kv];
        sum += perKvScores[kv];
      }
      chunkScores[ci] = sum;
      perChunkTokenScores.push(tokenScores);
    }

    if (skippedChunks > 0) {
      this.logger?.warn(
        `[QRRanker] ${skippedChunks}/${nChunks} chunks exceed kq_soft_max KV ` +
        `capacity (nKv=${nKv}), assigned zero rerank score`,
      );
    }

    return { chunkScores, perChunkTokenScores };
  }

  /**
   * Decode-stage attention: prefill, then sample N greedy tokens, reading
   * per-position kq_soft_max at each decode step. Returns the average of
   * the N per-position per-kv score vectors.
   *
   * Flow (using evaluate() async generator):
   *   iter 1: prefill + sample token_1   (no attention read; prefill slice is unused)
   *   iter k (k >= 2): decode token_{k-1} at position promptLength + k - 2
   *     BEFORE next(): setKqSoftMaxQueryRange(decodePos, decodePos + 1)
   *     AFTER  next(): read kq_soft_max for that single position
   *
   * Note: this runs in listwise mode — the model is generating a single
   * "summary" of all batched candidates. The averaged attention reflects
   * "the model's focus while drafting a holistic answer" and should weight
   * the truly relevant candidates higher.
   */
  private async _collectDecodeStageAttention(
    context: LlamaContext,
    sequence: ReturnType<LlamaContext["getSequence"]>,
    tokens: Token[],
    queryStart: number,
    queryEnd: number,
    model: LlamaModel,
  ): Promise<Float32Array> {
    const N = this.decodeSteps;
    const promptLength = tokens.length;

    // First set query range to the prefill range so cbEval has a valid
    // initial slice (the prefill row data is unused; only decode positions
    // are read below). This keeps C++ state consistent.
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);
    const prefillStart = Date.now();
    const gen = sequence.evaluate(tokens, { temperature: 0.6 });

    // iter 1: prefill + sample token_1
    const first = await gen.next();
    const prefillTime = Date.now() - prefillStart;
    if (first.done || !first.value) {
      this.logger?.warn(
        `[QRRanker] Decode generator ended before producing first token; ` +
        `falling back to prefill attention (prefill: ${prefillTime}ms)`,
      );
      return this._extractPerKvScoresFromKq(context, queryStart, queryEnd);
    }

    // Collect per-position attention, then average.
    const decodeStart = Date.now();
    const scoreStack: Float32Array[] = [];
    const generatedTokens: Token[] = [first.value]; // include the first sampled token
    for (let i = 0; i < N; i++) {
      const decodePos = promptLength + i;
      context.setKqSoftMaxQueryRange(decodePos, decodePos + 1);
      const step = await gen.next();
      if (step.done || !step.value) {
        this.logger?.debug(
          `[QRRanker] Decode stopped early at iter ${i + 2}/${N + 1}`,
        );
        break;
      }
      // After this .next() returns, the kq_soft_max contains attention from
      // the single query token at decodePos. nQueryTokens will be 1.
      const stepScores = this._extractPerKvScoresFromKq(context, decodePos, decodePos + 1);
      scoreStack.push(stepScores);
      generatedTokens.push(step.value);
    }

    const decodeTime = Date.now() - decodeStart;

    // Close the async generator to release the underlying sequence.
    // Without this, the sequence stays "in use" and subsequent batches
    // fail with "No sequences left" (context pool exhaustion).
    await gen.return(undefined);

    // Log the full generated text (推理输出)
    const fullText = model.detokenize(generatedTokens);
    this.logger?.info(
      `[QRRanker] Decode-stage inference output (${generatedTokens.length} tokens, ${scoreStack.length}/${N} positions) ` +
      `[prefill: ${prefillTime}ms, decode: ${decodeTime}ms]:\n${fullText}`,
    );

    if (scoreStack.length === 0) {
      this.logger?.warn(
        `[QRRanker] No decode positions captured; falling back to prefill attention`,
      );
      return this._extractPerKvScoresFromKq(context, queryStart, queryEnd);
    }

    // Average per-KV-position scores across all captured decode steps.
    const nKv = scoreStack[0].length;
    const avg = new Float32Array(nKv);
    for (const s of scoreStack) {
      for (let kv = 0; kv < nKv; kv++) avg[kv] += s[kv];
    }
    const denom = scoreStack.length;
    for (let kv = 0; kv < nKv; kv++) avg[kv] /= denom;
    return avg;
  }

  // ─── IReranker Interface ────────────────────────────────────────────

  async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
    if (candidates.length === 0) return [];

    await this._ensureModel();
    const contexts = await this._ensureContexts();
    const t0 = Date.now();

    if (contexts.length === 0) {
      this.logger?.warn("[QRRanker] No pooled contexts available, returning original scores");
      return candidates.map(c => ({
        id: c.id,
        score: c.score ?? 0,
        originalScore: c.score,
        payload: c.payload,
      }));
    }

    // Single batch — fast path
    if (candidates.length <= this.batchSize) {
      const results = await this._rerankBatch(contexts[0], query, candidates);
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
        group.map((batch, j) =>
          this._rerankBatchWithRetry(query, batch, contexts[j % contexts.length]),
        ),
      );
      for (const results of groupResults) {
        allResults.push(...results);
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    this._logResults(allResults, candidates, Date.now() - t0);
    return allResults;
  }

  /** Run QRRanker on a single batch of candidates using a pooled context. */
  private async _rerankBatch(
    context: LlamaContext,
    query: string,
    batch: RerankerCandidate[],
  ): Promise<RerankerResult[]> {
    const model = this._model!;

    // Tokenize and compute chunk ranges (uses incremental prefix tokenization
    // to avoid BPE cross-boundary merging mismatches).
    const { tokens, chunkRanges, queryStart, queryEnd } =
      this.tokenizeWithChunkRanges(model, query, batch);

    // Ensure context is large enough for this batch.
    // If the pooled context (at trainContextSize) is sufficient, use it directly;
    // otherwise create a one-off larger context.
    // +decodeSteps reserves room for the N tokens that the decode path will sample.
    const neededSize = tokens.length + 1024 + this.decodeSteps;
    if (context.contextSize < neededSize) {
      this.logger?.warn(
        `[QRRanker] Batch tokens (${tokens.length}) + decodeSteps (${this.decodeSteps}) ` +
        `exceed pooled context size (${context.contextSize}), ` +
        `creating temporary context of size ${neededSize}`,
      );
      const tempContext = await model.createContext({
        contextSize: Math.min(model.trainContextSize ?? 32768, neededSize),
        batchSize: 4096,
        sequences: 1,
        flashAttention: false,
        collectKqSoftMax: true,
      }) as LlamaContext;
      try {
        return await this._runQrPass(tempContext, model, tokens, chunkRanges, queryStart, queryEnd, batch);
      } finally {
        await tempContext.dispose();
      }
    }

    this.logger?.info(
      `[QRRanker] Processing ${tokens.length} tokens with batchSize=4096`,
    );
    return await this._runQrPass(context, model, tokens, chunkRanges, queryStart, queryEnd, batch);
  }

  /** Execute the QR forward pass and produce results. */
  private async _runQrPass(
    context: LlamaContext,
    model: LlamaModel,
    tokens: Token[],
    chunkRanges: Array<{ start: number; end: number }>,
    queryStart: number,
    queryEnd: number,
    batch: RerankerCandidate[],
  ): Promise<RerankerResult[]> {
    const sequence = context.getSequence();
    // Set query range so C++ cbEval only copies query token rows,
    // avoiding the V8 ArrayBuffer 4GB limit for long inputs.
    // See docs/plans/260523-qrranker-ubatch-overflow-fix.md
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);

    // Scale the layer range to the target model's transformer block count.
    // totalLayers includes the output layer (+1). Subtract 1 to get the actual
    // number of transformer blocks for proportional mapping.
    //
    // Two cases:
    //   1. QRRanker cropped model (25 blocks): use identity [17, 25).
    //      The cropping preserved original layer numbering 1:1.
    //   2. Other models (e.g., MiniCPM 24 blocks, original Qwen3-4B 36 blocks):
    //      scale proportionally using the original 36-layer architecture as source.
    const nModelLayerBlocks = model.fileInsights.totalLayers - 1;
    if (nModelLayerBlocks !== QR_QRRANKER_NLAYER) {
      const mappedStart = Math.round(QR_START_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      const mappedEnd = Math.round(QR_END_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      context.setKqSoftMaxLayerRange(mappedStart, mappedEnd);
      this.logger?.debug(
        `[QRRanker] Layer range scaled: ${QR_ORIGINAL_NLAYER}→${nModelLayerBlocks} blocks, ` +
        `range [${mappedStart}, ${mappedEnd})`,
      );
    }

    // Run forward pass and collect per-KV scores.
    //   - prefill mode: 1 evaluate() with no generation, scores are read straight
    //     from kq_soft_max after the call.
    //   - decode mode:  prefill + N greedy decode steps; we average N per-position
    //     kq_soft_max reads into a single per-kv vector.
    let perKvScores: Float32Array;
    if (this.decodeSteps > 0) {
      perKvScores = await this._collectDecodeStageAttention(
        context, sequence, tokens, queryStart, queryEnd, model,
      );
    } else {
      await sequence.evaluateWithoutGeneratingNewTokens(tokens);
      perKvScores = this._extractPerKvScoresFromKq(context, queryStart, queryEnd);
    }

    // Reset the sequence so the pooled context can be reused for the next batch.
    // Without this, the KV cache fills up and subsequent batches fail with
    // "No sequences left" (context pool exhaustion).
    await sequence.clearHistory();
    // dispose() releases the sequence slot back to the context pool.
    // getSequence() allocates a NEW sequence each call, so we must free it
    // after each batch or the pool exhausts (sequences: 1 per context).
    sequence.dispose();

    this.logger?.debug(
      `[QRRanker] Batch done: ${tokens.length} tokens, ${batch.length} docs, ` +
      `mode=${this.decodeSteps > 0 ? `decode(N=${this.decodeSteps})` : "prefill"}` +
      `, nKv=${perKvScores.length}`,
    );

    const { chunkScores, perChunkTokenScores } = this.computeChunkScores(
      perKvScores, chunkRanges,
    );

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
          _qrrankerTokenTexts: codeTokenIds.map((id) => model.detokenize([id as unknown as Token])),
        },
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private async _rerankBatchWithRetry(
    query: string,
    batch: RerankerCandidate[],
    context: LlamaContext,
  ): Promise<RerankerResult[]> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._rerankBatch(context, query, batch);
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
    for (const ctx of this._contexts) {
      await ctx.dispose();
    }
    this._contexts = [];
    this._contextPoolPromise = null;
    if (this._model) {
      await this._model.dispose();
      this._model = null;
      this._loadingPromise = null;
    }
  }
}
