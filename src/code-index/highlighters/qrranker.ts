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
 * Multiplicative penalty applied to pure-symbol lines (e.g. `}`, `*\\/`, `)`).
 * QRRanker attention heads naturally assign high scores to syntactic boundary
 * tokens; this factor demotes them so real content lines win top-K selection.
 * 0.01 means a content line needs ~1/100 the raw attention to outrank a `}` line.
 *
 * The penalty is still useful as a defensive measure even in decode-stage mode:
 * a `}` immediately following a high-relevance line can still absorb spillover
 * attention and slip into top-K.
 */
const PURE_SYMBOL_LINE_PENALTY = 0.01;

/**
 * Returns true for lines that are short (1-3 chars trimmed) and contain no
 * letters, digits, or underscores -- i.e. pure punctuation like `}`, `*\/`, `)`.
 * These are attention-magnets that don't represent semantic content.
 */
function isPureSymbolLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 3) return false;
  return !/[\p{L}\p{N}_]/u.test(trimmed);
}

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

const QR_START_LAYER = 17;
const QR_END_LAYER = 25; // exclusive

// Source layer count for proportional scaling: the original (uncropped)
// Qwen3-4B has 36 transformer blocks. QRRanker was trained on a cropped version
// (keeping only layers 0-24), so QR heads at layers 17-24 correspond to the
// 47%-67% depth range of the full 36-layer architecture.
// When applying to an uncropped model (like MiniCPM), scale relative to 36.
// The QRRanker cropped model (25 blocks) is handled as a special case:
// its layers map 1:1 to the original, so no scaling is needed.
const QR_ORIGINAL_NLAYER = 36;  // original Qwen3-4B blocks (before cropping)
const QR_QRRANKER_NLAYER = 25;  // QRRanker cropped model blocks

/**
 * QRRankerHighlighter: attention-based line-level highlighter.
 *
 * Uses QR attention heads from Qwen3-4B (kq_soft_max via cbEval) to compute
 * per-token query→document relevance scores, then maps tokens to lines via
 * character-offset proportional mapping.
 *
 * Performs an independent forward pass for each highlight() call, using
 * the model-appropriate chat template (ChatML for Qwen, Gemma format for
 * Gemma 3, auto-detected via tokenizer).
 *
 * When `decodeSteps > 0` the forward pass follows a prefill + decode pattern
 * (model samples N greedy tokens), and per-token scores are averaged across
 * the N decode positions. This shifts attention extraction from "understanding
 * the query" (prefill) to "drafting the answer" (decode), where QR heads
 * focus more on semantic content rather than syntactic boundary tokens.
 * See docs/plans/260605-decode-attention-comparison.md for the experiment.
 */
export class QRRankerHighlighter implements IHighlighter {
  private readonly modelPath: string;
  private readonly defaultMode: "topk" | "threshold";
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;
  private readonly decodeSteps: number;
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
    decodeSteps: number = 0,
  ) {
    this.modelPath = modelPath;
    this.defaultMode = mode;
    this.defaultTopK = topK;
    this.defaultThreshold = threshold;
    this.decodeSteps = Math.max(0, Math.floor(decodeSteps));
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

  /**
   * Build the QRRanker input prompt using the model-appropriate chat template.
   *
   * The trailing assistant turn prefix triggers the model to enter "answer"
   * mode. For ChatML models a `<think>` block is prepended to encourage the
   * model to reason about the chunks before producing an answer; Gemma models
   * do this internally without explicit think tags.
   * See docs/plans/260605-decode-attention-comparison.md.
   */
  private buildPrompt(query: string, codeChunk: string, model: LlamaModel): string {
    const t = this._getPromptTemplate(model);
    return (
      t.userTurn + t.prefix +
      `[1] Title: code\n${codeChunk}\n\n` +
      t.suffix + query + t.userEnd + t.assistantTurn + t.assistantPrefix
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
    const fullPrompt = this.buildPrompt(query, codeChunk, model);
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
    const t = this._getPromptTemplate(model);
    if (codeStart < 0) {
      this.logger?.warn(
        `[QRRankerHighlighter] Code subsequence search failed, using character-offset fallback`,
      );
      const promptPrefix = `${t.userTurn}${t.prefix}[1] Title: code\n`;
      const prefixTokens = model.tokenize(promptPrefix);
      codeStart = prefixTokens.length;
      codeEnd = codeStart + codeTokens.length;
      codeEnd = Math.min(codeEnd, tokens.length);
    }
    if (queryStart < 0) {
      this.logger?.warn(
        `[QRRankerHighlighter] Query subsequence search failed, using character-offset fallback`,
      );
      const promptSuffix = `\n\n${t.suffix}`;
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

    const kqShapeInfo = `nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, nLayers=${shape.nLayers}, layers=[${shape.layers.join(",")}]`;

    const scores = new Float32Array(nKv);
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
    const nModelLayerBlocks = context.model.fileInsights.totalLayers - 1;
    for (const { layer: rawLayer, head: rawHead } of QR_HEADS) {
      const head = nHead === QR_SOURCE_NHEAD
        ? rawHead
        : Math.min(Math.round(rawHead * nHead / QR_SOURCE_NHEAD), nHead - 1);
      // Scale layer index proportionally to target model's transformer block count.
      // For the QRRanker cropped model (25 blocks), layers map 1:1.
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
          scores[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
        }
      }
      validHeads++;
    }

    const headsLog = `[QRRankerHighlighter] QR heads (nHead=${nHead}): ${mappedHeads.join(" ")}`;
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

    // Soft penalty for pure-symbol lines (e.g. `}`, `*/`, `)`) -- they tend to
    // dominate QRRanker attention scores because they are structural boundary
    // tokens, not because they're semantically relevant. Multiplying by a
    // small factor pushes them below real content lines during top-K
    // selection, replacing the previous hard post-filter.
    for (let i = 0; i < lineScores.length; i++) {
      if (lineScores[i] > 0 && isPureSymbolLine(codeLines[i])) {
        lineScores[i] *= PURE_SYMBOL_LINE_PENALTY;
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
   *
   * Two execution paths depending on `this.decodeSteps`:
   *   - decodeSteps === 0  → prefill-only (legacy behavior)
   *   - decodeSteps  >  0  → prefill + N decode steps, average N attention vectors
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
    // +decodeSteps reserves room for the N tokens that the decode path will sample.
    const batchSize = Math.min(tokens.length, 4096);
    const mode = this.decodeSteps > 0 ? `decode(N=${this.decodeSteps})` : "prefill";
    this.logger?.info(
      `[QRRankerHighlighter] Processing ${tokens.length} tokens with batchSize=${batchSize}, mode=${mode}`,
    );
    const context = await model.createContext({
      contextSize: Math.min(
        model.trainContextSize ?? 32768,
        tokens.length + 1024 + this.decodeSteps,
      ),
      batchSize,
      sequences: 1,
      flashAttention: false,
      collectKqSoftMax: true,
    }) as LlamaContext;

    try {
      const sequence = context.getSequence();

      // Scale the layer range to the target model's transformer block count.
      // totalLayers includes the output layer (+1). Subtract 1 to get the actual
      // number of transformer blocks for proportional mapping.
      //
      // Two cases:
      //   1. QRRanker cropped model (25 blocks): use identity [17, 25).
      //   2. Other models: scale proportionally using original 36-layer source.
      const nModelLayerBlocks = model.fileInsights.totalLayers - 1;
      if (nModelLayerBlocks !== QR_QRRANKER_NLAYER) {
        const mappedStart = Math.round(QR_START_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
        const mappedEnd = Math.round(QR_END_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
        context.setKqSoftMaxLayerRange(mappedStart, mappedEnd);
        this.logger?.debug(
          `[QRRankerHighlighter] Layer range scaled: ${QR_ORIGINAL_NLAYER}→${nModelLayerBlocks} blocks, ` +
          `range [${mappedStart}, ${mappedEnd})`,
        );
      }

      // Collect per-token scores: either prefill-only or averaged across N decode steps.
      const perTokenScores = this.decodeSteps > 0
        ? await this._collectDecodeAttention(
            context, sequence, tokens, queryStart, queryEnd, model,
          )
        : await this._collectPrefillAttention(
            context, sequence, tokens, queryStart, queryEnd,
          );

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
   * Prefill-only attention: runs the full prompt in one pass, then reads
   * the query range. Cheapest, but QR heads at this stage allocate high
   * attention to syntactic boundary tokens (e.g. `}`, `*\/`).
   */
  private async _collectPrefillAttention(
    context: LlamaContext,
    sequence: ReturnType<LlamaContext["getSequence"]>,
    tokens: Token[],
    queryStart: number,
    queryEnd: number,
  ): Promise<Float32Array> {
    // Set query range so C++ cbEval only copies query token rows,
    // avoiding the V8 ArrayBuffer 4GB limit for long inputs.
    // See docs/plans/260523-qrranker-ubatch-overflow-fix.md
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);
    await sequence.evaluateWithoutGeneratingNewTokens(tokens);

    this.logger?.debug(
      `[QRRankerHighlighter] Prefill forward pass done: ${tokens.length} tokens`,
    );

    return this.computePerTokenScores(context, queryStart, queryEnd);
  }

  /**
   * Decode-stage attention: prefill, then sample N greedy tokens, reading
   * the kq_soft_max at each decode position. The model is "drafting the
   * answer" during these steps, so QR heads focus on semantic content.
   * Returns the average of the N per-position score vectors.
   *
   * Flow (using evaluate() async generator):
   *   iter 1: prefill + sample token_1      (no attention read; prefill range is wasteful)
   *   iter k (k >= 2): decode token_{k-1}   (at position promptLength + k - 2)
   *     BEFORE next(): setKqSoftMaxQueryRange(decodePos, decodePos + 1)
   *     AFTER  next(): read kq_soft_max for that single position
   */
  private async _collectDecodeAttention(
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
    // initial slice (this row data is unused; we only read decode positions).
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);
    const prefillStart = Date.now();
    const gen = sequence.evaluate(tokens, { temperature: 0.6 });

    // iter 1: prefill + sample token_1
    const first = await gen.next();
    const prefillTime = Date.now() - prefillStart;
    if (first.done || !first.value) {
      this.logger?.warn(
        `[QRRankerHighlighter] Decode generator ended before producing first token; ` +
        `falling back to prefill attention (prefill: ${prefillTime}ms)`,
      );
      return this.computePerTokenScores(context, queryStart, queryEnd);
    }

    // Collect attention from decode positions for token_1 ... token_N.
    // iter k (k=2..N+1) decodes token_{k-1} at position promptLength + k - 2.
    const decodeStart = Date.now();
    const scoreStack: Float32Array[] = [];
    const generatedTokens: Token[] = [first.value]; // include the first sampled token
    for (let i = 0; i < N; i++) {
      const decodePos = promptLength + i;
      context.setKqSoftMaxQueryRange(decodePos, decodePos + 1);
      const step = await gen.next();
      if (step.done || !step.value) {
        this.logger?.debug(
          `[QRRankerHighlighter] Decode stopped early at iter ${i + 2}/${N + 1}`,
        );
        break;
      }
      // After this .next() returns, the kq_soft_max contains attention from
      // the single query token at decodePos. nQueryTokens will be 1.
      const stepScores = this.computePerTokenScores(context, decodePos, decodePos + 1);
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
      `[QRRankerHighlighter] Decode-stage inference output (${generatedTokens.length} tokens, ${scoreStack.length}/${N} positions) ` +
      `[prefill: ${prefillTime}ms, decode: ${decodeTime}ms]:\n${fullText}`,
    );

    if (scoreStack.length === 0) {
      this.logger?.warn(
        `[QRRankerHighlighter] No decode positions captured; falling back to prefill attention`,
      );
      return this.computePerTokenScores(context, queryStart, queryEnd);
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

    // Soft penalty for pure-symbol lines (see tokensToLines for rationale)
    for (let i = 0; i < lineScores.length; i++) {
      if (lineScores[i] > 0 && isPureSymbolLine(codeLines[i])) {
        lineScores[i] *= PURE_SYMBOL_LINE_PENALTY;
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
