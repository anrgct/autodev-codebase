import { ApiHandlerOptions } from "../../shared/api"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { fetch, ProxyAgent } from "undici"

/**
 * Implements the IEmbedder interface using a local Ollama instance.
 */
export class CodeIndexOllamaEmbedder implements IEmbedder {
	private readonly baseUrl: string
	private readonly defaultModelId: string
	private readonly apiKey?: string

	constructor(options: ApiHandlerOptions) {
		// Ensure ollamaBaseUrl and ollamaModelId exist on ApiHandlerOptions or add defaults
		this.baseUrl = options['ollamaBaseUrl'] || "http://localhost:11434"
		this.defaultModelId = options['ollamaModelId'] || "nomic-embed-text:latest"
		this.apiKey = options['apiKey']
	}

	/**
	 * Creates embeddings for the given texts using the specified Ollama model.
	 * @param texts - An array of strings to embed.
	 * @param model - Optional model ID to override the default.
	 * @returns A promise that resolves to an EmbeddingResponse containing the embeddings and usage data.
	 */
	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId
		const url = `${this.baseUrl}/api/embed`

		// 检查环境变量中的代理设置
		const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
		const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

		// 根据目标 URL 协议选择合适的代理
		let dispatcher: any = undefined
		const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

		if (proxyUrl) {
			try {
				dispatcher = new ProxyAgent(proxyUrl)
				// console.log('✓ Using proxy:', proxyUrl)
			} catch (error) {
				console.error('✗ Failed to create proxy agent:', error)
			}
		} else {
			// console.log('ℹ No proxy configured')
		}

		const fetchOptions: any = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: modelToUse,
				input: texts,
			}),
		}

		if (dispatcher) {
			fetchOptions.dispatcher = dispatcher
		}


		try {
			const response = await fetch(url, fetchOptions)

			if (!response.ok) {
				let errorBody = "Could not read error body"
				try {
					errorBody = await response.text()
				} catch (e) {
					// Ignore error reading body
				}
				throw new Error(
					`Ollama API request failed with status ${response.status} ${response.statusText}: ${errorBody}`,
				)
			}

			const data = await response.json() as any

			// Extract embeddings using 'embeddings' key as requested
			const embeddings = data.embeddings
			if (!embeddings || !Array.isArray(embeddings)) {
				throw new Error(
					'Invalid response structure from Ollama API: "embeddings" array not found or not an array.',
				)
			}

			return {
				embeddings: embeddings,
			}
		} catch (error: any) {
			// Log the original error for debugging purposes
			console.error("Ollama embedding failed:", error)
			// Re-throw a more specific error for the caller
			throw new Error(`Ollama embedding failed: ${error.message}`)
		}
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "ollama",
		}
	}
}
