import { getLlama, LlamaModel, LlamaChatSession, QwenChatWrapper, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import type {
  IHighlighter,
  HighlightLine,
  HighlightResult,
  HighlighterInfo,
  HighlightOptions,
} from "../interfaces/highlighter"
import type { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">

/**
 * 使用 LLM chat prompt 实现的行级语义高亮器。
 *
 与 SemanticHighlightHighlighter（专用 GGUF 模型 + pruning head）不同，
 * 此类通过 LLM prompt 工程判断代码行相关性，适用于 0.6B 小模型。
 *
 * 架构：
 * 1. 延迟加载 GGUF 模型
 * 2. 构建极简 prompt（query + 行号标注的代码）
 * 3. LLM chat session 返回 JSONL 行范围
 * 4. 解析响应 → build HighlightResult
 */
export class LlamaCppLLMHighlighter implements IHighlighter {
  private readonly modelPath: string
  private readonly defaultMode: "topk" | "threshold"
  private readonly defaultTopK: number
  private readonly defaultThreshold: number
  private readonly logger?: LoggerLike

  private _model: LlamaModel | null = null
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
   * 延迟加载模型
   */
  private async _ensureModel(): Promise<LlamaModel> {
    if (this._model) return this._model
    if (this._loadingPromise) {
      await this._loadingPromise
      return this._model!
    }

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppLLMHighlighter] Loading model: ${this.modelPath}`)
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({ modelPath: this.modelPath })
      this.logger?.debug(`[LlamaCppLLMHighlighter] Model loaded: ${this.modelPath}`)
    })()

    await this._loadingPromise
    return this._model!
  }

  /**
   * 对给定代码块做行级高亮
   */
  async highlight(
    query: string,
    codeChunk: string,
    startLine: number,
    options?: HighlightOptions,
  ): Promise<HighlightResult> {
    const codeLines = codeChunk.split("\n")
    if (codeLines.length === 0) {
      return { formattedText: "", lines: [], startLine, endLine: startLine - 1 }
    }

    // 1. 构建 prompt（带行号的代码）
    const prompt = this._buildPrompt(query, codeLines, startLine, options)
    this.logger?.debug(`[LlamaCppLLMHighlighter] Prompt (first 600 chars): ${prompt.substring(0, 600).replace(/\n/g, "\\n")}`)

    // 2. 确保模型已加载
    const model = await this._ensureModel()

    // 3. 调用 LLM
    const context = await model.createContext({ contextSize: 32768 })
    try {
      const sequence = context.getSequence()
      const chatWrapper = new QwenChatWrapper({
        variation: "3.5",
        thoughts: "discourage",
      })
      const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })

      const response = await session.prompt(prompt, {
        maxTokens: 512,
        temperature: 0.1, // 低温度确保确定性
      })

      this.logger?.debug(
        `[LlamaCppLLMHighlighter] Raw response: ${response.replace(/\n/g, "\\n")}`,
      )

      // 3. 解析响应
      const range = this._parseResponse(response, startLine, codeLines.length)

      if (!range) {
        // 模型判定无相关行 — 返回空结果
        return this._emptyResult(codeLines, startLine)
      }

      // 4. 构建 HighlightResult
      return this._buildResult(codeLines, startLine, range, options)
    } finally {
      await context.dispose()
    }
  }

  /**
   * 构建针对 0.6B 小模型优化的 prompt（基于 MiniCPM 17 轮实测优化）
   *
   * 核心设计：TOPIC 前缀 + matching 语义 + 无示例 + 负向约束
   */
  private _buildPrompt(
    query: string,
    codeLines: string[],
    startLine: number,
    _options?: HighlightOptions,
  ): string {
    const normalized = query.replace(/^where\s+is\s+/i, '')
    const numberedCode = codeLines
      .map((line, i) => `${String(startLine + i).padStart(4)}  ${line}`)
      .join("\n")

    return `TOPIC: "${normalized}"

Find lines in this code matching this topic.
Matching = defines, implements, describes, or references the concept.
Synonyms count. Word overlap with different meaning does NOT count.

Output: START N END M (two numbers) or 0 0 if no match.

CODE:
${numberedCode}

RESULT:`
  }
  /**
   * 解析 LLM 返回的单范围输出（START N END M / 0 0 / NONE 等格式）
   */
  private _parseResponse(
    response: string,
    startLine: number,
    totalLines: number,
  ): { start: number; end: number } | null {
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
    if (!cleaned) return null

    const endLine = startLine + totalLines - 1

    // "START N END M" 或 "START N M END" 格式
    let m = cleaned.match(/START\s+(\d+)\s+END\s+(\d+)/i)
    if (!m) m = cleaned.match(/START\s+(\d+)\s+(\d+)\s*END/i)
    if (m) {
      const s = parseInt(m[1], 10)
      const e = parseInt(m[2], 10)
      if (s > 0 && e > 0 && s >= startLine && s <= endLine && s <= e) {
        return { start: s, end: Math.min(e, endLine) }
      }
    }

    // "0 0" 或 "NONE" → 无匹配
    if (/^\s*(NONE|0\s*[,\s]\s*0)\s*$/im.test(cleaned)) return null

    // 范围格式: Lxxx-Lyyy 或 xxx-yyy
    const rangeMatch = cleaned.match(/L?(\d+)\s*[-]\s*L?(\d+)/)
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1], 10)
      const e = parseInt(rangeMatch[2], 10)
      if (s > 0 && e > 0 && s >= startLine && e <= endLine && s <= e) {
        return { start: s, end: e }
      }
    }

    // 通用数字对 "X Y"（从后往前，取最后一个有效对）
    const pairs = cleaned.match(/\b(\d+)\s+(\d+)\b/g)
    if (pairs) {
      for (let i = pairs.length - 1; i >= 0; i--) {
        const pm = pairs[i].match(/(\d+)\s+(\d+)/)
        if (!pm) continue
        const s = parseInt(pm[1], 10)
        const e = parseInt(pm[2], 10)
        if (s === 0 || e === 0) continue
        if (s > e) continue
        if (s >= startLine && e <= endLine) {
          return { start: s, end: e }
        }
      }
    }

    return null
  }

  /**
   * 根据 LLM 返回的行范围构建 HighlightResult
   */
  private _buildResult(
    codeLines: string[],
    startLine: number,
    range: { start: number; end: number } | null,
    options?: HighlightOptions,
  ): HighlightResult {
    const endLine = startLine + codeLines.length - 1

    // 构建 kept set（单范围）
    const keptSet = new Set<number>()
    if (range) {
      for (let ln = range.start; ln <= range.end; ln++) {
        const idx = ln - startLine
        if (idx >= 0 && idx < codeLines.length) {
          keptSet.add(idx)
        }
      }
    }

    // 如果 LLM 保留的行太多，按 topK 裁剪
    const mode = options?.mode ?? this.defaultMode
    if (mode === "topk" && keptSet.size > 0) {
      const topK = options?.topK ?? this.defaultTopK
      if (keptSet.size > topK) {
        let count = 0
        const trimmedSet = new Set<number>()
        for (const idx of keptSet) {
          trimmedSet.add(idx)
          count++
          if (count >= topK) break
        }
        keptSet.clear()
        for (const idx of trimmedSet) keptSet.add(idx)
      }
    }

    // 构建 lines
    const lines: HighlightLine[] = codeLines.map((text, i) => ({
      lineNumber: startLine + i,
      text,
      score: keptSet.has(i) ? 1 : 0,
      kept: keptSet.has(i),
    }))

    // 格式化输出
    const formattedText = this._formatOutput(lines)

    return { formattedText, lines, startLine, endLine }
  }

  /**
   * 格式化输出：保留行按行号排序，连续行成组，组间用 `---` 分隔
   与 SemanticHighlightHighlighter._formatOutput 保持一致
   */
  private _formatOutput(lines: HighlightLine[]): string {
    const keptLines: Array<{ num: number; text: string }> = []
    for (const line of lines) {
      if (line.kept) {
        keptLines.push({ num: line.lineNumber, text: line.text })
      }
    }

    if (keptLines.length === 0) {
      return ""
    }

    keptLines.sort((a, b) => a.num - b.num)

    const groups: Array<Array<{ num: number; text: string }>> = []
    let currentGroup: Array<{ num: number; text: string }> = []

    for (const line of keptLines) {
      if (
        currentGroup.length === 0 ||
        line.num === currentGroup[currentGroup.length - 1].num + 1
      ) {
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
   * 当 LLM 判定无相关行时，返回空结果
   */
  private _emptyResult(codeLines: string[], startLine: number): HighlightResult {
    return {
      formattedText: "",
      lines: [],
      startLine,
      endLine: startLine + codeLines.length - 1,
    }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      const fs = await import("fs")
      if (!fs.existsSync(this.modelPath)) {
        return { valid: false, error: `Highlight LLM model file not found: ${this.modelPath}` }
      }

      const model = await this._ensureModel()
      const context = await model.createContext({ contextSize: 32768 })
      try {
        const sequence = context.getSequence()
        const chatWrapper = new QwenChatWrapper({
          variation: "3.5",
          thoughts: "discourage",
        })
        const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
        await session.prompt("Say 'ok'", { maxTokens: 5 })
        return { valid: true }
      } finally {
        await context.dispose()
      }
    } catch (error) {
      return {
        valid: false,
        error:
          error instanceof Error
            ? error.message
            : "LlamaCPP LLM highlighter validation failed",
      }
    }
  }

  get highlighterInfo(): HighlighterInfo {
    return {
      name: "llamacpp-llm",
      model: this.modelPath,
    }
  }

  async dispose(): Promise<void> {
    if (this._model) {
      await this._model.dispose().catch(() => {});
      this._model = null;
    }
    this._loadingPromise = null;
  }
}
