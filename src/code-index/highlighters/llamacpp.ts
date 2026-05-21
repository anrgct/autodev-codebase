import {
  getLlama,
  LlamaModel,
  LlamaEmbeddingContext,
  LlamaLogLevel,
} from "node-llama-cpp"
import { PRUNING_HEAD_WEIGHT, PRUNING_HEAD_BIAS } from "./constants/pruning-head-weights"
import type {
  IHighlighter,
  HighlightLine,
  HighlightResult,
  HighlighterInfo,
  HighlightOptions,
} from "../interfaces/highlighter"
import type { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

// ─── Debug Highlight: ANSI Color Helpers ────────────────────────────────

const ANSI_RESET = "\x1b[0m";

function scoreRatioToAnsiFg(ratio: number): string {
  if (ratio <= 0) return "\x1b[38;5;237m";
  if (ratio < 0.05) return "\x1b[38;5;240m";
  if (ratio < 0.15) return "\x1b[38;5;33m";
  if (ratio < 0.3) return "\x1b[38;5;45m";
  if (ratio < 0.45) return "\x1b[38;5;47m";
  if (ratio < 0.55) return "\x1b[38;5;119m";
  if (ratio < 0.65) return "\x1b[38;5;227m";
  if (ratio < 0.75) return "\x1b[38;5;214m";
  if (ratio < 0.9) return "\x1b[38;5;202m";
  return "\x1b[38;5;196m";
}

function scoreToAnsiFg(score: number, maxScore: number): string {
  if (maxScore <= 0) return "\x1b[38;5;237m";
  return scoreRatioToAnsiFg(Math.min(score / (maxScore * 1.15), 1));
}

/**
 * 使用本地 LlamaCPP 模型实现的行级语义高亮器。
 *
 * 架构：
 * 1. GGUF Backbone (XLM-RoBERTa, pooling_type=none) → token 级 hidden states
 * 2. 外置 Pruning Head (linear classifier [1024] → [2] → softmax) → token keep 概率
 * 3. Token → Line 映射（字符偏移比例）→ 行级聚合
 * 4. Top-K 选取 + 格式化输出
 */
export class LlamaCppHighlightProvider implements IHighlighter {
  private readonly modelPath: string
  private readonly defaultMode: "topk" | "threshold"
  private readonly defaultTopK: number
  private readonly defaultThreshold: number
  private readonly logger?: LoggerLike

  private _model: LlamaModel | null = null
  private _embeddingContext: LlamaEmbeddingContext | null = null
  private _loadingPromise: Promise<void> | null = null

  constructor(
    modelPath: string,
    topK: number = 20,
    logger?: LoggerLike,
    mode: "topk" | "threshold" = "topk",
    threshold: number = 0.5,
  ) {
    this.modelPath = modelPath
    this.defaultMode = mode
    this.defaultTopK = topK
    this.defaultThreshold = threshold
    this.logger = logger
  }

  /**
   * 延迟加载模型和 embedding context
   */
  private async _ensureModel(): Promise<void> {
    if (this._embeddingContext) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppHighlight] Loading model: ${this.modelPath}`)
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({
        modelPath: this.modelPath,
      })
      // 将 batchSize 设为足够大（与模型训练 context 匹配），确保单次 llama_decode() 能处理全部 token，
      // 从而利用 llama.cpp 内部 ubatch 循环正确累积所有 token 的 embedding。
      // 如果使用默认的 batchSize（512），则 JS 层 dispatchPendingBatch 会多次调用 llama_decode()，
      // 每次调用都会覆盖前一次的 embedding 缓冲区，导致只有最后一个 batch 的 token embedding 可用。
      // 详情见 docs/plans/260514-semantic-highlight-for-code-rerank.md § 已知限制-根因分析
      const embedContextSize = this._model.trainContextSize
      this._embeddingContext = await this._model.createEmbeddingContext({
        batchSize: embedContextSize,
      })
      this.logger?.debug(`[LlamaCppHighlight] Model loaded: ${this.modelPath} (batchSize=${embedContextSize})`)
    })()

    return this._loadingPromise
  }

  /**
   * 对给定代码块做行级高亮
   */
  async highlight(query: string, codeChunk: string, startLine: number, options?: HighlightOptions): Promise<HighlightResult> {
    await this._ensureModel()

    const codeLines = codeChunk.split("\n")
    if (codeLines.length === 0) {
      return {
        formattedText: "",
        lines: [],
        startLine,
        endLine: startLine - 1,
      }
    }

    // 1. 构建带 query 上下文的输入
    const input = `[Query] ${query} [Code] ${codeChunk}`

    // 2. 获取 token 级 embeddings（通过 GGUF backbone + pooling_type=none）
    const tokenEmbeddings = await this._embeddingContext!.getEmbeddingsForTokens(input)

    if (tokenEmbeddings.length === 0) {
      // Fallback: 返回所有行
      return this._fallbackAllLines(codeLines, startLine)
    }

    // 3. 应用外置 Pruning Head: logits = hidden @ W.T + b → softmax → probs[:,1]
    const codeOffset = this._findCodeOffset(input, codeChunk)

    // 4. Token → Line 映射（字符偏移比例）
    const lineScores = this._aggregateTokensToLines(
      codeChunk,
      codeLines,
      tokenEmbeddings,
      input,
      codeOffset,
    )

    if (lineScores.length === 0) {
      return this._fallbackAllLines(codeLines, startLine)
    }

    // 4.5. [debug] 生成 token 级 Pruning Head 热力图
    let debugTokenView: string | undefined;
    if (options?.debugHighlight) {
      debugTokenView = this._buildDebugTokenView(
        input, codeChunk, codeLines, startLine, tokenEmbeddings, lineScores, query,
      );
    }

    // 5. 根据模式选取行
    const mode = options?.mode ?? this.defaultMode
    const keptSet = new Set<number>()

    if (mode === "threshold") {
      const threshold = options?.threshold ?? this.defaultThreshold
      for (let i = 0; i < lineScores.length; i++) {
        if (lineScores[i] >= threshold) {
          keptSet.add(i)
        }
      }
    } else {
      // Top-K 模式（默认）
      const topK = Math.min(options?.topK ?? this.defaultTopK, lineScores.length)
      const sortedIndices = lineScores
        .map((s, i) => ({ score: s, index: i }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      for (const item of sortedIndices) {
        keptSet.add(item.index)
      }
    }

    // 5.5 后处理：排除不连续纯符号行（与 qrranker 一致）
    // 例如单独的 """、)、}、]、--- 且前后无保留行 → 噪音，不是内容
    const prevKeptSize = keptSet.size;
    for (const idx of [...keptSet]) {
      const trimmed = codeLines[idx].trim();
      if (trimmed.length >= 1 && trimmed.length <= 3 && !/[\p{L}\p{N}_]/u.test(trimmed)) {
        if (!keptSet.has(idx - 1) && !keptSet.has(idx + 1)) {
          keptSet.delete(idx);
        }
      }
    }

    // 6. 构建结果
    const lines: HighlightLine[] = codeLines.map((text, i) => ({
      lineNumber: startLine + i,
      text,
      score: lineScores[i] ?? 0,
      kept: keptSet.has(i),
    }))

    const formattedText = this._formatOutput(lines)

    return {
      formattedText,
      lines,
      startLine,
      endLine: startLine + codeLines.length - 1,
      debugTokenView,
    }
  }

  /**
   * 在 input 字符串中找到 codeChunk 的起始偏移
   */
  private _findCodeOffset(input: string, codeChunk: string): number {
    const idx = input.indexOf(codeChunk)
    return idx >= 0 ? idx : input.indexOf("[Code] ") + 7
  }

  /**
   * 应用 Pruning Head 计算单个 token 的 keep 概率
   * logits = hidden @ W.T + b → softmax → probs[:, 1]
   */
  private _applyPruningHead(hidden: number[]): number {
    // W: [2, 1024], b: [2]
    // logits[0] = sum(hidden[i] * W[0][i]) + b[0]
    // logits[1] = sum(hidden[i] * W[1][i]) + b[1]
    let logit0 = PRUNING_HEAD_BIAS[0]
    let logit1 = PRUNING_HEAD_BIAS[1]
    const dim = 1024 // hidden dimension

    for (let i = 0; i < dim && i < hidden.length; i++) {
      logit0 += hidden[i] * PRUNING_HEAD_WEIGHT[i] // W[0][i]
      logit1 += hidden[i] * PRUNING_HEAD_WEIGHT[dim + i] // W[1][i]
    }

    // Softmax
    const maxLogit = Math.max(logit0, logit1)
    const exp0 = Math.exp(logit0 - maxLogit)
    const exp1 = Math.exp(logit1 - maxLogit)
    const sum = exp0 + exp1

    // probs[:, 1] = keep probability
    return exp1 / sum
  }

  /**
   * 将 token embeddings 聚合到代码行。
   * 采用字符偏移比例映射 token 到代码行。
   */
  private _aggregateTokensToLines(
    codeChunk: string,
    codeLines: string[],
    tokenEmbeddings: number[][],
    input: string,
    codeOffset: number,
  ): number[] {
    const lineScores: number[] = new Array(codeLines.length).fill(0)
    const lineCounts: number[] = new Array(codeLines.length).fill(0)

    // 为每个 token 计算 score 并映射到代码行
    // 使用字符偏移比例近似
    const totalChars = input.length
    const codeChars = codeChunk.length
    const totalTokens = tokenEmbeddings.length

    for (let ti = 0; ti < totalTokens; ti++) {
      const tokenEmb = tokenEmbeddings[ti]
      const score = this._applyPruningHead(tokenEmb)

      // 估算此 token 对应的大致字符位置
      // 取 input 中 [Code] 之后的比例位置
      const approxCharPos = (ti / totalTokens) * totalChars
      const codePos = approxCharPos - codeOffset

      if (codePos < 0 || codePos >= codeChars) continue

      // 映射到行
      let charCount = 0
      for (let i = 0; i < codeLines.length; i++) {
        const lineLen = codeLines[i].length + 1 // +1 for newline
        if (codePos >= charCount && codePos < charCount + lineLen) {
          lineScores[i] += score
          lineCounts[i]++
          break
        }
        charCount += lineLen
      }
    }

    // 平均每行的分数（避免长行获得更多分数）
    for (let i = 0; i < lineScores.length; i++) {
      if (lineCounts[i] > 0) {
        lineScores[i] /= lineCounts[i]
      }
    }

    return lineScores
  }

  /**
   * 格式化输出：保留行按行号排序，连续行成组，组间用 `---` 分隔
   */
  private _formatOutput(lines: HighlightLine[]): string {
    const keptLines: { num: number; text: string }[] = []
    for (const line of lines) {
      if (line.kept && line.text.trim().length > 0) {
        keptLines.push({ num: line.lineNumber, text: line.text })
      }
    }

    if (keptLines.length === 0) {
      return ""
    }

    keptLines.sort((a, b) => a.num - b.num)

    const groups: { num: number; text: string }[][] = []
    let currentGroup: { num: number; text: string }[] = []

    for (const line of keptLines) {
      if (currentGroup.length === 0 || line.num === currentGroup[currentGroup.length - 1].num + 1) {
        currentGroup.push(line)
      } else {
        groups.push(currentGroup)
        currentGroup = [line]
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup)
    }

    return groups
      .map((group) =>
        group.map((l) => `${String(l.num).padStart(4)}  ${l.text}`).join("\n"),
      )
      .join("\n ---\n")
  }

  /**
   * [debug] 构建 token 级 Pruning Head 热力图。
   *
   * 格式：行号 + 分数条（左）+ 按 embedding 分数逐词着色的原始代码（右）。
   * 以词语为单位着色（词中点对应 embedding token 的分数），
   * 避免逐字符着色割裂词语，也避免 model.tokenize() API 差异导致的对齐错乱。
   */
  private _buildDebugTokenView(
    input: string,
    codeChunk: string,
    codeLines: string[],
    startLine: number,
    tokenEmbeddings: number[][],
    lineScores: number[],
    _query: string,
  ): string {
    const totalTokens = tokenEmbeddings.length;
    if (totalTokens === 0) return "";

    const codeOffset = this._findCodeOffset(input, codeChunk);
    const totalChars = input.length;
    const codeChars = codeChunk.length;
    const barWidth = 10;

    // 1. 计算每个 embedding 的 pruning head 分数
    const perTokenScores: number[] = new Array(totalTokens);
    let maxScore = 0;
    for (let ti = 0; ti < totalTokens; ti++) {
      const score = this._applyPruningHead(tokenEmbeddings[ti]);
      perTokenScores[ti] = score;
      const codePos = (ti / totalTokens) * totalChars - codeOffset;
      if (codePos >= 0 && codePos < codeChars && score > maxScore) {
        maxScore = score;
      }
    }
    if (maxScore <= 0) maxScore = 0.0001;

    const maxLineScore = Math.max(...lineScores, 0.00001);

    // 2. 逐词着色：将每行按空白/标点边界拆分为词，
    //    以词中点字符位置反向映射到 embedding token 分数
    const parts: string[] = [];
    let charAcc = 0; // 在 codeChunk 中的累计字符偏移
    // 匹配：空白序列 或 非空白序列
    const wordRe = /(\s+|[^\s]+)/g;

    for (let li = 0; li < codeLines.length; li++) {
      const line = codeLines[li];
      const segments: string[] = [];

      let match: RegExpExecArray | null;
      wordRe.lastIndex = 0;
      while ((match = wordRe.exec(line)) !== null) {
        const word = match[1];
        // 取词中点字符在 codeChunk 中的位置
        const midLocal = match.index + Math.floor(word.length / 2);
        const codePos = charAcc + midLocal;
        // 反向比例映射
        const ti = Math.floor(((codePos + codeOffset) / totalChars) * totalTokens);
        const wordScore = ti >= 0 && ti < totalTokens ? perTokenScores[ti] : 0;
        const color = scoreToAnsiFg(wordScore, maxScore);
        segments.push(`${color}${word}`);
      }
      if (segments.length > 0) segments.push(ANSI_RESET);

      charAcc += line.length + 1; // +1 for \n

      // 行号 + 分数值 + 分数条
      const s = lineScores[li] ?? 0;
      const filled = Math.round((s / maxLineScore) * barWidth);
      const bar =
        `${scoreToAnsiFg(s, maxLineScore)}█${ANSI_RESET}`.repeat(filled) +
        "░".repeat(barWidth - filled);
      const lineNum = String(startLine + li).padStart(4);
      const scoreStr = s.toFixed(6);

      parts.push(`  ${lineNum} ${bar} ${scoreStr} │  ${segments.join("")}`);
    }

    // 3. 统计信息（仅 code 区域）
    let codeScoreSum = 0;
    let codeScoreMin = Infinity;
    let codeTokenCount = 0;
    for (let ti = 0; ti < totalTokens; ti++) {
      const codePos = (ti / totalTokens) * totalChars - codeOffset;
      if (codePos >= 0 && codePos < codeChars) {
        const s = perTokenScores[ti];
        codeScoreSum += s;
        if (s < codeScoreMin) codeScoreMin = s;
        codeTokenCount++;
      }
    }
    if (codeScoreMin === Infinity) codeScoreMin = 0;
    const mean = codeTokenCount > 0 ? codeScoreSum / codeTokenCount : 0;

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

    return [
      `${ANSI_RESET}═══ Token (Pruning Head) Heatmap ═══`,
      ...parts,
      `\n─── Stats ───`,
      `  Tokens: ${codeTokenCount}  |  max=${maxScore.toFixed(6)}  min=${codeScoreMin.toFixed(6)}  mean=${mean.toFixed(6)}`,
      `  Legend: ${legendStr}`,
      `═══════════════════════════════`,
    ].join("\n");
  }

  /**
   * Fallback: 当无法获取 token embeddings 时，返回所有行
   */
  private _fallbackAllLines(codeLines: string[], startLine: number): HighlightResult {
    const lines: HighlightLine[] = codeLines.map((text, i) => ({
      lineNumber: startLine + i,
      text,
      score: 0,
      kept: true,
    }))

    const formattedText = lines
      .map((l) => `${String(l.lineNumber).padStart(4)}  ${l.text}`)
      .join("\n")

    return {
      formattedText,
      lines,
      startLine,
      endLine: startLine + codeLines.length - 1,
    }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs")
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `Highlight model file not found: ${this.modelPath}` }
      }

      await this._ensureModel()

      // 测试 token-level embedding
      const tokenEmbeddings = await this._embeddingContext!.getEmbeddingsForTokens("test")
      if (!tokenEmbeddings || tokenEmbeddings.length === 0) {
        return { valid: false, error: "Model loaded but failed to generate token embeddings. Ensure the model has pooling_type=none." }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Highlight validation failed",
      }
    }
  }

  get highlighterInfo(): HighlighterInfo {
    return {
      name: "llamacpp-semantic-highlight",
      model: this.modelPath,
    }
  }
}
