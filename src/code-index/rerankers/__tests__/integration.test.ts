/**
 * Integration tests for LLM Reranker functionality
 * Tests the integration between config manager, service factory, and search service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CodeIndexServiceFactory } from '../../service-factory'
import { CodeIndexConfigManager } from '../../config-manager'
import { CodeIndexStateManager } from '../../state-manager'
import { CodeIndexSearchService } from '../../search-service'
import { OllamaLLMReranker } from '../ollama'
import type { IEmbedder, IVectorStore } from '../../interfaces'
import type { IConfigProvider } from '../../../abstractions/config'
import type { IEventBus } from '../../../abstractions/core'
import type { CodeIndexConfig } from '../../interfaces/config'

// Mock dependencies
const mockEmbedder: IEmbedder = {
  createEmbeddings: vi.fn(),
  validateConfiguration: vi.fn(),
  embedderInfo: { name: 'openai' as const },
  optimalBatchSize: 60
}

const mockVectorStore: IVectorStore = {
  initialize: vi.fn(),
  search: vi.fn(),
  hasIndexedData: vi.fn(),
  getAllFilePaths: vi.fn(),
  deletePointsByMultipleFilePaths: vi.fn(),
  upsertPoints: vi.fn(),
  deletePointsByFilePath: vi.fn(),
  clearCollection: vi.fn(),
  deleteCollection: vi.fn(),
  collectionExists: vi.fn(),
  markIndexingComplete: vi.fn(),
  markIndexingIncomplete: vi.fn()
}

const mockEventBus: IEventBus = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  once: vi.fn()
}

const mockConfigProvider: IConfigProvider = {
  getConfig: vi.fn().mockResolvedValue({
    isEnabled: true,
    isConfigured: true,
    embedderProvider: 'openai',
    modelId: 'text-embedding-ada-002',
    modelDimension: 1536,
    qdrantUrl: 'http://localhost:6333',
    rerankerEnabled: false
  } as CodeIndexConfig),
  onConfigChange: vi.fn().mockReturnValue(() => {})
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
          provider: 'ollama' as const,
          ollamaBaseUrl: 'http://localhost:11434',
          ollamaModelId: 'qwen3-vl:4b-instruct'
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

    it('should create OllamaLLMReranker with concurrency parameters', () => {
      const mockConfigManager = {
        rerankerConfig: {
          enabled: true,
          provider: 'ollama' as const,
          ollamaBaseUrl: 'http://localhost:11434',
          ollamaModelId: 'qwen3-vl:4b-instruct',
          batchSize: 15,
          concurrency: 5,
          maxRetries: 5,
          retryDelayMs: 2000
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

    describe('createReranker', () => {
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

      it('should return undefined when reranker enabled but no provider specified', () => {
        const mockConfigManager = {
          rerankerConfig: {
            enabled: true,
            provider: undefined
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
    })
  })
})
