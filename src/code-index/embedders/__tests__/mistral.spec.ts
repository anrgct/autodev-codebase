import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MockedClass } from "vitest"
import { MistralEmbedder } from "../mistral"
import { OpenAICompatibleEmbedder } from "../openai-compatible"

// Mock the OpenAICompatibleEmbedder so we don't hit real APIs
vi.mock("../openai-compatible", () => ({
  OpenAICompatibleEmbedder: vi.fn(),
}))

const MockedOpenAICompatibleEmbedder = OpenAICompatibleEmbedder as unknown as MockedClass<
  typeof OpenAICompatibleEmbedder
>

describe("MistralEmbedder", () => {
  let embedder: MistralEmbedder
  let mockOpenAICompatibleEmbedder: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockOpenAICompatibleEmbedder = {
      createEmbeddings: vi.fn(),
      validateConfiguration: vi.fn(),
    }

    MockedOpenAICompatibleEmbedder.mockImplementation(() => mockOpenAICompatibleEmbedder)
  })

  describe("constructor", () => {
    it("creates an instance with default model when no model is specified", () => {
      const apiKey = "test-mistral-api-key"

      embedder = new MistralEmbedder(apiKey)

      expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
        "https://api.mistral.ai/v1",
        apiKey,
        "codestral-embed-2505",
        8191,
      )
      expect(embedder.embedderInfo.name).toBe("mistral")
    })

    it("creates an instance with the specified model", () => {
      const apiKey = "test-mistral-api-key"
      const modelId = "custom-embed-model"

      embedder = new MistralEmbedder(apiKey, modelId)

      expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
        "https://api.mistral.ai/v1",
        apiKey,
        "custom-embed-model",
        8191,
      )
    })

    it("throws a helpful error when API key is not provided", () => {
      expect(() => new MistralEmbedder("")).toThrow("API key is required for Mistral embedder")
      expect(() => new MistralEmbedder(null as any)).toThrow("API key is required for Mistral embedder")
      expect(() => new MistralEmbedder(undefined as any)).toThrow("API key is required for Mistral embedder")
    })
  })

  describe("embedderInfo", () => {
    it("returns correct embedder info", () => {
      embedder = new MistralEmbedder("test-api-key")

      const info = embedder.embedderInfo

      expect(info).toEqual({
        name: "mistral",
      })
    })
  })

  describe("createEmbeddings", () => {
    beforeEach(() => {
      embedder = new MistralEmbedder("test-api-key")
    })

    it("uses instance model when no model parameter is provided", async () => {
      const texts = ["test text 1", "test text 2"]
      const mockResponse = {
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }

      mockOpenAICompatibleEmbedder.createEmbeddings.mockResolvedValue(mockResponse)

      const result = await embedder.createEmbeddings(texts)

      expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(
        texts,
        "codestral-embed-2505",
      )
      expect(result).toEqual(mockResponse)
    })

    it("uses provided model parameter when specified", async () => {
      embedder = new MistralEmbedder("test-api-key", "custom-embed-model")

      const texts = ["test text 1", "test text 2"]
      const mockResponse = {
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }

      mockOpenAICompatibleEmbedder.createEmbeddings.mockResolvedValue(mockResponse)

      const result = await embedder.createEmbeddings(texts, "codestral-embed-2505")

      expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(
        texts,
        "codestral-embed-2505",
      )
      expect(result).toEqual(mockResponse)
    })

    it("propagates errors from OpenAICompatibleEmbedder", async () => {
      embedder = new MistralEmbedder("test-api-key")

      const texts = ["test text"]
      const error = new Error("Embedding failed")

      mockOpenAICompatibleEmbedder.createEmbeddings.mockRejectedValue(error)

      await expect(embedder.createEmbeddings(texts)).rejects.toThrow("Embedding failed")
    })
  })

  describe("validateConfiguration", () => {
    beforeEach(() => {
      embedder = new MistralEmbedder("test-api-key")
    })

    it("delegates validation to OpenAICompatibleEmbedder", async () => {
      const mockValidationResult = { valid: true }
      mockOpenAICompatibleEmbedder.validateConfiguration.mockResolvedValue(mockValidationResult)

      const result = await embedder.validateConfiguration()

      expect(mockOpenAICompatibleEmbedder.validateConfiguration).toHaveBeenCalled()
      expect(result).toEqual(mockValidationResult)
    })

    it("propagates validation errors from OpenAICompatibleEmbedder", async () => {
      const mockValidationResult = {
        valid: false,
        error: "Authentication failed. Please check your API key or credentials.",
      }
      mockOpenAICompatibleEmbedder.validateConfiguration.mockResolvedValue(mockValidationResult)

      const result = await embedder.validateConfiguration()

      expect(mockOpenAICompatibleEmbedder.validateConfiguration).toHaveBeenCalled()
      expect(result).toEqual(mockValidationResult)
    })

    it("propagates validation exceptions", async () => {
      const error = new Error("Validation failed")
      mockOpenAICompatibleEmbedder.validateConfiguration.mockRejectedValue(error)

      await expect(embedder.validateConfiguration()).rejects.toThrow("Validation failed")
    })
  })
})
