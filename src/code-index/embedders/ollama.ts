import { ApiHandlerOptions } from "../../shared/api"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { MAX_ITEM_TOKENS } from "../constants"
import { getModelQueryPrefix } from "../../shared/embeddingModels"
import { withValidationErrorHandling, sanitizeErrorMessage } from "../shared/validation-helpers"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for Ollama API requests
const OLLAMA_EMBEDDING_TIMEOUT_MS = 60000 // 60 seconds for embedding requests
const OLLAMA_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation requests

/**
 * Implements the IEmbedder interface using a local Ollama instance.
 */
export class CodeIndexOllamaEmbedder implements IEmbedder {
    private readonly baseUrl: string
    private readonly defaultModelId: string

    constructor(options: ApiHandlerOptions) {
        // Ensure ollamaBaseUrl and ollamaModelId exist on ApiHandlerOptions or add defaults
        let baseUrl = options.ollamaBaseUrl || "http://localhost:11434"

        // Normalize the baseUrl by removing all trailing slashes
        baseUrl = baseUrl.replace(/\/+$/, "")

        this.baseUrl = baseUrl
        this.defaultModelId = options.ollamaModelId || "nomic-embed-text:latest"
    }

    /**
     * Creates embeddings for the given texts using the specified Ollama model.
     * @param texts - An array of strings to embed.
     * @param model - Optional model ID to override the default.
     * @returns A promise that resolves to an EmbeddingResponse containing the embeddings and usage data.
     */
    async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
        const modelToUse = model || this.defaultModelId
        const url = `${this.baseUrl}/api/embed` // Endpoint as specified

        // Apply model-specific query prefix if required
        const queryPrefix = getModelQueryPrefix("ollama", modelToUse)
        const processedTexts = queryPrefix
            ? texts.map((text, index) => {
                    // Prevent double-prefixing
                    if (text.startsWith(queryPrefix)) {
                        return text
                    }
                    const prefixedText = `${queryPrefix}${text}`
                    const estimatedTokens = Math.ceil(prefixedText.length / 4)
                    if (estimatedTokens > MAX_ITEM_TOKENS) {
                        console.warn(
                            `Text at index ${index} with prefix exceeds token limit (${estimatedTokens} > ${MAX_ITEM_TOKENS}). Using original text.`,
                        )
                        // Return original text if adding prefix would exceed limit
                        return text
                    }
                    return prefixedText
                })
            : texts

        try {
            // Note: Standard Ollama API uses 'prompt' for single text, not 'input' for array.
            // Implementing based on user's specific request structure.

            // Add timeout to prevent indefinite hanging
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), OLLAMA_EMBEDDING_TIMEOUT_MS)

            // 检查环境变量中的代理设置
            const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
            const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

            // 根据目标 URL 协议选择合适的代理
            let dispatcher: any = undefined
            const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

            if (proxyUrl) {
                try {
                    dispatcher = new ProxyAgent(proxyUrl)
                    console.log('✓ Ollama using undici ProxyAgent:', proxyUrl)
                } catch (error) {
                    console.error('✗ Failed to create undici ProxyAgent for Ollama:', error)
                }
            }

            const fetchOptions: any = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelToUse,
                    input: processedTexts, // Using 'input' as requested
                }),
                signal: controller.signal,
            }

            if (dispatcher) {
                fetchOptions.dispatcher = dispatcher
            }

            const response = await fetch(url, fetchOptions)
            clearTimeout(timeoutId)

            if (!response.ok) {
                let errorBody = "Could not read error body"
                try {
                    errorBody = await response.text()
                } catch (e) {
                    // Ignore error reading body
                }
                throw new Error(
                    `Ollama API request failed with status ${response.status}: ${errorBody}`,
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
            // TelemetryService calls removed as per requirements

            // Log the original error for debugging purposes
            console.error("Ollama embedding failed:", error)

            // Handle specific error types with better messages
            if (error.name === "AbortError") {
                throw new Error("Connection failed due to timeout")
            } else if (error.message?.includes("fetch failed") || error.code === "ECONNREFUSED") {
                throw new Error(`Ollama service is not running at ${this.baseUrl}`)
            } else if (error.code === "ENOTFOUND") {
                throw new Error(`Host not found: ${this.baseUrl}`)
            }

            // Re-throw a more specific error for the caller
            throw new Error(`Ollama embedding failed: ${error.message}`)
        }
    }

    /**
     * Validates the Ollama embedder configuration by checking service availability and model existence
     * @returns Promise resolving to validation result with success status and optional error message
     */
    async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
        return withValidationErrorHandling(
            async () => {
                // First check if Ollama service is running by trying to list models
                const modelsUrl = `${this.baseUrl}/api/tags`

                // Add timeout to prevent indefinite hanging
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

                // 检查环境变量中的代理设置
                const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
                const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

                let dispatcher: any = undefined
                const proxyUrl = modelsUrl.startsWith('https:') ? httpsProxy : httpProxy

                if (proxyUrl) {
                    try {
                        dispatcher = new ProxyAgent(proxyUrl)
                    } catch (error) {
                        console.error('✗ Failed to create undici ProxyAgent for Ollama validation:', error)
                    }
                }

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
                clearTimeout(timeoutId)

                if (!modelsResponse.ok) {
                    if (modelsResponse.status === 404) {
                        return {
                            valid: false,
                            error: `Ollama service is not running at ${this.baseUrl}`,
                        }
                    }
                    return {
                        valid: false,
                        error: `Ollama service unavailable at ${this.baseUrl} (status: ${modelsResponse.status})`,
                    }
                }

                // Check if the specific model exists
                const modelsData = await modelsResponse.json() as any
                const models = modelsData.models || []

                // Check both with and without :latest suffix
                const modelExists = models.some((m: any) => {
                    const modelName = m.name || ""
                    return (
                        modelName === this.defaultModelId ||
                        modelName === `${this.defaultModelId}:latest` ||
                        modelName === this.defaultModelId.replace(":latest", "")
                    )
                })

                if (!modelExists) {
                    const availableModels = models.map((m: any) => m.name).join(", ")
                    return {
                        valid: false,
                        error: `Model '${this.defaultModelId}' not found. Available models: ${availableModels}`,
                    }
                }

                // Try a test embedding to ensure the model works for embeddings
                const testUrl = `${this.baseUrl}/api/embed`

                // Add timeout for test request too
                const testController = new AbortController()
                const testTimeoutId = setTimeout(() => testController.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

                const testFetchOptions: any = {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: this.defaultModelId,
                        input: ["test"],
                    }),
                    signal: testController.signal,
                }

                if (dispatcher) {
                    testFetchOptions.dispatcher = dispatcher
                }

                const testResponse = await fetch(testUrl, testFetchOptions)
                clearTimeout(testTimeoutId)

                if (!testResponse.ok) {
                    return {
                        valid: false,
                        error: `Model '${this.defaultModelId}' is not capable of generating embeddings`,
                    }
                }

                return { valid: true }
            },
            "ollama",
            {
                beforeStandardHandling: (error: any) => {
                    // Handle Ollama-specific connection errors
                    // Check for fetch failed errors which indicate Ollama is not running
                    if (
                        error?.message?.includes("fetch failed") ||
                        error?.code === "ECONNREFUSED" ||
                        error?.message?.includes("ECONNREFUSED")
                    ) {
                        // TelemetryService calls removed as per requirements
                        return {
                            valid: false,
                            error: `Ollama service is not running at ${this.baseUrl}`,
                        }
                    } else if (error?.code === "ENOTFOUND" || error?.message?.includes("ENOTFOUND")) {
                        // TelemetryService calls removed as per requirements
                        return {
                            valid: false,
                            error: `Host not found: ${this.baseUrl}`,
                        }
                    } else if (error?.name === "AbortError") {
                        // TelemetryService calls removed as per requirements
                        // Handle timeout
                        return {
                            valid: false,
                            error: "Connection failed due to timeout",
                        }
                    }
                    // Let standard handling take over
                    return undefined
                },
            },
        )
    }

    get embedderInfo(): EmbedderInfo {
        return {
            name: "ollama",
        }
    }
}