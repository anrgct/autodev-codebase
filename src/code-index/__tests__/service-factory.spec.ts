import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MockedClass } from "vitest"
import { CodeIndexServiceFactory } from "../service-factory"
import { CodeIndexConfigManager } from "../config-manager"
import { CacheManager } from "../cache-manager"

// Mock embedders
vi.mock("../embedders/openai", () => {
	class MockOpenAiEmbedder {
		createEmbeddings = vi.fn()
		validateConfiguration = vi.fn().mockResolvedValue({ valid: true })
		get embedderInfo() {
			return { name: "openai" }
		}
	}
	return { OpenAiEmbedder: vi.fn().mockImplementation((opts) => new MockOpenAiEmbedder()) }
})

vi.mock("../embedders/ollama", () => {
	class MockOllamaEmbedder {
		createEmbeddings = vi.fn()
		validateConfiguration = vi.fn().mockResolvedValue({ valid: true })
		get embedderInfo() {
			return { name: "ollama" }
		}
	}
	return { CodeIndexOllamaEmbedder: vi.fn().mockImplementation(() => new MockOllamaEmbedder()) }
})

vi.mock("../embedders/openai-compatible", () => {
	class MockOpenAICompatibleEmbedder {
		createEmbeddings = vi.fn()
		validateConfiguration = vi.fn().mockResolvedValue({ valid: true })
		get embedderInfo() {
			return { name: "openai-compatible" }
		}
	}
	return { OpenAICompatibleEmbedder: vi.fn().mockImplementation(() => new MockOpenAICompatibleEmbedder()) }
})

// Mock vector store
vi.mock("../vector-store/qdrant-client", () => {
	const createMockVectorStore = () => ({
		addEmbeddings: vi.fn(),
		search: vi.fn(),
		ensureCollection: vi.fn(),
		deleteCollection: vi.fn(),
		getCollectionInfo: vi.fn(),
	})
	return {
		QdrantVectorStore: vi.fn().mockImplementation(createMockVectorStore),
	}
})

// Mock embedding models helpers
vi.mock("../shared/embeddingModels", () => ({
	getDefaultModelId: vi.fn().mockReturnValue("text-embedding-3-small"),
	getModelDimension: vi.fn().mockReturnValue(1536),
}))

// Import mocked modules for type-safe access
import { OpenAiEmbedder } from "../embedders/openai"
import { CodeIndexOllamaEmbedder } from "../embedders/ollama"
import { OpenAICompatibleEmbedder } from "../embedders/openai-compatible"
import { QdrantVectorStore } from "../vector-store/qdrant-client"
import { getDefaultModelId, getModelDimension } from "../../shared/embeddingModels"

const MockedOpenAiEmbedder = OpenAiEmbedder as unknown as MockedClass<typeof OpenAiEmbedder>
const MockedCodeIndexOllamaEmbedder = CodeIndexOllamaEmbedder as unknown as MockedClass<
	typeof CodeIndexOllamaEmbedder
>
const MockedOpenAICompatibleEmbedder = OpenAICompatibleEmbedder as unknown as MockedClass<
	typeof OpenAICompatibleEmbedder
>
const MockedQdrantVectorStore = QdrantVectorStore as unknown as MockedClass<typeof QdrantVectorStore>

	describe("CodeIndexServiceFactory", () => {
	let factory: CodeIndexServiceFactory
	let mockConfigManager: any
	let mockCacheManager: CacheManager

	beforeEach(() => {
		vi.clearAllMocks()

		mockConfigManager = {
			getConfig: vi.fn(),
			isFeatureConfigured: true,
		} as any

		mockCacheManager = {} as CacheManager

		factory = new CodeIndexServiceFactory(mockConfigManager, "/test/workspace", mockCacheManager)
	})

	describe("createEmbedder", () => {
		it("should create OpenAI embedder with correct configuration", () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-large",
				embedderOpenAiApiKey: "test-api-key",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = factory.createEmbedder()

			expect(embedder).toBeDefined()
			expect(MockedOpenAiEmbedder).toHaveBeenCalledWith(
				expect.objectContaining({
					openAiNativeApiKey: "test-api-key",
					openAiEmbeddingModelId: "text-embedding-3-large",
				}),
			)
		})

		it("should create Ollama embedder with correct configuration", () => {
			const config = {
				embedderProvider: "ollama",
				embedderModelId: "nomic-embed-text",
				embedderOllamaBaseUrl: "http://localhost:11434",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = factory.createEmbedder()

			expect(embedder).toBeDefined()
			expect(MockedCodeIndexOllamaEmbedder).toHaveBeenCalledWith(
				expect.objectContaining({
					ollamaBaseUrl: "http://localhost:11434",
					ollamaModelId: "nomic-embed-text",
				}),
			)
		})

		it("should create OpenAI Compatible embedder with correct configuration", () => {
			const config = {
				embedderProvider: "openai-compatible",
				embedderModelId: "text-embedding-3-large",
				embedderOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				embedderOpenAiCompatibleApiKey: "test-api-key",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = factory.createEmbedder()

			expect(embedder).toBeDefined()
			expect(MockedOpenAICompatibleEmbedder).toHaveBeenCalledWith(
				"https://api.example.com/v1",
				"test-api-key",
				"text-embedding-3-large",
			)
		})

		it("should throw when OpenAI API key is missing", () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createEmbedder()).toThrow("OpenAI API key missing for embedder creation")
		})

		it("should throw when Ollama base URL is missing", () => {
			const config = {
				embedderProvider: "ollama",
				embedderModelId: "nomic-embed-text",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createEmbedder()).toThrow("Ollama base URL missing for embedder creation")
		})

		it("should throw when OpenAI Compatible base URL or API key is missing", () => {
			const config = {
				embedderProvider: "openai-compatible",
				embedderModelId: "text-embedding-3-large",
				embedderOpenAiCompatibleBaseUrl: "",
				embedderOpenAiCompatibleApiKey: "",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createEmbedder()).toThrow(
				"OpenAI Compatible base URL and API key missing for embedder creation",
			)
		})

		it("should throw for invalid embedder provider", () => {
			const config = {
				embedderProvider: "invalid-provider",
				embedderModelId: "some-model",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createEmbedder()).toThrow("Invalid embedder type configured: invalid-provider")
		})
	})

	describe("createVectorStore", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("should use model profile dimension when available", () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				embedderModelDimension: 2048,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const expectedDimension = getModelDimension("openai", "text-embedding-3-small")!

			factory.createVectorStore()

			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				expectedDimension,
				"test-key",
			)
		})

		it("should fall back to manual modelDimension when model has no profile", () => {
			const config = {
				embedderProvider: "openai-compatible",
				embedderModelId: "custom-model",
				embedderModelDimension: 1024,
				embedderOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				embedderOpenAiCompatibleApiKey: "test-api-key",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			factory.createVectorStore()

			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				1024,
				"test-key",
			)
		})

		it("should throw specialized error when OpenAI Compatible dimension cannot be determined", () => {
			const config = {
				embedderProvider: "openai-compatible",
				embedderModelId: "custom-model",
				embedderModelDimension: 0,
				embedderOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				embedderOpenAiCompatibleApiKey: "test-api-key",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createVectorStore()).toThrow(
				"Could not determine vector dimension for model 'custom-model' with provider 'openai-compatible'. Please ensure the 'Embedding Dimension' is correctly set in the OpenAI-Compatible provider settings.",
			)
		})

		it("should throw generic error when dimension cannot be determined for OpenAI", () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "unknown-model",
				embedderModelDimension: undefined,
				embedderOpenAiApiKey: "test-key",
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createVectorStore()).toThrow(
				"Could not determine vector dimension for model 'unknown-model' with provider 'openai'. Check model profiles or configuration.",
			)
		})

		it("should throw when Qdrant URL is missing", () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				embedderModelDimension: 1536,
				embedderOpenAiApiKey: "test-key",
				qdrantUrl: undefined,
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			expect(() => factory.createVectorStore()).toThrow("Qdrant URL missing for vector store creation")
		})
	})

	describe("validateEmbedder", () => {
		it("should return validation result from embedder", async () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				embedderOpenAiApiKey: "test-key",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedder = factory.createEmbedder()
			const result = await factory.validateEmbedder(embedder)

			expect(result).toEqual({ valid: true })
		})

		it("should preserve error message when validation throws", async () => {
			const config = {
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				embedderOpenAiApiKey: "test-key",
				qdrantUrl: "http://localhost:6333",
			}
			mockConfigManager.getConfig.mockReturnValue(config)

			const embedderInstance: any = {
				validateConfiguration: vi.fn().mockRejectedValue(new Error("authenticationFailed")),
			}
			;(MockedOpenAiEmbedder as any).mockImplementation(() => embedderInstance)

			const embedder = factory.createEmbedder()
			const result = await factory.validateEmbedder(embedder)

			expect(result).toEqual({
				valid: false,
				error: "authenticationFailed",
			})
		})
	})
})
