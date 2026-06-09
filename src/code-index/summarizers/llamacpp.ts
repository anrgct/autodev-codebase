import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo, SummarizerBatchRequest, SummarizerBatchResult } from "../interfaces"
import { LlamaModel, LlamaChatSession, QwenChatWrapper, LlamaContext, LlamaContextSequence } from "@realtimex/node-llama-cpp"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

interface FileSession {
  session: LlamaChatSession
  sequence: LlamaContextSequence
  sqIdx: number
  /** Snapshot of chat history containing only the system message, used to trim after each batch. */
  systemOnlyHistory: import("@realtimex/node-llama-cpp").ChatHistoryItem[]
}

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

  // Per-file session (shared across batches for KV cache reuse)
  private _fileSession: FileSession | null = null
  private _fileSessionKey: string = ''
  // Serialize batch processing for the same file (batches share one sequence)
  private _batchChain: Promise<void> = Promise.resolve()

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
    // Pool: one sequence per concurrent file.
    // Within a file, batches are serialized on the same sequence for KV cache reuse.
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
      // Pooling: grab all _sequences sequences from context once, hold permanently.
      // Avoids _reclaimUnusedSequenceId fire-and-forget race
      // (see docs/plans/260608-no-sequences-left-root-cause.md).
      // clearHistory() called once per file (on session creation), not per batch.
      // KV cache is preserved across batches via session reuse + setChatHistory trim.
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

  /**
   * Build system prompt: stable prefix shared across all batches of the same file.
   * Includes instructions, file path, and shared document context.
   * Placed in the system prompt so it survives context shifts and enables KV cache reuse.
   */
  private buildSystemPrompt(request: SummarizerBatchRequest): string {
    const { document, filePath, language } = request

    let prompt = `You are a code summarization assistant. Generate concise semantic descriptions for code snippets.\n`
    prompt += `- Focus on logic, implementation details, business role\n`
    prompt += `- **Start directly with verbs**, NO prefixes like "Function X" or "Class Y"\n`
    prompt += `- For core implementations, include keywords like "implements", "logic"\n`

    if (filePath) {
      prompt += `\n[File]: ${filePath}\n`
    }
    if (document) {
      prompt += `\n[Shared Context]:\n\`\`\`\n${document}\n\`\`\`\n`
    }

    if (language === 'Chinese') {
      prompt += `\nIMPORTANT: Respond in **Chinese (中文)**. Each description must be 30-80 Chinese characters.\n`
    }

    return prompt
  }

  /**
   * Build user prompt: variable content that changes per batch.
   * Contains only the snippets and output format for this specific batch.
   */
  private buildUserPrompt(request: SummarizerBatchRequest): string {
    const { blocks, language, document } = request

    let prompt = `Generate ONE semantic description for EACH of the ${blocks.length} snippet(s) below:\n\n`

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

    const placeholder = language === 'Chinese' ? '[描述]' : '[DESCRIPTION]'

    prompt += `Output format:\n`
    for (let i = 1; i <= blocks.length; i++) {
      prompt += `{"index":${i},"summary":"${placeholder}"}\n`
    }
    if (blocks.length === 1) {
      prompt += `\nReplace ${placeholder} with the actual description. Output ONLY this one line.\n`
    } else {
      prompt += `\nReplace each ${placeholder} with the actual description. Output exactly ${blocks.length} lines. Do NOT add any text before or after.\n`
    }

    return prompt
  }

  async summarizeBatch(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
    // Serialize batch processing: all batches of the same file share one sequence
    // for KV cache reuse. Concurrent calls are queued via _batchChain.
    let resolveResult!: (result: SummarizerBatchResult) => void
    let rejectResult!: (error: unknown) => void
    const resultPromise = new Promise<SummarizerBatchResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    this._batchChain = this._batchChain.then(async () => {
      try {
        const result = await this._summarizeBatchInternal(request)
        resolveResult(result)
      } catch (error) {
        rejectResult(error)
      }
    })

    return resultPromise
  }

  private async _summarizeBatchInternal(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
    this.logger?.debug(`Summarizing ${request.blocks.length} blocks for ${request.filePath || 'unknown file'}`)

    await this._ensureContexts()

    const fileKey = request.filePath || '__default__'

    // Create or reuse file session (one session per file for KV cache prefix reuse)
    if (!this._fileSession || this._fileSessionKey !== fileKey) {
      // New file: allocate a sequence from the pool
      const sqIdx = this._seqIdx++ % this._sequencePool.length
      const sequence = this._sequencePool[sqIdx]

      // Clear KV cache for a fresh start (only once per file)
      await sequence.clearHistory()

      const systemPrompt = this.buildSystemPrompt(request)
      const chatWrapper = new QwenChatWrapper({
        variation: "3.5",
        thoughts: "discourage",
      })
      const session = new LlamaChatSession({
        contextSequence: sequence,
        chatWrapper,
        systemPrompt,
      })
      // Snapshot the initial chat history (system message only) for trimming after each batch.
      // Uses getChatHistory() to ensure the text format matches what generateInitialChatHistory produces.
      const systemOnlyHistory = session.getChatHistory()

      this._fileSession = { session, sequence, sqIdx, systemOnlyHistory }
      this._fileSessionKey = fileKey
      this.logger?.debug(`[LlamaCppSummarizer] Created file session for "${fileKey}" on seq#${sqIdx}`)
    }

    const { session } = this._fileSession
    const userPrompt = this.buildUserPrompt(request)

    const response = await session.prompt(userPrompt, {
      temperature: this.temperature,
      maxTokens: 4096,
    })

    // After successful batch: trim chat history to system-only.
    // This prevents history accumulation while preserving KV cache.
    // adaptStateToTokens (called internally by alignCurrentSequenceStateWithCurrentTokens)
    // will erase mismatched tail and reuse the system prompt prefix on the next batch.
    session.setChatHistory(this._fileSession.systemOnlyHistory)

    const responseText = response.trim()

    // Normalize smart quotes to ASCII quotes.
    // Chinese-language models (e.g. MiniCPM-V) occasionally output Chinese-style
    // quotation marks (\u201c \u201d) instead of ASCII double quotes when the
    // summary content is in Chinese. These break JSON parsing.
    const normalizedText = responseText
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")

    // Parse JSONL format: each line is {"index": N, "summary": "..."}
    // JSONL is more robust than a single JSON array because each line is independent
    let jsonl = normalizedText

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
      this.logger?.warn(`[RAW OUTPUT] ${responseText}`)
      this.logger?.debug(`[DEBUG FULL INPUT] ${userPrompt}`)

      // Fallback: try parsing the entire response as a single JSON object
      // (handles cases where model ignores JSONL instruction and outputs old format)
      try {
        const parsedFallback = JSON.parse(normalizedText)
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
      // Pooled: reuse _sequencePool[0] for validation, no getSequence+dispose (avoids race)
      const sequence = this._sequencePool[0]
      await sequence.clearHistory()
      const chatWrapper = new QwenChatWrapper({
        variation: "3.5",
        thoughts: "discourage",
      })
      const session = new LlamaChatSession({
        contextSequence: sequence,
        chatWrapper,
        systemPrompt: "You are a helpful assistant.",
      })
      await session.prompt("Say 'ok'", {
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
    // Dispose pooled sequences, releasing sequence slots
    // (LlamaContextSequence.dispose returns void synchronously)
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

    // Clear file session state
    this._fileSession = null
    this._fileSessionKey = ''
    this._batchChain = Promise.resolve()
  }

  get summarizerInfo(): SummarizerInfo {
    return { name: "llamacpp", model: "" }
  }
}
