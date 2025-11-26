import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockedClass, MockedFunction } from "vitest"
import { OpenAI } from "openai"
import { OpenRouterEmbedder } from "../openrouter"
import { getModelDimension, getDefaultModelId } from "../../../shared/embeddingModels"

// Mock the OpenAI SDK
vi.mock("openai")

const MockedOpenAI = OpenAI as unknown as MockedClass<typeof OpenAI>

describe("OpenRouterEmbedder", () => {
	const mockApiKey = "test-api-key"

	let mockEmbeddingsCreate: MockedFunction<any>
	let mockOpenAIInstance: any

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		mockEmbeddingsCreate = vi.fn()
		mockOpenAIInstance = {
			embeddings: {
				create: mockEmbeddingsCreate,
			},
		}

		MockedOpenAI.mockImplementation(() => mockOpenAIInstance)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("constructor", () => {
		it("creates an instance with valid API key", () => {
			const embedder = new OpenRouterEmbedder(mockApiKey)
			expect(embedder).toBeInstanceOf(OpenRouterEmbedder)
		})

		it("throws a helpful error when API key is missing", () => {
			expect(() => new OpenRouterEmbedder("")).toThrow("API key is required for OpenRouter embedder")
		})

		it("initializes OpenAI client with the correct configuration", () => {
			new OpenRouterEmbedder(mockApiKey)

			expect(MockedOpenAI).toHaveBeenCalledWith({
				baseURL: "https://openrouter.ai/api/v1",
				apiKey: mockApiKey,
				defaultHeaders: {
					"HTTP-Referer": "https://github.com/RooCodeInc/Roo-Code",
					"X-Title": "Roo Code",
				},
			})
		})

		it("uses the correct default model id from shared embedding models", () => {
			const embedder = new OpenRouterEmbedder(mockApiKey)
			const defaultModel = getDefaultModelId("openrouter")

			expect(defaultModel).toBeDefined()
			expect(embedder.embedderInfo.name).toBe("openrouter")
		})
	})

	describe("embedderInfo", () => {
		it("returns correct embedder info", () => {
			const embedder = new OpenRouterEmbedder(mockApiKey)

			expect(embedder.embedderInfo).toEqual({
				name: "openrouter",
			})
		})
	})

	describe("createEmbeddings", () => {
		let embedder: OpenRouterEmbedder

		beforeEach(() => {
			embedder = new OpenRouterEmbedder(mockApiKey)
		})

		it("creates embeddings successfully with default model", async () => {
			const texts = ["test text"]
			const defaultModel = getDefaultModelId("openrouter")

			const testEmbedding = new Float32Array([0.25, 0.5, 0.75])
			const base64String = Buffer.from(testEmbedding.buffer).toString("base64")

			const mockResponse = {
				data: [{ embedding: base64String }],
				usage: {
					prompt_tokens: 5,
					total_tokens: 5,
				},
			}

			mockEmbeddingsCreate.mockResolvedValue(mockResponse)

			const result = await embedder.createEmbeddings(texts)

			expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
				input: texts,
				model: defaultModel,
				encoding_format: "base64",
			})

			expect(result.embeddings).toHaveLength(1)
			expect(result.embeddings[0]).toEqual([0.25, 0.5, 0.75])
			expect(result.usage?.promptTokens).toBe(5)
			expect(result.usage?.totalTokens).toBe(5)
		})

		it("supports multiple texts", async () => {
			const texts = ["text1", "text2"]

			const embedding1 = new Float32Array([0.25, 0.5])
			const embedding2 = new Float32Array([0.75, 1.0])

			const base64String1 = Buffer.from(embedding1.buffer).toString("base64")
			const base64String2 = Buffer.from(embedding2.buffer).toString("base64")

			const mockResponse = {
				data: [{ embedding: base64String1 }, { embedding: base64String2 }],
				usage: {
					prompt_tokens: 10,
					total_tokens: 10,
				},
			}

			mockEmbeddingsCreate.mockResolvedValue(mockResponse)

			const result = await embedder.createEmbeddings(texts)

			expect(result.embeddings).toHaveLength(2)
			expect(result.embeddings[0]).toEqual([0.25, 0.5])
			expect(result.embeddings[1]).toEqual([0.75, 1.0])
		})

		it("uses custom model when provided", async () => {
			const customModel = "mistralai/mistral-embed-2312"
			const embedderWithCustomModel = new OpenRouterEmbedder(mockApiKey, customModel)

			const texts = ["test"]
			const testEmbedding = new Float32Array([0.25, 0.5])
			const base64String = Buffer.from(testEmbedding.buffer).toString("base64")

			const mockResponse = {
				data: [{ embedding: base64String }],
				usage: {
					prompt_tokens: 5,
					total_tokens: 5,
				},
			}

			mockEmbeddingsCreate.mockResolvedValue(mockResponse)

			await embedderWithCustomModel.createEmbeddings(texts)

			expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
				input: texts,
				model: customModel,
				encoding_format: "base64",
			})
		})

		it("propagates formatted authentication errors", async () => {
			const texts = ["test"]
			const authError = new Error("Invalid API key")
			;(authError as any).status = 401

			mockEmbeddingsCreate.mockRejectedValue(authError)

			await expect(embedder.createEmbeddings(texts)).rejects.toThrow(
				"Authentication failed. Please check your API key.",
			)
		})
	})

	describe("validateConfiguration", () => {
		let embedder: OpenRouterEmbedder

		beforeEach(() => {
			embedder = new OpenRouterEmbedder(mockApiKey)
		})

		it("validates configuration successfully", async () => {
			const testEmbedding = new Float32Array([0.25, 0.5])
			const base64String = Buffer.from(testEmbedding.buffer).toString("base64")

			const mockResponse = {
				data: [{ embedding: base64String }],
				usage: {
					prompt_tokens: 1,
					total_tokens: 1,
				},
			}

			mockEmbeddingsCreate.mockResolvedValue(mockResponse)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(true)
			expect(result.error).toBeUndefined()
			expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
				input: ["test"],
				model: getDefaultModelId("openrouter"),
				encoding_format: "base64",
			})
		})

		it("maps authentication errors to a helpful validation message", async () => {
			const authError = new Error("Invalid API key")
			;(authError as any).status = 401

			mockEmbeddingsCreate.mockRejectedValue(authError)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("Authentication failed. Please check your API key or credentials.")
		})
	})

	describe("integration with shared model metadata", () => {
		it("has dimensions defined for known OpenRouter models", () => {
			const openRouterModels = [
				"openai/text-embedding-3-small",
				"openai/text-embedding-3-large",
				"openai/text-embedding-ada-002",
			]

			openRouterModels.forEach((model) => {
				const dimension = getModelDimension("openrouter", model)
				expect(dimension).toBeDefined()
				expect(dimension).toBeGreaterThan(0)

				const embedder = new OpenRouterEmbedder(mockApiKey, model)
				expect(embedder.embedderInfo.name).toBe("openrouter")
			})
		})

		it("uses correct default model metadata", () => {
			const defaultModel = getDefaultModelId("openrouter")
			expect(defaultModel).toBeDefined()

			const dimension = getModelDimension("openrouter", defaultModel)
			expect(dimension).toBeGreaterThan(0)
		})
	})
})
