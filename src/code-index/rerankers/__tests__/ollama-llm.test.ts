/**
 * Unit tests for OllamaLLMReranker
 * Tests LLM-based reranking functionality using Ollama
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OllamaLLMReranker } from '../ollama-llm'
import type { RerankerCandidate } from '../../interfaces/reranker'

// Use vi.hoisted to ensure mocks are hoisted properly
const { mockFetch, mockProxyAgent } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockProxyAgent: vi.fn().mockImplementation(() => ({}))
}))

vi.mock('undici', () => ({
  fetch: mockFetch,
  ProxyAgent: mockProxyAgent
}))

describe('OllamaLLMReranker', () => {
  let reranker: OllamaLLMReranker
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    // Save original environment variables
    originalEnv = { ...process.env }
    // Clear all environment variables for clean testing
    process.env = {}
    // Clear all mocks
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original environment variables
    process.env = originalEnv
  })

  describe('Constructor', () => {
    it('should use default baseUrl, modelId, and batchSize when no parameters provided', () => {
      reranker = new OllamaLLMReranker()

      expect(reranker['baseUrl']).toBe('http://localhost:11434')
      expect(reranker['modelId']).toBe('qwen3-vl:4b-instruct')
      expect(reranker['batchSize']).toBe(10)
    })

    it('should use custom baseUrl, modelId, and batchSize when provided', () => {
      const customBaseUrl = 'https://custom-ollama.example.com:8080'
      const customModelId = 'custom-model:latest'
      const customBatchSize = 5

      reranker = new OllamaLLMReranker(customBaseUrl, customModelId, customBatchSize)

      expect(reranker['baseUrl']).toBe(customBaseUrl)
      expect(reranker['modelId']).toBe(customModelId)
      expect(reranker['batchSize']).toBe(customBatchSize)
    })

    it('should normalize baseUrl by removing trailing slashes', () => {
      const testCases = [
        { input: 'http://localhost:11434/', expected: 'http://localhost:11434' },
        { input: 'http://localhost:11434//', expected: 'http://localhost:11434' },
        { input: 'https://example.com:8080/', expected: 'https://example.com:8080' },
        { input: 'https://example.com:8080//', expected: 'https://example.com:8080' }
      ]

      testCases.forEach(({ input, expected }) => {
        reranker = new OllamaLLMReranker(input)
        expect(reranker['baseUrl']).toBe(expected)
      })
    })
  })

  describe('rerankerInfo property', () => {
    it('should return correct reranker info', () => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')

      const info = reranker.rerankerInfo

      expect(info.name).toBe('ollama-llm')
      expect(info.model).toBe('test-model')
    })
  })

  describe('rerank method', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should return empty array when candidates array is empty', async () => {
      const result = await reranker.rerank('test query', [])

      expect(result).toEqual([])
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should handle successful LLM reranking with JSON response', async () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test1() { return 1; }', score: 0.8 },
        { id: '2', content: 'function test2() { return 2; }', score: 0.6 },
        { id: '3', content: 'function test3() { return 3; }', score: 0.4 }
      ]

      // Mock successful fetch response with JSON scores
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          response: '{"scores": [8.5, 6.0, 9.2]}'
        })
      })

      const result = await reranker.rerank('test function', candidates)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: expect.stringContaining('test function')
        })
      )

      expect(result).toHaveLength(3)

      // Results should be sorted by score (descending)
      expect(result[0].id).toBe('3')
      expect(result[0].score).toBe(9.2)
      expect(result[1].id).toBe('1')
      expect(result[1].score).toBe(8.5)
      expect(result[2].id).toBe('2')
      expect(result[2].score).toBe(6.0)

      // Original scores should be preserved
      expect(result[0].originalScore).toBe(0.4)
      expect(result[1].originalScore).toBe(0.8)
      expect(result[2].originalScore).toBe(0.6)
    })

    it('should handle non-JSON response and throw error', async () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test1() { return 1; }' },
        { id: '2', content: 'function test2() { return 2; }' }
      ]

      // Mock fetch response with non-JSON text (should throw error in new implementation)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          response: 'Scores: 7.5 and 3.2'
        })
      })

      const result = await reranker.rerank('test function', candidates)

      // Should return fallback results due to error
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('1')
      expect(result[0].score).toBe(10) // Fallback score
      expect(result[1].id).toBe('2')
      expect(result[1].score).toBe(9.9) // Fallback score
    })

    it('should clamp scores to 0-10 range', async () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'test content 1' },
        { id: '2', content: 'test content 2' }
      ]

      // Mock response with scores outside 0-10 range
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          response: '{"scores": [-5, 15.5]}'
        })
      })

      const result = await reranker.rerank('test', candidates)

      // The scores should be clamped to [0, 10], and then sorted by score (descending)
      // -5 becomes 0, 15.5 becomes 10, so 10 should be first
      const clampedScores = result.map(r => r.score).sort((a, b) => b - a)
      expect(clampedScores).toEqual([10, 0]) // 15.5 clamped to 10, -5 clamped to 0
    })

    it('should handle fetch errors gracefully and return fallback results', async () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'test content 1', score: 0.8 },
        { id: '2', content: 'test content 2', score: 0.6 },
        { id: '3', content: 'test content 3', score: 0.4 }
      ]

      // Mock fetch error
      mockFetch.mockRejectedValue(new Error('Network error'))

      const result = await reranker.rerank('test', candidates)

      // Should return fallback results with slight decreasing scores
      expect(result).toHaveLength(3)
      expect(result[0].id).toBe('1')
      expect(result[0].score).toBe(10)
      expect(result[1].id).toBe('2')
      expect(result[1].score).toBe(9.9)
      expect(result[2].id).toBe('3')
      expect(result[2].score).toBe(9.8)
    })

    it('should handle invalid JSON response and return fallback results', async () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'test content 1' },
        { id: '2', content: 'test content 2' }
      ]

      // Mock response with invalid JSON
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          response: 'invalid json [abc, def]'
        })
      })

      const result = await reranker.rerank('test', candidates)

      // Should return fallback results due to JSON parsing error
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('1')
      expect(result[0].score).toBe(10) // Fallback score
      expect(result[1].id).toBe('2')
      expect(result[1].score).toBe(9.9) // Fallback score
    })
  })

  describe('Batch processing', () => {
    it('should process single batch when candidates <= batchSize', async () => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model', 5)

      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test1() { return 1; }', score: 0.8 },
        { id: '2', content: 'function test2() { return 2; }', score: 0.6 },
        { id: '3', content: 'function test3() { return 3; }', score: 0.4 }
      ]

      // Mock successful fetch response
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          response: '{"scores": [8.5, 6.0, 9.2]}'
        })
      })

      const result = await reranker.rerank('test function', candidates)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(result).toHaveLength(3)

      // Results should be sorted by score (descending)
      expect(result[0].id).toBe('3')
      expect(result[0].score).toBe(9.2)
    })

    it('should process multiple batches when candidates > batchSize', async () => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model', 3)

      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test1() { return 1; }', score: 0.8 },
        { id: '2', content: 'function test2() { return 2; }', score: 0.6 },
        { id: '3', content: 'function test3() { return 3; }', score: 0.4 },
        { id: '4', content: 'function test4() { return 4; }', score: 0.3 },
        { id: '5', content: 'function test5() { return 5; }', score: 0.2 }
      ]

      // Mock fetch responses for 2 batches: first 3 candidates, then 2 candidates
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [8.5, 6.0, 9.2]}'
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [7.0, 8.0]}'
          })
        })

      const result = await reranker.rerank('test function', candidates)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(5)

      // All results should be sorted by score (descending) across batches
      const scores = result.map(r => r.score)
      expect(scores).toEqual([9.2, 8.5, 8.0, 7.0, 6.0])

      // Verify ids match the scores
      expect(result[0].id).toBe('3') // score 9.2 from first batch
      expect(result[1].id).toBe('1') // score 8.5 from first batch
      expect(result[2].id).toBe('5') // score 8.0 from second batch
      expect(result[3].id).toBe('4') // score 7.0 from second batch
      expect(result[4].id).toBe('2') // score 6.0 from first batch
    })

    it('should handle batch failure gracefully with fallback', async () => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model', 2)

      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test1() { return 1; }', score: 0.8 },
        { id: '2', content: 'function test2() { return 2; }', score: 0.6 },
        { id: '3', content: 'function test3() { return 3; }', score: 0.4 },
        { id: '4', content: 'function test4() { return 4; }', score: 0.3 }
      ]

      // Mock first batch failure, second batch success
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [7.0, 8.0]}'
          })
        })

      const result = await reranker.rerank('test function', candidates)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(4)

      // First batch should have fallback scores (positions 0, 1): 10, 9.9
      // Second batch should have real scores (positions 2, 3): 8.0, 7.0
      const scores = result.map(r => r.score)
      const allScores = [10, 9.9, 8.0, 7.0].sort((a, b) => b - a)
      expect(scores).toEqual(allScores)
    })

    it('should correctly divide candidates into batches', async () => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model', 2)

      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'content1' },
        { id: '2', content: 'content2' },
        { id: '3', content: 'content3' },
        { id: '4', content: 'content4' },
        { id: '5', content: 'content5' }
      ]

      // Mock responses for 3 batches: 2, 2, 1 candidates
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [1, 2]}'
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [3, 4]}'
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: '{"scores": [5]}'
          })
        })

      await reranker.rerank('test', candidates)

      expect(mockFetch).toHaveBeenCalledTimes(3)

      // Verify each batch call had correct number of candidates
      const firstCall = mockFetch.mock.calls[0][1]
      const firstBody = JSON.parse(firstCall.body)
      expect(firstBody.prompt).toContain('## snippet 1')
      expect(firstBody.prompt).toContain('content1')
      expect(firstBody.prompt).toContain('## snippet 2')
      expect(firstBody.prompt).toContain('content2')

      const secondCall = mockFetch.mock.calls[1][1]
      const secondBody = JSON.parse(secondCall.body)
      expect(secondBody.prompt).toContain('## snippet 1')
      expect(secondBody.prompt).toContain('content3')
      expect(secondBody.prompt).toContain('## snippet 2')
      expect(secondBody.prompt).toContain('content4')

      const thirdCall = mockFetch.mock.calls[2][1]
      const thirdBody = JSON.parse(thirdCall.body)
      expect(thirdBody.prompt).toContain('## snippet 1')
      expect(thirdBody.prompt).toContain('content5')
    })
  })

  describe('buildScoringPrompt method', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should build proper scoring prompt with query and candidates', () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test() { return "hello"; }' },
        { id: '2', content: 'const variable = 42;' }
      ]

      // Access private method using bracket notation for testing
      const prompt = (reranker as any)['buildScoringPrompt']('search query', candidates)

      expect(prompt).toContain('You are a code relevance scorer')
      expect(prompt).toContain('with their hierarchy context')
      expect(prompt).toContain('Query: search query')
      expect(prompt).toContain('## snippet 1')
      expect(prompt).toContain('function test() { return "hello"; }')
      expect(prompt).toContain('## snippet 2')
      expect(prompt).toContain('const variable = 42;')
      expect(prompt).toContain('Respond with ONLY a JSON object with a relevant "scores" array')
    })

    it('should include context information when payload is provided', () => {
      const candidates: RerankerCandidate[] = [
        {
          id: '1',
          content: 'function test() { return "hello"; }',
          payload: {
            hierarchyDisplay: 'MyClass.myMethod',
            filePath: 'src/test.js',
            type: 'function',
            startLine: 10,
            endLine: 12
          }
        }
      ]

      const prompt = (reranker as any)['buildScoringPrompt']('search query', candidates)

      expect(prompt).toContain('## snippet 1 [Context: MyClass.myMethod] [File: test.js]')
      expect(prompt).toContain('function test() { return "hello"; }')
    })

    it('should handle special characters in query and content', () => {
      const candidates: RerankerCandidate[] = [
        { id: '1', content: 'function test() { return "hello & world"; }' }
      ]

      const prompt = (reranker as any)['buildScoringPrompt']('search & query', candidates)

      expect(prompt).toContain('Query: search & query')
      expect(prompt).toContain('function test() { return "hello & world"; }')
    })
  })

  describe('buildContextInfo method', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should build complete context info when all payload fields are present', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          hierarchyDisplay: 'MyClass.myMethod',
          filePath: 'src/components/test.ts',
          type: 'function',
          startLine: 15,
          endLine: 20
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('[Context: MyClass.myMethod] [File: test.ts]\n')
    })

    it('should build partial context info when only some payload fields are present', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'const variable = 42;',
        payload: {
          filePath: 'src/constants.ts',
          type: 'variable'
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('[File: constants.ts]\n')
    })

    it('should return empty string when no payload is provided', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}'
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })

    it('should return empty string when payload is empty', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {}
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })

    it('should handle only hierarchyDisplay', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          hierarchyDisplay: 'UserService.authenticate'
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('[Context: UserService.authenticate]\n')
    })

    it('should handle only filePath', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          filePath: '/path/to/file.js'
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('[File: file.js]\n')
    })

    it('should handle only type', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          type: 'class'
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })

    it('should handle line numbers with only startLine (should not include lines)', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          startLine: 15
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })

    it('should handle line numbers with only endLine (should not include lines)', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          endLine: 20
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })

    it('should handle complex file paths correctly', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          filePath: 'src/utils/helpers/date/format.ts'
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('[File: format.ts]\n')
    })

    it('should handle empty strings in payload fields', () => {
      const candidate: RerankerCandidate = {
        id: '1',
        content: 'function test() {}',
        payload: {
          hierarchyDisplay: '',
          filePath: '',
          type: 'function',
          startLine: 0,
          endLine: 0
        }
      }

      const contextInfo = (reranker as any)['buildContextInfo'](candidate)

      expect(contextInfo).toBe('')
    })
  })

  describe('extractScoresFromText method', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should extract numbers from text response', () => {
      const testCases = [
        { text: '[8.5, 6.0, 9.2]', expected: [8.5, 6.0, 9.2] },
        { text: 'Scores: 7.5 and 3.2', expected: [7.5, 3.2] },
        { text: 'Rating: 10, 5, 0', expected: [10, 5, 0] },
        { text: 'Mixed numbers 1, 2.5, and 3.75', expected: [1, 2.5, 3.75] }
      ]

      testCases.forEach(({ text, expected }) => {
        const result = (reranker as any)['extractScoresFromText'](text)
        expect(result).toEqual(expected)
      })
    })

    it('should clamp extracted scores to 0-10 range', () => {
      const result = (reranker as any)['extractScoresFromText']('Scores: -5, 15.5, 8.0')
      expect(result).toEqual([5, 10, 8.0]) // -5 becomes 5 (minus sign ignored), 15.5 clamped to 10
    })

    it('should return empty array when no numbers found', () => {
      const result = (reranker as any)['extractScoresFromText']('No scores here')
      expect(result).toEqual([])
    })

    it('should handle decimal numbers correctly', () => {
      const result = (reranker as any)['extractScoresFromText']('Ratings: 3.14159, 2.71828')
      expect(result).toEqual([3.14159, 2.71828])
    })
  })

  describe('validateConfiguration method', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should validate successfully when Ollama service and model exist', async () => {
      // Mock successful models list response
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              { name: 'test-model' },
              { name: 'other-model:latest' }
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'test' })
        })

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'http://localhost:11434/api/tags',
        expect.objectContaining({ method: 'GET' })
      )
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'http://localhost:11434/api/generate',
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('should fail validation when Ollama service is not running', async () => {
      // Mock 404 response (service not found)
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404
      })

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Ollama service is not running')
    })

    it('should fail validation when model is not found', async () => {
      // Mock successful models list but model not found
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: 'other-model' },
            { name: 'another-model:latest' }
          ]
        })
      })

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Model \'test-model\' not found')
      expect(result.error).toContain('Available models: other-model, another-model:latest')
    })

    it('should fail validation when model cannot generate text', async () => {
      // Mock successful models list but test generation fails
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'test-model' }]
          })
        })
        .mockResolvedValueOnce({
          ok: false
        })

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('not capable of text generation')
    })

    it('should handle connection errors gracefully', async () => {
      // Mock connection refused error
      mockFetch.mockRejectedValue(new Error('fetch failed'))

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Ollama service is not running')
    })

    it('should handle timeout errors gracefully', async () => {
      // Mock timeout error
      const timeoutError = new Error('Request timeout')
      timeoutError.name = 'AbortError'
      mockFetch.mockRejectedValue(timeoutError)

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Connection failed due to timeout')
    })

    it('should handle host not found errors', async () => {
      // Mock ENOTFOUND error
      const notFoundError = new Error('getaddrinfo ENOTFOUND localhost') as Error & { code?: string }
      notFoundError.code = 'ENOTFOUND'
      mockFetch.mockRejectedValue(notFoundError)

      const result = await reranker.validateConfiguration()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Host not found')
    })

    it('should match models with different suffixes', async () => {
      const testCases = [
        { modelId: 'test-model', models: ['test-model:latest'], shouldMatch: true },
        { modelId: 'test-model:latest', models: ['test-model'], shouldMatch: true },
        { modelId: 'test-model', models: ['test-model'], shouldMatch: true },
        { modelId: 'test-model:v1', models: ['test-model:v1'], shouldMatch: true }
      ]

      for (const testCase of testCases) {
        reranker = new OllamaLLMReranker('http://localhost:11434', testCase.modelId)

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({
            models: testCase.models.map(name => ({ name }))
          })
        })

        const result = await reranker.validateConfiguration()

        if (testCase.shouldMatch) {
          expect(result.valid).toBe(true)
        }

        mockFetch.mockClear()
      }
    })
  })

  describe('Proxy settings detection', () => {
    beforeEach(() => {
      reranker = new OllamaLLMReranker('http://localhost:11434', 'test-model')
    })

    it('should use HTTP_PROXY when target is HTTP', async () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080'

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] })
      })

      await reranker.validateConfiguration()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatcher: expect.any(Object)
        })
      )
    })

    it('should use HTTPS_PROXY when target is HTTPS', async () => {
      reranker = new OllamaLLMReranker('https://localhost:11434', 'test-model')
      process.env['HTTPS_PROXY'] = 'https://secure-proxy.example.com:8080'

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] })
      })

      await reranker.validateConfiguration()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatcher: expect.any(Object)
        })
      )
    })

    it('should not use proxy when no environment variables set', async () => {
      // No proxy environment variables set (cleared in beforeEach)

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] })
      })

      await reranker.validateConfiguration()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({
          dispatcher: expect.any(Object)
        })
      )
    })

    it('should use lowercase proxy environment variables', async () => {
      process.env['http_proxy'] = 'http://proxy.example.com:8080'

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] })
      })

      await reranker.validateConfiguration()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatcher: expect.any(Object)
        })
      )
    })

    it('should handle ProxyAgent creation errors gracefully', async () => {
      // Mock ProxyAgent to throw an error
      mockProxyAgent.mockImplementationOnce(() => {
        throw new Error('Failed to create ProxyAgent')
      })

      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080'

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] })
      })

      // Should not throw error
      await expect(reranker.validateConfiguration()).resolves.not.toThrow()

      // Should proceed without proxy
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({
          dispatcher: expect.any(Object)
        })
      )
    })
  })
})
