import { OpenAICompatibleEmbedder } from "./openai-compatible"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { MAX_ITEM_TOKENS } from "../constants"

/**
 * Mistral embedder implementation that wraps the OpenAI Compatible embedder
 * with configuration for Mistral's embedding API.
 *
 * Supported models:
 * - codestral-embed-2505 (dimension: 1536)
 */
export class MistralEmbedder implements IEmbedder {
    private readonly openAICompatibleEmbedder: OpenAICompatibleEmbedder
    private static readonly MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
    private static readonly DEFAULT_MODEL = "codestral-embed-2505"
    private readonly modelId: string

    /**
     * Creates a new Mistral embedder
     * @param apiKey The Mistral API key for authentication
     * @param modelId The model ID to use (defaults to codestral-embed-2505)
     */
    constructor(apiKey: string, modelId?: string) {
        if (!apiKey) {
            throw new Error("API key is required for Mistral embedder")
        }

        // Use provided model or default
        this.modelId = modelId || MistralEmbedder.DEFAULT_MODEL

        // Create an OpenAI Compatible embedder with Mistral's configuration
        this.openAICompatibleEmbedder = new OpenAICompatibleEmbedder(
            MistralEmbedder.MISTRAL_BASE_URL,
            apiKey,
            this.modelId,
            MAX_ITEM_TOKENS, // This is the max token limit (8191), not the embedding dimension
        )
    }

    /**
     * Creates embeddings for the given texts using Mistral's embedding API
     * @param texts Array of text strings to embed
     * @param model Optional model identifier (uses constructor model if not provided)
     * @returns Promise resolving to embedding response
     */
    async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
        try {
            // Use the provided model or fall back to the instance's model
            const modelToUse = model || this.modelId
            return await this.openAICompatibleEmbedder.createEmbeddings(texts, modelToUse)
        } catch (error) {
            // TelemetryService calls removed as per requirements
            throw error
        }
    }

    /**
     * Validates the Mistral embedder configuration by delegating to the underlying OpenAI-compatible embedder
     * @returns Promise resolving to validation result with success status and optional error message
     */
    async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
        try {
            // Delegate validation to the OpenAI-compatible embedder
            // The error messages will be specific to Mistral since we're using Mistral's base URL
            return await this.openAICompatibleEmbedder.validateConfiguration()
        } catch (error) {
            // TelemetryService calls removed as per requirements
            throw error
        }
    }

    /**
     * Returns information about this embedder
     */
    get embedderInfo(): EmbedderInfo {
        return {
            name: "mistral",
        }
    }

    /**
     * Gets the optimal batch size for this Mistral embedder
     */
    get optimalBatchSize(): number {
        // Return recommended batch size for Mistral
        return 30
    }
}