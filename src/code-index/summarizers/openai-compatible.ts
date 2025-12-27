import { ISummarizer, SummarizerRequest, SummarizerResult, SummarizerInfo } from "../interfaces"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for OpenAI-compatible API requests
const OPENAI_COMPATIBLE_SUMMARIZE_TIMEOUT_MS = 60000 // 60 seconds for summarization
const OPENAI_COMPATIBLE_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation

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
	 */
	async summarize(request: SummarizerRequest): Promise<SummarizerResult> {
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
					max_tokens: 150
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
			
			// Try to extract JSON from the response (in case model wraps it in markdown)
			let parsedResponse: any
			try {
				// First try direct parse
				parsedResponse = JSON.parse(responseText)
			} catch {
				// Try to extract JSON from markdown code blocks
				const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
								  responseText.match(/```\s*([\s\S]*?)\s*```/)
				if (jsonMatch) {
					try {
						parsedResponse = JSON.parse(jsonMatch[1])
					} catch {
						// If still fails, use the raw text as summary
						return {
							summary: responseText,
							language: request.language
						}
					}
				} else {
					// Use raw text as summary
					return {
						summary: responseText,
						language: request.language
					}
				}
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