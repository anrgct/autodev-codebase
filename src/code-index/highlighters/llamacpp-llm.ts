import { getLlama, LlamaModel, LlamaChatSession, QwenChatWrapper, LlamaLogLevel } from "node-llama-cpp"
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
 * 与 LlamaCppHighlightProvider（专用 GGUF 模型 + pruning head）不同，
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

			// 3. 解析 JSONL 响应
			const ranges = this._parseResponse(response, startLine, codeLines.length)

				if (ranges.length === 0) {
				// 模型判定无相关行 — 返回空结果
					return this._emptyResult(codeLines, startLine)
				}

			// 4. 构建 HighlightResult
			return this._buildResult(codeLines, startLine, ranges, options)
		} finally {
			// 释放 context（不保留状态）
			// LlamaContext 通过 GC 回收，无需显式释放
		}
	}

	/**
	 * 构建针对 0.6B 小模型优化的 prompt
	 */
	private _buildPrompt(
		query: string,
		codeLines: string[],
		startLine: number,
		_options?: HighlightOptions,
	): string {
		const numberedCode = codeLines
			.map((line, i) => `${String(startLine + i).padStart(4)}  ${line}`)
			.join("\n")

		return `Find ALL line ranges in this code related to: "${query}"
Output each range as one JSON line with "reason", "startLine", "endLine".
If nothing is related, output: {"reason":"not related","startLine":0,"endLine":0}

Example with multiple ranges:
   5  class Model:
  12      def train(self, data, epochs=10):
  13          optimizer = torch.optim.Adam()
  18          return self
  30      @property
  32          return self.device
  50      def evaluate(self):
  51          self.train(data)
Output:
{"reason":"defines train method","startLine":12,"endLine":18}
{"reason":"calls train method","startLine":50,"endLine":51}

Example with nothing found:
  30  @property
  32      return self.device
Output:
{"reason":"not related","startLine":0,"endLine":0}

Now analyze:
${numberedCode}
Output:`
	}
	/**
	 * 解析 LLM 返回的 JSONL 行范围
	 */
	private _parseResponse(
		response: string,
		startLine: number,
		totalLines: number,
	): Array<{ reason: string; startLine: number; endLine: number }> {
		// 去除 <think>...</think> 标签
		const cleaned = response.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
		if (!cleaned) return []

		// 如果模型返回 startLine:0 且 endLine:0 表示代码与 query 无关
		if (/"startLine"\s*:\s*0\b/.test(cleaned) && /"endLine"\s*:\s*0\b/.test(cleaned)) return []
		// 确保响应中至少有一个包含 startLine 的 JSON 对象
		if (!/"startLine"\s*:/.test(cleaned)) return []

		const endLine = startLine + totalLines - 1
		const ranges: Array<{ reason: string; startLine: number; endLine: number }> = []
		const lines = cleaned.split("\n")

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed.startsWith("{")) continue

			try {
				const obj = JSON.parse(trimmed)
				if (
					typeof obj.startLine === "number" &&
					typeof obj.endLine === "number"
				) {
					const s = Math.max(startLine, Math.min(obj.startLine, endLine))
					const e = Math.max(s, Math.min(obj.endLine, endLine))
					ranges.push({
						reason: typeof obj.reason === "string" ? obj.reason : "",
						startLine: s,
						endLine: e,
					})
				}
			} catch {
				// 跳过无法解析的行
				continue
			}
		}

		return ranges
	}

	/**
	 * 根据 LLM 返回的行范围构建 HighlightResult
	 */
	private _buildResult(
		codeLines: string[],
		startLine: number,
		ranges: Array<{ reason: string; startLine: number; endLine: number }>,
		options?: HighlightOptions,
	): HighlightResult {
		const endLine = startLine + codeLines.length - 1

		// 构建 kept set
		const keptSet = new Set<number>()
		for (const range of ranges) {
			for (let ln = range.startLine; ln <= range.endLine; ln++) {
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
				// 范围已按 LLM 输出顺序排列（通常重要性递减），截断到 topK
				let count = 0
				const trimmedSet = new Set<number>()
				for (const range of ranges) {
					for (let ln = range.startLine; ln <= range.endLine; ln++) {
						const idx = ln - startLine
						if (idx >= 0 && idx < codeLines.length && keptSet.has(idx)) {
							trimmedSet.add(idx)
							count++
							if (count >= topK) break
						}
					}
					if (count >= topK) break
				}
				// 替换 keptSet
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
	 * 与 LlamaCppHighlightProvider._formatOutput 保持一致
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
			const sequence = context.getSequence()
			const chatWrapper = new QwenChatWrapper({
				variation: "3.5",
				thoughts: "discourage",
			})
			const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
			await session.prompt("Say 'ok'", { maxTokens: 5 })
			return { valid: true }
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
}
