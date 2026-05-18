import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockedClass, MockedFunction } from "vitest"
import { OpenAI } from "openai"
import { OpenAICompatibleEmbedder } from "../openai-compatible"

// Mock the OpenAI SDK
vi.mock("openai")

const MockedOpenAI = OpenAI as unknown as MockedClass<typeof OpenAI>

describe("OpenAICompatibleEmbedder - global rate limiting", () => {
  let mockOpenAIInstance: any
  let mockEmbeddingsCreate: MockedFunction<any>

  const testBaseUrl = "https://api.openai.com/v1"
  const testApiKey = "test-api-key"
  const testModelId = "text-embedding-3-small"

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    mockEmbeddingsCreate = vi.fn()
    mockOpenAIInstance = {
      embeddings: {
        create: mockEmbeddingsCreate,
      },
    }

    MockedOpenAI.mockImplementation(() => mockOpenAIInstance)

    // Reset global rate limit state between tests
    const embedder = new OpenAICompatibleEmbedder(testBaseUrl, testApiKey, testModelId)
    ;(embedder as any).constructor.globalRateLimitState = {
      isRateLimited: false,
      rateLimitResetTime: 0,
      consecutiveRateLimitErrors: 0,
      lastRateLimitError: 0,
      mutex: (embedder as any).constructor.globalRateLimitState.mutex,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("applies global rate limiting across multiple batch requests", async () => {
    const embedder1 = new OpenAICompatibleEmbedder(testBaseUrl, testApiKey, testModelId)
    const embedder2 = new OpenAICompatibleEmbedder(testBaseUrl, testApiKey, testModelId)

    const rateLimitError = new Error("Rate limit exceeded") as any
    rateLimitError.status = 429

    mockEmbeddingsCreate
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue({
        data: [{ embedding: "base64encodeddata" }],
        usage: { prompt_tokens: 10, total_tokens: 15 },
      })

    const batch1Promise = embedder1.createEmbeddings(["test1"])

    // Let first attempt fail and set global rate limit state
    await vi.advanceTimersByTimeAsync(100)

    const batch2Promise = embedder2.createEmbeddings(["test2"])

    const state = (embedder1 as any).constructor.globalRateLimitState
    expect(state.isRateLimited).toBe(true)
    expect(state.consecutiveRateLimitErrors).toBe(1)

    // Advance time to complete rate limit delay (base delay is 500ms, but global
    // state may increase it; advance generously)
    await vi.advanceTimersByTimeAsync(5000)

    const [result1, result2] = await Promise.all([batch1Promise, batch2Promise])

    expect(result1.embeddings).toHaveLength(1)
    expect(result2.embeddings).toHaveLength(1)

    // We intentionally do not assert on any specific log output here:
    // logging has been minimized to avoid log flooding.
  })

  it("tracks consecutive rate limit errors", async () => {
    const embedder = new OpenAICompatibleEmbedder(testBaseUrl, testApiKey, testModelId)
    const state = (embedder as any).constructor.globalRateLimitState

    const rateLimitError = new Error("Rate limit exceeded") as any
    rateLimitError.status = 429

    mockEmbeddingsCreate
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        data: [{ embedding: "base64encodeddata" }],
        usage: { prompt_tokens: 10, total_tokens: 15 },
      })

    const promise1 = embedder.createEmbeddings(["test1"])

    await vi.advanceTimersByTimeAsync(100)
    expect(state.consecutiveRateLimitErrors).toBe(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(state.consecutiveRateLimitErrors).toBeGreaterThanOrEqual(1)

    await vi.advanceTimersByTimeAsync(20000)
    await promise1

    mockEmbeddingsCreate.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
      data: [{ embedding: "base64encodeddata" }],
      usage: { prompt_tokens: 10, total_tokens: 15 },
    })

    const previousCount = state.consecutiveRateLimitErrors

    const promise2 = embedder.createEmbeddings(["test2"])
    await vi.advanceTimersByTimeAsync(100)

    expect(state.consecutiveRateLimitErrors).toBeGreaterThan(previousCount)

    await vi.advanceTimersByTimeAsync(20000)
    await promise2
  })

  it("does not exceed maximum backoff delay of 5 minutes", async () => {
    const embedder = new OpenAICompatibleEmbedder(testBaseUrl, testApiKey, testModelId)
    const state = (embedder as any).constructor.globalRateLimitState

    state.consecutiveRateLimitErrors = 10

    const rateLimitError = new Error("Rate limit exceeded") as any
    rateLimitError.status = 429

    await (embedder as any).updateGlobalRateLimitState(rateLimitError)

    const now = Date.now()
    const delay = state.rateLimitResetTime - now

    expect(delay).toBeLessThanOrEqual(300000)
    expect(delay).toBeGreaterThan(0)
  })
})
