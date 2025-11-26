import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MockedClass } from "vitest"
import { GeminiEmbedder } from "../gemini"
import { OpenAICompatibleEmbedder } from "../openai-compatible"

// Mock the OpenAICompatibleEmbedder so we don't hit real APIs
vi.mock("../openai-compatible", () => ({
	OpenAICompatibleEmbedder: vi.fn(),
}))

const MockedOpenAICompatibleEmbedder = OpenAICompatibleEmbedder as unknown as MockedClass<
	typeof OpenAICompatibleEmbedder
>

describe("GeminiEmbedder", () => {
	let embedder: GeminiEmbedder
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
			const apiKey = "test-gemini-api-key"

			embedder = new GeminiEmbedder(apiKey)

			expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
				"https://generativelanguage.googleapis.com/v1beta/openai/",
				apiKey,
				"gemini-embedding-001",
				2048,
			)
			expect(embedder.embedderInfo.name).toBe("gemini")
		})

		it("creates an instance with the specified model", () => {
			const apiKey = "test-gemini-api-key"
			const modelId = "text-embedding-004"

			embedder = new GeminiEmbedder(apiKey, modelId)

			expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
				"https://generativelanguage.googleapis.com/v1beta/openai/",
				apiKey,
				"text-embedding-004",
				2048,
			)
		})

		it("throws a helpful error when API key is not provided", () => {
			expect(() => new GeminiEmbedder("")).toThrow("API key is required for Gemini embedder")
			expect(() => new GeminiEmbedder(null as any)).toThrow("API key is required for Gemini embedder")
			expect(() => new GeminiEmbedder(undefined as any)).toThrow("API key is required for Gemini embedder")
		})
	})

	describe("embedderInfo", () => {
		it("returns correct embedder info", () => {
			embedder = new GeminiEmbedder("test-api-key")

			const info = embedder.embedderInfo

			expect(info).toEqual({
				name: "gemini",
			})
		})
	})

	describe("createEmbeddings", () => {
		beforeEach(() => {
			embedder = new GeminiEmbedder("test-api-key")
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
				"gemini-embedding-001",
			)
			expect(result).toEqual(mockResponse)
		})

		it("uses provided model parameter when specified", async () => {
			embedder = new GeminiEmbedder("test-api-key", "text-embedding-004")

			const texts = ["test text 1", "test text 2"]
			const mockResponse = {
				embeddings: [
					[0.1, 0.2],
					[0.3, 0.4],
				],
			}

			mockOpenAICompatibleEmbedder.createEmbeddings.mockResolvedValue(mockResponse)

			const result = await embedder.createEmbeddings(texts, "gemini-embedding-001")

			expect(mockOpenAICompatibleEmbedder.createEmbeddings).toHaveBeenCalledWith(
				texts,
				"gemini-embedding-001",
			)
			expect(result).toEqual(mockResponse)
		})

		it("propagates errors from OpenAICompatibleEmbedder", async () => {
			embedder = new GeminiEmbedder("test-api-key")

			const texts = ["test text"]
			const error = new Error("Embedding failed")

			mockOpenAICompatibleEmbedder.createEmbeddings.mockRejectedValue(error)

			await expect(embedder.createEmbeddings(texts)).rejects.toThrow("Embedding failed")
		})
	})

	describe("validateConfiguration", () => {
		beforeEach(() => {
			embedder = new GeminiEmbedder("test-api-key")
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

