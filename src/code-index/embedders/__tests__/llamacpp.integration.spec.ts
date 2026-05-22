/**
 * Integration tests for LlamaCPP providers.
 * Auto-detects GGUF model paths from autodev-config.json.
 * Tests skip automatically when no GGUF model is configured.
 */
import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { parse } from "jsonc-parser"
import { LlamaCppEmbedder } from "../llamacpp"
import { LlamaCppReranker } from "../../rerankers/llamacpp-rerank"
import { SemanticHighlightReranker } from "../../rerankers/semantic-highlight"
import { LlamaCppSummarizer } from "../../summarizers/llamacpp"
import { getLlama } from "node-llama-cpp"

const CONFIG_DIRS = [
  process.cwd(),
  path.join(process.cwd(), "demo"),
  path.join(os.homedir(), ".autodev-cache"),
]

function findModelPath(key: string): string | undefined {
  // Check env var first (LLAMACPP_EMBEDDER_MODEL / LLAMACPP_RERANKER_MODEL / LLAMACPP_LLM_MODEL)
  const envKey = "LLAMACPP_" + key.replace(/([A-Z])/g, "_$1").toUpperCase()
  const envPath = process.env[envKey]
  if (envPath && fs.existsSync(envPath)) return envPath

  // Check all config file locations, return first match with existing file
  for (const dir of CONFIG_DIRS) {
    const filepath = path.join(dir, "autodev-config.json")
    try {
      if (fs.existsSync(filepath)) {
        const config = parse(fs.readFileSync(filepath, "utf-8"))
        const modelPath = config?.[key]
        if (typeof modelPath === "string" && fs.existsSync(modelPath)) {
          return modelPath
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined
}

const embedderModelPath = findModelPath("embedderLlamaCppModelPath")
const rerankerModelPath = findModelPath("rerankerGgufPath")
const llmModelPath = findModelPath("summarizerLlamaCppModelPath")
// Skip cross-encoder test if model path is a semantic-highlight model (doesn't support ranking)
const isCrossEncoderModel = rerankerModelPath && !rerankerModelPath.includes("semantic_highlight")

// Detect reranker provider type from config
function getRerankerProvider(): string | undefined {
  for (const dir of CONFIG_DIRS) {
    const filepath = path.join(dir, "autodev-config.json")
    try {
      if (fs.existsSync(filepath)) {
        const config = parse(fs.readFileSync(filepath, "utf-8"))
        return config?.rerankerProvider
      }
    } catch { /* ignore */ }
  }
  return undefined
}
const rerankerProvider = getRerankerProvider()

describe.runIf(embedderModelPath)("LlamaCPP Embedder", () => {
  it("loads model and creates embeddings", async () => {
    const embedder = new LlamaCppEmbedder(embedderModelPath!)
    const result = await embedder.createEmbeddings(["test query", "another test"])
    expect(result.embeddings).toHaveLength(2)
    expect(result.embeddings[0].length).toBeGreaterThan(0)
    expect(result.embeddings[1].length).toBe(result.embeddings[0].length)
  }, 120_000)

  it("validates configuration with existing model file", async () => {
    const embedder = new LlamaCppEmbedder(embedderModelPath!)
    const result = await embedder.validateConfiguration()
    expect(result.valid).toBe(true)
  }, 120_000)

  it("fails validation for non-existent model path", async () => {
    const embedder = new LlamaCppEmbedder("/nonexistent/model.gguf")
    const result = await embedder.validateConfiguration()
    expect(result.valid).toBe(false)
    expect(result.error).toContain("not found")
  }, 10_000)

  it("reports embedder info and optimal batch size", () => {
    const embedder = new LlamaCppEmbedder(embedderModelPath!)
    expect(embedder.embedderInfo.name).toBe("llamacpp")
    expect(embedder.optimalBatchSize).toBe(1)
  })
})

describe.runIf(isCrossEncoderModel)("LlamaCPP Reranker (cross-encoder)", () => {
  it("loads model and reranks candidates", async () => {
    const reranker = new LlamaCppReranker(rerankerModelPath!)
    const candidates = [
      { id: "1", content: "def add(a, b): return a + b", score: 0.5, payload: {} },
      { id: "2", content: "class DataProcessor:", score: 0.4, payload: {} },
      { id: "3", content: "import requests", score: 0.3, payload: {} },
    ]
    const results = await reranker.rerank("python addition function", candidates)
    expect(results).toHaveLength(3)
    results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(10)
    })
  }, 120_000)

  it("returns empty for empty candidates", async () => {
    const reranker = new LlamaCppReranker(rerankerModelPath!)
    const results = await reranker.rerank("test", [])
    expect(results).toEqual([])
  }, 10_000)

  it("validates configuration", async () => {
    const reranker = new LlamaCppReranker(rerankerModelPath!)
    const result = await reranker.validateConfiguration()
    expect(result.valid).toBe(true)
  }, 120_000)
})

// Semantic-Highlight Reranker (unified GGUF: backbone + RerankHead)
describe.runIf(rerankerModelPath && rerankerProvider === "semantic-highlight")("SemanticHighlight Reranker", () => {
  it("loads model and reranks candidates", async () => {
    const reranker = new SemanticHighlightReranker(rerankerModelPath!)
    const candidates = [
      { id: "1", content: "def add(a, b): return a + b", score: 0.5, payload: {} },
      { id: "2", content: "class DataProcessor:", score: 0.4, payload: {} },
      { id: "3", content: "import requests", score: 0.3, payload: {} },
    ]
    const results = await reranker.rerank("python addition function", candidates)
    expect(results).toHaveLength(3)
    results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
      // Should have precomputed PruningHead probs in payload
      const payload = r.payload as Record<string, unknown> | undefined
      expect(payload?.["_semanticHighlightTokenProbs"]).toBeTruthy()
      expect(payload?.["_semanticHighlightCodeText"]).toBe(candidates.find(c => c.id === r.id)?.content)
    })
  }, 180_000)

  it("returns empty for empty candidates", async () => {
    const reranker = new SemanticHighlightReranker(rerankerModelPath!)
    const results = await reranker.rerank("test", [])
    expect(results).toEqual([])
  }, 10_000)

  it("validates configuration", async () => {
    const reranker = new SemanticHighlightReranker(rerankerModelPath!)
    const result = await reranker.validateConfiguration()
    expect(result.valid).toBe(true)
  }, 180_000)
})

describe.runIf(llmModelPath)("LlamaCPP Summarizer", () => {
  it("generates summary for a code block", async () => {
    const llama = await getLlama()
    const model = await llama.loadModel({ modelPath: llmModelPath! })
    const summarizer = new LlamaCppSummarizer(model, "English", 0)
    const result = await summarizer.summarize({
      content: "def greet(name):\n    return f'Hello, {name}'",
      codeType: "function",
      codeName: "greet",
      language: "English",
    })
    expect(result.summary).toBeTruthy()
    expect(typeof result.summary).toBe("string")
  }, 300_000)

  it("validates configuration", async () => {
    const llama = await getLlama()
    const model = await llama.loadModel({ modelPath: llmModelPath! })
    const summarizer = new LlamaCppSummarizer(model, "English", 0)
    const result = await summarizer.validateConfiguration()
    expect(result.valid).toBe(true)
  }, 120_000)
})

describe("LlamaCPP providers (no model required)", () => {
  it("embedder reports info without loading model", () => {
    const embedder = new LlamaCppEmbedder("/some/model.gguf")
    expect(embedder.embedderInfo.name).toBe("llamacpp")
    expect(embedder.optimalBatchSize).toBe(1)
  })

  it("reranker reports info without loading model", () => {
    const reranker = new LlamaCppReranker("/some/model.gguf")
    expect(reranker.rerankerInfo.name).toBe("llamacpp")
  })
})
