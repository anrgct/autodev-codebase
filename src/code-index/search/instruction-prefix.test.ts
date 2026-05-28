import { describe, it, expect } from "vitest"
import {
  resolveQueryPrefix,
  resolveDocumentPrefix,
  wrapInChatTemplate,
  QWEN_PREFILL_TEMPLATE,
  LLM_EMBEDDER_PREFILL_TEMPLATE,
  JINA_QUERY_PREFIX,
  F2LLM_PREFILL_TEMPLATE,
} from "./instruction-prefix"
import { IEmbedder } from "../interfaces"

// ============================================================================
// resolveQueryPrefix 测试
// ============================================================================

describe("resolveQueryPrefix", () => {
  // ── llamacpp（专用 embedding 模型） ──────────────
  describe("llamacpp provider (dedicated embedding models)", () => {
    it('returns "Query: " prefix for jina-embeddings-v5 models', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp", "jina-embeddings-v5-nano-retrieval")
      expect(result).toBe("Query: find auth")
    })

    it("prevents duplicate prefix for jina models", () => {
      const result = resolveQueryPrefix("Query: find auth", "llamacpp", "jina-embeddings-v5-nano-retrieval")
      expect(result).toBe("Query: find auth")
    })

    it("returns query unchanged for non-jina models", () => {
      const result = resolveQueryPrefix("find auth", "llamacpp", "mxbai-embed-large-v1-f16")
      expect(result).toBe("find auth")
    })

    it("returns query unchanged when modelId is undefined", () => {
      const result = resolveQueryPrefix("find auth", "llamacpp", undefined)
      expect(result).toBe("find auth")
    })
  })

  // ── llamacpp-llm（通用 LLM embedder） ────────────
  describe("llamacpp-llm provider (general LLM embeddings)", () => {
    it("applies instruction prefill when enableLlmPrefix=true", () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", undefined, true)
      expect(result).toBe(LLM_EMBEDDER_PREFILL_TEMPLATE + "find auth")
    })

    it("does NOT apply prefill when enableLlmPrefix=false", () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", undefined, false)
      expect(result).toBe("find auth")
    })

    it("prevents duplicate instruction prefill", () => {
      const prefilled = LLM_EMBEDDER_PREFILL_TEMPLATE + "existing query"
      const result = resolveQueryPrefix(prefilled, "llamacpp-llm", undefined, true)
      expect(result).toBe(prefilled)
    })

    it('uses "Query: " prefix for jina models when enableLlmPrefix=true', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "jina-embeddings-v5-nano-retrieval", true)
      expect(result).toBe("Query: find auth")
    })

    it("does NOT apply prefix for jina models when enableLlmPrefix=false", () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "jina-embeddings-v5-nano-retrieval", false)
      expect(result).toBe("find auth")
    })

    it("prevents duplicate Query: prefix for jina models", () => {
      const result = resolveQueryPrefix("Query: find auth", "llamacpp-llm", "jina-embeddings-v5-nano-retrieval", true)
      expect(result).toBe("Query: find auth")
    })

    it('applies instruction prefill for non-jina models with jina-like modelId', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "mxbai-embed-large-v1-f16", true)
      expect(result).toBe(LLM_EMBEDDER_PREFILL_TEMPLATE + "find auth")
    })

    it('uses F2LLM-specific prefix for F2LLM models', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "F2LLM-v2-330M.Q8_0.gguf", true)
      expect(result).toBe(F2LLM_PREFILL_TEMPLATE + "find auth")
    })

    it('uses F2LLM prefix regardless of case in modelId', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "f2llm-v2-80M.Q8_0.gguf", true)
      expect(result).toBe(F2LLM_PREFILL_TEMPLATE + "find auth")
    })

    it('prevents duplicate F2LLM prefix', () => {
      const prefilled = F2LLM_PREFILL_TEMPLATE + "find auth"
      const result = resolveQueryPrefix(prefilled, "llamacpp-llm", "F2LLM-v2-330M.Q8_0.gguf", true)
      expect(result).toBe(prefilled)
    })

    it('does NOT apply F2LLM prefix for non-F2LLM models', () => {
      const result = resolveQueryPrefix("find auth", "llamacpp-llm", "MiniCPM-V-4_6-Q8_0.gguf", true)
      expect(result).toBe(LLM_EMBEDDER_PREFILL_TEMPLATE + "find auth")
    })
  })

  // ── ollama + qwen3-embedding ─────────────────────
  describe("ollama + qwen3-embedding models", () => {
    it("applies prefill to qwen3-embedding:0.6b", () => {
      const result = resolveQueryPrefix("test function", "ollama", "qwen3-embedding:0.6b")
      expect(result).toBe(QWEN_PREFILL_TEMPLATE + "test function")
    })

    it("applies prefill to qwen3-embedding:4b", () => {
      const result = resolveQueryPrefix("async await", "ollama", "qwen3-embedding:4b")
      expect(result).toContain("Instruct: Given a codebase search query")
      expect(result).toContain("Query: async await")
    })

    it("applies prefill to qwen3-embedding:8b", () => {
      const result = resolveQueryPrefix("db connection", "ollama", "qwen3-embedding:8b")
      expect(result).toContain("Instruct:")
      expect(result).toContain("Query: db connection")
    })

    it("prevents duplicate prefill", () => {
      const prefilled = QWEN_PREFILL_TEMPLATE + "existing query"
      const result = resolveQueryPrefix(prefilled, "ollama", "qwen3-embedding:0.6b")
      expect(result).toBe(prefilled)
    })

    it("does NOT apply to non-qwen3 ollama models", () => {
      expect(resolveQueryPrefix("test", "ollama", "nomic-embed-text")).toBe("test")
      expect(resolveQueryPrefix("test", "ollama", "mxbai-embed-large")).toBe("test")
    })

    it("does NOT apply when modelId is undefined", () => {
      expect(resolveQueryPrefix("test", "ollama", undefined)).toBe("test")
    })

    it("does NOT apply when modelId is empty", () => {
      expect(resolveQueryPrefix("test", "ollama", "")).toBe("test")
    })

    it("does NOT apply to qwen-embedding (wrong pattern)", () => {
      expect(resolveQueryPrefix("test", "ollama", "qwen-embedding")).toBe("test")
    })
  })

  // ── 其他 provider 不受影响 ───────────────────────
  describe("other providers", () => {
    it("returns query unchanged for openai", () => {
      expect(resolveQueryPrefix("test", "openai", "text-embedding-3-small")).toBe("test")
    })

    it("returns query unchanged for gemini", () => {
      expect(resolveQueryPrefix("test", "gemini", "text-embedding-004")).toBe("test")
    })

    it("returns query unchanged for mistral", () => {
      expect(resolveQueryPrefix("test", "mistral", "codestral-embed-2505")).toBe("test")
    })

    it("returns query unchanged for openai-compatible", () => {
      expect(resolveQueryPrefix("test", "openai-compatible", "text-embedding-3-small")).toBe("test")
    })
  })

  // ── 复杂查询 ─────────────────────────────────────
  describe("complex queries", () => {
    it("handles multi-line queries", () => {
      const result = resolveQueryPrefix("find async\nfunctions", "ollama", "qwen3-embedding:4b")
      expect(result).toContain("Instruct:")
      expect(result).toContain("Query: find async\nfunctions")
    })

    it("handles queries with special characters", () => {
      const result = resolveQueryPrefix("React.useEffect() [state]", "ollama", "qwen3-embedding:8b")
      expect(result).toContain("Query: React.useEffect() [state]")
    })
  })
})

// ============================================================================
// resolveDocumentPrefix 测试
// ============================================================================

describe("resolveDocumentPrefix", () => {
  function createMockEmbedder(
    name: string,
    modelPath?: string,
    enableLlmPrefix?: boolean,
  ): IEmbedder {
    return {
      embedderInfo: { name: name as any },
      enableLlmPrefix,
      modelPath,
      createEmbeddings: async () => ({ embeddings: [] }),
      validateConfiguration: async () => ({ valid: true }),
      optimalBatchSize: 1,
      poolingMode: "mean",
    } as unknown as IEmbedder
  }

  // 辅助函数：用 modelPath 创建 embedder（模拟 llamacpp-llm 的实现模式）
  function mockEmbedderWithModelPath(
    name: string,
    modelPath: string,
    enableLlmPrefix?: boolean,
  ): IEmbedder {
    const e = createMockEmbedder(name, modelPath, enableLlmPrefix)
    ;(e as any).modelPath = modelPath
    return e
  }

  describe("llamacpp provider", () => {
    it('returns "Query: " for jina-embeddings-v5 models', () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp",
        "models/jina-embeddings-v5-nano-retrieval-Q8_0.gguf",
      )
      expect(resolveDocumentPrefix(embedder)).toBe("Query: ")
    })

    it("returns undefined for non-jina models", () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp",
        "models/mxbai-embed-large-v1-f16.gguf",
      )
      expect(resolveDocumentPrefix(embedder)).toBeUndefined()
    })
  })

  describe("llamacpp-llm provider", () => {
    it('returns "Query: " for jina models when enableLlmPrefix=true', () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp-llm",
        "jina-embeddings-v5-nano-retrieval-Q8_0.gguf",
        true,
      )
      expect(resolveDocumentPrefix(embedder)).toBe("Query: ")
    })

    it("returns undefined for jina models when enableLlmPrefix=false", () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp-llm",
        "jina-embeddings-v5-nano-retrieval-Q8_0.gguf",
        false,
      )
      expect(resolveDocumentPrefix(embedder)).toBeUndefined()
    })

    it("returns undefined for non-jina models even when enableLlmPrefix=true", () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp-llm",
        "models/minicpm-v-4.6-Q8_0.gguf",
        true,
      )
      expect(resolveDocumentPrefix(embedder)).toBeUndefined()
    })

    it("returns undefined when enableLlmPrefix is not set (default false)", () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp-llm",
        "jina-embeddings-v5-nano-retrieval.gguf",
      )
      expect(resolveDocumentPrefix(embedder)).toBeUndefined()
    })
  })

  describe("unrelated providers", () => {
    const providers = ["ollama", "openai", "jina", "openai-compatible"]
    for (const provider of providers) {
      it(`returns undefined for ${provider}`, () => {
        const embedder = mockEmbedderWithModelPath(
          provider,
          "jina-embeddings-v5-nano-retrieval.gguf",
        )
        expect(resolveDocumentPrefix(embedder)).toBeUndefined()
      })
    }
  })

  describe("edge cases", () => {
    it("returns undefined when embedder has no modelPath", () => {
      const embedder = createMockEmbedder("llamacpp")
      expect(resolveDocumentPrefix(embedder)).toBeUndefined()
    })

    it("extracts model name from full GGUF path", () => {
      const embedder = mockEmbedderWithModelPath(
        "llamacpp",
        "/home/user/models/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0.gguf",
      )
      expect(resolveDocumentPrefix(embedder)).toBe("Query: ")
    })
  })
})

// ============================================================================
// wrapInChatTemplate 测试
// ============================================================================

describe("wrapInChatTemplate", () => {
  it("wraps text in ChatML user-assistant format", () => {
    const result = wrapInChatTemplate("hello")
    expect(result).toBe("<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n")
  })

  it("wraps multi-line text", () => {
    const result = wrapInChatTemplate("line1\nline2")
    expect(result).toContain("<|im_start|>user")
    expect(result).toContain("<|im_start|>assistant")
    expect(result).toContain("line1\nline2")
  })

  it("wraps text with special characters", () => {
    const result = wrapInChatTemplate("function<T>(x: T): T")
    expect(result).toContain("function<T>(x: T): T")
  })

  it("wraps empty string", () => {
    const result = wrapInChatTemplate("")
    expect(result).toBe("<|im_start|>user\n<|im_end|>\n<|im_start|>assistant\n")
  })
})
