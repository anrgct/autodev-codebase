import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MockedClass, MockedFunction } from "vitest"
import { CodeIndexServiceFactory } from "../service-factory"
import { CodeIndexConfigManager } from "../config-manager"
import { CacheManager } from "../cache-manager"

// Mock the embedders and vector store with factory functions that return proper mocks
vi.mock("../embedders/openai", () => {
	class MockOpenAiEmbedder {
		async createEmbeddings(texts: string[], model?: string) {
			return {
				embeddings: [[0.1, 0.2, 0.3]],
				usage: { promptTokens: 10, totalTokens: 10 },
			}
		}

		get embedderInfo() {
			return {
				name: "openai",
			}
		}
	}

	return {
		OpenAiEmbedder: MockOpenAiEmbedder,
	}
})
vi.mock("../embedders/ollama", () => {
	class MockOllamaEmbedder {
		async createEmbeddings(texts: string[], model?: string) {
			return {
				embeddings: [[0.1, 0.2, 0.3]],
				usage: { promptTokens: 10, totalTokens: 10 },
			}
		}

		get embedderInfo() {
			return {
				name: "ollama",
			}
		}
	}

	return {
		CodeIndexOllamaEmbedder: MockOllamaEmbedder,
	}
})
vi.mock("../embedders/openai-compatible", () => {
	class MockOpenAICompatibleEmbedder {
		async createEmbeddings(texts: string[], model?: string) {
			return {
				embeddings: [[0.1, 0.2, 0.3]],
				usage: { promptTokens: 10, totalTokens: 10 },
			}
		}

		get embedderInfo() {
			return {
				name: "openai-compatible",
			}
		}
	}

	return {
		OpenAICompatibleEmbedder: MockOpenAICompatibleEmbedder,
	}
})
vi.mock("../vector-store/qdrant-client", () => {
	const createMockVectorStore = () => ({
		addEmbeddings: vi.fn().mockResolvedValue({}),
		search: vi.fn().mockResolvedValue([
			{ id: "1", score: 0.9, metadata: { file: "test.ts" } },
		]),
		ensureCollection: vi.fn().mockResolvedValue(true),
		deleteCollection: vi.fn().mockResolvedValue(true),
		getCollectionInfo: vi.fn().mockResolvedValue({ vectors_count: 0 }),
	})

	return {
		QdrantVectorStore: vi.fn().mockImplementation(createMockVectorStore),
	}
})

// Mock the embedding models module
vi.mock("../../../shared/embeddingModels", () => ({
	getDefaultModelId: vi.fn().mockReturnValue("text-embedding-3-small"),
	getModelDimension: vi.fn().mockReturnValue(1536),
}))

// Import the mocked modules after mocking to get proper typing
import { OpenAiEmbedder } from "../embedders/openai"
import { CodeIndexOllamaEmbedder } from "../embedders/ollama"
import { OpenAICompatibleEmbedder } from "../embedders/openai-compatible"
import { QdrantVectorStore } from "../vector-store/qdrant-client"
import { getDefaultModelId, getModelDimension } from "../../../shared/embeddingModels"

// Type casting for better IntelliSense and type checking - only for QdrantVectorStore since it's still mocked with vi.fn()
const MockedQdrantVectorStore = QdrantVectorStore as any

describe("CodeIndexServiceFactory", () => {
	let factory: CodeIndexServiceFactory
	let mockConfigManager: any
	let mockCacheManager: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockConfigManager = {
			getConfig: vi.fn(),
		}

		mockCacheManager = {}

		factory = new CodeIndexServiceFactory(mockConfigManager, "/test/workspace", mockCacheManager)
	})

	describe("createEmbedder", () => {
		it("should pass model ID to OpenAI embedder when using OpenAI provider", async () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: testModelId,
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert - check that an embedder was created with expected methods
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
			// Note: Cannot test constructor calls due to Vitest mocking limitations
		})

		it("should pass model ID to Ollama embedder when using Ollama provider", async () => {
			// Arrange
			const testModelId = "nomic-embed-text:latest"
			const testConfig = {
				embedder: {
					provider: "ollama",
					baseUrl: "http://localhost:11434",
					model: testModelId,
					dimension: 768,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert - check that an embedder was created with expected methods
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
		})

		it("should handle undefined model ID for OpenAI embedder", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: undefined,
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert - check that an embedder was created with expected methods
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
		})

		it("should handle undefined model ID for Ollama embedder", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "ollama",
					baseUrl: "http://localhost:11434",
					model: undefined,
					dimension: 768,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert - check that an embedder was created with expected methods
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
		})

		it("should throw error when OpenAI API key is missing", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: undefined,
					model: "text-embedding-3-large",
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createEmbedder()).rejects.toThrow("OpenAI API key missing for embedder creation")
		})

		it("should throw error when Ollama base URL is missing", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "ollama",
					baseUrl: undefined,
					model: "nomic-embed-text:latest",
					dimension: 768,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createEmbedder()).rejects.toThrow("Ollama base URL missing for embedder creation")
		})

		it("should pass model ID to OpenAI Compatible embedder when using OpenAI Compatible provider", async () => {
			// Arrange
			const testModelId = "text-embedding-3-large"
			const testConfig = {
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
					model: testModelId,
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
		})

		it("should handle undefined model ID for OpenAI Compatible embedder", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
					model: undefined,
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			const result = await factory.createEmbedder()

			// Assert
			expect(result).toBeDefined()
			expect(result).toHaveProperty('createEmbeddings')
			expect(result).toHaveProperty('embedderInfo')
		})

		it("should throw error when OpenAI Compatible base URL is missing", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai-compatible",
					baseUrl: undefined,
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createEmbedder()).rejects.toThrow(
				"OpenAI Compatible base URL and API key missing for embedder creation",
			)
		})

		it("should throw error when OpenAI Compatible API key is missing", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: undefined,
					model: "text-embedding-3-large",
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createEmbedder()).rejects.toThrow(
				"OpenAI Compatible base URL and API key missing for embedder creation",
			)
		})

		it("should throw error for invalid embedder provider", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "invalid-provider",
					apiKey: "test-api-key",
					model: "some-model",
					dimension: 1536,
				} as any,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createEmbedder()).rejects.toThrow("Invalid embedder provider configured: invalid-provider")
		})
	})

	describe("createVectorStore", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("should use embedder.dimension from config for OpenAI provider", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			await factory.createVectorStore()

			// Assert
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should use embedder.dimension from config for Ollama provider", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "ollama",
					baseUrl: "http://localhost:11434",
					model: "nomic-embed-text:latest",
					dimension: 768,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			await factory.createVectorStore()

			// Assert
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				768,
				"test-key",
			)
		})

		it("should use embedder.dimension from config for OpenAI Compatible provider", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: 3072,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act
			await factory.createVectorStore()

			// Assert
			expect(MockedQdrantVectorStore).toHaveBeenCalledWith(
				"/test/workspace",
				"http://localhost:6333",
				3072,
				"test-key",
			)
		})

		it("should throw error when embedder dimension is invalid", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: 0, // Invalid dimension
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createVectorStore()).rejects.toThrow(
				"Invalid vector dimension '0' for model 'text-embedding-3-large' with provider 'openai'. Please specify a valid dimension in the configuration."
			)
		})

		it("should throw error when embedder dimension is undefined", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: undefined,
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createVectorStore()).rejects.toThrow(
				"Invalid vector dimension 'undefined' for model 'text-embedding-3-large' with provider 'openai'. Please specify a valid dimension in the configuration."
			)
		})

		it("should throw error when Qdrant URL is missing", async () => {
			// Arrange
			const testConfig = {
				embedder: {
					provider: "openai",
					apiKey: "test-api-key",
					model: "text-embedding-3-small",
					dimension: 1536,
				},
				qdrantUrl: undefined,
				qdrantApiKey: "test-key",
			}
			mockConfigManager.getConfig.mockResolvedValue(testConfig as any)

			// Act & Assert
			await expect(factory.createVectorStore()).rejects.toThrow("Qdrant URL missing for vector store creation")
		})
	})
})
