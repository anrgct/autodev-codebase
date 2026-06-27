/**
 * Escalate proxy — type definitions
 *
 * Public types for the auto-escalation HTTP proxy that injects the
 * `ESCALATION_CONTRACT` into upstream LLM requests, watches for
 * `<<<NEEDS_PRO>>>` markers in the first response chunk, and transparently
 * retries the call on a stronger model.
 */

/**
 * Resolved proxy configuration — every field is required.
 * Built by merging the three-layer config (default → global → project → CLI overrides).
 */
export interface EscalateConfig {
  /** Escalation mode: how the proxy decides to switch tiers. */
  mode: EscalationMode
  /** Upstream OpenAI-compatible API base URL (no trailing slash). */
  apiBase: string
  /**
   * API key used when calling the upstream.
   * `undefined` means: forward the client's `Authorization: Bearer ...` header as-is.
   */
  apiKey: string | undefined
  /** Cheap / fast model used for the first attempt. */
  flashModel: string
  /** Stronger model used after `<<<NEEDS_PRO>>>` is detected. */
  proModel: string
  /** Local proxy listening port. */
  port: number
  /** Local proxy listening host. */
  host: string
  /**
   * TTL for sticky pro entries in milliseconds (default: 300_000 = 5 min).
   * After this period of inactivity the conversation decays back to flash.
   * Set to 0 to disable sticky pro entirely.
   */
  stickyProTtlMs: number
}

/**
 * Reason the final model was selected for a request.
 *
 *  - `self-report` — flash model emitted `<<<NEEDS_PRO>>>` in its first line
 *  - `downgrade`  — pro model emitted `<<<NEEDS_FLASH>>>` in its first line
 *  - `advisor`    — flash model called the virtual `advisor` tool; the proxy
 *                   intercepted the call, queried pro, and returned the result
 *                   to flash as a `tool` message before delivering flash's
 *                   final answer. Path will be e.g. `['flash', 'pro', 'flash']`.
 *  - `passthrough` — no escalation was triggered, response was proxied as-is (stream)
 *  - `non-stream`  — non-streaming request, response fully buffered then proxied
 *  - `error`       — upstream returned a non-2xx status
 */
export type EscalationReason = 'self-report' | 'downgrade' | 'advisor' | 'passthrough' | 'non-stream' | 'error'

/**
 * Escalation mode.
 *
 * - `self-report` (default): inject the ESCALATION_CONTRACT into the system
 *   prompt; the flash model self-reports `<<<NEEDS_PRO>>>` when it decides
 *   the task needs the stronger tier.
 * - `advisor`: inject a virtual `advisor` tool definition into the request
 *   alongside the contract. When the flash model calls `advisor`, the proxy
 *   intercepts the call, forwards the question to the pro model, and returns
 *   pro's analysis as a `tool` message so flash can synthesize the final
 *   answer.
 */
export type EscalationMode = 'self-report' | 'advisor'

/**
 * Result of dispatching a single chat-completion request.
 */
export interface DispatchResult {
  /** Final model that produced the response (`flash` or `pro`). */
  finalModel: 'flash' | 'pro'
  /** Why this final model was selected. */
  reason: EscalationReason
  /**
   * The path the request took through the tiers — useful for telemetry and
   * debugging. Examples: `['flash']`, `['flash', 'pro']`, `['flash', 'pro', 'flash']`.
   */
  path: Array<'flash' | 'pro'>
  /** Upstream HTTP status code. */
  status: number
  /** Upstream response headers (with `X-Escalated-*` annotations appended). */
  headers: Record<string, string>
  /** Upstream response body. For streaming responses this is a `ReadableStream<Uint8Array>`; otherwise a `Buffer`. */
  body: Buffer | ReadableStream<Uint8Array>
  /** `true` when the response is an SSE stream. */
  isStream: boolean
}
