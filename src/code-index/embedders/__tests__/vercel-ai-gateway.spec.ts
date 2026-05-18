import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MockedClass } from "vitest"
import { VercelAiGatewayEmbedder } from "../vercel-ai-gateway"
import { OpenAICompatibleEmbedder } from "../openai-compatible"

// Mock the OpenAICompatibleEmbedder so we don't hit real APIs
vi.mock("../openai-compatible", () => ({
  OpenAICompatibleEmbedder: vi.fn(),
}))

const MockedOpenAICompatibleEmbedder = OpenAICompatibleEmbedder as unknown as MockedClass<
  typeof OpenAICompatibleEmbedder
>

describe("VercelAiGatewayEmbedder", () => {
  let embedder: VercelAiGatewayEmbedder
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
      const apiKey = "test-vercel-api-key"

      embedder = new VercelAiGatewayEmbedder(apiKey)

      expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
        "https://ai-gateway.vercel.sh/v1",
        apiKey,
        "openai/text-embedding-3-large",
        8191,
      )
      expect(embedder.embedderInfo.name).toBe("vercel-ai-gateway")
    })

    it("creates an instance with the specified model", () => {
      const apiKey = "test-vercel-api-key"
      const modelId = "openai/text-embedding-3-small"

      embedder = new VercelAiGatewayEmbedder(apiKey, modelId)

      expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
        "https://ai-gateway.vercel.sh/v1",
        apiKey,
        "openai/text-embedding-3-small",
        8191,
      )
    })

    it("throws a helpful error when API key is not provided", () => {
      expect(() => new VercelAiGatewayEmbedder("")).toThrow(
        "API key is required for Vercel AI Gateway embedder",
      )
    })
  })

  describe("createEmbeddings", () => {
    beforeEach(() => {
      embedder = new VercelAiGatewayEmbedder("test-api-key")
    })

    it("delegates to OpenAICompatibleEmbedder with default model when no model is provided", async () => {
      const texts = ["test text 1", "test text 2"]
      const expectedResponse = {
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }

      mockOpenAICompatibleEmbedder.createEmbeddings.mockResolvedValue(expectedResponse)

      const result = await embedder.createEmbeddings(texts)

      expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(
        texts,
        "openai/text-embedding-3-large",
      )
      expect(result).toBe(expectedResponse)
    })

    it("delegates to OpenAICompatibleEmbedder with custom model when provided", async () => {
      const texts = ["test text"]
      const customModel = "google/gemini-embedding-001"
      const expectedResponse = { embeddings: [[0.1, 0.2, 0.3]] }

      mockOpenAICompatibleEmbedder.createEmbeddings.mockResolvedValue(expectedResponse)

      const result = await embedder.createEmbeddings(texts, customModel)

      expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(texts, customModel)
      expect(result).toBe(expectedResponse)
    })

    it("propagates errors from OpenAICompatibleEmbedder", async () => {
      const texts = ["test text"]
      const error = new Error("API request failed")

      mockOpenAICompatibleEmbedder.createEmbeddings.mockRejectedValue(error)

      await expect(embedder.createEmbeddings(texts)).rejects.toThrow("API request failed")
      expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(
        texts,
        "openai/text-embedding-3-large",
      )
    })
  })

  describe("validateConfiguration", () => {
    beforeEach(() => {
      embedder = new VercelAiGatewayEmbedder("test-api-key")
    })

    it("delegates validation to OpenAICompatibleEmbedder", async () => {
      const expectedResult = { valid: true }
      mockOpenAICompatibleEmbedder.validateConfiguration.mockResolvedValue(expectedResult)

      const result = await embedder.validateConfiguration()

      expect(mockOpenAICompatibleEmbedder.validateConfiguration).toHaveBeenCalled()
      expect(result).toBe(expectedResult)
    })

    it("propagates validation errors", async () => {
      const error = new Error("Validation failed")
      mockOpenAICompatibleEmbedder.validateConfiguration.mockRejectedValue(error)

      await expect(embedder.validateConfiguration()).rejects.toThrow("Validation failed")
      expect(mockOpenAICompatibleEmbedder.validateConfiguration).toHaveBeenCalled()
    })
  })

  describe("embedderInfo", () => {
    it("returns correct embedder info", () => {
      embedder = new VercelAiGatewayEmbedder("test-api-key")

      const info = embedder.embedderInfo

      expect(info).toEqual({
        name: "vercel-ai-gateway",
      })
    })
  })
})
