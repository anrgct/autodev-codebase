import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import { withValidationErrorHandling } from "../shared/validation-helpers"
import { fetch, ProxyAgent } from "undici"

// Timeout constants for OpenAI-compatible API requests
const OPENAI_RERANK_TIMEOUT_MS = 60000 // 60 seconds for rerank requests
const OPENAI_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation requests

/**
 * Implements the IReranker interface using OpenAI-compatible API endpoints with LLM-based reranking.
 */
export class OpenAICompatibleReranker implements IReranker {
    private readonly baseUrl: string
    private readonly modelId: string
    private readonly apiKey: string
    private readonly batchSize: number

    constructor(baseUrl: string = "http://localhost:8080/v1", modelId: string = "gpt-4", apiKey: string = "", batchSize: number = 10) {
        // Normalize the baseUrl by removing all trailing slashes
        const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
        this.baseUrl = normalizedBaseUrl
        this.modelId = modelId
        this.apiKey = apiKey
        this.batchSize = batchSize
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

        // If candidates count <= batchSize, process directly (original logic)
        if (candidates.length <= this.batchSize) {
            return this.rerankSingleBatch(query, candidates)
        }

        // Process in batches
        const allResults: RerankerResult[] = []
        let processedCount = 0

        for (let i = 0; i < candidates.length; i += this.batchSize) {
            const batch = candidates.slice(i, i + this.batchSize)
            try {
                const batchResults = await this.rerankSingleBatch(query, batch)
                allResults.push(...batchResults)
            } catch (error) {
                console.error(`Batch ${Math.floor(i / this.batchSize) + 1} failed:`, error)
                // Fallback for failed batch
                const fallbackResults = batch.map((candidate, idx) => ({
                    id: candidate.id,
                    score: 10 - (processedCount + idx) * 0.1,
                    originalScore: candidate.score,
                    payload: candidate.payload
                }))
                allResults.push(...fallbackResults)
            }
            processedCount += batch.length
        }

        // Merge and re-sort all results
        allResults.sort((a, b) => b.score - a.score)
        return allResults
    }

    /**
     * Reranks a single batch of candidates.
     * @param query The search query
     * @param candidates Array of candidates to rerank (single batch)
     * @returns Promise resolving to reranked results with LLM scores
     */
    private async rerankSingleBatch(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
        try {
            // Build the scoring prompt with all candidates
            const prompt = this.buildScoringPrompt(query, candidates)

            // Call OpenAI-compatible /chat/completions endpoint
            const scores = await this.generateScores(prompt)

            // Combine original candidates with LLM scores
            const results: RerankerResult[] = candidates.map((candidate, index) => ({
                id: candidate.id,
                score: scores[index] || 0, // Default to 0 if no score
                originalScore: candidate.score,
                payload: candidate.payload
            }))

            // Sort by LLM score (descending) - this maintains order within the batch
            results.sort((a, b) => b.score - a.score)

            return results
        } catch (error: any) {
            console.error("OpenAI-compatible LLM batch reranking failed, returning original order:", error)

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
        let prompt = `You are a code relevance scorer. Given a search query and code snippets with their hierarchy context, rate each snippet's relevance (0-10).

Scoring criteria:

10 points: Perfect match with query intent, directly includes relevant code
7-9 points: Highly relevant, includes relevant functions/classes/concepts
4-6 points: Moderately relevant, mentions related topics but not directly
1-3 points: Slightly relevant, only indirect connections
0 points: Completely unrelated

Query: ${query}

Snippets:
`

        candidates.forEach((candidate, index) => {
            // Build context information
            const contextInfo = this.buildContextInfo(candidate)

            prompt += `## snippet ${index + 1} ${contextInfo}\`\`\`\n${candidate.content}\`\`\`
---
`
        })

        prompt += `Respond with ONLY a JSON object with a relevant "scores" array: {"scores": [${Array.from({length: candidates.length}, (_, i) => `score${i + 1}`).join(', ')}]}`


        return prompt
    }

    /**
     * Builds context information for a candidate based on its payload.
     */
    private buildContextInfo(candidate: RerankerCandidate): string {
        const parts: string[] = []

        // Add hierarchy information
        if (candidate.payload?.hierarchyDisplay) {
            parts.push(`[Context: ${candidate.payload.hierarchyDisplay}]`)
        }

        // Add file path information
        if (candidate.payload?.filePath) {
            const fileName = candidate.payload.filePath.split('/').pop()
            parts.push(`[File: ${fileName}]`)
        }

        // // Add code type information
        // if (candidate.payload?.type) {
        //     parts.push(`[Type: ${candidate.payload.type}]`)
        // }

        // // Add line number information
        // if (candidate.payload?.startLine && candidate.payload?.endLine) {
        //     parts.push(`[Lines: ${candidate.payload.startLine}-${candidate.payload.endLine}]`)
        // }

        return parts.length > 0 ? parts.join(' ') + '\n' : ''
    }

    /**
     * Calls OpenAI-compatible API to generate scores for the candidates.
     */
    private async generateScores(prompt: string): Promise<number[]> {
        const url = `${this.baseUrl}/chat/completions`

        // Add timeout to prevent indefinite hanging
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), OPENAI_RERANK_TIMEOUT_MS)

        // Check for proxy settings in environment variables
        const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
        const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

        // Choose appropriate proxy based on target URL protocol
        let dispatcher: any = undefined
        const proxyUrl = url.startsWith('https:') ? httpsProxy : httpProxy

        if (proxyUrl) {
            try {
                dispatcher = new ProxyAgent(proxyUrl)
                console.log('✓ OpenAI-compatible reranker using undici ProxyAgent:', proxyUrl)
            } catch (error) {
                console.error('✗ Failed to create undici ProxyAgent for OpenAI-compatible reranker:', error)
            }
        }

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
                temperature: 0,
                max_tokens: 500
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
                `OpenAI-compatible API request failed with status ${response.status}: ${errorBody}`,
            )
        }

        const data = await response.json() as any

        // Extract and parse the response from choices[0].message.content
        if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
            throw new Error("Invalid response structure from OpenAI-compatible API. Expected 'choices[0].message.content' field.")
        }

        let responseText = data.choices[0].message.content.trim()
        let parsedResponse: any

        // Strip markdown code blocks if present
        if (responseText.startsWith('```')) {
            // Remove opening code block (with optional language specifier)
            responseText = responseText.replace(/^```(?:json)?\s*\n?/, '')
            // Remove closing code block
            responseText = responseText.replace(/\n?```\s*$/, '')
            responseText = responseText.trim()
        }

        try {
            // Parse the JSON string in the content field
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
        return scores.map((score: number | string) => {
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
     * Validates the OpenAI-compatible reranker configuration by checking service availability and model existence
     * @returns Promise resolving to validation result with success status and optional error message
     */
    async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
        return withValidationErrorHandling(
            async () => {
                // First check if OpenAI-compatible service is running by trying to list models
                const modelsUrl = `${this.baseUrl}/models`

                // Add timeout to prevent indefinite hanging
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), OPENAI_VALIDATION_TIMEOUT_MS)

                // Check for proxy settings in environment variables
                const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
                const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

                let dispatcher: any = undefined
                const proxyUrl = modelsUrl.startsWith('https:') ? httpsProxy : httpProxy

                if (proxyUrl) {
                    try {
                        dispatcher = new ProxyAgent(proxyUrl)
                    } catch (error) {
                        console.error('✗ Failed to create undici ProxyAgent for OpenAI-compatible validation:', error)
                    }
                }

                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                }

                // Add Authorization header if API key is provided
                if (this.apiKey) {
                    headers["Authorization"] = `Bearer ${this.apiKey}`
                }

                const fetchOptions: any = {
                    method: "GET",
                    headers: headers,
                    signal: controller.signal,
                }

                if (dispatcher) {
                    fetchOptions.dispatcher = dispatcher
                }

                const modelsResponse = await fetch(modelsUrl, fetchOptions)
                clearTimeout(timeoutId)

                if (!modelsResponse.ok) {
                    if (modelsResponse.status === 404) {
                        // If /models endpoint is not available, try a simple chat/completions test instead
                        console.log(`/models endpoint not available at ${this.baseUrl}, trying chat/completions fallback...`)

                        try {
                            const testUrl = `${this.baseUrl}/chat/completions`
                            const testController = new AbortController()
                            const testTimeoutId = setTimeout(() => testController.abort(), OPENAI_VALIDATION_TIMEOUT_MS)

                            const testFetchOptions: any = {
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
                                    temperature: 0,
                                    max_tokens: 10
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
                                    error: `OpenAI-compatible service unavailable at ${this.baseUrl} (both /models and /chat/completions failed)`,
                                }
                            }

                            // If chat/completions works, assume the service is valid
                            return { valid: true }
                        } catch (error) {
                            return {
                                valid: false,
                                error: `OpenAI-compatible service is not running at ${this.baseUrl}`,
                            }
                        }
                    }
                    return {
                        valid: false,
                        error: `OpenAI-compatible service unavailable at ${this.baseUrl} (status: ${modelsResponse.status})`,
                    }
                }

                // Check if the specific model exists
                const modelsData = await modelsResponse.json() as any
                const models = modelsData.data || []

                // Check both with and without :latest suffix
                const modelExists = models.some((m: any) => {
                    const modelName = m.id || ""
                    return (
                        modelName === this.modelId ||
                        modelName === `${this.modelId}:latest` ||
                        modelName === this.modelId.replace(":latest", "")
                    )
                })

                if (!modelExists) {
                    const availableModels = models.map((m: any) => m.id).join(", ")
                    return {
                        valid: false,
                        error: `Model '${this.modelId}' not found. Available models: ${availableModels}`,
                    }
                }

                // Try a test chat completion to ensure the model works for text generation
                const testUrl = `${this.baseUrl}/chat/completions`

                // Add timeout for test request too
                const testController = new AbortController()
                const testTimeoutId = setTimeout(() => testController.abort(), OPENAI_VALIDATION_TIMEOUT_MS)

                const testFetchOptions: any = {
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
                        temperature: 0,
                        max_tokens: 10
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
            "openai-compatible",
            {
                beforeStandardHandling: (error: any) => {
                    // Handle OpenAI-compatible specific connection errors
                    if (
                        error?.message?.includes("fetch failed") ||
                        error?.code === "ECONNREFUSED" ||
                        error?.message?.includes("ECONNREFUSED")
                    ) {
                        return {
                            valid: false,
                            error: `OpenAI-compatible service is not running at ${this.baseUrl}`,
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
            name: "openai-compatible",
            model: this.modelId,
        }
    }
}