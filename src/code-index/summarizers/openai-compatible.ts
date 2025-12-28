import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo, SummarizerBatchRequest, SummarizerBatchResult } from "../interfaces"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for OpenAI-compatible API requests
const OPENAI_COMPATIBLE_SUMMARIZE_TIMEOUT_MS = 60000 // 60 seconds for summarization
const OPENAI_COMPATIBLE_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation

/**
 * Extracts a complete JSON object from text using bracket matching
 * This handles nested JSON objects correctly, unlike regex greedy matching
 * @returns The extracted JSON string or null if not found
 */
function extractCompleteJsonObject(text: string): string | null {
	// Find the first opening brace
	const startIndex = text.indexOf('{')
	if (startIndex === -1) {
		return null
	}

	// Use stack to find matching closing brace
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
				if (depth === 0) {
					// Found matching closing brace
					return text.substring(startIndex, i + 1)
				}
			}
		}
	}

	return null
}

/**
 * Implements the ISummarizer interface using OpenAI-compatible API endpoints with LLM-based summarization.
 * Supports any OpenAI-compatible API such as DeepSeek, SiliconFlow, local LM Studio, etc.
 */
export class OpenAICompatibleSummarizer implements ISummarizer {
	private readonly baseUrl: string
	private readonly modelId: string
	private readonly apiKey: string
	private readonly defaultLanguage: 'English' | 'Chinese'
	private readonly temperature: number

	constructor(
		baseUrl: string = "http://localhost:8080/v1",
		modelId: string = "gpt-4",
		apiKey: string = "",
		defaultLanguage: 'English' | 'Chinese' = 'English',
		temperature: number = 0.3
	) {
		// Normalize the baseUrl by removing all trailing slashes
		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
		this.baseUrl = normalizedBaseUrl
		this.modelId = modelId
		this.apiKey = apiKey
		this.defaultLanguage = defaultLanguage
		this.temperature = temperature
	}

	/**
	 * Generate a summary for the given code content
	 * Internally delegates to summarizeBatch() for unified processing
	 */
	async summarize(request: SummarizerRequest): Promise<SummarizerResult> {
		// Wrap single request as a batch of one
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

	/**
	 * Builds a unified batch prompt for summarizing code blocks
	 * Works for both single and batch requests
	 */
	private buildPrompt(request: SummarizerBatchRequest): string {
		const { blocks, language, document, filePath } = request

		// Unified English prompt template
		let prompt = `Generate semantic descriptions for the following code snippets:\n\n`

		// Add shared context once at the beginning
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

		// Language-specific output instructions
		if (language === 'Chinese') {
			prompt += `IMPORTANT: Respond in **Chinese (中文)**. Each description must be 30-80 Chinese characters.\n\n`
		}

		prompt += `IMPORTANT: Respond with ONLY the JSON object, no extra text.\n\n`
		
		// Build return format with explicit desc1, desc2, ..., descN
		const descs = Array.from({length: blocks.length}, (_, i) => `"desc${i + 1}"`).join(', ')
		prompt += `Return format: {"summaries": [${descs}]} (${blocks.length} descriptions required, one-to-one mapping)`

		return prompt
	}

	/**
	 * Generate summaries for multiple code blocks in a single batch request
	 * This is more efficient than calling summarize() multiple times
	 */
	async summarizeBatch(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
		const prompt = this.buildPrompt(request)
		const url = `${this.baseUrl}/chat/completions`

		// Add timeout to prevent indefinite hanging
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), OPENAI_COMPATIBLE_SUMMARIZE_TIMEOUT_MS)

		// Check for proxy settings in environment variables
		const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
		const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

		// Choose appropriate proxy based on target URL protocol
		let dispatcher: any = undefined
		const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

		if (proxyUrl) {
			try {
				dispatcher = new ProxyAgent(proxyUrl)
			} catch (error) {
				// Silently fail - proxy is optional
			}
		}

		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			}

			// Add Authorization header if API key is provided
			if (this.apiKey) {
				headers["Authorization"] = `Bearer ${this.apiKey}`
			}

			const fetchOptions: any = {
				method: "POST",
				headers: headers,
				body: JSON.stringify({
					model: this.modelId,
					messages: [
						{
							role: "user",
							content: prompt
						}
					],
					stream: false,
					temperature: this.temperature,
					max_tokens: 500 // Increased for batch responses
				}),
				signal: controller.signal,
			}

			if (dispatcher) {
				fetchOptions.dispatcher = dispatcher
			}

			const response = await fetch(url, fetchOptions)

			if (!response.ok) {
				let errorBody = "Could not read error body"
				try {
					errorBody = await response.text()
				} catch (e) {
					// Ignore error reading body
				}
				throw new Error(`OpenAI-compatible API error: ${response.status} - ${errorBody}`)
			}

			const data = await response.json() as any

			// Parse response: data.choices[0].message.content
			if (!data.choices || !data.choices[0] || !data.choices[0].message) {
				throw new Error(`Invalid response format: missing 'choices' field`)
			}

			const responseText = data.choices[0].message.content.trim()

			// Try to extract JSON from the response with multiple fallback strategies
			let parsedResponse: any
			try {
				// Strategy 1: Try direct parse
				parsedResponse = JSON.parse(responseText)
			} catch {
				// Strategy 2: Extract JSON from markdown code blocks
				let jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
								  responseText.match(/```\s*([\s\S]*?)\s*```/)
				if (jsonMatch) {
					try {
						parsedResponse = JSON.parse(jsonMatch[1].trim())
					} catch {
						// Strategy 3: Use bracket matching to find complete JSON object
						const extracted = extractCompleteJsonObject(responseText)
						if (extracted) {
							parsedResponse = JSON.parse(extracted)
						} else {
							throw new Error(`Failed to parse batch response JSON after multiple attempts`)
						}
					}
				} else {
					// Strategy 4: Use bracket matching to find complete JSON object
					const extracted = extractCompleteJsonObject(responseText)
					if (extracted) {
						parsedResponse = JSON.parse(extracted)
					} else {
						throw new Error(`Could not extract JSON from batch response`)
					}
				}
			}

			if (!parsedResponse.summaries || !Array.isArray(parsedResponse.summaries)) {
				throw new Error(`Invalid batch response format: missing 'summaries' array`)
			}

			// Validate response length matches request length
			if (parsedResponse.summaries.length !== request.blocks.length) {
				throw new Error(
					`Batch response length mismatch: expected ${request.blocks.length}, got ${parsedResponse.summaries.length}`
				)
			}

			// Transform response to SummarizerBatchResult format
			const summaries = parsedResponse.summaries.map((item: any) => {
				const text = typeof item === 'string' ? item : item.summary
				return {
					summary: text.trim(),
					language: request.language
				}
			})

			return { summaries }
		} finally {
			clearTimeout(timeoutId)
		}
	}

	/**
	 * Validates the OpenAI-compatible summarizer configuration by checking service availability
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			// Test by calling the chat completions endpoint with a simple prompt
			const url = `${this.baseUrl}/chat/completions`

			// Add timeout to prevent indefinite hanging
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), OPENAI_COMPATIBLE_VALIDATION_TIMEOUT_MS)

			// Check for proxy settings in environment variables
			const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
			const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

			let dispatcher: any = undefined
			const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

			if (proxyUrl) {
				try {
					dispatcher = new ProxyAgent(proxyUrl)
				} catch (error) {
					// Silently fail - proxy is optional
				}
			}

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				}

				// Add Authorization header if API key is provided
				if (this.apiKey) {
					headers["Authorization"] = `Bearer ${this.apiKey}`
				}

				const fetchOptions: any = {
					method: "POST",
					headers: headers,
					body: JSON.stringify({
						model: this.modelId,
						messages: [
							{
								role: "user",
								content: "test"
							}
						],
						stream: false,
						max_tokens: 10
					}),
					signal: controller.signal,
				}

				if (dispatcher) {
					fetchOptions.dispatcher = dispatcher
				}

				const response = await fetch(url, fetchOptions)

				if (!response.ok) {
					let errorBody = "Could not read error body"
					try {
						errorBody = await response.text()
					} catch (e) {
						// Ignore error reading body
					}
					return {
						valid: false,
						error: `API unavailable at ${this.baseUrl} (status: ${response.status}): ${errorBody}`
					}
				}

				return { valid: true }
			} finally {
				clearTimeout(timeoutId)
			}
		} catch (error: any) {
			if (error.name === 'AbortError') {
				return { valid: false, error: 'Connection timeout' }
			}
			if (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
				return { valid: false, error: `Service not running at ${this.baseUrl}` }
			}
			return { valid: false, error: error.message }
		}
	}

	get summarizerInfo(): SummarizerInfo {
		return {
			name: 'openai-compatible',
			model: this.modelId
		}
	}
}