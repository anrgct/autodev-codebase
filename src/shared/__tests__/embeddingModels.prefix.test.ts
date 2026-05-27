import { describe, it, expect } from "vitest"
import {
  getModelQueryPrefix,
  getModelDocumentPrefix,
  EmbedderProvider,
} from "../embeddingModels"

describe("getModelQueryPrefix", () => {
  describe("llamacpp with jina-embeddings-v5 models", () => {
    it(`returns "Query: " for llamacpp with jina-embeddings-v5-nano-retrieval`, () => {
      expect(getModelQueryPrefix("llamacpp", "jina-embeddings-v5-nano-retrieval")).toBe(
        "Query: ",
      )
    })

    it(`returns "Query: " for llamacpp with full GGUF path containing jina-embeddings-v5`, () => {
      expect(
        getModelQueryPrefix(
          "llamacpp",
          "jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0",
        ),
      ).toBe("Query: ")
    })
  })

  describe("non-llamacpp providers with jina-embeddings-v5 models", () => {
    const providers: EmbedderProvider[] = [
      "ollama",
      "openai-compatible",
      "jina",
      "openai",
      "llamacpp-llm",
    ]

    for (const provider of providers) {
      it(`returns null for ${provider} even with jina-embeddings-v5-nano-retrieval`, () => {
        expect(getModelQueryPrefix(provider, "jina-embeddings-v5-nano-retrieval")).toBeNull()
      })
    }
  })

  describe("non-jina-v5 models", () => {
    it("returns null for mxbai-embed-large (llamacpp)", () => {
      expect(getModelQueryPrefix("llamacpp", "mxbai-embed-large-v1-f16")).toBeNull()
    })

    it("returns null for jina-embeddings-v2-base-code (jina provider)", () => {
      expect(getModelQueryPrefix("jina", "jina-embeddings-v2-base-code")).toBeNull()
    })

    it("returns null for jina-embeddings-v4 (jina provider)", () => {
      expect(getModelQueryPrefix("jina", "jina-embeddings-v4")).toBeNull()
    })

    it("returns null for nomic-embed-text (ollama)", () => {
      expect(getModelQueryPrefix("ollama", "nomic-embed-text")).toBeNull()
    })

    it("returns null for text-embedding-3-small (openai)", () => {
      expect(getModelQueryPrefix("openai", "text-embedding-3-small")).toBeNull()
    })
  })
})

describe("getModelDocumentPrefix", () => {
  describe("llamacpp with jina-embeddings-v5 models", () => {
    it(`returns "Query: " for llamacpp with jina-embeddings-v5-nano-retrieval (symmetric with query)`, () => {
      expect(
        getModelDocumentPrefix("llamacpp", "jina-embeddings-v5-nano-retrieval"),
      ).toBe("Query: ")
    })

    it(`returns "Query: " for llamacpp with full GGUF path containing jina-embeddings-v5`, () => {
      expect(
        getModelDocumentPrefix(
          "llamacpp",
          "jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0",
        ),
      ).toBe("Query: ")
    })
  })

  describe("llamacpp-llm with jina-embeddings-v5 models", () => {
    it(`returns "Query: " for llamacpp-llm with jina-embeddings-v5-nano-retrieval (symmetric with query)`, () => {
      expect(
        getModelDocumentPrefix("llamacpp-llm", "jina-embeddings-v5-nano-retrieval"),
      ).toBe("Query: ")
    })

    it(`returns "Query: " for llamacpp-llm with full GGUF path containing jina-embeddings-v5`, () => {
      expect(
        getModelDocumentPrefix(
          "llamacpp-llm",
          "jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0",
        ),
      ).toBe("Query: ")
    })
  })

  describe("non-llamacpp/llamacpp-llm providers with jina-embeddings-v5 models", () => {
    const providers: EmbedderProvider[] = [
      "ollama",
      "openai-compatible",
      "jina",
    ]

    for (const provider of providers) {
      it(`returns null for ${provider} even with jina-embeddings-v5-nano-retrieval`, () => {
        expect(
          getModelDocumentPrefix(provider, "jina-embeddings-v5-nano-retrieval"),
        ).toBeNull()
      })
    }
  })

  describe("llamacpp-llm non-jina-v5 models", () => {
    it(`returns null for llamacpp-llm with mxbai-embed-large (same as llamacpp)`, () => {
      expect(getModelDocumentPrefix("llamacpp-llm", "mxbai-embed-large-v1-f16")).toBeNull()
    })

    it(`returns null for llamacpp-llm with all-MiniLM-L6 (same as llamacpp)`, () => {
      expect(getModelDocumentPrefix("llamacpp-llm", "all-MiniLM-L6-v2-Q4_K_M")).toBeNull()
    })

    it(`returns null for llamacpp-llm with nomic-embed-text (same as llamacpp)`, () => {
      expect(getModelDocumentPrefix("llamacpp-llm", "nomic-embed-text-v1.5-Q4_K_M")).toBeNull()
    })
  })

  describe("non-jina-v5 models", () => {
    it("returns null for all-MiniLM-L6 (llamacpp)", () => {
      expect(getModelDocumentPrefix("llamacpp", "all-MiniLM-L6-v2-Q4_K_M")).toBeNull()
    })

    it("returns null for nomic-embed-text (ollama)", () => {
      expect(getModelDocumentPrefix("ollama", "nomic-embed-text")).toBeNull()
    })

    it("returns null for jina-embeddings-v2-base-code", () => {
      expect(getModelDocumentPrefix("jina", "jina-embeddings-v2-base-code")).toBeNull()
    })
  })
})
