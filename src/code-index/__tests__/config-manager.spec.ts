import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"
import { DEFAULT_SEARCH_MIN_SCORE, DEFAULT_MAX_SEARCH_RESULTS } from "../constants"

describe("CodeIndexConfigManager", () => {
	let mockConfigProvider: any
	let configManager: CodeIndexConfigManager

	const setGlobalConfig = (config: any) => {
		mockConfigProvider.getGlobalState.mockImplementation((key: string) => {
			if (key === "codebaseIndexConfig") {
				return config
			}
			return undefined
		})
	}

	const setSecrets = (secrets: Record<string, string>) => {
		mockConfigProvider.getSecret.mockImplementation((key: string) => {
			return Promise.resolve(secrets[key] ?? "")
		})
	}

	beforeEach(() => {
		// Minimal mock compatible with CodeIndexConfigManager
		mockConfigProvider = {
			getGlobalState: vi.fn(),
			getSecret: vi.fn(),
			refreshSecrets: vi.fn().mockResolvedValue(undefined),
		}

		// Default configuration mirrors the extension's defaults
		setGlobalConfig({
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai",
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMinScore: undefined,
			codebaseIndexSearchMaxResults: undefined,
		})

		setSecrets({
			codeIndexOpenAiKey: "",
			codeIndexQdrantApiKey: "",
			codebaseIndexOpenAiCompatibleApiKey: "",
			codebaseIndexGeminiApiKey: "",
			codebaseIndexMistralApiKey: "",
			codebaseIndexVercelAiGatewayApiKey: "",
			codebaseIndexOpenRouterApiKey: "",
		})

		configManager = new CodeIndexConfigManager(mockConfigProvider)
	})

	describe("constructor", () => {
		it("should initialize with ConfigProvider", () => {
			expect(configManager).toBeDefined()
			// Default mock enables the feature
			expect(configManager.isFeatureEnabled).toBe(true)
			expect(configManager.currentEmbedderProvider).toBe("openai")
		})
	})

	describe("loadConfiguration", () => {
		it("should load OpenAI configuration from global state and secrets", async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "text-embedding-3-small",
				codebaseIndexSearchMinScore: 0.4,
				codebaseIndexSearchMaxResults: 25,
			})

			setSecrets({
				codeIndexOpenAiKey: "test-openai-key",
				codeIndexQdrantApiKey: "test-qdrant-key",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toMatchObject({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "openai",
				modelId: "text-embedding-3-small",
				openAiOptions: { openAiNativeApiKey: "test-openai-key" },
				ollamaOptions: undefined,
				openAiCompatibleOptions: undefined,
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
			})

			// Search configuration should be surfaced through helpers
			expect(result.currentConfig.searchMinScore).toBe(0.4)
			expect(result.currentConfig.searchMaxResults).toBe(25)
		})

		it("should load Ollama configuration", async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "ollama",
				codebaseIndexEmbedderBaseUrl: "http://ollama.local",
				codebaseIndexEmbedderModelId: "nomic-embed-text",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toMatchObject({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "ollama",
				modelId: "nomic-embed-text",
				openAiOptions: { openAiNativeApiKey: "" },
				ollamaOptions: { ollamaBaseUrl: "http://ollama.local" },
				qdrantUrl: "http://qdrant.local",
			})
		})

		it("should load OpenAI Compatible configuration", async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "openai-compatible",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "text-embedding-3-large",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
				codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				codebaseIndexEmbedderModelDimension: 1024,
			})

			setSecrets({
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "test-qdrant-key",
				codebaseIndexOpenAiCompatibleApiKey: "test-openai-compatible-key",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toMatchObject({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "openai-compatible",
				modelId: "text-embedding-3-large",
				modelDimension: 1024,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-openai-compatible-key",
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
			})
		})

		it("should detect restart requirement when critical settings change", async () => {
			// Initial configuration: OpenAI provider
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "text-embedding-3-small",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "openai-key-1",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			await configManager.loadConfiguration()

			// Change provider and credentials
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.other",
				codebaseIndexEmbedderProvider: "ollama",
				codebaseIndexEmbedderBaseUrl: "http://ollama.local",
				codebaseIndexEmbedderModelId: "nomic-embed-text",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "openai-key-2",
				codeIndexQdrantApiKey: "qdrant-key-2",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			const second = await configManager.loadConfiguration()
			expect(second.requiresRestart).toBe(true)
		})
	})

	describe("isConfigured", () => {
		it("should return true when OpenAI is fully configured", async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "text-embedding-3-small",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "openai-key",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			await configManager.loadConfiguration()
			expect(configManager.isFeatureConfigured).toBe(true)
		})

		it("should return false when required values are missing", async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "",
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			await configManager.loadConfiguration()
			expect(configManager.isFeatureConfigured).toBe(false)
		})
	})

	describe("getter properties", () => {
		beforeEach(async () => {
			setGlobalConfig({
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "http://qdrant.local",
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "text-embedding-3-large",
				codebaseIndexSearchMinScore: undefined,
				codebaseIndexSearchMaxResults: undefined,
			})

			setSecrets({
				codeIndexOpenAiKey: "openai-key",
				codeIndexQdrantApiKey: "qdrant-key",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
			})

			await configManager.loadConfiguration()
		})

		it("should return the current configuration", () => {
			const config = configManager.getConfig()

			expect(config.isEnabled).toBe(true)
			expect(config.embedderProvider).toBe("openai")
			expect(config.modelId).toBe("text-embedding-3-large")
			expect(config.qdrantUrl).toBe("http://qdrant.local")
			expect(config.qdrantApiKey).toBe("qdrant-key")
		})

		it("should expose feature flags and embedder info", () => {
			expect(configManager.isFeatureEnabled).toBe(true)
			expect(configManager.isFeatureConfigured).toBe(true)
			expect(configManager.currentEmbedderProvider).toBe("openai")
			expect(configManager.currentModelId).toBe("text-embedding-3-large")
		})

		it("should use sensible defaults for search config when not set", () => {
			// We didn't set explicit search scores in this setup – value should come
			// from model-specific threshold or the global default, but always be > 0.
			expect(configManager.currentSearchMinScore).toBeGreaterThan(0)
			expect(configManager.currentSearchMaxResults).toBe(DEFAULT_MAX_SEARCH_RESULTS)
		})
	})
})
