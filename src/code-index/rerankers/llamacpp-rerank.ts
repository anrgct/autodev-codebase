import { spawn, ChildProcess } from "child_process"
import path from "path"
import net from "net"
import fs from "fs"
import { getLlama, LlamaModel, LlamaRankingContext, LlamaLogLevel } from "node-llama-cpp"
import { IReranker, RerankerCandidate, RerankerResult, RerankerInfo } from "../interfaces"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

const RERANK_REQUEST_TIMEOUT_MS = 60_000 // 1 minute per request
const HEALTH_POLL_INTERVAL_MS = 500
const MAX_HEALTH_POLL_RETRIES = 240 // 2 minutes total

/**
 * Sigmoid function to normalize raw logits to [0, 1] range.
 */
function _sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Implements the IReranker interface using a dedicated LlamaCPP reranker model.
 *
 * Two modes:
 * 1. **Direct mode** (default): Uses node-llama-cpp's createRankingContext + rank() for cross-encoder reranking.
 * 2. **Server mode** (server=true): Auto-starts a llama.cpp server process and uses its /v1/rerank HTTP endpoint.
 */
export class LlamaCppReranker implements IReranker {
  private readonly modelPath: string
  private readonly server: boolean
  private readonly serverBinPath: string
  private readonly logger?: LoggerLike

  // Direct mode (node-llama-cpp)
  private _model: LlamaModel | null = null
  private _rankingContext: LlamaRankingContext | null = null
  private _loadingPromise: Promise<void> | null = null

  // Server mode (HTTP)
  private _serverProcess: ChildProcess | null = null
  private _serverPort: number | null = null
  private _serverReadyPromise: Promise<void> | null = null
  private _serverUrl: string = ""

  constructor(modelPath: string, server: boolean = false, serverBinPath: string = "", logger?: LoggerLike) {
    this.modelPath = modelPath
    this.server = server
    this.serverBinPath = serverBinPath
    this.logger = logger
  }

  // ─── Direct Mode (node-llama-cpp) ──────────────────────────────────────

  private async _ensureModel(): Promise<void> {
    if (this.server) return
    if (this._rankingContext) return
    if (this._loadingPromise) return this._loadingPromise

    this._loadingPromise = (async () => {
      this.logger?.debug(`[LlamaCppReranker] Loading model: ${this.modelPath}`)
      const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
      this._model = await llama.loadModel({ modelPath: this.modelPath })
      this._rankingContext = await this._model.createRankingContext()
      this.logger?.debug(`[LlamaCppReranker] Model loaded`)
    })()

    return this._loadingPromise
  }

  // ─── Server Mode (llama.cpp HTTP server) ───────────────────────────────

  /**
   * Find a random available TCP port.
   */
  private async _findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, () => {
        const address = srv.address()
        if (address && typeof address === "object") {
          const port = address.port
          srv.close(() => resolve(port))
        } else {
          reject(new Error("Failed to get port from net.Server"))
        }
      })
      srv.on("error", reject)
    })
  }

  /**
   * Find the llama-server binary path bundled with node-llama-cpp.
   */
  private async _findServerBinary(): Promise<string> {
    // If user configured a path, use it
    if (this.serverBinPath) {
      if (fs.existsSync(this.serverBinPath)) {
        this.logger?.debug(`[LlamaCppReranker] Using configured llama-server path: ${this.serverBinPath}`)
        return this.serverBinPath
      }
      this.logger?.warn(`[LlamaCppReranker] Configured path not found: ${this.serverBinPath}, trying fallback`)
    }

    // Check hardcoded fallback path
    const hardcodedPath = "/Users/anrgct/workspace/llama.cpp/build/bin/llama-server"
    if (fs.existsSync(hardcodedPath)) {
      this.logger?.debug(`[LlamaCppReranker] Found llama-server at fallback path: ${hardcodedPath}`)
      return hardcodedPath
    }

    // Fallback: try in PATH
    this.logger?.warn(`[LlamaCppReranker] llama-server not found, trying PATH`)
    return "llama-server"
  }

  /**
   * Start the llama.cpp server process and wait for it to be ready.
   */
  private async _ensureServer(): Promise<void> {
    if (this._serverReadyPromise) return this._serverReadyPromise
    if (this._serverProcess && this._serverPort) return

    this._serverReadyPromise = (async () => {
      const port = await this._findFreePort()
      this._serverPort = port
      this._serverUrl = `http://localhost:${port}`

      const binaryPath = await this._findServerBinary()

      this.logger?.info(`[LlamaCppReranker] Starting llama-server on port ${port} with model: ${this.modelPath}`)

      this._serverProcess = spawn(binaryPath, [
        "-m", this.modelPath,
        "--port", String(port),
        "--host", "127.0.0.1",
        "--reranking",
        "--ubatch-size", "2048",
        // Minimal: only run the rerank endpoint
        "--no-webui",
        "--cont-batching",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        // Don't crash if the process exits unexpectedly
        detached: false,
      })

      // Unref so the child process doesn't keep the Node.js event loop alive
      this._serverProcess.unref()

      // Register cleanup handlers to kill the server on Node exit
      const cleanup = () => this.dispose()
      process.on("exit", cleanup)
      process.on("SIGINT", cleanup)
      process.on("SIGTERM", cleanup)
      // Store cleanup reference so we can remove it later
      ;(this._serverProcess as any)._cleanup = cleanup

      const out = this._serverProcess.stdout as any
      if (out) {
        out.on("data", (data: Buffer) => {
          this.logger?.debug(`[llama-server stdout] ${data.toString().trim()}`)
        })
        out.unref()
      }

      const err = this._serverProcess.stderr as any
      if (err) {
        err.on("data", (data: Buffer) => {
          this.logger?.debug(`[llama-server stderr] ${data.toString().trim()}`)
        })
        err.unref()
      }

      this._serverProcess.on("exit", (code, signal) => {
        this.logger?.warn(`[LlamaCppReranker] llama-server exited (code=${code}, signal=${signal})`)
        this._serverProcess = null
        this._serverReadyPromise = null
      })

      this._serverProcess.on("error", (err) => {
        this.logger?.error(`[LlamaCppReranker] llama-server error: ${err.message}`)
        this._serverProcess = null
        this._serverReadyPromise = null
      })

      // Wait for server to be ready by polling the health endpoint
      await this._waitForServerReady()

      this.logger?.info(`[LlamaCppReranker] llama-server ready at ${this._serverUrl}`)
    })()

    return this._serverReadyPromise
  }

  /**
   * Poll the /health endpoint until the server responds.
   */
  private async _waitForServerReady(): Promise<void> {
    for (let i = 0; i < MAX_HEALTH_POLL_RETRIES; i++) {
      try {
        const response = await fetch(`${this._serverUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS),
        })
        if (response.ok) {
          return
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
    }
    throw new Error(
      `LlamaCPP server did not become ready within ${(MAX_HEALTH_POLL_RETRIES * HEALTH_POLL_INTERVAL_MS) / 1000}s`
    )
  }

  /**
   * Send a rerank request to the llama.cpp server's /v1/rerank endpoint.
   * Follows the Cohere-compatible rerank API format.
   */
  private async _serverRerank(query: string, docs: string[]): Promise<number[]> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), RERANK_REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(`${this._serverUrl}/v1/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          documents: docs,
          top_n: docs.length,
          return_documents: false,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown")
        throw new Error(`LlamaCPP server rerank failed (${response.status}): ${errorBody}`)
      }

      const data = await response.json() as {
        results: Array<{ index: number; relevance_score: number }>
      }

      this.logger?.debug(`[LlamaCppReranker] Raw response: ${JSON.stringify(data)}`)

      if (!data.results || !Array.isArray(data.results)) {
        throw new Error("Invalid rerank response: missing results array")
      }

      // Build a map of index → score
      const scoreMap = new Map<number, number>()
      for (const result of data.results) {
        scoreMap.set(result.index, result.relevance_score)
      }

      const rawScores = docs.map((_, i) => scoreMap.get(i) ?? 0)

      // Step 1: if scores are raw logits (outside [0,1]), apply sigmoid
      const needsSigmoid = rawScores.some((s) => s < 0) || rawScores.some((s) => s > 1)
      const normalized = needsSigmoid
        ? rawScores.map((s) => _sigmoid(s))
        : rawScores
      if (needsSigmoid) {
        this.logger?.debug(`[LlamaCppReranker] Scores are raw logits, applied sigmoid`)
      }

      // Step 2: scale to [0,10]
      return normalized.map((s) => s * 10)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ─── IReranker Interface ──────────────────────────────────────────────

  async rerank(query: string, candidates: RerankerCandidate[]): Promise<RerankerResult[]> {
    if (candidates.length === 0) return []

    if (this.server) {
      // ── Server mode ──
      await this._ensureServer()
      const docs = candidates.map((c) => c.content)
      const ranked = await this._serverRerank(query, docs)
      this.logger?.debug(`[LlamaCppReranker] Server rerank scores: ${ranked}`)

      // The rerank results are already in the order of input candidates
      return candidates.map((candidate, index) => ({
        id: candidate.id,
        score: ranked[index] ?? 0,
        originalScore: candidate.score,
        payload: candidate.payload,
      }))
    } else {
      // ── Direct mode (node-llama-cpp) ──
      await this._ensureModel()

      const docs = candidates.map((c) => c.content)
      const rawRanked = await this._rankingContext!.rankAll(query, docs)
      this.logger?.debug(`[LlamaCppReranker] rerank scores: ${rawRanked}`)

      // Apply same normalization as _serverRerank: sigmoid if raw logits -> scale to [0,10]
      const needsSigmoid = rawRanked.some((s) => s < 0) || rawRanked.some((s) => s > 1)
      const normalized = needsSigmoid
        ? rawRanked.map((s) => _sigmoid(s))
        : rawRanked
      const ranked = normalized.map((s) => s * 10)
      if (needsSigmoid) {
        this.logger?.debug(`[LlamaCppReranker] rerank scores are raw logits, applied sigmoid: ${ranked}`)
      }

      return candidates.map((candidate, index) => ({
        id: candidate.id,
        score: ranked[index] ?? 0,
        originalScore: candidate.score,
        payload: candidate.payload,
      }))
    }
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    if (this.server) {
      // ── Server mode ──
      try {
        const binaryPath = await this._findServerBinary()
        // Check binary exists
        const absPath = path.isAbsolute(binaryPath) ? binaryPath : await this._resolveBinaryInPath(binaryPath)
        if (!fs.existsSync(absPath)) {
          return { valid: false, error: `llama-server binary not found at: ${binaryPath}` }
        }
        // Check model exists
        if (!fs.existsSync(this.modelPath)) {
          return { valid: false, error: `Reranker model file not found: ${this.modelPath}` }
        }
        return { valid: true }
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : "LlamaCPP server validation failed",
        }
      }
    } else {
      // ── Direct mode ──
      try {
        if (!fs.existsSync(this.modelPath)) {
          return { valid: false, error: `LlamaCPP reranker model file not found: ${this.modelPath}` }
        }
        await this._ensureModel()
        return { valid: true }
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : "LlamaCPP reranker validation failed",
        }
      }
    }
  }

  get rerankerInfo(): RerankerInfo {
    return {
      name: "llamacpp",
      model: this.modelPath,
    }
  }

  /**
   * Clean up resources. Stops the server process if running.
   * Call this when the reranker is no longer needed.
   */
  dispose(): void {
    if (this._serverProcess) {
      // Remove process-level listeners to avoid leaks
      const cleanup = (this._serverProcess as any)._cleanup
      if (cleanup) {
        process.off("exit", cleanup)
        process.off("SIGINT", cleanup)
        process.off("SIGTERM", cleanup)
      }

      this.logger?.info(`[LlamaCppReranker] Stopping llama-server process`)
      try {
        this._serverProcess.kill("SIGTERM")
      } catch {
        // Process already exited
      }
      this._serverProcess = null
      this._serverReadyPromise = null
      this._serverPort = null
      this._serverUrl = ""
    }
  }

  /**
   * Resolve a command name to its full path using PATH environment.
   */
  private async _resolveBinaryInPath(binary: string): Promise<string> {
    const envPath = process.env["PATH"] || ""
    const dirs = envPath.split(path.delimiter)
    for (const dir of dirs) {
      const candidate = path.join(dir, binary)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
    return binary
  }
}
