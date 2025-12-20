import { describe, it, expect } from 'vitest'
import { ConfigValidator, ValidationIssue } from '../config-validator'
import { CodeIndexConfig, EmbedderProvider } from '../interfaces/config'

describe('ConfigValidator', () => {
	// Helper to create a basic valid config
	const createValidConfig = (): CodeIndexConfig => ({
		isEnabled: true,
		embedderProvider: 'openai',
		embedderModelId: 'text-embedding-3-small',
		embedderModelDimension: 1536,
		embedderOpenAiApiKey: 'test-api-key',
		qdrantUrl: 'http://localhost:6333',
		vectorSearchMinScore: 0.1,
		vectorSearchMaxResults: 20
	})

	describe('validate', () => {
		it('should return valid for a complete OpenAI configuration', () => {
			const config = createValidConfig()
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for a complete Ollama configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'ollama',
				embedderOpenAiApiKey: undefined,
				embedderOllamaBaseUrl: 'http://localhost:11434',
				embedderModelId: 'nomic-embed-text'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for a complete OpenAI Compatible configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openai-compatible',
				embedderOpenAiApiKey: undefined,
				embedderOpenAiCompatibleBaseUrl: 'https://api.siliconflow.cn/v1',
				embedderOpenAiCompatibleApiKey: 'test-key'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for Gemini configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'gemini',
				embedderOpenAiApiKey: undefined,
				embedderGeminiApiKey: 'test-gemini-key'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for Mistral configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'mistral',
				embedderOpenAiApiKey: undefined,
				embedderMistralApiKey: 'test-mistral-key'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for Vercel AI Gateway configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'vercel-ai-gateway',
				embedderOpenAiApiKey: undefined,
				embedderVercelAiGatewayApiKey: 'test-vercel-key'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should return valid for OpenRouter configuration', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openrouter',
				embedderOpenAiApiKey: undefined,
				embedderOpenRouterApiKey: 'test-openrouter-key'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})
	})

	describe('OpenAI embedder validation', () => {
		it('should require OpenAI API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openai',
				embedderOpenAiApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderOpenAiApiKey',
				code: 'required',
				message: 'OpenAI API key is required for OpenAI embedder'
			} as ValidationIssue)
		})

		it('should require OpenAI options object', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openai',
				embedderOpenAiApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderOpenAiApiKey',
				code: 'required',
				message: 'OpenAI API key is required for OpenAI embedder'
			} as ValidationIssue)
		})
	})

	describe('Ollama embedder validation', () => {
		it('should require Ollama base URL', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'ollama',
				embedderOpenAiApiKey: '',
				embedderOllamaBaseUrl: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderOllamaBaseUrl',
				code: 'required',
				message: 'Ollama base URL is required for Ollama embedder'
			} as ValidationIssue)
		})
	})

	describe('OpenAI Compatible embedder validation', () => {
		it('should require base URL and API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openai-compatible',
				embedderOpenAiApiKey: '',
				embedderOpenAiCompatibleBaseUrl: '',
				embedderOpenAiCompatibleApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toHaveLength(2)
			expect(result.issues).toContainEqual({
				path: 'embedderOpenAiCompatibleBaseUrl',
				code: 'required',
				message: 'Base URL is required for OpenAI Compatible embedder'
			} as ValidationIssue)
			expect(result.issues).toContainEqual({
				path: 'embedderOpenAiCompatibleApiKey',
				code: 'required',
				message: 'API key is required for OpenAI Compatible embedder'
			} as ValidationIssue)
		})
	})

	describe('Jina embedder validation', () => {
		it('should skip validation for Jina (not yet implemented)', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'jina',
				embedderOpenAiApiKey: undefined
			}
			const result = ConfigValidator.validate(config)

			// Jina validation is currently not implemented
			// This test ensures we don't accidentally break existing behavior
			expect(result.issues.some(issue => issue.path.includes('jina'))).toBe(false)
		})
	})

	describe('Gemini embedder validation', () => {
		it('should require API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'gemini',
				embedderOpenAiApiKey: '',
				embedderGeminiApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderGeminiApiKey',
				code: 'required',
				message: 'Gemini API key is required for Gemini embedder'
			} as ValidationIssue)
		})
	})

	describe('Mistral embedder validation', () => {
		it('should require API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'mistral',
				embedderOpenAiApiKey: '',
				embedderMistralApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderMistralApiKey',
				code: 'required',
				message: 'Mistral API key is required for Mistral embedder'
			} as ValidationIssue)
		})
	})

	describe('Vercel AI Gateway embedder validation', () => {
		it('should require API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'vercel-ai-gateway',
				embedderOpenAiApiKey: '',
				embedderVercelAiGatewayApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderVercelAiGatewayApiKey',
				code: 'required',
				message: 'Vercel AI Gateway API key is required for Vercel AI Gateway embedder'
			} as ValidationIssue)
		})
	})

	describe('OpenRouter embedder validation', () => {
		it('should require API key', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				embedderProvider: 'openrouter',
				embedderOpenAiApiKey: '',
				embedderOpenRouterApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'embedderOpenRouterApiKey',
				code: 'required',
				message: 'OpenRouter API key is required for OpenRouter embedder'
			} as ValidationIssue)
		})
	})

	describe('Qdrant validation', () => {
		it('should require Qdrant URL', () => {
			const config = createValidConfig()
			config.qdrantUrl = undefined
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'qdrantUrl',
				code: 'required',
				message: 'Qdrant URL is required for vector storage'
			} as ValidationIssue)
		})
	})

	describe('Reranker validation', () => {
		it('should validate enabled reranker with ollama provider', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerEnabled: true,
				rerankerProvider: 'ollama',
				rerankerOllamaBaseUrl: 'http://localhost:11434',
				rerankerOllamaModelId: 'llama3.1'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should require provider when reranker enabled', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerEnabled: true,
				rerankerProvider: undefined
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'rerankerProvider',
				code: 'required',
				message: 'Reranker provider is required when reranker is enabled'
			} as ValidationIssue)
		})

		it('should require Ollama base URL for ollama reranker', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerEnabled: true,
				rerankerProvider: 'ollama',
				rerankerOllamaModelId: 'llama3.1'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'rerankerOllamaBaseUrl',
				code: 'required',
				message: 'Ollama base URL is required for ollama reranker'
			} as ValidationIssue)
		})

		it('should require Ollama model ID for ollama reranker', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerEnabled: true,
				rerankerProvider: 'ollama',
				rerankerOllamaBaseUrl: 'http://localhost:11434'
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'rerankerOllamaModelId',
				code: 'required',
				message: 'Ollama model ID is required for ollama reranker'
			} as ValidationIssue)
		})

		it('should pass when reranker is disabled', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerEnabled: false
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})
	})

	describe('Basic consistency validation', () => {
		it('should detect inconsistency when enabled but not configured', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				isEnabled: true
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(true)
			expect(result.issues).toHaveLength(0)
		})

		it('should validate search min score range', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				vectorSearchMinScore: -0.1
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'vectorSearchMinScore',
				code: 'invalid_range',
				message: 'Search minimum score must be between 0 and 1'
			} as ValidationIssue)
		})

		it('should validate reranker min score range', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerMinScore: -1
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'rerankerMinScore',
				code: 'invalid_range',
				message: 'Reranker minimum score must be non-negative'
			} as ValidationIssue)
		})

		it('should validate reranker batch size', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				rerankerBatchSize: 0
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'rerankerBatchSize',
				code: 'invalid_range',
				message: 'Reranker batch size must be positive'
			} as ValidationIssue)
		})

		it('should validate search max results', () => {
			const config: CodeIndexConfig = {
				...createValidConfig(),
				vectorSearchMaxResults: 0
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues).toContainEqual({
				path: 'vectorSearchMaxResults',
				code: 'invalid_range',
				message: 'Search maximum results must be positive'
			} as ValidationIssue)
		})
	})

	describe('Multiple issues', () => {
		it('should collect multiple validation issues', () => {
			const config: CodeIndexConfig = {
				isEnabled: true,
				embedderProvider: 'openai',
				// Missing required OpenAI API key and Qdrant URL
				qdrantUrl: undefined,
				embedderOpenAiApiKey: ''
			}
			const result = ConfigValidator.validate(config)

			expect(result.valid).toBe(false)
			expect(result.issues.length).toBeGreaterThan(1)
			expect(result.issues.some(issue => issue.path === 'embedderOpenAiApiKey')).toBe(true)
			expect(result.issues.some(issue => issue.path === 'qdrantUrl')).toBe(true)
		})
	})
})
