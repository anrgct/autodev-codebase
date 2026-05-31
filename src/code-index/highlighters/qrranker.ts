import { getLlama, LlamaModel, LlamaContext, LlamaLogLevel, Token } from "@realtimex/node-llama-cpp";
import type {
  IHighlighter,
  HighlightLine,
  HighlightResult,
  HighlighterInfo,
  HighlightOptions,
} from "../interfaces/highlighter";
import type { Logger } from "../../utils/logger";

// ─── Debug Highlight: ANSI Color Helpers ────────────────────────────────

const ANSI_RESET = "\x1b[0m";

/**
 * Map a score ratio (0~1) to ANSI 256-color foreground code.
 * Gradient: dark gray → blue → green → yellow → orange → red.
 */
function scoreRatioToAnsiFg(ratio: number): string {
  if (ratio <= 0) return "\x1b[38;5;237m"; // near-invisible
  if (ratio < 0.05) return "\x1b[38;5;240m"; // dark gray
  if (ratio < 0.15) return "\x1b[38;5;33m";  // blue
  if (ratio < 0.3)  return "\x1b[38;5;45m";  // light blue
  if (ratio < 0.45) return "\x1b[38;5;47m";  // green
  if (ratio < 0.55) return "\x1b[38;5;119m"; // light green
  if (ratio < 0.65) return "\x1b[38;5;215m"; // yellow (dimmed)
  if (ratio < 0.75) return "\x1b[38;5;214m"; // orange
  if (ratio < 0.9)  return "\x1b[38;5;202m"; // dark orange
  return "\x1b[38;5;196m"; // bright red
}

/** Score-to-foreground-color with relative scaling by maxScore. */
function scoreToAnsiFg(score: number, maxScore: number): string {
  if (maxScore <= 0) return "\x1b[38;5;237m";
  return scoreRatioToAnsiFg(Math.min(score / (maxScore * 1.15), 1));
}

/**
 * Build a colorized token heatmap string from per-token scores.
 * Merges line-level score bars (left) with token-level colored text (right),
 * one line per code line.
 */
function buildTokenHeatmap(
  tokens: Token[],
  codeStart: number,
  codeEnd: number,
  perTokenScores: Float32Array,
  detokenizeFn: (tok: Token) => string,
  codeChunk: string,
  startLine: number,
  lineScores: number[], // precomputed from tokensToLines for bar consistency
): string {
  const codeTokenCount = codeEnd - codeStart;
  if (codeTokenCount === 0) return "";

  // Find max score in code region for adaptive color scaling
  let maxScore = 0;
  for (let i = codeStart; i < codeEnd; i++) {
    if (perTokenScores[i] > maxScore) maxScore = perTokenScores[i];
  }

  const codeLines = codeChunk.split("\n");
  const codeChars = codeChunk.length;
  const barWidth = 10;

  // Pre-collect detokenized texts
  const tokenTexts: string[] = new Array(codeTokenCount);
  for (let ti = 0; ti < codeTokenCount; ti++) {
    tokenTexts[ti] = detokenizeFn(tokens[codeStart + ti]);
  }

  // Pre-compute each code line's character range in codeChunk.
  // Each line (except the last) includes a trailing \n separator character.
  const lineCharEnds: number[] = new Array(codeLines.length);
  let charAcc = 0;
  for (let li = 0; li < codeLines.length; li++) {
    charAcc += codeLines[li].length + (li < codeLines.length - 1 ? 1 : 0);
    lineCharEnds[li] = charAcc;
  }

  // Build per-line token parts (colored text) from per-token scores
  const lineTokenParts: string[][] = Array.from({ length: codeLines.length }, () => []);

  let detokAcc = 0;
  for (let ti = 0; ti < codeTokenCount; ti++) {
    const score = perTokenScores[codeStart + ti] || 0;
    const text = tokenTexts[ti];

    // Windowed search: detokAcc gives approximate position, indexOf
    // refines it within a narrow window to avoid distant substring collisions.
    let codePos: number;
    if (text.length > 0) {
      const searchFrom = Math.max(0, detokAcc - 5);
      const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
      const idx = codeChunk.indexOf(text, searchFrom);
      if (idx >= 0 && idx < searchTo) {
        codePos = idx;
        detokAcc = idx + text.length;
      } else {
        codePos = detokAcc;
        detokAcc += text.length; // drift, but constrained
      }
    } else {
      codePos = detokAcc;
    }

    if (codePos < 0 || codePos >= codeChars) continue;

    let lineStart = 0;
    for (let li = 0; li < codeLines.length; li++) {
      if (codePos >= lineStart && codePos < lineCharEnds[li]) {
        const color = scoreToAnsiFg(score, maxScore);
        if (/\r?\n/.test(text)) {
          // Token spans multiple lines: split and distribute across consecutive lines
          const segments = text.split(/\r?\n/);
          for (let si = 0; si < segments.length && (li + si) < codeLines.length; si++) {
            if (segments[si].length > 0) {
              lineTokenParts[li + si].push(`${color}${segments[si]}${ANSI_RESET}`);
            } else if (si > 0 && si < segments.length - 1) {
              lineTokenParts[li + si].push(`${color}↵${ANSI_RESET}`);
            }
          }
          if (segments.length > 1) {
            lineTokenParts[li].push(`${color}↵${ANSI_RESET}`);
          }
        } else if (text.length > 0) {
          lineTokenParts[li].push(`${color}${text}${ANSI_RESET}`);
        }
        break;
      }
      lineStart = lineCharEnds[li];
    }
  }

  // Use the passed-in lineScores for bars (same as tokensToLines for selection)
  const maxLineScore = Math.max(...lineScores, 0.00001);

  // Build merged line-by-line output
  const mergedParts: string[] = [];
  for (let li = 0; li < codeLines.length; li++) {
    const s = lineScores[li];
    const filled = Math.round((s / maxLineScore) * barWidth);
    const bar =
      `${scoreToAnsiFg(s, maxScore)}█${ANSI_RESET}`.repeat(filled) +
      "░".repeat(barWidth - filled);
    const lineNum = String(startLine + li).padStart(4);
    const tokenSide = lineTokenParts[li].join("");
    const rightSide = tokenSide || `${ANSI_RESET}${codeLines[li]}`;
    const scoreStr = s.toFixed(6);
    mergedParts.push(`  ${lineNum} ${bar} ${scoreStr} │  ${rightSide}`);
  }

  // Legend
  const legendSteps = [
    { label: "low", ratio: 0.05 },
    { label: "", ratio: 0.3 },
    { label: "med", ratio: 0.5 },
    { label: "", ratio: 0.7 },
    { label: "high", ratio: 1.0 },
  ];
  const legendStr = legendSteps
    .map(({ label, ratio }) => `${scoreRatioToAnsiFg(ratio)}■${ANSI_RESET}${label}`)
    .join("  ");

  const total = codeTokenCount;
  const sum = Array.from(perTokenScores.slice(codeStart, codeEnd)).reduce((a, b) => a + b, 0);
  const mean = total > 0 ? sum / total : 0;
  let minScore = Infinity;
  for (let i = codeStart; i < codeEnd; i++) {
    if (perTokenScores[i] < minScore) minScore = perTokenScores[i];
  }
  if (minScore === Infinity) minScore = 0;

  return [
    `${ANSI_RESET}═══ Token Attention Heatmap ═══`,
    ...mergedParts,
    `\n─── Stats ───`,
    `  Tokens: ${total}  |  max=${maxScore.toFixed(6)}  min=${minScore.toFixed(6)}  mean=${mean.toFixed(6)}`,
    `  Legend: ${legendStr}`,
    `═══════════════════════════════`,
  ].join("\n");
}

/**
 * Build debug heatmap using pre-detokenized token texts from the reranker.
 * Uses exact BPE boundaries (same as original buildTokenHeatmap) but no model needed.
 */
function buildTokenHeatmapFromTexts(
  texts: string[],
  perTokenScores: Float32Array,
  codeChunk: string,
  startLine: number,
  lineScores: number[],
  chunkScore?: number,
): string {
  const totalTokens = texts.length;
  if (totalTokens === 0) return "";

  let maxScore = 0;
  for (let i = 0; i < totalTokens; i++) {
    if (perTokenScores[i] > maxScore) maxScore = perTokenScores[i];
  }

  const codeLines = codeChunk.split("\n");
  const codeChars = codeChunk.length;
  const barWidth = 10;

  const lineCharEnds: number[] = new Array(codeLines.length);
  let charAcc = 0;
  for (let li = 0; li < codeLines.length; li++) {
    charAcc += codeLines[li].length + (li < codeLines.length - 1 ? 1 : 0);
    lineCharEnds[li] = charAcc;
  }

  const lineTokenParts: string[][] = Array.from({ length: codeLines.length }, () => []);
  const maxLineScore = Math.max(...lineScores, 0.00001);

  let detokAcc = 0;
  for (let ti = 0; ti < totalTokens; ti++) {
    const score = perTokenScores[ti] || 0;
    const text = texts[ti];

    // Windowed search: detokAcc gives approximate position, indexOf
    // refines it within a narrow window to avoid distant substring collisions.
    let codePos: number;
    if (text.length > 0) {
      const searchFrom = Math.max(0, detokAcc - 5);
      const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
      const idx = codeChunk.indexOf(text, searchFrom);
      if (idx >= 0 && idx < searchTo) {
        codePos = idx;
        detokAcc = idx + text.length;
      } else {
        codePos = detokAcc;
        detokAcc += text.length; // drift, but constrained
      }
    } else {
      codePos = detokAcc;
    }

    if (codePos < 0 || codePos >= codeChars) continue;

    let lineStart = 0;
    for (let li = 0; li < codeLines.length; li++) {
      if (codePos >= lineStart && codePos < lineCharEnds[li]) {
        const color = scoreToAnsiFg(score, maxScore);
        if (/\r?\n/.test(text)) {
          // Token spans multiple lines: split and distribute across consecutive lines
          const segments = text.split(/\r?\n/);
          for (let si = 0; si < segments.length && (li + si) < codeLines.length; si++) {
            const seg = segments[si];
            if (seg.length > 0) {
              const visible = /^\s+$/.test(seg) ? "░".repeat(Math.max(1, seg.length)) : seg;
              lineTokenParts[li + si].push(`${color}${visible}${ANSI_RESET}`);
            } else if (si > 0 && si < segments.length - 1) {
              // Empty intermediate segment: blank line consumed by this BPE token
              lineTokenParts[li + si].push(`${color}↵${ANSI_RESET}`);
            }
          }
          // Mark BPE token boundary at end of anchor line
          if (segments.length > 1) {
            lineTokenParts[li].push(`${color}↵${ANSI_RESET}`);
          }
        } else if (text.length > 0) {
          const visible = /^\s+$/.test(text) ? "░".repeat(Math.max(1, text.length)) : text;
          lineTokenParts[li].push(`${color}${visible}${ANSI_RESET}`);
        }
        break;
      }
      lineStart = lineCharEnds[li];
    }
  }

  const mergedParts: string[] = [];
  for (let li = 0; li < codeLines.length; li++) {
    const s = lineScores[li];
    const filled = Math.round((s / maxLineScore) * barWidth);
    const bar =
      `${scoreToAnsiFg(s, maxScore)}█${ANSI_RESET}`.repeat(filled) +
      "░".repeat(barWidth - filled);
    const lineNum = String(startLine + li).padStart(4);
    const tokenSide = lineTokenParts[li].join("");
    const rightSide = tokenSide || `${ANSI_RESET}${codeLines[li]}`;
    const scoreStr = s.toFixed(6);
    mergedParts.push(`  ${lineNum} ${bar} ${scoreStr} │  ${rightSide}`);
  }

  const legendSteps = [
    { label: "low", ratio: 0.05 },
    { label: "", ratio: 0.3 },
    { label: "med", ratio: 0.5 },
    { label: "", ratio: 0.7 },
    { label: "high", ratio: 1.0 },
  ];
  const legendStr = legendSteps
    .map(({ label, ratio }) => `${scoreRatioToAnsiFg(ratio)}■${ANSI_RESET}${label}`)
    .join("  ");

  const sum = Array.from(perTokenScores).reduce((a, b) => a + b, 0);
  const mean = totalTokens > 0 ? sum / totalTokens : 0;
  let minScore = Infinity;
  for (let i = 0; i < totalTokens; i++) {
    if (perTokenScores[i] < minScore) minScore = perTokenScores[i];
  }
  if (minScore === Infinity) minScore = 0;

  // Per-line stats
  const lineMax = Math.max(...lineScores, 0);
  const lineMin = lineScores.length > 0 ? Math.min(...lineScores) : 0;
  const lineSum = lineScores.reduce((a, b) => a + b, 0);
  const lineMean = lineScores.length > 0 ? lineSum / lineScores.length : 0;

  return [
    `${ANSI_RESET}═══ Token Attention Heatmap ═══`,
    ...mergedParts,
    `\n─── Stats ───`,
    `  Tokens: ${totalTokens}  |  max=${maxScore.toFixed(6)}  min=${minScore.toFixed(6)}  mean=${mean.toFixed(6)}`,
    `  Lines:  ${lineScores.length}  |  max=${lineMax.toFixed(6)}  min=${lineMin.toFixed(6)}  mean=${lineMean.toFixed(6)}`,
    ...(chunkScore !== undefined ? [`  Rerank: ${chunkScore.toFixed(6)}`] : []),
    `  Legend: ${legendStr}`,
    `═══════════════════════════════`,
  ].join("\n");
}

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">;

// QR head configuration — same as QRRankerReranker
const QR_HEADS: Array<{ layer: number; head: number }> = [
  { layer: 20, head: 15 }, { layer: 21, head: 11 }, { layer: 17, head: 27 },
  { layer: 23, head: 10 }, { layer: 22, head:  4 }, { layer: 21, head: 10 },
  { layer: 21, head:  8 }, { layer: 21, head: 18 }, { layer: 18, head: 15 },
  { layer: 18, head: 19 }, { layer: 17, head: 25 }, { layer: 17, head: 17 },
  { layer: 24, head: 13 }, { layer: 17, head:  4 }, { layer: 19, head: 12 },
  { layer: 21, head: 31 },
];

/**
 * QRRankerHighlighter: attention-based line-level highlighter.
 *
 * Uses QR attention heads from Qwen3-4B (kq_soft_max via cbEval) to compute
 * per-token query→document relevance scores, then maps tokens to lines via
 * character-offset proportional mapping.
 *
 * Performs an independent forward pass for each highlight() call, using the
 * same chatml prompt format as QRRankerReranker.
 */
export class QRRankerHighlighter implements IHighlighter {
  private readonly modelPath: string;
  private readonly defaultMode: "topk" | "threshold";
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;
  private readonly logger?: LoggerLike;

  private _model: LlamaModel | null = null;
  private _loadingPromise: Promise<LlamaModel> | null = null;

  private _disposed = false

  constructor(
    modelPath: string,
    topK: number = 20,
    logger?: LoggerLike,
    mode: "topk" | "threshold" = "topk",
    threshold: number = 0.5,
  ) {
    this.modelPath = modelPath;
    this.defaultMode = mode;
    this.defaultTopK = topK;
    this.defaultThreshold = threshold;
    this.logger = logger;
  }

  // ─── Model Loading ──────────────────────────────────────────────────

  private async _ensureModel(): Promise<LlamaModel> {
    if (this._model) return this._model;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      this.logger?.debug(`[QRRankerHighlighter] Loading model: ${this.modelPath}`);
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled, gpu: "metal" });
      this._model = await llama.loadModel({ modelPath: this.modelPath });
      this.logger?.info(`[QRRankerHighlighter] Model loaded`);
      return this._model;
    })();

    return this._loadingPromise;
  }

  // ─── Prompt Construction ────────────────────────────────────────────

  /**
   * Build the QRRanker input prompt in chatml format (single chunk).
   * Matches the format used by QRRankerReranker.buildPrompt().
   */
  private buildPrompt(query: string, codeChunk: string): string {
    return (
      "<|im_start|>user\nHere are some retrieved chunks:\n\n" +
      `[1] Title: code\n${codeChunk}\n\n` +
      "Use the retrieved chunks to answer the user's query.\n\n" +
      `Query: ${query}`
    );
  }

  // ─── Tokenization & Ranges ──────────────────────────────────────────

  /**
   * Find the first occurrence of a token subsequence within a token array,
   * starting the search from a given position.
   * @returns the start index of the subsequence, or -1 if not found
   */
  private _findSubsequence(
    haystack: Token[],
    needle: Token[],
    startFrom: number,
  ): number {
    if (needle.length === 0) return -1;
    const firstId = Number(needle[0]);
    const maxStart = haystack.length - needle.length;
    for (let i = Math.max(0, startFrom); i <= maxStart; i++) {
      if (Number(haystack[i]) !== firstId) continue;
      let match = true;
      for (let j = 1; j < needle.length; j++) {
        if (Number(haystack[i + j]) !== Number(needle[j])) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  /**
   * Tokenize the full prompt and compute token ranges for code and query.
   * Uses subsequence search to handle tokenizer boundary merging.
   *
   * Strategy:
   *  1. Find codeStart by searching for the first code token
   *  2. Find suffixStart by searching for "Use the retrieved chunks" marker
   *  3. codeEnd = suffixStart (code ends where suffix begins)
   *  4. Find queryStart by searching for "Query: <query>" from suffix onward
   */
  private tokenizeWithRanges(
    model: LlamaModel,
    query: string,
    codeChunk: string,
  ): {
    tokens: Token[];
    codeStart: number;
    codeEnd: number;
    queryStart: number;
    queryEnd: number;
  } {
    const fullPrompt = this.buildPrompt(query, codeChunk);
    const tokens = model.tokenize(fullPrompt);

    // Tokenize anchor sequences
    const codeTokens = model.tokenize(codeChunk);
    const suffixMarker = model.tokenize("Use the retrieved chunks");
    const queryFull = `Query: ${query}`;
    const queryFullTokens = model.tokenize(queryFull);

    // 1. Find codeStart: search for first 3 code tokens as subsequence
    //    Using multi-token subsequence avoids false matches in prompt prefix
    let codeStart = -1;
    if (codeTokens.length > 0) {
      const searchLen = Math.min(3, codeTokens.length);
      const codePrefix = codeTokens.slice(0, searchLen);
      codeStart = this._findSubsequence(tokens, codePrefix, 0);
    }

    // 2. Find suffixStart: "Use the retrieved chunks" marker
    let codeEnd = -1;
    let suffixStart = -1;
    if (codeStart >= 0) {
      suffixStart = this._findSubsequence(tokens, suffixMarker, codeStart);
      codeEnd = suffixStart > codeStart ? suffixStart : tokens.length;
    }

    // 3. Find query tokens from suffix onward
    let queryStart = -1;
    let queryEnd = -1;
    if (suffixStart >= 0) {
      queryStart = this._findSubsequence(tokens, queryFullTokens, suffixStart);
      if (queryStart >= 0) {
        queryEnd = queryStart + queryFullTokens.length;
      }
    }

    // Fallback: character-offset estimation
    if (codeStart < 0) {
      this.logger?.warn(
        `[QRRankerHighlighter] Code subsequence search failed, using character-offset fallback`,
      );
      const promptPrefix = "<|im_start|>user\nHere are some retrieved chunks:\n\n[1] Title: code\n";
      const prefixTokens = model.tokenize(promptPrefix);
      codeStart = prefixTokens.length;
      codeEnd = codeStart + codeTokens.length;
      codeEnd = Math.min(codeEnd, tokens.length);
    }
    if (queryStart < 0) {
      this.logger?.warn(
        `[QRRankerHighlighter] Query subsequence search failed, using character-offset fallback`,
      );
      const promptSuffix = "\n\nUse the retrieved chunks to answer the user's query.\n\nQuery: ";
      const suffixTokens = model.tokenize(promptSuffix);
      const queryTokens = model.tokenize(query);
      queryStart = (codeEnd > 0 ? codeEnd : tokens.length) + suffixTokens.length;
      queryEnd = queryStart + queryTokens.length;
    }

    // Bounds clamp
    if (codeEnd > tokens.length) codeEnd = tokens.length;
    if (queryEnd > tokens.length) queryEnd = tokens.length;

    this.logger?.debug(
      `[QRRankerHighlighter] Tokenized: ${tokens.length} tokens, ` +
      `code [${codeStart}, ${codeEnd}), query [${queryStart}, ${queryEnd})`,
    );

    return { tokens, codeStart, codeEnd, queryStart, queryEnd };
  }

  // ─── QR Attention Scoring ──────────────────────────────────────────

  /**
   * Compute per-KV-token relevance scores from QR attention heads.
   *
   * For each QR head, computes the mean attention from query tokens to
   * each KV position, then aggregates across all 16 heads.
   *
   * kq_soft_max tensor (row-major): data[head * nTokens * nKv + tok * nKv + kv]
   *   ne[0] = n_kv, ne[1] = n_tokens, ne[2] = n_head
   *
   * @returns Float32Array of length nKv, one score per KV position
   */
  private computePerTokenScores(
    context: LlamaContext,
    queryStart: number,
    queryEnd: number,
  ): Float32Array {
    const shape = context.getKqSoftMaxShape();
    const nKv = shape.nKv;
    const nTokens = shape.nTokens;
    const nHead = shape.nHead;
    const nQueryTokens = queryEnd - queryStart;

    this.logger?.debug(
      `[QRRankerHighlighter] kq_soft_max: nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, ` +
      `nLayers=${shape.nLayers}, layers=[${shape.layers.join(",")}]`,
    );

    const scores = new Float32Array(nKv);
    let validHeads = 0;
    // QR_HEADS was designed for 32-head models. Map proportionally to the
    // actual model's head count so relative positions (low/mid/high) are preserved.
    const QR_SOURCE_NHEAD = 32;

    const mappedHeads: string[] = [];
    for (const { layer, head: rawHead } of QR_HEADS) {
      const head = nHead === QR_SOURCE_NHEAD
        ? rawHead
        : Math.min(Math.round(rawHead * nHead / QR_SOURCE_NHEAD), nHead - 1);
      const layerData = context.getKqSoftMax(layer);
      if (!layerData) {
        this.logger?.debug(`[QRRankerHighlighter] Layer ${layer} data missing, skipping`);
        continue;
      }
      mappedHeads.push(`${layer}:${head}`);

      // Sum attention from each query token to each KV position.
      // After C++ slice filtering, nTokens = nQueryTokens and data layout
      // is [head][0..nQueryTokens)[kv] instead of the full token range.
      // q indices are now 0-relative (0 = first query token).
      for (let q = 0; q < nQueryTokens; q++) {
        for (let kv = 0; kv < nKv; kv++) {
          scores[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
        }
      }
      validHeads++;
    }

    this.logger?.debug(`[QRRankerHighlighter] QR heads (nHead=${nHead}): ${mappedHeads.join(" ")}`);

    // Normalize by (validHeads × query tokens) so scores are in [0, 1]
    const normalizer = validHeads * nQueryTokens;
    if (normalizer > 0) {
      for (let kv = 0; kv < nKv; kv++) {
        scores[kv] /= normalizer;
      }
    }

    return scores;
  }

  // ─── Token → Line Mapping ──────────────────────────────────────────

  /**
   * Map per-token scores (from code region) to per-line scores using
   * character-offset proportional mapping.
   *
   * Each code token is assigned an approximate character position in the
   * code text; that position is then mapped to a code line. The per-line
   * score is the average of the token scores in that line.
   */
  private tokensToLines(
    codeChunk: string,
    codeLines: string[],
    perTokenScores: Float32Array,
    codeStart: number,
    codeEnd: number,
    tokens: Token[],
  ): number[] {
    const codeChars = codeChunk.length;
    const codeTokenCount = codeEnd - codeStart;
    if (codeTokenCount === 0) return new Array(codeLines.length).fill(0);

    // Pre-compute each code line's character range in codeChunk
    // Each line (except the last) includes a trailing \n separator character
    const lineCharEnds: number[] = new Array(codeLines.length);
    let charAcc = 0;
    for (let li = 0; li < codeLines.length; li++) {
      charAcc += codeLines[li].length + (li < codeLines.length - 1 ? 1 : 0);
      lineCharEnds[li] = charAcc;
    }

    const lineScores = new Array<number>(codeLines.length).fill(0);
    const lineCounts = new Array<number>(codeLines.length).fill(0);

    let detokAcc = 0;
    for (let ti = 0; ti < codeTokenCount; ti++) {
      const tokenScore = perTokenScores[codeStart + ti];
      const text = this._detokenizeOne(tokens[codeStart + ti]);

      // Windowed indexOf: detokAcc provides approximate position,
      // narrow search window avoids distant substring collisions.
      let codePos: number;
      if (text.length > 0) {
        const searchFrom = Math.max(0, detokAcc - 5);
        const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
        const idx = codeChunk.indexOf(text, searchFrom);
        if (idx >= 0 && idx < searchTo) {
          codePos = idx;
          detokAcc = idx + text.length;
        } else {
          codePos = detokAcc;
          detokAcc += text.length;
        }
      } else {
        codePos = detokAcc;
      }

      if (codePos < 0 || codePos >= codeChars) continue;

      // Map character position to line index
      let lineStart = 0;
      for (let i = 0; i < codeLines.length; i++) {
        if (codePos >= lineStart && codePos < lineCharEnds[i]) {
          lineScores[i] += tokenScore;
          lineCounts[i]++;
          break;
        }
        lineStart = lineCharEnds[i];
      }
    }

    // Average per line (avoid bias toward long lines)
    for (let i = 0; i < lineScores.length; i++) {
      if (lineCounts[i] > 0) {
        lineScores[i] /= lineCounts[i];
      }
    }

    return lineScores;
  }

  /** Detokenize a single token, caching via model.detokenize. */
  private _detokenizeOne(tok: Token): string {
    return this._model ? this._model.detokenize([tok]) : "";
  }

  // ─── IHighlighter Interface ──────────────────────────────────────────

  async highlight(
    query: string,
    codeChunk: string,
    startLine: number,
    options?: HighlightOptions,
  ): Promise<HighlightResult> {
    const codeLines = codeChunk.split("\n");
    if (codeLines.length === 0) {
      return { formattedText: "", lines: [], startLine, endLine: startLine - 1 };
    }

    let lineScores: number[];
    let debugTokenView: string | undefined;
    const debugHighlight = options?.debugHighlight ?? false;
    const hasPrecomputed = (options?._qrrankerPerTokenScores && options?._qrrankerCodeText === codeChunk);

    if (hasPrecomputed) {
      // Fast path: use reranker's precomputed scores.
      const pScores = options!._qrrankerPerTokenScores!;
      this.logger?.debug(
        `[QRRankerHighlighter] Using precomputed scores (${pScores.length} tokens)`,
      );

      // Use proportional character-offset mapping for safety.
      // Token IDs come from the reranker's model and may be incompatible
      // with the highlighter's vocabulary → proportional mapping avoids crashes.
      lineScores = this._mapPrecomputedToLines(codeChunk, codeLines, pScores, options._qrrankerTokenTexts);

      // Debug heatmap: use pre-detokenized texts from reranker for exact BPE boundaries
      if (debugHighlight) {
        debugTokenView = buildTokenHeatmapFromTexts(options!._qrrankerTokenTexts!, pScores, codeChunk, startLine, lineScores, options._qrrankerChunkScore);
      }
    } else {
      // No precomputed scores: run a full forward pass (also used when benchmark/new query)
      const result = await this._runForwardPass(query, codeChunk, codeLines, startLine, debugHighlight);
      lineScores = result.lineScores;
      debugTokenView = result.debugView;
    }

    // Apply selection mode
    const mode = options?.mode ?? this.defaultMode;
    const keptSet = new Set<number>();

    if (mode === "threshold") {
      const threshold = options?.threshold ?? this.defaultThreshold;
      for (let i = 0; i < lineScores.length; i++) {
        if (lineScores[i] >= threshold) {
          keptSet.add(i);
        }
      }
    } else {
      // Top-K mode (default)
      const topK = Math.min(options?.topK ?? this.defaultTopK, lineScores.length);
      const sortedIndices = lineScores
        .map((s, i) => ({ score: s, index: i }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      for (const { index } of sortedIndices) {
        keptSet.add(index);
      }
    }

    // Post-processing: remove isolated structural-only lines (1-3 pure non-word symbols)
    // e.g. standalone """, ), }, ], --- with no adjacent kept line → noise, not content
    const prevKeptSize = keptSet.size;
    for (const idx of [...keptSet]) {
      const trimmed = codeLines[idx].trim();
      if (trimmed.length >= 1 && trimmed.length <= 3 && !/[\p{L}\p{N}_]/u.test(trimmed)) {
        // Isolated: no adjacent kept line on either side
        if (!keptSet.has(idx - 1) && !keptSet.has(idx + 1)) {
          keptSet.delete(idx);
        }
      }
    }
    if (keptSet.size !== prevKeptSize) {
      this.logger?.debug(
        `[QRRankerHighlighter] Removed ${prevKeptSize - keptSet.size} isolated structural lines, kept ${keptSet.size}`,
      );
    }

    // Build HighlightResult
    const lines: HighlightLine[] = codeLines.map((text, i) => ({
      lineNumber: startLine + i,
      text,
      score: lineScores[i] ?? 0,
      kept: keptSet.has(i),
    }));

    const formattedText = this._formatOutput(lines);

    return {
      formattedText,
      lines,
      startLine,
      endLine: startLine + codeLines.length - 1,
      debugTokenView,
    };
  }

  /**
   * Run a full forward pass to compute per-token scores from QR attention heads.
   * Used when no precomputed scores are available.
   */
  private async _runForwardPass(
    query: string,
    codeChunk: string,
    codeLines: string[],
    startLine: number,
    debugHighlight?: boolean,
  ): Promise<{ lineScores: number[]; debugView?: string }> {
    const model = await this._ensureModel();

    // Tokenize and compute token ranges
    const { tokens, codeStart, codeEnd, queryStart, queryEnd } =
      this.tokenizeWithRanges(model, query, codeChunk);

    // Create context with kq_soft_max collection enabled.
    // Keep Metal kq_soft_max tensors below the range where tensor reads return NaN.
    // C++ cbEval accumulates query slices across JS decode batches.
    const batchSize = Math.min(tokens.length, 4096);
    this.logger?.info(
      `[QRRankerHighlighter] Processing ${tokens.length} tokens with batchSize=${batchSize}`,
    );
    const context = await model.createContext({
      contextSize: Math.min(model.trainContextSize ?? 32768, tokens.length + 1024),
      batchSize,
      sequences: 1,
      flashAttention: false,
      collectKqSoftMax: true,
    }) as LlamaContext;

    try {
      const sequence = context.getSequence();
      // Set query range so C++ cbEval only copies query token rows,
      // avoiding the V8 ArrayBuffer 4GB limit for long inputs.
      // See docs/plans/260523-qrranker-ubatch-overflow-fix.md
      context.setKqSoftMaxQueryRange(queryStart, queryEnd);
      await sequence.evaluateWithoutGeneratingNewTokens(tokens);

      this.logger?.debug(
        `[QRRankerHighlighter] Forward pass done: ${tokens.length} tokens`,
      );

      // Compute per-token relevance scores from QR attention
      const perTokenScores = this.computePerTokenScores(context, queryStart, queryEnd);

      // Map code token scores to lines (compute first so buildTokenHeatmap can reuse)
      const lineScores = this.tokensToLines(
        codeChunk, codeLines, perTokenScores, codeStart, codeEnd, tokens,
      );

      // Build debug token heatmap if requested (reuses lineScores for bar consistency)
      let debugView: string | undefined;
      if (debugHighlight) {
        debugView = buildTokenHeatmap(
          tokens, codeStart, codeEnd, perTokenScores,
          (tok) => model.detokenize([tok]),
          codeChunk, startLine, lineScores,
        );
      }

      return { lineScores, debugView };
    } finally {
      await context.dispose();
    }
  }

  /**
   * Map precomputed per-token scores (code-region only, sliced by reranker)
   * to per-line scores using direct proportional mapping.
   *
   * Since the reranker now slices scores to only cover the code text,
   * this function can map directly from code token indices to code characters
   * without needing to know the chunk's prefix/suffix format.
   */
  private _mapPrecomputedToLines(
    codeChunk: string,
    codeLines: string[],
    perTokenScores: Float32Array,
    tokenTexts?: string[],
  ): number[] {
    const codeChars = codeChunk.length;
    const totalTokens = perTokenScores.length;
    if (totalTokens === 0) return new Array(codeLines.length).fill(0);

    const lineScores = new Array<number>(codeLines.length).fill(0);
    const lineCounts = new Array<number>(codeLines.length).fill(0);
    const hasTexts = tokenTexts && tokenTexts.length === totalTokens;

    let detokAcc = 0;
    for (let ti = 0; ti < totalTokens; ti++) {
      const score = perTokenScores[ti];

      // Windowed indexOf when token texts available, else fallback to proportional
      let codePos: number;
      if (hasTexts) {
        const text = tokenTexts![ti];
        if (text.length > 0) {
          const searchFrom = Math.max(0, detokAcc - 5);
          const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
          const idx = codeChunk.indexOf(text, searchFrom);
          if (idx >= 0 && idx < searchTo) {
            codePos = idx;
            detokAcc = idx + text.length;
          } else {
            codePos = detokAcc;
            detokAcc += text.length;
          }
        } else {
          codePos = detokAcc;
        }
      } else {
        codePos = (ti / totalTokens) * codeChars;
      }
      if (codePos < 0 || codePos >= codeChars) continue;

      // Each line (except the last) includes a trailing \n separator character
      let charCount = 0;
      for (let i = 0; i < codeLines.length; i++) {
        const lineLen = codeLines[i].length + (i < codeLines.length - 1 ? 1 : 0);
        if (codePos >= charCount && codePos < charCount + lineLen) {
          lineScores[i] += score;
          lineCounts[i]++;
          break;
        }
        charCount += lineLen;
      }
    }

    // Average per line
    for (let i = 0; i < lineScores.length; i++) {
      if (lineCounts[i] > 0) {
        lineScores[i] /= lineCounts[i];
      }
    }

    return lineScores;
  }

  /**
   * Format output: kept lines sorted by line number, consecutive lines
   * grouped, groups separated by "---".
   */
  private _formatOutput(lines: HighlightLine[]): string {
    const keptLines: Array<{ num: number; text: string }> = [];
    for (const line of lines) {
      if (line.kept && line.text.trim().length > 0) {
        keptLines.push({ num: line.lineNumber, text: line.text });
      }
    }

    if (keptLines.length === 0) {
      return "";
    }

    keptLines.sort((a, b) => a.num - b.num);

    const groups: Array<Array<{ num: number; text: string }>> = [];
    let currentGroup: Array<{ num: number; text: string }> = [];

    for (const line of keptLines) {
      if (
        currentGroup.length === 0 ||
        line.num === currentGroup[currentGroup.length - 1].num + 1
      ) {
        currentGroup.push(line);
      } else {
        groups.push(currentGroup);
        currentGroup = [line];
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups
      .map((group) =>
        group.map((l) => `${String(l.num).padStart(4)}  ${l.text}`).join("\n"),
      )
      .join("\n ---\n");
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    if (this._model) {
      await this._model.dispose().catch(() => {});
      this._model = null;
    }
    this._loadingPromise = null;
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs");
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `QRRanker highlight model file not found: ${this.modelPath}` };
      }

      const model = await this._ensureModel();
      if (!model) {
        return { valid: false, error: "Failed to load QRRanker model" };
      }
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "QRRanker highlighter validation failed",
      };
    }
  }

  get highlighterInfo(): HighlighterInfo {
    return {
      name: "qrranker",
      model: this.modelPath,
    };
  }
}
