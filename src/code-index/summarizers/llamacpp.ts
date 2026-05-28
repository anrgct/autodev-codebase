import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo, SummarizerBatchRequest, SummarizerBatchResult } from "../interfaces"
import { LlamaModel, LlamaChatSession, QwenChatWrapper } from "@realtimex/node-llama-cpp"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export class LlamaCppSummarizer implements ISummarizer {
  private readonly model: LlamaModel
  private readonly defaultLanguage: 'English' | 'Chinese'
  private readonly temperature: number
  private readonly logger?: LoggerLike

  constructor(
    model: LlamaModel,
    defaultLanguage: 'English' | 'Chinese' = 'English',
    temperature: number = 0,
    logger?: LoggerLike,
  ) {
    this.model = model
    this.defaultLanguage = defaultLanguage
    this.temperature = temperature
    this.logger = logger
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

    prompt += `IMPORTANT: Respond with ONLY the JSON object, no extra text.\n\n`

    if (blocks.length === 1) {
      prompt += `Return format: {"summaries": "description"} (single string)\n`
    } else {
      const descs = Array.from({length: blocks.length}, (_, i) => `"snippet${i + 1}_desc"`).join(', ')
      prompt += `Return format: {"summaries": [${descs}]} (EXACTLY ${blocks.length} descriptions)\n`
      prompt += `CRITICAL: You MUST output EXACTLY ${blocks.length} item(s) and nothing else. You MUST NOT describe any other snippets.\n`
    }

    return prompt
  }

  async summarizeBatch(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
    const prompt = this.buildPrompt(request)
    this.logger?.debug(`Summarizing ${request.blocks.length} blocks for ${request.filePath || 'unknown file'}`)

    const context = await this.model.createContext({ contextSize: 32768 })
    const sequence = context.getSequence()
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

    // Try to extract JSON from the response with multiple fallback strategies
    let parsedResponse: any
    try {
      parsedResponse = JSON.parse(responseText)
    } catch {
      let jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
              responseText.match(/```\s*([\s\S]*?)\s*```/)
      if (jsonMatch) {
        try {
          parsedResponse = JSON.parse(jsonMatch[1].trim())
        } catch {
          const extracted = this.extractCompleteJsonObject(responseText)
          if (extracted) {
            parsedResponse = JSON.parse(extracted)
          } else {
            throw new Error(`Failed to parse batch response JSON after multiple attempts`)
          }
        }
      } else {
        const extracted = this.extractCompleteJsonObject(responseText)
        if (extracted) {
          parsedResponse = JSON.parse(extracted)
        } else {
          throw new Error(`Could not extract JSON from batch response`)
        }
      }
    }

    let summariesArray: string[] = []

    if (typeof parsedResponse.summaries === 'string') {
      summariesArray = [parsedResponse.summaries]
    } else if (Array.isArray(parsedResponse.summaries)) {
      summariesArray = parsedResponse.summaries
    } else {
      throw new Error(`Invalid batch response format: 'summaries' must be array or string`)
    }

    if (summariesArray.length !== request.blocks.length) {
      throw new Error(
        `Batch response length mismatch: expected ${request.blocks.length}, got ${summariesArray.length}`
      )
    }

    const summaries = summariesArray.map((item: any) => {
      const text = typeof item === 'string' ? item : (item.desc1 || item.summary || '')
      return {
        summary: text.trim(),
        language: request.language
      }
    })

    return { summaries }
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

  get summarizerInfo(): SummarizerInfo {
    return { name: "llamacpp", model: "" }
  }
}
