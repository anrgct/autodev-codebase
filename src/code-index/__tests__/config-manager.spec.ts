import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"
import { DEFAULT_SEARCH_MIN_SCORE, DEFAULT_MAX_SEARCH_RESULTS } from "../constants"
import type { IConfigProvider, CodeIndexConfig } from "../../../src/abstractions/config"

describe("CodeIndexConfigManager", () => {
	let mockConfigProvider: IConfigProvider & { getConfig: ReturnType<typeof vi.fn>, onConfigChange: ReturnType<typeof vi.fn> }
	let configManager: CodeIndexConfigManager
	let currentConfig: CodeIndexConfig

	const setGlobalConfig = (config: Partial<CodeIndexConfig>) => {
		currentConfig = {
			isEnabled: true,
			embedderProvider: "openai",
			...config,
		}
	}

	const setSecrets = (secrets: Record<string, string>) => {
		// Update secrets in the current config
		if (secrets['codeIndexOpenAiKey'] !== undefined) {
			currentConfig.embedderOpenAiApiKey = secrets['codeIndexOpenAiKey']
		}
		if (secrets['codeIndexQdrantApiKey'] !== undefined) {
			currentConfig.qdrantApiKey = secrets['codeIndexQdrantApiKey']
		}
		if (secrets['codebaseIndexOpenAiCompatibleApiKey'] !== undefined) {
			if (currentConfig.embedderProvider === "openai-compatible") {
				currentConfig.embedderOpenAiCompatibleApiKey = secrets['codebaseIndexOpenAiCompatibleApiKey']
			}
		}
		if (secrets['codebaseIndexGeminiApiKey'] !== undefined) {
			if (currentConfig.embedderProvider === "gemini") {
				currentConfig.embedderGeminiApiKey = secrets['codebaseIndexGeminiApiKey']
			}
		}
		if (secrets['codebaseIndexMistralApiKey'] !== undefined) {
			if (currentConfig.embedderProvider === "mistral") {
				currentConfig.embedderMistralApiKey = secrets['codebaseIndexMistralApiKey']
			}
		}
		if (secrets['codebaseIndexVercelAiGatewayApiKey'] !== undefined) {
			if (currentConfig.embedderProvider === "vercel-ai-gateway") {
				currentConfig.embedderVercelAiGatewayApiKey = secrets['codebaseIndexVercelAiGatewayApiKey']
			}
		}
		if (secrets['codebaseIndexOpenRouterApiKey'] !== undefined) {
			if (currentConfig.embedderProvider === "openrouter") {
				currentConfig.embedderOpenRouterApiKey = secrets['codebaseIndexOpenRouterApiKey']
			}
		}
	}

	beforeEach(() => {
		// Mock IConfigProvider with the new interface
		mockConfigProvider = {
			getConfig: vi.fn().mockImplementation(() => Promise.resolve(currentConfig)),
			onConfigChange: vi.fn().mockReturnValue(() => {}),
		}

		// Default configuration mirrors the extension's defaults
		setGlobalConfig({
			isEnabled: true,
			qdrantUrl: "http://localhost:6333",
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
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				vectorSearchMinScore: 0.4,
				vectorSearchMaxResults: 25,
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
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
				embedderOpenAiApiKey: "test-openai-key",
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
			})

			// Search configuration should be surfaced through helpers
			expect(result.currentConfig.vectorSearchMinScore).toBe(0.4)
			expect(result.currentConfig.vectorSearchMaxResults).toBe(25)
		})

		it("should load Ollama configuration", async () => {
			setGlobalConfig({
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "ollama",
				embedderModelId: "nomic-embed-text",
				embedderOllamaBaseUrl: "http://ollama.local",
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
				embedderProvider: "ollama",
				embedderModelId: "nomic-embed-text",
				embedderOpenAiApiKey: "",
				embedderOllamaBaseUrl: "http://ollama.local",
				qdrantUrl: "http://qdrant.local",
			})
		})

		it("should load OpenAI Compatible configuration", async () => {
			setGlobalConfig({
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "openai-compatible",
				embedderModelId: "text-embedding-3-large",
				embedderModelDimension: 1024,
				embedderOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				embedderOpenAiCompatibleApiKey: "", // Will be set by secrets
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
				embedderProvider: "openai-compatible",
				embedderModelId: "text-embedding-3-large",
				embedderModelDimension: 1024,
				embedderOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				embedderOpenAiCompatibleApiKey: "test-openai-compatible-key",
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
			})
		})

		it("should detect restart requirement when critical settings change", async () => {
			// Initial configuration: OpenAI provider
			setGlobalConfig({
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
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
				isEnabled: true,
				qdrantUrl: "http://qdrant.other",
				embedderProvider: "ollama",
				embedderModelId: "nomic-embed-text",
				embedderOllamaBaseUrl: "http://ollama.local",
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
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-small",
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
				isEnabled: true,
				qdrantUrl: "",
				embedderProvider: "openai",
				embedderModelId: "",
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
				isEnabled: true,
				qdrantUrl: "http://qdrant.local",
				embedderProvider: "openai",
				embedderModelId: "text-embedding-3-large",
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
			expect(config.embedderModelId).toBe("text-embedding-3-large")
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
