import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo } from "../interfaces"
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
	 */
	async summarize(request: SummarizerRequest): Promise<SummarizerResult> {
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
					format: "json", // Request JSON output format
					options: {
						num_predict: 100,
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

			// Parse JSON response: data.response is a JSON string
			const responseText = data.response.trim()
			let parsedResponse: any

			try {
				parsedResponse = JSON.parse(responseText)
			} catch (e) {
				throw new Error(`Failed to parse Ollama response: ${responseText}`)
			}

			if (!parsedResponse.summary || typeof parsedResponse.summary !== 'string') {
				throw new Error(`Invalid response format: missing 'summary' field`)
			}

			return {
				summary: parsedResponse.summary.trim(),
				language: request.language
			}
		} finally {
			clearTimeout(timeoutId)
		}
	}

	/**
	 * Builds the prompt for the LLM based on language and code type.
	 */
	private buildPrompt(request: SummarizerRequest): string {
		const { content, language, codeType, codeName, document } = request

		if (language === 'Chinese') {
			if (document && document !== content) {
				// With document context
				return `为以下代码片段生成功能语义描述，用于代码检索。

【上下文】：
\`\`\`
${document}
\`\`\`

【目标代码】：
\`\`\`
${content}
\`\`\`

要求：
- 描述具体执行逻辑和实现细节，核心实现需包含"实现"、"核心逻辑"等关键词
- 识别代码性质（定义/声明/实现）和业务角色
- 包含同义词和关联词（如：代码里是save，描述包含persist/store）
- 30-80个中文字，**严禁**以"函数XXX"、"XXX类"开头，直接以动词开头描述动作
- 这是${codeType}${codeName ? ` "${codeName}"` : ''}

示例：
✅ "处理数据清洗和过滤，检查空值并去除空格..."
✅ "实现数据批处理，遍历批次应用标准化转换..."
❌ "函数process_data用于处理数据..."

返回JSON：{"summary": "描述"}`
			} else {
				// Without document context
				return `为以下${codeType}${codeName ? ` "${codeName}"` : ''}生成功能语义描述：
\`\`\`
${content}
\`\`\`

要求：30-80个中文字，描述具体逻辑、实现细节、业务角色，**严禁**以"函数XXX"、"XXX类"开头，直接以动词开头描述动作。

✅ "处理数据清洗和过滤，检查空值..."
❌ "函数process_data用于处理数据..."

返回JSON：{"summary": "描述"}`
			}
		}

		// English (default)
		if (document && document !== content) {
			// With document context
			return `Generate semantic description for code retrieval:

[Context]:
\`\`\`
${document}
\`\`\`

[Target]:
\`\`\`
${content}
\`\`\`

Focus on: logic, implementation details, business role, synonyms.
For core implementations, include keywords like "implements", "logic".
Max 20 words, **start directly with verbs**, NO prefixes like "Function X" or "Class Y".
This is a ${codeType}${codeName ? ` "${codeName}"` : ''}.

Examples:
✅ "Processes data cleaning and filtering, checks for nulls..."
✅ "Implements batch processing, applies normalization..."
❌ "Function process_data processes data..."

Return JSON: {"summary": "description"}`
		} else {
			// Without document context
			return `Describe this ${codeType}${codeName ? ` "${codeName}"` : ''}:
\`\`\`
${content}
\`\`\`

Max 20 words. Focus on logic and implementation. **Start with verb**, NO prefixes like "Function X".

✅ "Processes data cleaning and filtering..."
❌ "Function process_data processes data..."

Return JSON: {"summary": "description"}`
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
