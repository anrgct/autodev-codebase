import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo, SummarizerBatchRequest, SummarizerBatchResult } from "../interfaces"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for Ollama API requests
const OLLAMA_SUMMARIZE_TIMEOUT_MS = 60000 // 60 seconds for summarization
const OLLAMA_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation

/**
 * Implements the ISummarizer interface using a local Ollama instance with LLM-based summarization.
 */
export class OllamaSummarizer implements ISummarizer {
	private readonly baseUrl: string
	private readonly modelId: string
	private readonly defaultLanguage: 'English' | 'Chinese'
	private readonly temperature: number

	constructor(
		baseUrl: string = "http://localhost:11434",
		modelId: string = "qwen3-vl:4b-instruct",
		defaultLanguage: 'English' | 'Chinese' = 'English',
		temperature: number = 0.3
	) {
		// Normalize the baseUrl by removing all trailing slashes
		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
		this.baseUrl = normalizedBaseUrl
		this.modelId = modelId
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

		// Different format for single vs multiple blocks
		if (blocks.length === 1) {
			prompt += `Return format: {"summaries": "description"} (single string)\n`
		} else {
			const descs = Array.from({length: blocks.length}, (_, i) => `"desc${i + 1}"`).join(', ')
			prompt += `Return format: {"summaries": [${descs}]} (${blocks.length} descriptions)\n`
		}

		return prompt
	}

	/**
	 * Extracts a complete JSON object from text using bracket matching
	 * This handles nested JSON objects correctly, unlike regex greedy matching
	 * @returns The extracted JSON string or null if not found
	 */
	private extractCompleteJsonObject(text: string): string | null {
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
	 * Generate summaries for multiple code blocks in a single batch request
	 * This is more efficient than calling summarize() multiple times
	 */
	async summarizeBatch(request: SummarizerBatchRequest): Promise<SummarizerBatchResult> {
		const prompt = this.buildPrompt(request)
		const url = `${this.baseUrl}/api/generate`

		// Add timeout to prevent indefinite hanging
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), OLLAMA_SUMMARIZE_TIMEOUT_MS)

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
			const fetchOptions: any = {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.modelId,
					prompt: prompt,
					stream: false,
					format: "json",
					options: {
						num_predict: 500, // Increased for batch responses
						temperature: this.temperature
					}
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
				throw new Error(`Ollama API error: ${response.status} - ${errorBody}`)
			}

			const data = await response.json() as any

			// Parse response: data.response is a JSON string
			const responseText = data.response.trim()

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
						const extracted = this.extractCompleteJsonObject(responseText)
						if (extracted) {
							parsedResponse = JSON.parse(extracted)
						} else {
							throw new Error(`Failed to parse batch response JSON after multiple attempts`)
						}
					}
				} else {
					// Strategy 4: Use bracket matching to find complete JSON object
					const extracted = this.extractCompleteJsonObject(responseText)
					if (extracted) {
						parsedResponse = JSON.parse(extracted)
					} else {
						throw new Error(`Could not extract JSON from batch response`)
					}
				}
			}

			// Validate response format - support both array and string (for single block with small models)
			let summariesArray: string[] = []
			
			if (typeof parsedResponse.summaries === 'string') {
				// Small model may return {"summaries": "desc"} instead of {"summaries": ["desc"]}
				summariesArray = [parsedResponse.summaries]
			} else if (Array.isArray(parsedResponse.summaries)) {
				summariesArray = parsedResponse.summaries
			} else {
				throw new Error(`Invalid batch response format: 'summaries' must be array or string`)
			}

			// Validate response length matches request length
			if (summariesArray.length !== request.blocks.length) {
				throw new Error(
					`Batch response length mismatch: expected ${request.blocks.length}, got ${summariesArray.length}`
				)
			}

			// Transform response to SummarizerBatchResult format
			const summaries = summariesArray.map((item: any) => {
				const text = typeof item === 'string' ? item : (item.desc1 || item.summary || '')
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
	 * Validates the Ollama summarizer configuration by checking service availability and model existence
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			// 1. Check if Ollama service is running by trying to list models
			const modelsUrl = `${this.baseUrl}/api/tags`

			// Add timeout to prevent indefinite hanging
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

			// Check for proxy settings in environment variables
			const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
			const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

			let dispatcher: any = undefined
			const proxyUrl = modelsUrl.startsWith('https:') ? httpsProxy : httpProxy

			if (proxyUrl) {
				try {
					dispatcher = new ProxyAgent(proxyUrl)
				} catch (error) {
					// Silently fail - proxy is optional
				}
			}

			try {
				const fetchOptions: any = {
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
					signal: controller.signal,
				}

				if (dispatcher) {
					fetchOptions.dispatcher = dispatcher
				}

				const modelsResponse = await fetch(modelsUrl, fetchOptions)

				if (!modelsResponse.ok) {
					return {
						valid: false,
						error: `Ollama service unavailable at ${this.baseUrl} (status: ${modelsResponse.status})`
					}
				}

				// 2. Check if model exists
				const modelsData = await modelsResponse.json() as any
				const models = modelsData.models || []

				// Check both with and without :latest suffix
				const modelExists = models.some((m: any) => {
					const name = m.name || ""
					return (
						name === this.modelId ||
						name === `${this.modelId}:latest` ||
						name === this.modelId.replace(":latest", "")
					)
				})

				if (!modelExists) {
					const available = models.map((m: any) => m.name).join(', ')
					return {
						valid: false,
						error: `Model '${this.modelId}' not found. Available: ${available}`
					}
				}

				// 3. Test generation
				const testUrl = `${this.baseUrl}/api/generate`

				// Add timeout for test request too
				const testController = new AbortController()
				const testTimeoutId = setTimeout(() => testController.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

				try {
					const testFetchOptions: any = {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: this.modelId,
							prompt: "test",
							stream: false,
							options: {
								num_predict: 10
							}
						}),
						signal: testController.signal,
					}

					if (dispatcher) {
						testFetchOptions.dispatcher = dispatcher
					}

					const testResponse = await fetch(testUrl, testFetchOptions)

					if (!testResponse.ok) {
						return {
							valid: false,
							error: `Model '${this.modelId}' failed generation test`
						}
					}
				} finally {
					clearTimeout(testTimeoutId)
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
				return { valid: false, error: `Ollama not running at ${this.baseUrl}` }
			}
			return { valid: false, error: error.message }
		}
	}

	get summarizerInfo(): SummarizerInfo {
		return {
			name: 'ollama',
			model: this.modelId
		}
	}
}
