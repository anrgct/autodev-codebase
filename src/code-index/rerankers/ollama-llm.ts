import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import { withValidationErrorHandling } from "../shared/validation-helpers"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for Ollama API requests
const OLLAMA_RERANK_TIMEOUT_MS = 60000 // 60 seconds for rerank requests
const OLLAMA_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation requests

/**
 * Implements the IReranker interface using a local Ollama instance with LLM-based reranking.
 */
export class OllamaLLMReranker implements IReranker {
    private readonly baseUrl: string
    private readonly modelId: string

    constructor(baseUrl: string = "http://localhost:11434", modelId: string = "gemma3n:e2b") {
        // Normalize the baseUrl by removing all trailing slashes
        const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
        this.baseUrl = normalizedBaseUrl
        this.modelId = modelId
    }

    /**
     * Reranks candidates using LLM-based scoring.
     * @param query The search query
     * @param candidates Array of candidates to rerank
     * @returns Promise resolving to reranked results with LLM scores
     */
    async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
        if (candidates.length === 0) {
            return []
        }

        try {
            // Build the scoring prompt with all candidates
            const prompt = this.buildScoringPrompt(query, candidates)

            // Call Ollama /api/generate endpoint
            const scores = await this.generateScores(prompt)

            // Combine original candidates with LLM scores
            const results: RerankerResult[] = candidates.map((candidate, index) => ({
                id: candidate.id,
                score: scores[index] || 0, // Default to 0 if no score
                originalScore: candidate.score,
                payload: candidate.payload
            }))

            // Sort by LLM score (descending)
            results.sort((a, b) => b.score - a.score)

            return results
        } catch (error: any) {
            console.error("Ollama LLM reranking failed, returning original order:", error)

            // Fallback to original order with default scores
            return candidates.map((candidate, index) => ({
                id: candidate.id,
                score: 10 - index * 0.1, // Slight decreasing scores to maintain order
                originalScore: candidate.score,
                payload: candidate.payload
            }))
        }
    }

    /**
     * Builds the scoring prompt for the LLM.
     */
    private buildScoringPrompt(query: string, candidates: RerankerCandidate[]): string {
        let prompt = `You are a code relevance scorer. Given a search query and code snippets, rate each snippet's relevance (0-10).

Query: ${query}

Snippets:\n`

        candidates.forEach((candidate, index) => {
            prompt += `[${index + 1}] ${candidate.content}\n---\n`
        })

        prompt += `Respond with ONLY a JSON object with a "scores" array: {"scores": [score1, score2, ..., score${candidates.length}]}`

        return prompt
    }

    /**
     * Calls Ollama API to generate scores for the candidates.
     */
    private async generateScores(prompt: string): Promise<number[]> {
        const url = `${this.baseUrl}/api/generate`

        // Add timeout to prevent indefinite hanging
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_RERANK_TIMEOUT_MS)

        // Check for proxy settings in environment variables
        const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
        const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

        // Choose appropriate proxy based on target URL protocol
        let dispatcher: any = undefined
        const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

        if (proxyUrl) {
            try {
                dispatcher = new ProxyAgent(proxyUrl)
                console.log('✓ Ollama LLM reranker using undici ProxyAgent:', proxyUrl)
            } catch (error) {
                console.error('✗ Failed to create undici ProxyAgent for Ollama LLM reranker:', error)
            }
        }

        const fetchOptions: any = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.modelId,
                prompt: prompt,
                stream: false,
                format: "json" // Request JSON output format
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

        // Extract and parse the response - only support { "response": "{\"scores\": [8, 7, 9, 6, 5]}" } format
        if (!data.response) {
            throw new Error("Invalid response structure from Ollama API. Expected 'response' field.")
        }

        const responseText = data.response.trim()
        let parsedResponse: any

        try {
            // Parse the JSON string in the response field
            parsedResponse = JSON.parse(responseText)
        } catch (parseError) {
            throw new Error(`Failed to parse response JSON: ${responseText}`)
        }

        // Extract scores array from the parsed response
        if (!parsedResponse.scores || !Array.isArray(parsedResponse.scores)) {
            throw new Error("Invalid response format. Expected object with 'scores' array.")
        }

        const scores = parsedResponse.scores

        // Process and validate scores
        return scores.map(score => {
            const num = typeof score === 'number' ? score : parseFloat(score)
            return isNaN(num) ? 0 : Math.max(0, Math.min(10, num)) // Clamp between 0-10
        })
    }

    /**
     * Extracts scores from text response when JSON parsing fails.
     */
    private extractScoresFromText(text: string): number[] {
        const numbers: number[] = []
        const regex = /\d+(?:\.\d+)?/g
        const matches = text.match(regex)

        if (matches) {
            for (const match of matches) {
                const num = parseFloat(match)
                if (!isNaN(num)) {
                    numbers.push(Math.max(0, Math.min(10, num))) // Clamp between 0-10
                }
            }
        }

        return numbers
    }

    /**
     * Validates the Ollama LLM reranker configuration by checking service availability and model existence
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

                // Check for proxy settings in environment variables
                const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
                const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

                let dispatcher: any = undefined
                const proxyUrl = modelsUrl.startsWith('https:') ? httpsProxy : httpProxy

                if (proxyUrl) {
                    try {
                        dispatcher = new ProxyAgent(proxyUrl)
                    } catch (error) {
                        console.error('✗ Failed to create undici ProxyAgent for Ollama LLM validation:', error)
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
                        modelName === this.modelId ||
                        modelName === `${this.modelId}:latest` ||
                        modelName === this.modelId.replace(":latest", "")
                    )
                })

                if (!modelExists) {
                    const availableModels = models.map((m: any) => m.name).join(", ")
                    return {
                        valid: false,
                        error: `Model '${this.modelId}' not found. Available models: ${availableModels}`,
                    }
                }

                // Try a test generation to ensure the model works for text generation
                const testUrl = `${this.baseUrl}/api/generate`

                // Add timeout for test request too
                const testController = new AbortController()
                const testTimeoutId = setTimeout(() => testController.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

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
                clearTimeout(testTimeoutId)

                if (!testResponse.ok) {
                    return {
                        valid: false,
                        error: `Model '${this.modelId}' is not capable of text generation`,
                    }
                }

                return { valid: true }
            },
            "ollama",
            {
                beforeStandardHandling: (error: any) => {
                    // Handle Ollama-specific connection errors
                    if (
                        error?.message?.includes("fetch failed") ||
                        error?.code === "ECONNREFUSED" ||
                        error?.message?.includes("ECONNREFUSED")
                    ) {
                        return {
                            valid: false,
                            error: `Ollama service is not running at ${this.baseUrl}`,
                        }
                    } else if (error?.code === "ENOTFOUND" || error?.message?.includes("ENOTFOUND")) {
                        return {
                            valid: false,
                            error: `Host not found: ${this.baseUrl}`,
                        }
                    } else if (error?.name === "AbortError") {
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

    get rerankerInfo(): RerankerInfo {
        return {
            name: "ollama-llm",
            model: this.modelId,
        }
    }
}
