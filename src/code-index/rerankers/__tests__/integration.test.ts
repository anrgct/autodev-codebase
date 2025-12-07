/**
 * Integration tests for LLM Reranker functionality
 * Tests the integration between config manager, service factory, and search service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CodeIndexServiceFactory } from '../../service-factory'
import { CodeIndexConfigManager } from '../../config-manager'
import { CodeIndexStateManager } from '../../state-manager'
import { CodeIndexSearchService } from '../../search-service'
import { OllamaLLMReranker } from '../ollama-llm'
import type { IEmbedder, IVectorStore, IEventBus } from '../../interfaces'
import type { ICodeIndexConfigProvider } from '../../config-manager'

// Mock dependencies
const mockEmbedder: IEmbedder = {
  createEmbeddings: vi.fn(),
  validateConfiguration: vi.fn()
}

const mockVectorStore: IVectorStore = {
  initialize: vi.fn(),
  search: vi.fn(),
  hasIndexedData: vi.fn(),
  getAllFilePaths: vi.fn(),
  deletePointsByMultipleFilePaths: vi.fn()
}

const mockEventBus: IEventBus = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn()
}

const mockConfigProvider: ICodeIndexConfigProvider = {
  getConfig: vi.fn(),
  getStorage: vi.fn()
}

describe('LLM Reranker Integration Tests', () => {
  let configManager: CodeIndexConfigManager
  let serviceFactory: CodeIndexServiceFactory
  let stateManager: CodeIndexStateManager
  let cacheManager: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock cache manager
    cacheManager = {
      initialize: vi.fn(),
      clearCacheFile: vi.fn(),
      deleteHashes: vi.fn()
    }

    // Setup default config
    mockConfigProvider.getConfig = vi.fn().mockReturnValue({
      embedderProvider: 'openai',
      modelId: 'text-embedding-ada-002',
      qdrantUrl: 'http://localhost:6333',
      qdrantApiKey: undefined,
      codeIndexingEnabled: true,
      rerankerConfig: {
        enabled: false,
        provider: 'none' as const
      }
    })

    configManager = new CodeIndexConfigManager(mockConfigProvider)
    serviceFactory = new CodeIndexServiceFactory(
      configManager,
      '/test/workspace',
      cacheManager
    )
    stateManager = new CodeIndexStateManager(mockEventBus)
  })

  describe('Reranker Configuration', () => {
    it('should return undefined reranker when disabled in config', () => {
      const reranker = serviceFactory.createReranker()
      expect(reranker).toBeUndefined()
    })

    it('should create search service without reranker when disabled', () => {
      const searchService = new CodeIndexSearchService(
        configManager,
        stateManager,
        mockEmbedder,
        mockVectorStore,
        undefined // No reranker
      )

      expect(searchService).toBeDefined()
    })

    it('should create search service with reranker when enabled', () => {
      const reranker = new OllamaLLMReranker()
      const searchService = new CodeIndexSearchService(
        configManager,
        stateManager,
        mockEmbedder,
        mockVectorStore,
        reranker
      )

      expect(searchService).toBeDefined()
    })
  })

  describe('Service Factory createReranker', () => {
    it('should create OllamaLLMReranker with default config', () => {
      // Create a config manager with mocked reranker config
      const mockConfigManager = {
        rerankerConfig: {
          enabled: true,
          provider: 'ollama-llm' as const,
          ollamaBaseUrl: 'http://localhost:11434',
          ollamaModelId: 'gemma2:9b'
        }
      }

      const factory = new CodeIndexServiceFactory(
        mockConfigManager as any,
        '/test/workspace',
        cacheManager
      )

      const reranker = factory.createReranker()
      expect(reranker).toBeInstanceOf(OllamaLLMReranker)
    })

    it('should return undefined when reranker disabled', () => {
      const mockConfigManager = {
        rerankerConfig: {
          enabled: false,
          provider: 'none' as const
        }
      }

      const factory = new CodeIndexServiceFactory(
        mockConfigManager as any,
        '/test/workspace',
        cacheManager
      )

      const reranker = factory.createReranker()
      expect(reranker).toBeUndefined()
    })

    it('should return undefined when reranker config is undefined', () => {
      const mockConfigManager = {
        rerankerConfig: undefined
      }

      const factory = new CodeIndexServiceFactory(
        mockConfigManager as any,
        '/test/workspace',
        cacheManager
      )

      const reranker = factory.createReranker()
      expect(reranker).toBeUndefined()
    })
  })
})