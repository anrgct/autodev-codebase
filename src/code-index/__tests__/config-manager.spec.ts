import { vitest, describe, it, expect, beforeEach } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"
import { IConfigProvider, CodeIndexConfig } from "../../../abstractions/config"

describe("CodeIndexConfigManager", () => {
	let mockConfigProvider: any
	let configManager: CodeIndexConfigManager

	beforeEach(() => {
		// Setup mock IConfigProvider with all required methods
		mockConfigProvider = {
			getConfig: vitest.fn(),
			getEmbedderConfig: vitest.fn(),
			getVectorStoreConfig: vitest.fn(),
			isCodeIndexEnabled: vitest.fn(),
			getSearchConfig: vitest.fn(),
			onConfigChange: vitest.fn().mockReturnValue(() => {}),
		}

		configManager = new CodeIndexConfigManager(mockConfigProvider)
	})

	describe("constructor", () => {
		it("should initialize with ConfigProvider", () => {
			expect(configManager).toBeDefined()
			expect(configManager.isFeatureEnabled).toBe(false)
			expect(configManager.currentEmbedderProvider).toBe("openai")
		})
	})

	describe("loadConfiguration", () => {
		it("should load default configuration when no state exists", async () => {
			const defaultConfig: CodeIndexConfig = {
				isEnabled: false,
				isConfigured: false,
				embedder: {
					provider: "openai",
					apiKey: "",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(defaultConfig)

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toEqual({
				isEnabled: false,
				isConfigured: false,
				embedderProvider: "openai",
				modelId: "text-embedding-3-small",
				openAiOptions: { openAiNativeApiKey: "", apiKey: "" },
				ollamaOptions: undefined,
				openAiCompatibleOptions: undefined,
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			})
			expect(result.requiresRestart).toBe(false)
		})

		it("should load configuration from provider", async () => {
			const enabledConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-openai-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(enabledConfig)

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toEqual({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "openai",
				modelId: "text-embedding-3-large",
				openAiOptions: { openAiNativeApiKey: "test-openai-key", apiKey: "test-openai-key" },
				ollamaOptions: undefined,
				openAiCompatibleOptions: undefined,
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			})
		})

		it("should load Ollama configuration", async () => {
			const ollamaConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "ollama",
					baseUrl: "http://ollama.local",
					model: "nomic-embed-text",
					dimension: 768
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(ollamaConfig)

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toEqual({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "ollama",
				modelId: "nomic-embed-text",
				openAiOptions: undefined,
				ollamaOptions: { ollamaBaseUrl: "http://ollama.local" },
				openAiCompatibleOptions: undefined,
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			})
		})

		it("should load OpenAI Compatible configuration", async () => {
			const openAiCompatibleConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-openai-compatible-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(openAiCompatibleConfig)

			const result = await configManager.loadConfiguration()

			expect(result.currentConfig).toEqual({
				isEnabled: true,
				isConfigured: true,
				embedderProvider: "openai-compatible",
				modelId: "text-embedding-3-large",
				openAiOptions: undefined,
				ollamaOptions: undefined,
				openAiCompatibleOptions: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-openai-compatible-key",
					modelDimension: 3072,
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			})
		})

		it("should detect restart requirement when provider changes", async () => {
			// Initial state
			const initialConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(initialConfig)
			await configManager.loadConfiguration()

			// Change provider
			const changedConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "ollama",
					baseUrl: "http://ollama.local",
					model: "nomic-embed-text",
					dimension: 768
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(changedConfig)

			const result = await configManager.loadConfiguration()
			expect(result.requiresRestart).toBe(true)
		})

		it("should detect restart requirement when vector dimensions change", async () => {
			// Initial state with text-embedding-3-small (1536D)
			const initialConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(initialConfig)
			await configManager.loadConfiguration()

			// Change to text-embedding-3-large (3072D)
			const changedConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(changedConfig)

			const result = await configManager.loadConfiguration()
			expect(result.requiresRestart).toBe(true)
		})

		it("should NOT require restart when models have same dimensions", async () => {
			// Initial state with text-embedding-3-small (1536D)
			const initialConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(initialConfig)
			await configManager.loadConfiguration()

			// Change to text-embedding-ada-002 (also 1536D)
			const changedConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-ada-002",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(changedConfig)

			const result = await configManager.loadConfiguration()
			expect(result.requiresRestart).toBe(false)
		})

		it("should detect restart requirement when transitioning to enabled+configured", async () => {
			// Initial state - disabled
			const disabledConfig: CodeIndexConfig = {
				isEnabled: false,
				isConfigured: false,
				embedder: {
					provider: "openai",
					apiKey: "",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(disabledConfig)
			await configManager.loadConfiguration()

			// Enable and configure
			const enabledConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(enabledConfig)

			const result = await configManager.loadConfiguration()
			expect(result.requiresRestart).toBe(true)
		})

		it("should not require restart when configuration hasn't changed between calls", async () => {
			// Setup initial configuration
			const config: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(config)

			// First load - this will initialize the config manager with current state
			await configManager.loadConfiguration()

			// Second load with same configuration - should not require restart
			const secondResult = await configManager.loadConfiguration()
			expect(secondResult.requiresRestart).toBe(false)
		})
	})

	describe("isConfigured", () => {
		it("should validate OpenAI configuration correctly", async () => {
			const openaiConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(openaiConfig)
			await configManager.loadConfiguration()

			expect(configManager.isFeatureConfigured).toBe(true)
		})

		it("should validate Ollama configuration correctly", async () => {
			const ollamaConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "ollama",
					baseUrl: "http://ollama.local",
					model: "nomic-embed-text",
					dimension: 768
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(ollamaConfig)
			await configManager.loadConfiguration()

			expect(configManager.isFeatureConfigured).toBe(true)
		})

		it("should validate OpenAI Compatible configuration correctly", async () => {
			const openAiCompatibleConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai-compatible",
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-api-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(openAiCompatibleConfig)
			await configManager.loadConfiguration()

			expect(configManager.isFeatureConfigured).toBe(true)
		})

		it("should return false when required values are missing", async () => {
			const unconfiguredConfig: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: false,
				embedder: {
					provider: "openai",
					apiKey: "",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(unconfiguredConfig)
			await configManager.loadConfiguration()

			expect(configManager.isFeatureConfigured).toBe(false)
		})
	})

	describe("getter properties", () => {
		beforeEach(async () => {
			const config: CodeIndexConfig = {
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-openai-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(config)
			await configManager.loadConfiguration()
		})

		it("should return correct configuration via getConfig", async () => {
			const config = await configManager.getConfig()
			expect(config).toEqual({
				isEnabled: true,
				isConfigured: true,
				embedder: {
					provider: "openai",
					apiKey: "test-openai-key",
					model: "text-embedding-3-large",
					dimension: 3072
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "test-qdrant-key",
				searchMinScore: 0.4,
			})
		})

		it("should return correct feature enabled state", () => {
			expect(configManager.isFeatureEnabled).toBe(true)
		})

		it("should return correct embedder provider", () => {
			expect(configManager.currentEmbedderProvider).toBe("openai")
		})

		it("should return correct Qdrant configuration", () => {
			expect(configManager.qdrantConfig).toEqual({
				url: "http://qdrant.local",
				apiKey: "test-qdrant-key",
			})
		})

		it("should return correct model ID", () => {
			expect(configManager.currentModelId).toBe("text-embedding-3-large")
		})
	})

	describe("initialization and restart prevention", () => {
		it("should properly initialize with current config to prevent false restarts", async () => {
			// Setup configuration
			const config: CodeIndexConfig = {
				isEnabled: false,
				isConfigured: false,
				embedder: {
					provider: "openai",
					apiKey: "test-key",
					model: "text-embedding-3-small",
					dimension: 1536
				},
				qdrantUrl: "http://qdrant.local",
				qdrantApiKey: "",
				searchMinScore: 0.4,
			}

			mockConfigProvider.getConfig.mockResolvedValue(config)

			// Create a new config manager (simulating what happens in CodeIndexManager.initialize)
			const newConfigManager = new CodeIndexConfigManager(mockConfigProvider)

			// Load configuration - should not require restart since the manager should be initialized with current config
			const result = await newConfigManager.loadConfiguration()
			expect(result.requiresRestart).toBe(false)
		})
	})
})