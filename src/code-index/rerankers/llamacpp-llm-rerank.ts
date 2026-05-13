import { LlamaModel, LlamaChatSession, QwenChatWrapper } from "node-llama-cpp"
import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/**
 * Implements the IReranker interface using a shared LlamaCPP LLM model for chat-based scoring.
 * Unlike LlamaCppReranker (which uses a dedicated cross-encoder reranker model),
 * this class uses LLM chat completion to score candidate relevance.
 */
export class LlamaCppLLMReranker implements IReranker {
	private readonly model: LlamaModel
	private readonly logger?: LoggerLike
	private readonly batchSize: number
	private readonly concurrency: number
	private readonly maxRetries: number
	private readonly retryDelayMs: number

	constructor(
		model: LlamaModel,
		logger?: LoggerLike,
		batchSize: number = 10,
		concurrency: number = 3,
		maxRetries: number = 3,
		retryDelayMs: number = 1000,
	) {
		this.model = model
		this.logger = logger
		this.batchSize = batchSize
		this.concurrency = concurrency
		this.maxRetries = maxRetries
		this.retryDelayMs = retryDelayMs
	}

	async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
		if (candidates.length === 0) return []

		// Single batch — fast path without batching machinery
		if (candidates.length <= this.batchSize) {
			const context = await this.model.createContext({ contextSize: 32768 })
			return this.rerankSingleBatch(query, candidates, context)
		}

		const batches: RerankerCandidate[][] = []
		for (let i = 0; i < candidates.length; i += this.batchSize) {
			batches.push(candidates.slice(i, i + this.batchSize))
		}

		const allResults: RerankerResult[] = []

		// Process batches with concurrency control
		// Each batch creates its own context, verified thread-safe experimentally.
		for (let i = 0; i < batches.length; i += this.concurrency) {
			const batchGroup = batches.slice(i, i + this.concurrency)
			const groupResults = await Promise.all(
				batchGroup.map((batch, j) =>
					this.processBatchWithRetry(query, batch, i + j, batches.length)
				)
			)
			for (const results of groupResults) {
				allResults.push(...results)
			}
		}

		allResults.sort((a, b) => b.score - a.score)
		return allResults
	}

	private async processBatchWithRetry(
		query: string,
		batch: RerankerCandidate[],
		batchIndex: number,
		totalBatches: number,
	): Promise<RerankerResult[]> {
		let attempt = 0

		while (attempt < this.maxRetries) {
			try {
				const context = await this.model.createContext({ contextSize: 32768 })
				const results = await this.rerankSingleBatch(query, batch, context)
				this.logger?.info(
					`[LlamaCppLLMReranker] Progress: ${batchIndex + 1}/${totalBatches} batches completed`,
				)
				return results
			} catch (error) {
				attempt++
				if (attempt < this.maxRetries) {
					const delay = this.retryDelayMs * Math.pow(2, attempt - 1)
					this.logger?.warn(
						`[LlamaCppLLMReranker] Batch ${batchIndex + 1} failed (attempt ${attempt}/${this.maxRetries}): ${(error as Error).message}. Retrying in ${delay}ms...`,
					)
					await new Promise((resolve) => setTimeout(resolve, delay))
				} else {
					this.logger?.warn(
						`[LlamaCppLLMReranker] Batch ${batchIndex + 1} failed after ${this.maxRetries} attempts. Using fallback scores...`,
					)
					const baseScore = 10 - batchIndex * 0.1
					return batch.map((candidate, idx) => ({
						id: candidate.id,
						score: baseScore - idx * 0.01,
						originalScore: candidate.score,
						payload: candidate.payload,
					}))
				}
			}
		}

		return []
	}

	private async rerankSingleBatch(query: string, candidates: RerankerCandidate[], context: import("node-llama-cpp").LlamaContext): Promise<RerankerResult[]> {
		const prompt = this.buildScoringPrompt(query, candidates)
		const scores = await this.generateScores(prompt, context, candidates.length)

		const results: RerankerResult[] = candidates.map((candidate, index) => ({
			id: candidate.id,
			score: scores[index] || 0,
			originalScore: candidate.score,
			payload: candidate.payload,
		}))

		results.sort((a, b) => b.score - a.score)
		return results
	}

	private buildScoringPrompt(query: string, candidates: RerankerCandidate[]): string {
		let prompt = `You are a code relevance scorer. Given a search query and code snippets with their hierarchy context, rate each snippet's relevance (0-10).

Scoring criteria:

10 points: Directly implements the exact functionality asked about
7-9 points: Contains the core logic related to the query
4-6 points: Related helper/utility code, indirectly relevant
1-3 points: Tangentially mentions related keywords, no direct relevance
0 points: Completely unrelated

IMPORTANT: Be highly critical. Most snippets are NOT directly relevant to the query. Only 1-2 out of 10-20 snippets should score 7+. Default to low scores (0-3) unless the code directly implements what the query asks for.

Query: ${query}

<snippets>
`

		candidates.forEach((candidate, index) => {
			const contextInfo = this.buildContextInfo(candidate)
			prompt += `<snippet index="${index + 1}"${contextInfo ? " " + contextInfo : ""}>
<code>
${candidate.content}
</code>
</snippet>
`
		})

		prompt += `</snippets>

Respond with ONLY JSON Lines, one object per line. For each snippet, first analyze the code relevance in reason, then assign a score. No other text or formatting. Output exactly ${candidates.length} lines. Example:
${this.buildExampleScores(candidates.length)}`

		return prompt
	}

	private buildExampleScores(count: number): string {
		if (count === 1) {
			return `{"index":1,"reason":"Callback helper, not train logic","score":2}`
		} else if (count >= 3) {
			return [
				`{"index":1,"reason":"Directly implements train method","score":8}`,
				`{"index":2,"reason":"Related helper utility","score":3}`,
				`{"index":3,"reason":"README doc, no code","score":0}`,
			].join("\n")
		} else {
			return [
				`{"index":1,"reason":"Directly implements train method","score":8}`,
				`{"index":2,"reason":"README doc, no code","score":0}`,
			].join("\n")
		}
	}

			private buildContextInfo(candidate: RerankerCandidate): string {
		const parts: string[] = []
		if (candidate.payload?.hierarchyDisplay) {
			parts.push(`context="${candidate.payload.hierarchyDisplay.replace(/"/g, "&quot;")}"`)
		}
		if (candidate.payload?.filePath) {
			parts.push(`file="${candidate.payload.filePath.replace(/"/g, "&quot;")}"`)
		}
		return parts.join(" ")
	}

	private async generateScores(prompt: string, context: import("node-llama-cpp").LlamaContext, expectedCount: number): Promise<number[]> {
		const sequence = context.getSequence()
		const chatWrapper = new QwenChatWrapper({
			variation: "3.5",
			thoughts: "discourage",
		})
		const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })

		const response = await session.prompt(prompt, {
			maxTokens: 1024,
			temperature: 0.7,
		})

		this.logger?.debug(`[LlamaCppLLMReranker] Raw response: ${response.replace(/\n/g, '\\n')}`)

		// Strip <think>...</think> tags that Qwen3 models output even in chat mode
		const cleaned = response.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()

		if (!cleaned) {
			throw new Error("Empty response after stripping think tags")
		}

		// Parse JSON Lines — each line is a JSON object
		const scoresMap = new Map<number, number>()
		const lines = cleaned.split("\n")

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed.startsWith("{")) continue

			try {
				const obj = JSON.parse(trimmed)
				if (typeof obj.index === "number" && typeof obj.score === "number") {
					const idx = obj.index - 1  // Convert to 0-based
					const score = Math.max(0, Math.min(10, obj.score))
					if (idx >= 0 && idx < 100 && !scoresMap.has(idx)) {
						scoresMap.set(idx, score)
					}
				}
			} catch {
				// Skip malformed lines
				continue
			}
		}

		if (scoresMap.size === 0) {
			throw new Error(`Failed to extract any valid JSON Lines from LLM response: ${cleaned}`)
		}

		// Build result array, defaulting missing indices to 0
		return Array.from({ length: expectedCount }, (_, i) => scoresMap.get(i) ?? 0)
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			const context = await this.model.createContext({ contextSize: 32768 })
			const sequence = context.getSequence()
			const chatWrapper = new QwenChatWrapper({
			variation: "3.5",
			thoughts: "discourage",
		})
			const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
			await session.prompt("test", {
				maxTokens: 10,
			})
			return { valid: true }
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : "LlamaCPP LLM reranker validation failed",
			}
		}
	}

	get rerankerInfo(): RerankerInfo {
		return { name: "llamacpp", model: "" }
	}
}
