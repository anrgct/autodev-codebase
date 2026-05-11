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
		const scores = await this.generateScores(prompt, context)

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

10 points: Perfect match with query intent, directly includes relevant code
7-9 points: Highly relevant, includes relevant functions/classes/concepts
4-6 points: Moderately relevant, mentions related topics but not directly
1-3 points: Slightly relevant, only indirect connections
0 points: Completely unrelated

Query: ${query}

Snippets:
`

		candidates.forEach((candidate, index) => {
			const contextInfo = this.buildContextInfo(candidate)
			prompt += `## snippet ${index + 1} ${contextInfo}\`\`\`\n${candidate.content}\`\`\`
---
`
		})

		prompt += `Respond with ONLY a JSON object with a relevant "scores" array: {"scores": [${Array.from({ length: candidates.length }, (_, i) => `snippet${i + 1}_score`).join(", ")}]}`

		return prompt
	}

	private buildContextInfo(candidate: RerankerCandidate): string {
		const parts: string[] = []
		if (candidate.payload?.hierarchyDisplay) {
			parts.push(`[Context: ${candidate.payload.hierarchyDisplay}]`)
		}
		if (candidate.payload?.filePath) {
			parts.push(`[File: ${candidate.payload.filePath}]`)
		}
		return parts.length > 0 ? parts.join(" ") + "\n" : ""
	}

	private async generateScores(prompt: string, context: import("node-llama-cpp").LlamaContext): Promise<number[]> {
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

		this.logger?.debug(`[LlamaCppLLMReranker] Raw response: ${response.substring(0, 200)}`)

		// Strip <think>...</think> tags that Qwen3 models output even in chat mode
		const cleaned = response.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()

		if (!cleaned) {
			throw new Error("Empty response after stripping think tags")
		}

		let parsed: any
		try {
			parsed = JSON.parse(cleaned)
		} catch {
			const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				try {
					parsed = JSON.parse(jsonMatch[0])
				} catch {
					throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`)
				}
			} else {
				throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`)
			}
		}

		if (!parsed.scores || !Array.isArray(parsed.scores)) {
			throw new Error("Invalid response format. Expected object with 'scores' array.")
		}

		return parsed.scores.map((score: number | string) => {
			const num = typeof score === "number" ? score : parseFloat(score)
			return isNaN(num) ? 0 : Math.max(0, Math.min(10, num))
		})
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
