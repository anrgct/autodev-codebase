import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo, SummarizerBatchRequest, SummarizerBatchResult } from "../interfaces"
import { LlamaModel, LlamaChatSession, QwenChatWrapper, LlamaContext, LlamaContextSequence } from "@realtimex/node-llama-cpp"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export class LlamaCppSummarizer implements ISummarizer {
  private readonly model: LlamaModel
  private readonly defaultLanguage: 'English' | 'Chinese'
  private readonly temperature: number
  private readonly logger?: LoggerLike
  private readonly _concurrency: number
  private readonly _sequences: number
  private _contexts: LlamaContext[] = []
  private _sequencePool: LlamaContextSequence[] = []
  private _seqIdx: number = 0
  private _contextPoolPromise: Promise<void> | null = null

  constructor(
    model: LlamaModel,
    defaultLanguage: 'English' | 'Chinese' = 'English',
    temperature: number = 0,
    logger?: LoggerLike,
    concurrency: number = 2,
    sequences?: number,
  ) {
    this.model = model
    this.defaultLanguage = defaultLanguage
    this.temperature = temperature
    this.logger = logger
    this._concurrency = concurrency
    // 池化: slot 数 = 并发数. 之前 ×2 是为兑底 _reclaimUnusedSequenceId 的
    // fire-and-forget race, 现在池化方案完全避开了 race, 不再需要冗余 slot.
    this._sequences = sequences ?? concurrency
  }

  private async _ensureContexts(): Promise<typeof this._contexts> {
    if (this._contexts.length > 0) return this._contexts
    if (this._contextPoolPromise) {
      await this._contextPoolPromise
      return this._contexts
    }

    this._contextPoolPromise = (async () => {
      this.logger?.debug(`[LlamaCppSummarizer] Creating context with ${this._sequences} sequence(s)`)
      const ctx = await this.model.createContext({
        contextSize: Math.min(this.model.trainContextSize ?? 32768, 32768),
        sequences: this._sequences,
      })
      this._contexts = [ctx]
      // Pooling: 一次性从 context 拿 _sequences 个 sequence, 永久持有
      // 避免 _reclaimUnusedSequenceId 的 fire-and-forget race
      // (见 docs/plans/260608-no-sequences-left-root-cause.md)
      // clearHistory() 负责在每次 call 前重置 KV cache, 不再调 native dispose
      for (let i = 0; i < this._sequences; i++) {
        this._sequencePool.push(ctx.getSequence())
      }
      this.logger?.info(`[LlamaCppSummarizer] Created 1 context with ${this._sequences} pooled sequence(s)`)
    })()

    await this._contextPoolPromise
    return this._contexts
  }

  async summarize(request: SummarizerRequest): Promise<SummarizerResult> {
    const batchRequest: SummarizerBatchRequest = {
      document: request.document,
      filePath: request.filePath,
      blocks: [{
        content: request.content,
        codeType: request.codeType,
        codeName: request.codeName
      }],
      language: request.language
    }

    const result = await this.summarizeBatch(batchRequest)
    return result.summaries[0]
  }

  private extractCompleteJsonObject(text: string): string | null {
    const startIndex = text.indexOf('{')
    if (startIndex === -1) return null

    let depth = 0
    let inString = false
    let escapeNext = false

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i]

      if (escapeNext) {
        escapeNext = false
        continue
      }

      if (char === '\\') {
        escapeNext = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (!inString) {
        if (char === '{') {
          depth++
        } else if (char === '}') {
          depth--
          if (depth === 0) return text.substring(startIndex, i + 1)
        }
      }
    }

    return null
  }

  /**
   * Attempt to repair malformed JSON from model output.
   * Tracks both {} and [] bracket depth to handle trailing extra brackets
   * that some models (e.g. MiniCPM-V) occasionally produce.
   */
  private tryRepairJson(text: string): string | null {
    const startIndex = text.indexOf('{')
    if (startIndex === -1) return null

    const stack: string[] = []
    let inString = false
    let escapeNext = false
    let result = ''
    let foundComplete = false

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i]

      if (escapeNext) {
        escapeNext = false
        result += char
        continue
      }

      if (char === '\\') {
        escapeNext = true
        result += char
        continue
      }

      if (char === '"') {
        inString = !inString
        result += char
        continue
      }

      if (inString) {
        result += char
        continue
      }

      if (char === '{') {
        stack.push('{')
        result += char
      } else if (char === '[') {
        stack.push('[')
        result += char
      } else if (char === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop()
          result += char
          if (stack.length === 0) {
            foundComplete = true
            break
          }
        } else {
          // Mismatched: extra content after valid JSON
          break
        }
      } else if (char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop()
          result += char
        }
        // Ignore mismatched ] (model may add extra trailing bracket)
      } else {
        result += char
      }
    }

    if (foundComplete) return result
    return null
  }

  private buildPrompt(request: SummarizerBatchRequest): string {
    const { blocks, language, document, filePath } = request

    let prompt = `You are given ${blocks.length} individual code snippet(s). Generate ONE semantic description for EACH snippet below:\n\n`

    if (filePath) {
      prompt += `[File]: ${filePath}\n\n`
    }
    if (document) {
      prompt += `[Shared Context]:\n\`\`\`\n${document}\n\`\`\`\n\n`
    }

    blocks.forEach((block, index) => {
      prompt += `### Snippet ${index + 1}\n\n`
      prompt += `[Type]: ${block.codeType}${block.codeName ? ` "${block.codeName}"` : ''}\n\n`
      prompt += `[Target Code]:\n`

      if (block.content === document) {
        prompt += `(See Shared Context)\n\n---\n\n`
      } else {
        prompt += `\`\`\`\n${block.content}\n\`\`\`\n\n---\n\n`
      }
    })

    prompt += `Requirements:\n`
    prompt += `- Generate semantic description for each snippet\n`
    prompt += `- Focus on logic, implementation details, business role\n`
    prompt += `- **Start directly with verbs**, NO prefixes like "Function X" or "Class Y"\n`
    prompt += `- For core implementations, include keywords like "implements", "logic"\n\n`

    if (language === 'Chinese') {
      prompt += `IMPORTANT: Respond in **Chinese (中文)**. Each description must be 30-80 Chinese characters.\n\n`
    }

    const placeholder = language === 'Chinese' ? '[描述]' : '[DESCRIPTION]'

    prompt += `Output format:\n`
    for (let i = 1; i <= blocks.length; i++) {
      prompt += `{"index":${i},"summary":"${placeholder}"}\n`
    }
    if (blocks.length === 1) {
      prompt += `\nReplace ${placeholder} with the actual description. `
      prompt += `Output ONLY this one line, nothing else.\n`
    } else {
      prompt += `\nReplace each ${placeholder} with the actual description. `
      prompt += `Output exactly ${blocks.length} lines. Do NOT add any text before or after.\n`
    }

    return prompt
  }

  async summarizeBatch(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
    const prompt = this.buildPrompt(request)
    this.logger?.debug(`Summarizing ${request.blocks.length} blocks for ${request.filePath || 'unknown file'}`)

    await this._ensureContexts()

    // 池化分配: 轮询从池中借一个 sequence, 不调 dispose
    // (避免 _reclaimUnusedSequenceId 的 fire-and-forget race)
    const sequence = this._sequencePool[this._seqIdx++ % this._sequencePool.length]

    // clearHistory 重置 KV cache, 用 withLock(锁) 串行化访问同一个 context
    await sequence.clearHistory()

    const chatWrapper = new QwenChatWrapper({
      variation: "3.5",
      thoughts: "discourage",
    })
    const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })

    const response = await session.prompt(prompt, {
      temperature: this.temperature,
      maxTokens: 4096,
    })

    const responseText = response.trim()

    // Parse JSONL format: each line is {"index": N, "summary": "..."}
    // JSONL is more robust than a single JSON array because each line is independent
    let jsonl = responseText

    // Strip markdown code block fences if present
    const codeBlockMatch = jsonl.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
    if (codeBlockMatch) {
      jsonl = codeBlockMatch[1].trim()
    }

    // Also handle inline backtick wrapping
    jsonl = jsonl.replace(/^`+|`+$/g, '').trim()

    const summariesMap = new Map<number, string>()
    const lines = jsonl.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let parsed: any
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        this.logger?.warn(`[RAW] ${trimmed}`)
        // Attempt repair for malformed JSON lines
        const extracted = this.tryRepairJson(trimmed) ?? this.extractCompleteJsonObject(trimmed)
        if (!extracted) continue
        try {
          parsed = JSON.parse(extracted)
        } catch {
          continue // Skip unparseable lines
        }
      }

      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
        const index = typeof parsed.index === 'number' ? parsed.index : summariesMap.size + 1
        summariesMap.set(index, parsed.summary.trim())
      }
    }

    if (summariesMap.size === 0) {
      // Print full raw output for debugging
      this.logger?.warn(`[RAW] ${responseText}`)

      // Fallback: try parsing the entire response as a single JSON object
      // (handles cases where model ignores JSONL instruction and outputs old format)
      try {
        const parsedFallback = JSON.parse(responseText)
        if (parsedFallback && typeof parsedFallback === 'object') {
          let fallbackSummaries: string[] = []
          if (typeof parsedFallback.summaries === 'string') {
            fallbackSummaries = [parsedFallback.summaries]
          } else if (Array.isArray(parsedFallback.summaries)) {
            fallbackSummaries = parsedFallback.summaries.map((s: any) =>
              typeof s === 'string' ? s : (s.summary || '')
            )
          } else if (typeof parsedFallback.summary === 'string') {
            fallbackSummaries = [parsedFallback.summary]
          }

          if (fallbackSummaries.length > 0) {
            const summaries = fallbackSummaries.slice(0, request.blocks.length).map((text) => ({
              summary: text.trim(),
              language: request.language,
            }))
            while (summaries.length < request.blocks.length) {
              summaries.push({ summary: '', language: request.language })
            }
            return { summaries }
          }
        }
      } catch {
        // Fallback also failed, will throw below
      }

      throw new Error(
        `Failed to parse any JSONL lines from batch response. ` +
        `Expected ${request.blocks.length} block(s). See [RAW] log above for full output.`
      )
    }

    // Sort by index to preserve order, slice to expected count
    const sortedEntries = Array.from(summariesMap.entries()).sort(([a], [b]) => a - b)
    const summaries: { summary: string; language: string }[] = sortedEntries
      .slice(0, request.blocks.length)
      .map(([, summary]) => ({
        summary,
        language: request.language,
      }))

    // Pad with empty summaries if model returned fewer than expected
    while (summaries.length < request.blocks.length) {
      summaries.push({ summary: '', language: request.language })
    }

    return { summaries }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this._ensureContexts()
      // 池化: 复用 _sequencePool[0] 验证, 不再 getSequence + dispose (避免 race)
      const sequence = this._sequencePool[0]
      await sequence.clearHistory()
      const chatWrapper = new QwenChatWrapper({
        variation: "3.5",
        thoughts: "discourage",
      })
      const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
      await session.prompt("test", {
        temperature: this.temperature,
        maxTokens: 10,
      })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "LlamaCPP summarizer validation failed",
      }
    }
  }

  async dispose(): Promise<void> {
    // 先 dispose 池中所有 sequence, 释放 sequence slot
    // (LlamaContextSequence.dispose 同步返回 void)
    for (const seq of this._sequencePool) {
      try { seq.dispose() } catch {}
    }
    this._sequencePool = []
    this._seqIdx = 0

    for (const ctx of this._contexts) {
      await ctx.dispose().catch(() => {})
    }
    this._contexts = []
    this._contextPoolPromise = null
  }

  get summarizerInfo(): SummarizerInfo {
    return { name: "llamacpp", model: "" }
  }
}
