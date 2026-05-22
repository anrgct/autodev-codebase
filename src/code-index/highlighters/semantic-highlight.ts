import {
  getLlama,
  LlamaModel,
  LlamaEmbeddingContext,
  LlamaLogLevel,
  readGgufFileInfo,
} from "node-llama-cpp"
import type { GgufFileInfo } from "node-llama-cpp"
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
 * 使用 Unified GGUF 模型实现的行级语义高亮器。
 *
 * 架构：
 * 1. GGUF Backbone (XLM-RoBERTa, pooling_type=none) → token 级 hidden states
 * 2. Pruning Head（权重从 GGUF metadata 读取）→ token keep 概率
 * 3. Token → Line 映射（字符偏移比例）→ 行级聚合
 * 4. Top-K 选取 + 格式化输出
 *
 * 同时支持 fast path：当 reranker 已预计算 PruningHead keep probs 时，
 * 跳过模型加载和 forward pass，直接使用预计算数据。
 */
export class SemanticHighlightHighlighter implements IHighlighter {
  private readonly modelPath: string
  private readonly defaultMode: "topk" | "threshold"
  private readonly defaultTopK: number
  private readonly defaultThreshold: number
  private readonly logger?: LoggerLike

  private _model: LlamaModel | null = null
  private _embeddingContext: LlamaEmbeddingContext | null = null
  private _loadingPromise: Promise<void> | null = null

  /** Pruning Head 权重（从 GGUF metadata 动态读取） */
  private _pruningHeadWeight: Float32Array | null = null
  private _pruningHeadBias: Float32Array | null = null

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
   * 从 GGUF metadata 读取 Pruning Head 权重
   */
  private async _loadHeadWeights(): Promise<void> {
    if (this._pruningHeadWeight && this._pruningHeadBias) return

    this.logger?.debug(`[LlamaCppHighlight] Reading head weights from GGUF metadata: ${this.modelPath}`)
    const info = await readGgufFileInfo(this.modelPath, { readTensorInfo: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = info.metadata as any
    const ph = meta["open_provence"]?.["pruning_head"]
    if (!ph?.weight || !ph?.bias) {
      throw new Error(
        "Pruning Head weights not found in GGUF metadata. " +
        "Expected keys: open_provence.pruning_head.weight, open_provence.pruning_head.bias",
      )
    }
    this._pruningHeadWeight = new Float32Array(ph.weight as number[])
    this._pruningHeadBias = new Float32Array(ph.bias as number[])
    this.logger?.debug(
      `[LlamaCppHighlight] Head weights loaded: weight[${this._pruningHeadWeight.length}], bias[${this._pruningHeadBias.length}]`,
    )
  }

  /**
   * 延迟加载模型和 embedding context
   */
  private async _ensureModel(): Promise<void> {
    if (this._embeddingContext) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppHighlight] Loading model: ${this.modelPath}`)

      // 并行加载 GGUF metadata（head 权重）和 llama.cpp 模型
      await Promise.all([
        this._loadHeadWeights(),
        (async () => {
          const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
          this._model = await llama.loadModel({
            modelPath: this.modelPath,
          })
          const embedContextSize = this._model.trainContextSize
          this._embeddingContext = await this._model.createEmbeddingContext({
            batchSize: embedContextSize,
          })
        })(),
      ])

      this.logger?.debug(`[LlamaCppHighlight] Model loaded: ${this.modelPath}`)
    })()

    return this._loadingPromise
  }

  /**
   * 对给定代码块做行级高亮
   */
  async highlight(query: string, codeChunk: string, startLine: number, options?: HighlightOptions): Promise<HighlightResult> {
    const codeLines = codeChunk.split("\n")
    if (codeLines.length === 0) {
      return {
        formattedText: "",
        lines: [],
        startLine,
        endLine: startLine - 1,
      }
    }

    // ── Fast Path: 检测 reranker 预计算的 PruningHead keep probs ──
    // 当 rerankerProvider=highlighterProvider=semantic-highlight 时，
    // reranker 已计算 PruningHead(tokenEmbeddings)，存入 payload._semanticHighlightTokenProbs
    const precomputedProbs = options?._semanticHighlightTokenProbs
    if (precomputedProbs && precomputedProbs.length > 0) {
      // 使用 reranker 的输入格式（XLM-RoBERTa text pair）对齐 token 位置
      const input = `${query} </s></s> ${codeChunk}`
      const codeOffset = this._findCodeOffset(input, codeChunk)

      const lineScores = this._aggregatePrecomputedProbsToLines(
        codeChunk,
        codeLines,
        precomputedProbs,
        input,
        codeOffset,
      )

      if (lineScores.length === 0) {
        return this._fallbackAllLines(codeLines, startLine)
      }

      let debugTokenView: string | undefined
      if (options?.debugHighlight) {
        debugTokenView = this._buildDebugTokenViewFromProbs(
          input, codeChunk, codeLines, startLine, precomputedProbs, lineScores,
        )
      }

      const result = this._selectAndFormat(codeLines, startLine, lineScores, options)
      return { ...result, debugTokenView }
    }

    // ── Normal Path: 加载模型，完整 forward pass ──
    await this._ensureModel()

    // 1. 构建带 query 上下文的输入
    const input = `[Query] ${query} [Code] ${codeChunk}`

    // 2. 获取 token 级 embeddings（通过 GGUF backbone + pooling_type=none）
    const tokenEmbeddings = await this._embeddingContext!.getEmbeddingsForTokens(input)

    if (tokenEmbeddings.length === 0) {
      return this._fallbackAllLines(codeLines, startLine)
    }

    // 3. 应用 Pruning Head: logits = hidden @ W.T + b → softmax → probs[:,1]
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

    const result = this._selectAndFormat(codeLines, startLine, lineScores, options)
    return { ...result, debugTokenView }
  }

  /**
   * 将预计算的 PruningHead keep probs 聚合到代码行。
   */
  private _aggregatePrecomputedProbsToLines(
    codeChunk: string,
    codeLines: string[],
    precomputedProbs: Float32Array,
    input: string,
    codeOffset: number,
  ): number[] {
    const lineScores: number[] = new Array(codeLines.length).fill(0)
    const lineCounts: number[] = new Array(codeLines.length).fill(0)

    const totalChars = input.length
    const codeChars = codeChunk.length
    const totalTokens = precomputedProbs.length

    for (let ti = 0; ti < totalTokens; ti++) {
      const score = precomputedProbs[ti]
      const approxCharPos = (ti / totalTokens) * totalChars
      const codePos = approxCharPos - codeOffset

      if (codePos < 0 || codePos >= codeChars) continue

      let charCount = 0
      for (let i = 0; i < codeLines.length; i++) {
        const lineLen = codeLines[i].length + 1
        if (codePos >= charCount && codePos < charCount + lineLen) {
          lineScores[i] += score
          lineCounts[i]++
          break
        }
        charCount += lineLen
      }
    }

    for (let i = 0; i < lineScores.length; i++) {
      if (lineCounts[i] > 0) {
        lineScores[i] /= lineCounts[i]
      }
    }

    return lineScores
  }

  /**
   * 根据模式选取行 + 格式化输出（normal path 和 fast path 共用）
   */
  private _selectAndFormat(
    codeLines: string[],
    startLine: number,
    lineScores: number[],
    options?: HighlightOptions,
  ): HighlightResult {
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
      const topK = Math.min(options?.topK ?? this.defaultTopK, lineScores.length)
      const sortedIndices = lineScores
        .map((s, i) => ({ score: s, index: i }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      for (const item of sortedIndices) {
        keptSet.add(item.index)
      }
    }

    // 后处理：排除不连续纯符号行
    for (const idx of [...keptSet]) {
      const trimmed = codeLines[idx].trim();
      if (trimmed.length >= 1 && trimmed.length <= 3 && !/[\p{L}\p{N}_]/u.test(trimmed)) {
        if (!keptSet.has(idx - 1) && !keptSet.has(idx + 1)) {
          keptSet.delete(idx);
        }
      }
    }

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
    }
  }

  private _findCodeOffset(input: string, codeChunk: string): number {
    const idx = input.indexOf(codeChunk)
    return idx >= 0 ? idx : input.indexOf("[Code] ") + 7
  }

  private _applyPruningHead(hidden: number[]): number {
    const W = this._pruningHeadWeight!
    const B = this._pruningHeadBias!
    let logit0 = B[0]
    let logit1 = B[1]
    const dim = 1024

    for (let i = 0; i < dim && i < hidden.length; i++) {
      logit0 += hidden[i] * W[i]
      logit1 += hidden[i] * W[dim + i]
    }

    const maxLogit = Math.max(logit0, logit1)
    const exp0 = Math.exp(logit0 - maxLogit)
    const exp1 = Math.exp(logit1 - maxLogit)
    const sum = exp0 + exp1

    return exp1 / sum
  }

  private _aggregateTokensToLines(
    codeChunk: string,
    codeLines: string[],
    tokenEmbeddings: number[][],
    input: string,
    codeOffset: number,
  ): number[] {
    const lineScores: number[] = new Array(codeLines.length).fill(0)
    const lineCounts: number[] = new Array(codeLines.length).fill(0)

    const totalChars = input.length
    const codeChars = codeChunk.length
    const totalTokens = tokenEmbeddings.length

    for (let ti = 0; ti < totalTokens; ti++) {
      const tokenEmb = tokenEmbeddings[ti]
      const score = this._applyPruningHead(tokenEmb)

      const approxCharPos = (ti / totalTokens) * totalChars
      const codePos = approxCharPos - codeOffset

      if (codePos < 0 || codePos >= codeChars) continue

      let charCount = 0
      for (let i = 0; i < codeLines.length; i++) {
        const lineLen = codeLines[i].length + 1
        if (codePos >= charCount && codePos < charCount + lineLen) {
          lineScores[i] += score
          lineCounts[i]++
          break
        }
        charCount += lineLen
      }
    }

    for (let i = 0; i < lineScores.length; i++) {
      if (lineCounts[i] > 0) {
        lineScores[i] /= lineCounts[i]
      }
    }

    return lineScores
  }

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

    const parts: string[] = [];
    let charAcc = 0;
    const wordRe = /(\s+|[^\s]+)/g;

    for (let li = 0; li < codeLines.length; li++) {
      const line = codeLines[li];
      const segments: string[] = [];

      let match: RegExpExecArray | null;
      wordRe.lastIndex = 0;
      while ((match = wordRe.exec(line)) !== null) {
        const word = match[1];
        const midLocal = match.index + Math.floor(word.length / 2);
        const codePos = charAcc + midLocal;
        const ti = Math.floor(((codePos + codeOffset) / totalChars) * totalTokens);
        const wordScore = ti >= 0 && ti < totalTokens ? perTokenScores[ti] : 0;
        const color = scoreToAnsiFg(wordScore, maxScore);
        segments.push(`${color}${word}`);
      }
      if (segments.length > 0) segments.push(ANSI_RESET);

      charAcc += line.length + 1;

      const s = lineScores[li] ?? 0;
      const filled = Math.round((s / maxLineScore) * barWidth);
      const bar =
        `${scoreToAnsiFg(s, maxLineScore)}█${ANSI_RESET}`.repeat(filled) +
        "░".repeat(barWidth - filled);
      const lineNum = String(startLine + li).padStart(4);
      const scoreStr = s.toFixed(6);

      parts.push(`  ${lineNum} ${bar} ${scoreStr} │  ${segments.join("")}`);
    }

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
   * [debug] fast path 版热力图 — 使用预计算 probs。
   */
  private _buildDebugTokenViewFromProbs(
    input: string,
    codeChunk: string,
    codeLines: string[],
    startLine: number,
    precomputedProbs: Float32Array,
    lineScores: number[],
  ): string {
    const totalTokens = precomputedProbs.length
    if (totalTokens === 0) return ""

    const codeOffset = this._findCodeOffset(input, codeChunk)
    const totalChars = input.length
    const codeChars = codeChunk.length
    const barWidth = 10

    const perTokenScores = precomputedProbs
    let maxScore = 0
    for (let ti = 0; ti < totalTokens; ti++) {
      const codePos = (ti / totalTokens) * totalChars - codeOffset
      if (codePos >= 0 && codePos < codeChars && precomputedProbs[ti] > maxScore) {
        maxScore = precomputedProbs[ti]
      }
    }
    if (maxScore <= 0) maxScore = 0.0001

    const maxLineScore = Math.max(...lineScores, 0.00001)

    const parts: string[] = []
    let charAcc = 0
    const wordRe = /(\s+|[^\s]+)/g

    for (let li = 0; li < codeLines.length; li++) {
      const line = codeLines[li]
      const segments: string[] = []

      let match: RegExpExecArray | null
      wordRe.lastIndex = 0
      while ((match = wordRe.exec(line)) !== null) {
        const word = match[1]
        const midLocal = match.index + Math.floor(word.length / 2)
        const codePos = charAcc + midLocal
        const ti = Math.floor(((codePos + codeOffset) / totalChars) * totalTokens)
        const wordScore = ti >= 0 && ti < totalTokens ? perTokenScores[ti] : 0
        const color = scoreToAnsiFg(wordScore, maxScore)
        segments.push(`${color}${word}`)
      }
      if (segments.length > 0) segments.push(ANSI_RESET)

      charAcc += line.length + 1

      const s = lineScores[li] ?? 0
      const filled = Math.round((s / maxLineScore) * barWidth)
      const bar =
        `${scoreToAnsiFg(s, maxLineScore)}█${ANSI_RESET}`.repeat(filled) +
        "░".repeat(barWidth - filled)
      const lineNum = String(startLine + li).padStart(4)
      const scoreStr = s.toFixed(6)

      parts.push(`  ${lineNum} ${bar} ${scoreStr} │  ${segments.join("")}`)
    }

    let codeScoreSum = 0
    let codeScoreMin = Infinity
    let codeTokenCount = 0
    for (let ti = 0; ti < totalTokens; ti++) {
      const codePos = (ti / totalTokens) * totalChars - codeOffset
      if (codePos >= 0 && codePos < codeChars) {
        const s = perTokenScores[ti]
        codeScoreSum += s
        if (s < codeScoreMin) codeScoreMin = s
        codeTokenCount++
      }
    }
    if (codeScoreMin === Infinity) codeScoreMin = 0
    const mean = codeTokenCount > 0 ? codeScoreSum / codeTokenCount : 0

    const legendSteps = [
      { label: "low", ratio: 0.05 },
      { label: "", ratio: 0.3 },
      { label: "med", ratio: 0.5 },
      { label: "", ratio: 0.7 },
      { label: "high", ratio: 1.0 },
    ]
    const legendStr = legendSteps
      .map(({ label, ratio }) => `${scoreRatioToAnsiFg(ratio)}■${ANSI_RESET}${label}`)
      .join("  ")

    return [
      `${ANSI_RESET}═══ Token (Pruning Head) Heatmap (fast path) ═══`,
      ...parts,
      `\n─── Stats ───`,
      `  Tokens: ${codeTokenCount}  |  max=${maxScore.toFixed(6)}  min=${codeScoreMin.toFixed(6)}  mean=${mean.toFixed(6)}`,
      `  Legend: ${legendStr}`,
      `═══════════════════════════════`,
    ].join("\n")
  }

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
