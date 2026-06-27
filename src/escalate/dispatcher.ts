/**
 * Dispatcher — request forwarding, escalation, downgrade, streaming peek-and-passthrough.
 *
 * Responsibilities:
 *   1. Send the request to the upstream API (with the appropriate tier
 *      contract injected into the system prompt and the `model` field set
 *      to the target tier ID).
 *   2. For non-stream responses: read the whole body, look for the
 *      `<<<NEEDS_PRO>>>` (flash → pro escalation) or `<<<NEEDS_FLASH>>>`
 *      (pro → flash downgrade) marker, and switch tiers accordingly.
 *   3. For stream responses: read a tiny peek buffer (up to PEEK_MAX_CHARS
 *      of accumulated SSE delta content), look for the marker, and:
 *        - on match: cancel the current stream, retry against the other
 *          tier, return its stream
 *        - on no match: passthrough the buffered chunk and pipe the rest
 *          of the original stream to the client.
 *
 * The peek-and-passthrough design keeps the latency overhead of the proxy
 * at ~50ms in the common (no-switch) case while still allowing a clean
 * tier switch when the model self-reports.
 *
 * Path tracking:
 *   - `['flash']` — flash response, no switch
 *   - `['flash', 'pro']` — flash escalated to pro
 *   - `['flash', 'pro', 'flash']` — flash escalated, then pro downgraded
 *   - (the pro-downgrade case is rare but supported)
 */

import { fetch, Pool, type Dispatcher } from 'undici'
import {
  ADVISOR_TOOL_NAME,
  injectAdvisorTool,
  injectContract,
  type ChatCompletionRequestBody,
  type ChatCompletionMessage,
} from './contract'
import { detectEscalationMarker, detectMarkerPrefix, stripNeedsProMarker } from './detector'
import { SseLineBuffer, type SseLine } from './sse-buffer'
import type { DispatchResult, EscalateConfig } from './types'
import { StickyStore } from './sticky'

/**
 * Default upstream request timeout (2 minutes).
 */
const UPSTREAM_TIMEOUT_MS = 120_000

/**
 * Hard ceiling on how much `delta.content` we accumulate in the streaming
 * peek loop before forcing a decision. In practice `detectMarkerPrefix`
 * decides within the first 1–2 content chunks (an immediate `no-marker` once
 * the first char isn't `<`), so this is just a safety net against pathological
 * upstreams that emit a very long partial marker prefix.
 */
const PEEK_MAX_CONTENT_CHARS = 1024

/**
 * Try to extract the assistant message content from an OpenAI-compatible
 * chat-completion response body. If the body is JSON in the expected shape,
 * return `choices[0].message.content` (string). If it's not a chat
 * completion, or the body is plain text, return the original input verbatim.
 */
function extractChatContent(body: string): string {
  if (!body || body[0] !== '{') return body
  try {
    const parsed = JSON.parse(body)
    const choices = parsed?.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const c0 = choices[0]
      const content = c0?.message?.content ?? c0?.text ?? c0?.delta?.content
      if (typeof content === 'string') return content
    }
  } catch {
    // Not JSON; treat the body as raw text.
  }
  return body
}

/** Internal — never throw across the dispatcher boundary; convert to a structured error result. */
export class DispatcherError extends Error {
  constructor(message: string, public readonly status: number = 502) {
    super(message)
    this.name = 'DispatcherError'
  }
}

export interface DispatcherOptions {
  config: EscalateConfig
  logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void }
  /** Override the underlying fetch (used in tests). */
  fetchImpl?: typeof fetch
  /** Override the undici Pool (used in tests). */
  dispatcher?: Dispatcher
}

/**
 * Build the upstream request headers from the client's headers and our config.
 *
 * Authorization priority:
 *   1. If `config.apiKey` is set, use it (overriding the client).
 *   2. Otherwise forward the client's Authorization header verbatim.
 *   3. If neither is set, send no Authorization header.
 *
 * Hop-by-hop headers (Connection, Keep-Alive, Proxy-*, TE, etc.) and the
 * Host header are dropped.
 */
function buildUpstreamHeaders(clientHeaders: Record<string, string | string[] | undefined>, config: EscalateConfig): Record<string, string> {
  const out: Record<string, string> = {}
  // Hop-by-hop / unsafe-to-forward headers
  const DROP = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length'
  ])
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (DROP.has(lk)) continue
    if (lk === 'authorization' && config.apiKey) continue // we will set our own
    out[lk] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  if (config.apiKey) {
    out['authorization'] = `Bearer ${config.apiKey}`
  }
  if (!out['content-type']) {
    out['content-type'] = 'application/json'
  }
  if (!out['accept']) {
    out['accept'] = 'application/json'
  }
  return out
}

/** Build upstream response headers — same drop rules + inject our annotation headers. */
function buildResponseHeaders(upstreamHeaders: Headers | Record<string, string | string[] | undefined>, extras: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const DROP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
  ])
  const iter = upstreamHeaders instanceof Headers
    ? Array.from(upstreamHeaders.entries())
    : Object.entries(upstreamHeaders)
  for (const [k, v] of iter) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (DROP.has(lk)) continue
    // Strip content-length — we may not match the upstream body byte-for-byte.
    if (lk === 'content-length') continue
    out[lk] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  for (const [k, v] of Object.entries(extras)) {
    out[k.toLowerCase()] = v
  }
  return out
}

/** Convert undici Headers-like to a plain Record. */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers.entries()) {
    out[k] = v
  }
  return out
}

/**
 * Extract messages from a parsed body, returning null on missing/invalid data.
 */
function extractMessages(rawBody: unknown): ChatCompletionMessage[] | null {
  if (!rawBody || typeof rawBody !== 'object') return null
  const body = rawBody as Record<string, unknown>
  const msgs = body['messages']
  if (!Array.isArray(msgs)) return null
  return msgs as ChatCompletionMessage[]
}


/**
 * Shape of a tool call attached to an assistant message, after delta accumulation.
 * Matches the OpenAI streaming + non-streaming chat-completion format.
 */
interface NormalizedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Find the first `advisor` tool call attached to an assistant message's
 * `tool_calls` array, returning the normalized shape (or null if no advisor
 * call is present). Returns null if the message is not an assistant message
 * or has no tool calls.
 */
export function extractAdvisorToolCall(
  message: ChatCompletionMessage | undefined | null
): NormalizedToolCall | null {
  if (!message || message.role !== 'assistant') return null
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return null
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue
    if (c.function?.name !== ADVISOR_TOOL_NAME) continue
    const id = typeof c.id === 'string' && c.id.length > 0
      ? c.id
      : `advisor-${Math.random().toString(36).slice(2, 10)}`
    return {
      id,
      type: 'function',
      function: {
        name: ADVISOR_TOOL_NAME,
        arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '',
      },
    }
  }
  return null
}

/**
 * Extract ALL `advisor` tool calls from an assistant message (not just the
 * first one). Returns an empty array if the message has no advisor tool calls.
 */
export function extractAllAdvisorToolCalls(
  message: ChatCompletionMessage | undefined | null
): NormalizedToolCall[] {
  if (!message || message.role !== 'assistant') return []
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return []
  const results: NormalizedToolCall[] = []
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue
    if (c.function?.name !== ADVISOR_TOOL_NAME) continue
    const id = typeof c.id === 'string' && c.id.length > 0
      ? c.id
      : `advisor-${Math.random().toString(36).slice(2, 10)}`
    results.push({
      id,
      type: 'function',
      function: {
        name: ADVISOR_TOOL_NAME,
        arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '',
      },
    })
  }
  return results
}

/**
 * Parse the `question` parameter out of an advisor tool call's JSON arguments.
 * Returns `undefined` if the arguments are not valid JSON or the field is missing.
 */
export function extractAdvisorQuestion(toolCall: NormalizedToolCall): string | undefined {
  const raw = toolCall.function.arguments
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { question?: unknown }
    if (typeof parsed.question === 'string' && parsed.question.length > 0) {
      return parsed.question
    }
  } catch {
    // Fall through — treat the raw arguments as the question (model may have
    // emitted plain text instead of a JSON object).
  }
  return raw
}

/**
 * Best-effort JSON parse of a chat-completion response body. Returns null
 * if the body is not valid JSON or doesn't have a `choices[0]` array.
 */
function safeParseChatCompletion(body: string): { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: unknown; delta?: Record<string, unknown> }> } | null {
  if (!body || body[0] !== '{') return null
  try {
    const parsed = JSON.parse(body) as { choices?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.choices)) return null
    return parsed as { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: unknown; delta?: Record<string, unknown> }> }
  } catch {
    return null
  }
}

/**
 * Build a synthetic SSE `data:` chunk that marks the start of a pro-as-advisor
 * consultation. Injected into the client's reasoning_content stream so the
 * think panel shows a clear visual separator.
 */
function buildAdvisorBeginEvent(question?: string): Uint8Array {
  const label = question
    ? `[proxy: consulting advisor (pro): ${question}]`
    : '[proxy: consulting advisor (pro)]'
  const text = `\n\n--- ${label} ---\n\n`
  const payload = {
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  }
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf-8')
}

/**
 * Build a synthetic SSE `data:` chunk that marks the end of a pro-as-advisor
 * consultation and the return to flash.
 */
function buildAdvisorEndEvent(): Uint8Array {
  const text = `\n\n--- [proxy: back to flash with advisor analysis] ---\n\n`
  const payload = {
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  }
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf-8')
}


/** Normalize `apiBase` to remove trailing slash. */
function normalizeBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '')
}

/**
 * Build the annotation headers we attach to the upstream response so
 * clients (and their UIs) can see what the proxy actually did.
 */
function annotationHeaders(opts: {
  finalModel: 'flash' | 'pro'
  switchedFrom?: 'flash' | 'pro'
  path: Array<'flash' | 'pro'>
  reason?: string
}): Record<string, string> {
  const switchedFrom = opts.switchedFrom ?? opts.finalModel
  const out: Record<string, string> = {
    'X-Escalated-To': opts.finalModel,
    'X-Escalated-From': switchedFrom,
    'X-Escalation-Path': opts.path.join('->'),
  }
  if (opts.reason) {
    out['X-Escalation-Reason'] = sanitizeHeaderValue(opts.reason)
  }
  return out
}

/**
 * Sanitize a value for use in an HTTP header — URL-encode any character
 * outside the printable ASCII range (0x20–0x7E).
 *
 * Also collapses internal whitespace runs to a single space and strips
 * leading/trailing whitespace, ensuring the value is a single line
 * without leading/trailing whitespace (per RFC 7230).
 */
function sanitizeHeaderValue(raw: string): string {
  if (!raw) return raw
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  let out = ''
  for (let i = 0; i < collapsed.length; i++) {
    const cp = collapsed.charCodeAt(i)
    if (cp >= 0x20 && cp <= 0x7e) {
      out += collapsed[i]
    } else {
      out += encodeURIComponent(collapsed[i])
    }
  }
  return out
}

/** Concatenate two Uint8Arrays (null-safe). */
function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (a === null) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Build a synthetic SSE `data:` chunk that injects a visible separator into
 * the client's `reasoning_content` (think) stream — a concise statement of
 * the tier switch and the resulting current tier, rendered in the same UI
 * region where the prior model's reasoning was shown.
 *
 * Format: `--- [proxy: now on <to> (was <from>; <reason>)] ---`
 * States the current tier plainly so the model (and the user reading the
 * think panel) knows where the request now sits, without any command-style
 * directives.
 */
function buildTierSwitchEvent(from: 'flash' | 'pro', to: 'flash' | 'pro', reason?: string): Uint8Array {
  const detail = reason ? `; ${reason}` : ''
  const text = `\n\n--- [proxy: now on ${to} (was ${from}${detail})] ---\n\n`
  const payload = {
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  }
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf-8')
}

/**
 * Build a synthetic SSE tail that delivers a proxy-side error to the client
 * as a normal-looking assistant `content` delta followed by `[DONE]`. Used
 * when an upstream retry fails mid-stream and we have nothing else to send.
 */
function buildProxyErrorEvent(status: number, message: string): Uint8Array {
  const trimmed = (message ?? '').slice(0, 200)
  const text = `[proxy error: upstream returned ${status}${trimmed ? `: ${trimmed}` : ''}]`
  const payload = {
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  }
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, 'utf-8')
}

/**
 * Drain a reader into a WritableStreamDefaultController until the reader is
 * done. Used after a tier switch to forward the final tier's response with
 * no further marker inspection.
 */
async function pumpReaderToController(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    if (value) controller.enqueue(value)
  }
}

/**
 * Flush remaining lines from `lines[startIdx]` onward into the controller.
 * Used when peekTierStream switches to passthrough mode mid-chunk to ensure
 * no SSE events from the current TCP chunk are dropped.
 */
function flushRemainingLines(
  controller: ReadableStreamDefaultController<Uint8Array>,
  lines: SseLine[],
  startIdx: number
): void {
  for (let i = startIdx; i < lines.length; i++) {
    try { controller.enqueue(lines[i].bytes) } catch { /* noop */ }
  }
}

export class EscalateDispatcher {
  private readonly config: EscalateConfig
  private readonly logger: NonNullable<DispatcherOptions['logger']>
  private readonly fetchImpl: typeof fetch
  private readonly pool: Dispatcher | undefined
  /** Sticky pro session store (null when disabled). */
  private readonly stickyStore: StickyStore | null

  constructor(opts: DispatcherOptions) {
    this.config = opts.config
    this.logger = opts.logger ?? {}
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch)
    this.pool = opts.dispatcher
    this.stickyStore = this.config.stickyProTtlMs > 0
      ? new StickyStore({ ttlMs: this.config.stickyProTtlMs })
      : null
    if (this.stickyStore) {
      this.stickyStore.startCleanup()
    }
  }

  /**
   * Build a flash request body — inject the flash-side contract, force model.
   */
  private buildFlashBody(rawBody: unknown): ChatCompletionRequestBody {
    const body = (rawBody ?? {}) as ChatCompletionRequestBody
    return injectContract(body, this.config.flashModel, this.config.proModel)
  }

  /**
   * Build a pro request body — inject the pro-side contract (which teaches
   * the model about the `<<<NEEDS_FLASH>>>` downgrade marker), force model.
   */
  private buildProBody(rawBody: unknown): ChatCompletionRequestBody {
    const body = (rawBody ?? {}) as ChatCompletionRequestBody
    // Second arg is the pro model ID — same as target here since the
    // target IS the pro model. The contract generator uses this to know
    // it's targeting the pro tier.
    return injectContract(body, this.config.proModel, this.config.proModel)
  }

  /**
   * Build a body targeted at a specific tier (used by downgrade retry to
   * flash after a successful pro escalation). Same injection as the
   * original flash call.
   */
  private buildFlashRetryBody(rawBody: unknown): ChatCompletionRequestBody {
    return this.buildFlashBody(rawBody)
  }

  // ----------------------------------------------------------------------
  // Advisor mode body builders
  // ----------------------------------------------------------------------

  /**
   * Build a flash body for advisor mode: append the `advisor` tool definition
   * and the advisor usage fragment to the request. Used on every flash turn,
   * including retries, so the model can call `advisor` again if it is still
   * uncertain after receiving pro's analysis.
   *
   * Note: this intentionally does NOT call `injectContract()`. Advisor mode
   * uses the `advisor` tool exclusively; the `<<<NEEDS_PRO>>>` text marker
   * is a different escalation strategy (self-report mode) and the advisor
   * fragment explicitly tells the model the marker is NOT active here.
   * Injecting both would confuse the model about which escalation channel
   * to use.
   */
  private buildFlashAdvisorBody(
    rawBody: unknown,
    messages?: ChatCompletionMessage[]
  ): ChatCompletionRequestBody {
    const base = (rawBody ?? {}) as ChatCompletionRequestBody
    // If `messages` is provided (e.g. carrying a previous `tool_calls` +
    // `tool` round), override the inbound messages so the assistant message
    // history is consistent with what flash actually emitted.
    const bodyWithMessages: ChatCompletionRequestBody = messages
      ? { ...base, messages }
      : base
    // Force the model field to the flash ID. We can't rely on
    // `injectContract()` here because advisor mode deliberately skips it —
    // so we set the model ourselves.
    const withModel: ChatCompletionRequestBody = { ...bodyWithMessages, model: this.config.flashModel }
    return injectAdvisorTool(withModel)
  }

  /**
   * Build a pro body for advisor mode: target the pro model and STRIP ALL
   * tools. Pro is a passive advisor — it should NOT have access to the
   * `advisor` tool definition (that's flash's privilege) or any client
   * tools. Strip `tool_choice` as well (irrelevant without tools).
   *
   * Note: this does NOT inject the self-report tier-switch contract. Advisor
   * mode is independent of the `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>`
   * markers, so we don't pollute pro's system prompt with explanations of
   * markers it will never use. If the client supplied a `system` message it
   * carries through untouched.
   */
  private buildProAdvisorBody(
    rawBody: unknown,
    messages: ChatCompletionMessage[]
  ): ChatCompletionRequestBody {
    const base = (rawBody ?? {}) as ChatCompletionRequestBody
    // Strip ALL tools and tool_choice — pro is a passive advisor.
    const {
      tools: _tools,
      tool_choice: _tc,
      ...rest
    } = {
      ...base,
      messages,
      model: this.config.proModel,
    } as ChatCompletionRequestBody & { tool_choice?: unknown }
    void _tools
    void _tc
    return rest as ChatCompletionRequestBody
  }


  /**
   * Make a single upstream call and return the raw Response.
   * Caller is responsible for reading the body and handling errors.
   */
  private async callUpstream(
    body: ChatCompletionRequestBody,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<Response> {
    const url = `${normalizeBase(this.config.apiBase)}/chat/completions`
    const headers = buildUpstreamHeaders(clientHeaders, this.config)
    const init: Record<string, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }
    if (this.pool) {
      init['dispatcher'] = this.pool
    }
    // undici.fetch returns its own Response; cast through unknown to the global Response.
    // The init cast is needed because undici's RequestInit and the global RequestInit
    // disagree on Blob types under the project's TS lib config.
    return (await this.fetchImpl(url, init as never)) as unknown as Response
  }

  // ----------------------------------------------------------------------
  // Advisor history helpers — rewrite tool_calls that arrived without
  // tool messages in the client's request body. We turn each orphaned
  // advisor call into a `user` message that says "you previously tried to
  // ask the advisor this; please answer directly now". This avoids the
  // deepseek 400 ("An assistant message with 'tool_calls' must be
  // followed by tool messages") without inventing a fake pro response.
  // ----------------------------------------------------------------------

  /**
   * Walk the inbound `messages` and rewrite any assistant message whose
   * `tool_calls` include an `advisor` call with no matching `role:'tool'`
   * message after it.
   *
   * The orphaned advisor call is replaced with a `user` message that
   * surfaces the question and asks the model to answer directly:
   *
   *   user: [Earlier you attempted to call the advisor tool with the
   *         following question]: <question text>
   *         Please proceed with your best answer based on your own analysis.
   *
   * Any non-advisor tool_calls on the same assistant message are preserved
   * (they belong to the client's tool surface, not to our proxy).
   */
  private rewriteOrphanedAdvisorCalls(
    messages: ChatCompletionMessage[]
  ): ChatCompletionMessage[] {
    const result: ChatCompletionMessage[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      // Quick path: not an assistant message with tool_calls.
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
        result.push(m)
        continue
      }

      // Look forward for any matching tool message.
      const laterToolIds = new Set<string>()
      for (let j = i + 1; j < messages.length; j++) {
        const lm = messages[j]
        if (lm.role === 'tool' && typeof lm.tool_call_id === 'string') {
          laterToolIds.add(lm.tool_call_id)
        }
      }

      const advisorCalls = m.tool_calls.filter(
        (tc) => tc && typeof tc === 'object' && tc.function?.name === ADVISOR_TOOL_NAME
      )
      const nonAdvisorCalls = m.tool_calls.filter(
        (tc) => !(tc && typeof tc === 'object' && tc.function?.name === ADVISOR_TOOL_NAME)
      )

      const orphanedAdvisorCalls = advisorCalls.filter(
        (tc) => typeof tc.id !== 'string' || !laterToolIds.has(tc.id)
      )

      if (orphanedAdvisorCalls.length === 0) {
        // Nothing to rewrite — keep the assistant message as-is.
        result.push(m)
        continue
      }

      // Build the user prompt that surfaces each orphaned advisor question.
      const questions = orphanedAdvisorCalls.map((tc) => {
        const raw = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}'
        try {
          const parsed = JSON.parse(raw) as { question?: unknown }
          return typeof parsed.question === 'string' && parsed.question.length > 0
            ? parsed.question
            : raw
        } catch {
          return raw
        }
      })
      const plural = questions.length > 1 ? 's' : ''
      const list = questions.map((q) => `- ${q}`).join('\n')
      const userPrompt =
        `[Earlier you attempted to call the advisor tool with the following question${plural}]:\n${list}\n\n` +
        `Please proceed with your best answer based on your own analysis.`

      result.push({ role: 'user', content: userPrompt })

      // If the assistant message had non-advisor tool_calls, preserve them
      // on a separate assistant message — they belong to the client.
      if (nonAdvisorCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: m.content,
          tool_calls: nonAdvisorCalls,
        })
      }
    }
    return result
  }


  /**
   * Dispatch a chat-completion request, applying flash ↔ pro switching
   * (escalation + downgrade) as needed.
   *
   * @param rawBody     Parsed JSON body of the inbound request.
   * @param isStream    Whether the client requested `stream: true` (SSE).
   * @param clientHeaders  Headers from the inbound request (for forwarding Authorization, etc.).
   */
  async dispatch(
    rawBody: unknown,
    isStream: boolean,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    // Advisor mode routes through a different dispatcher (tool-call interception
    // instead of self-report markers); sticky pro does not apply because flash
    // is always in control in advisor mode.
    if (this.config.mode === 'advisor') {
      if (isStream) {
        return this.dispatchAdvisorStream(rawBody, clientHeaders)
      }
      return this.dispatchAdvisorNonStream(rawBody, clientHeaders)
    }

    // Sticky pro: if this conversation prefix was recently escalated, skip flash.
    if (this.stickyStore) {
      const msgs = extractMessages(rawBody)
      if (msgs) {
        const sticky = this.stickyStore.lookup(msgs)
        if (sticky === 'pro') {
          this.logger.info?.(`[escalate] sticky pro HIT — dispatching directly to pro`)
          return this.dispatchDirectPro(rawBody, isStream, clientHeaders)
        }
      }
    }

    if (isStream) {
      return this.dispatchStream(rawBody, clientHeaders)
    }
    return this.dispatchNonStream(rawBody, clientHeaders)
  }

  /**
   * Direct pro dispatch — skip flash entirely because sticky pro hit.
   * For non-stream: just call pro and check for downgrade.
   * For stream: call pro stream, peek for NEEDS_FLASH, downgrade if needed.
   */
  private async dispatchDirectPro(
    rawBody: unknown,
    isStream: boolean,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    if (isStream) {
      return this.dispatchDirectProStream(rawBody, clientHeaders)
    }
    return this.dispatchDirectProNonStream(rawBody, clientHeaders)
  }

  private async dispatchDirectProNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders)
    const path: Array<'flash' | 'pro'> = ['pro']

    if (!proResp.ok) {
      const errBuf = Buffer.from(await proResp.arrayBuffer())
      // Upstream error on direct pro — clear sticky so next retry goes flash.
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      return {
        finalModel: 'pro',
        reason: 'error',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path })),
        body: errBuf,
        isStream: false,
      }
    }

    const proText = await proResp.text()
    const proContent = extractChatContent(proText)
    const proDetect = detectEscalationMarker(proContent)

    if (proDetect.matched && proDetect.direction === 'flash') {
      // Pro downgraded — clear sticky and retry on flash.
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      this.logger.info?.(`[escalate] sticky pro: pro downgraded (${proDetect.reason ?? 'bare'}) — retrying on flash`)
      const flashBody = this.buildFlashRetryBody(rawBody)
      const flashResp = await this.callUpstream(flashBody, clientHeaders)
      path.push('flash')

      if (!flashResp.ok) {
        const errBuf = Buffer.from(await flashResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'downgrade',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
            finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
          })),
          body: errBuf,
          isStream: false,
        }
      }
      const flashBuf = Buffer.from(await flashResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'downgrade',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
          finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
        })),
        body: flashBuf,
        isStream: false,
      }
    }

    // Pro kept — return response.
    return {
      finalModel: 'pro',
      reason: 'passthrough',
      path,
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path })),
      body: Buffer.from(stripNeedsProMarker(proText), 'utf-8'),
      isStream: false,
    }
  }

  private async dispatchDirectProStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders)

    // Upstream error on direct pro — clear sticky and pass the error through
    // as a non-stream body (with annotation headers, since we haven't started
    // streaming yet).
    if (!proResp.ok || !proResp.body) {
      const errBuf = proResp.body ? Buffer.from(await proResp.arrayBuffer()) : Buffer.from('')
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      return {
        finalModel: 'pro',
        reason: 'error',
        path: ['pro'],
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path: ['pro'] })),
        body: errBuf,
        isStream: false,
      }
    }

    const dispatcher = this
    const proReader = proResp.body.getReader()
    const msgs = extractMessages(rawBody)

    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // Pro peek — look for NEEDS_FLASH (downgrade).
          const proResult = await dispatcher.peekTierStream(controller, proReader, 'flash')
          if (proResult.outcome === 'done') {
            controller.close()
            return
          }

          // Pro → flash downgrade. Clear sticky so next request starts from flash.
          if (msgs) dispatcher.stickyStore?.clear(msgs)
          dispatcher.logger.info?.(`[escalate] sticky pro: <<<NEEDS_FLASH>>> detected — downgrading to flash`)

          controller.enqueue(buildTierSwitchEvent('pro', 'flash', proResult.reason))

          const flashBody = dispatcher.buildFlashRetryBody(rawBody)
          const flashResp = await dispatcher.callUpstream(flashBody, clientHeaders)
          if (!flashResp.ok || !flashResp.body) {
            const errText = flashResp.body ? await flashResp.text().catch(() => '') : ''
            controller.enqueue(buildProxyErrorEvent(flashResp.status, errText))
            controller.close()
            return
          }

          // Pump flash retry directly — no further peeking (avoid downgrade loops).
          await pumpReaderToController(flashResp.body.getReader(), controller)
          controller.close()
        } catch (err) {
          try {
            controller.enqueue(buildProxyErrorEvent(500, err instanceof Error ? err.message : String(err)))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
      async cancel(reason) {
        try { await proReader.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'pro',
      reason: 'passthrough',
      path: ['pro'],
      status: proResp.status,
      // Streaming responses no longer carry X-Escalated-* headers — see note
      // in dispatchStream.
      headers: buildResponseHeaders(proResp.headers, {}),
      body: passthrough,
      isStream: true,
    }
  }

  // ----------------------------------------------------------------------
  // Non-streaming path
  // ----------------------------------------------------------------------

  private async dispatchNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    // 1. Flash call.
    const flashBody = this.buildFlashBody(rawBody)
    const flashResp = await this.callUpstream(flashBody, clientHeaders)
    const path: Array<'flash' | 'pro'> = ['flash']

    if (!flashResp.ok) {
      const errBuf = Buffer.from(await flashResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'error',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: errBuf,
        isStream: false,
      }
    }

    const flashText = await flashResp.text()
    const flashContent = extractChatContent(flashText)
    const flashDetect = detectEscalationMarker(flashContent)

    if (!flashDetect.matched) {
      // No escalation. Strip a stray marker (paranoia) and pass through.
      return {
        finalModel: 'flash',
        reason: 'non-stream',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: Buffer.from(stripNeedsProMarker(flashText), 'utf-8'),
        isStream: false,
      }
    }

    if (flashDetect.direction !== 'pro') {
      // The flash model emitted a NEEDS_FLASH marker — unusual (flash shouldn't
      // know about that marker), but defensively treat it as no-op and passthrough.
      this.logger.warn?.(`[escalate] flash model emitted unexpected <<<NEEDS_FLASH>>> — treating as passthrough`)
      return {
        finalModel: 'flash',
        reason: 'non-stream',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: Buffer.from(stripNeedsProMarker(flashText), 'utf-8'),
        isStream: false,
      }
    }

    this.logger.info?.(`[escalate] <<<NEEDS_PRO>>> detected (${flashDetect.reason ?? 'bare'}) — retrying on pro`)

    // 2. Pro call (escalation).
    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders)
    path.push('pro')

    if (!proResp.ok) {
      const errBuf = Buffer.from(await proResp.arrayBuffer())
      return {
        finalModel: 'pro',
        reason: 'self-report',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({
          finalModel: 'pro', switchedFrom: 'flash', path, reason: flashDetect.reason ?? 'self-report',
        })),
        body: errBuf,
        isStream: false,
      }
    }

    const proText = await proResp.text()
    const proContent = extractChatContent(proText)
    const proDetect = detectEscalationMarker(proContent)

    // Sticky pro: record the upgrade so next request with same prefix skips flash.
    const msgs = extractMessages(rawBody)
    if (msgs) this.stickyStore?.storeUpgrade(msgs)

    if (proDetect.matched && proDetect.direction === 'flash') {
      this.logger.info?.(`[escalate] <<<NEEDS_FLASH>>> detected on pro (${proDetect.reason ?? 'bare'}) — downgrading to flash`)
      // Clear sticky — next request should start from flash again.
      if (msgs) this.stickyStore?.clear(msgs)

      // 3. Flash retry (downgrade).
      const flashRetryBody = this.buildFlashRetryBody(rawBody)
      const flashRetryResp = await this.callUpstream(flashRetryBody, clientHeaders)
      path.push('flash')

      if (!flashRetryResp.ok) {
        const errBuf = Buffer.from(await flashRetryResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'downgrade',
          path,
          status: flashRetryResp.status,
          headers: buildResponseHeaders(flashRetryResp.headers, annotationHeaders({
            finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
          })),
          body: errBuf,
          isStream: false,
        }
      }
      const flashRetryBuf = Buffer.from(await flashRetryResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'downgrade',
        path,
        status: flashRetryResp.status,
        headers: buildResponseHeaders(flashRetryResp.headers, annotationHeaders({
          finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
        })),
        body: flashRetryBuf,
        isStream: false,
      }
    }

    // No downgrade — return the pro response.
    return {
      finalModel: 'pro',
      reason: 'self-report',
      path,
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, annotationHeaders({
        finalModel: 'pro', switchedFrom: 'flash', path, reason: flashDetect.reason ?? 'self-report',
      })),
      body: Buffer.from(stripNeedsProMarker(proText), 'utf-8'),
      isStream: false,
    }
  }

  // ----------------------------------------------------------------------
  // Streaming path
  // ----------------------------------------------------------------------

  private async dispatchStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    const flashBody = this.buildFlashBody(rawBody)
    const flashResp = await this.callUpstream(flashBody, clientHeaders)

    // Upstream error — pass through as a non-stream body (annotation headers
    // are still available here because we haven't started streaming yet).
    if (!flashResp.ok || !flashResp.body) {
      const errBuf = flashResp.body
        ? Buffer.from(await flashResp.arrayBuffer())
        : Buffer.from('')
      return {
        finalModel: 'flash',
        reason: 'error',
        path: ['flash'],
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path: ['flash'] })),
        body: errBuf,
        isStream: false,
      }
    }

    const dispatcher = this
    const flashReader = flashResp.body.getReader()

    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // ---- Flash peek: forward reasoning immediately, inspect content. ----
          const flashResult = await dispatcher.peekTierStream(controller, flashReader, 'pro')
          if (flashResult.outcome === 'done') {
            controller.close()
            return
          }

          // ---- Switched: flash → pro. ----
          // Sticky pro: record the upgrade before the potentially-downgrading pro peek.
          const msgs = extractMessages(rawBody)
          if (msgs) dispatcher.stickyStore?.storeUpgrade(msgs)
          dispatcher.logger.info?.(`[escalate] <<<NEEDS_PRO>>> detected in stream — switching to pro`)

          // Inject a visible separator into the reasoning stream.
          controller.enqueue(buildTierSwitchEvent('flash', 'pro', flashResult.reason))

          const proBody = dispatcher.buildProBody(rawBody)
          const proResp = await dispatcher.callUpstream(proBody, clientHeaders)
          if (!proResp.ok || !proResp.body) {
            const errText = proResp.body ? await proResp.text().catch(() => '') : ''
            controller.enqueue(buildProxyErrorEvent(proResp.status, errText))
            controller.close()
            return
          }

          // ---- Pro peek: forward reasoning, watch for NEEDS_FLASH downgrade. ----
          const proReader = proResp.body.getReader()
          const proResult = await dispatcher.peekTierStream(controller, proReader, 'flash')
          if (proResult.outcome === 'done') {
            controller.close()
            return
          }

          // ---- Switched: pro → flash (downgrade). ----
          if (msgs) dispatcher.stickyStore?.clear(msgs)
          dispatcher.logger.info?.(`[escalate] <<<NEEDS_FLASH>>> detected in pro stream — downgrading to flash`)

          controller.enqueue(buildTierSwitchEvent('pro', 'flash', proResult.reason))

          const flashRetryBody = dispatcher.buildFlashRetryBody(rawBody)
          const flashRetryResp = await dispatcher.callUpstream(flashRetryBody, clientHeaders)
          if (!flashRetryResp.ok || !flashRetryResp.body) {
            const errText = flashRetryResp.body ? await flashRetryResp.text().catch(() => '') : ''
            controller.enqueue(buildProxyErrorEvent(flashRetryResp.status, errText))
            controller.close()
            return
          }

          // Pump flash retry directly — no further peeking (avoid downgrade loops).
          await pumpReaderToController(flashRetryResp.body.getReader(), controller)
          controller.close()
        } catch (err) {
          try {
            controller.enqueue(buildProxyErrorEvent(500, err instanceof Error ? err.message : String(err)))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
      async cancel(reason) {
        try { await flashReader.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'flash',
      reason: 'passthrough',
      path: ['flash'],
      status: flashResp.status,
      // Note: streaming responses no longer carry X-Escalated-* headers.
      // The upgrade decision happens AFTER the response head is sent (so that
      // reasoning_content can stream through immediately and keep the client's
      // TTFB low). The in-band separator injected via reasoning_content
      // (`--- [proxy: now on pro (was flash)] ---`) is the visible signal.
      headers: buildResponseHeaders(flashResp.headers, {}),
      body: passthrough,
      isStream: true,
    }
  }

  /**
   * Peek one tier's SSE stream and forward bytes to `controller`:
   *   - `delta.reasoning_content` (think blocks) → forwarded immediately, so
   *     the client never blocks waiting for the model's thinking to finish.
   *   - `delta.content` → buffered and run through `detectMarkerPrefix`:
   *       * `matched-<expectedDirection>` → cancel reader, return 'switched'.
   *         Caller is responsible for emitting the tier-switch separator and
   *         starting the next tier's request.
   *       * `no-marker` (first content char isn't `<`, or first line complete
   *         without a match) → flush the content buffer, switch to pure
   *         passthrough mode, and keep pumping until the stream ends.
   *       * `need-more` → keep buffering (partial marker prefix).
   *
   * Returns `{outcome:'switched', reason?}` if the expected marker was seen
   * (reader cancelled, buffered content bytes dropped), or `{outcome:'done'}`
   * if the stream ended naturally (all bytes — buffered and live — have been
   * forwarded to the controller; caller should close the controller).
   *
   * The 'switched' return deliberately does NOT close the controller — the
   * caller typically wants to enqueue more bytes (separator + next tier).
   */
  private async peekTierStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    expectedDirection: 'pro' | 'flash'
  ): Promise<{ outcome: 'done' } | { outcome: 'switched'; reason?: string }> {
    const sseBuf = new SseLineBuffer()
    let sseContentBuf = ''
    let contentPeekBytes: Uint8Array | null = null
    let mode: 'peeking' | 'passthrough' = 'peeking'

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        // Stream ended naturally — flush any buffered content and signal done.
        if (contentPeekBytes !== null) {
          controller.enqueue(contentPeekBytes)
          contentPeekBytes = null
        }
        return { outcome: 'done' }
      }
      if (!value || value.length === 0) continue

      if (mode === 'passthrough') {
        controller.enqueue(value)
        continue
      }

      const { lines, leftover } = sseBuf.feed(value)

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]

        // Non-`data:` lines (blank lines, comments, event: lines) — forward.
        if (!line.isData) {
          controller.enqueue(line.bytes)
          continue
        }
        // `data: [DONE]` — forward.
        if (line.done) {
          controller.enqueue(line.bytes)
          continue
        }
        // `data:` without a parseable chat delta — forward verbatim.
        if (!line.delta) {
          controller.enqueue(line.bytes)
          continue
        }

        const hasContent = typeof line.delta.content === 'string' && line.delta.content.length > 0
        const hasReasoning = typeof line.delta.reasoning_content === 'string' && line.delta.reasoning_content.length > 0

        // reasoning_content (think) — forward immediately. This is the core
        // fix for the long-TTFB problem on reasoning models: the client sees
        // think bytes as soon as the model emits them, not after a full peek.
        if (hasReasoning) {
          controller.enqueue(line.bytes)
        }

        // content — buffer + prefix-increment detection.
        if (hasContent) {
          sseContentBuf += line.delta.content!
          contentPeekBytes = concatBytes(contentPeekBytes, line.bytes)

          const decision = detectMarkerPrefix(sseContentBuf)
          if (decision === 'matched-pro' && expectedDirection === 'pro') {
            const det = detectEscalationMarker(sseContentBuf)
            try { await reader.cancel() } catch { /* noop */ }
            return { outcome: 'switched', reason: det.reason }
          }
          if (decision === 'matched-flash' && expectedDirection === 'flash') {
            const det = detectEscalationMarker(sseContentBuf)
            try { await reader.cancel() } catch { /* noop */ }
            return { outcome: 'switched', reason: det.reason }
          }
          if (decision === 'no-marker') {
            // Definitively no marker — flush the content buffer, switch to
            // pure passthrough for the rest of this stream, and flush any
            // remaining lines in this chunk that came after the content line.
            controller.enqueue(contentPeekBytes!)
            contentPeekBytes = null
            mode = 'passthrough'
            flushRemainingLines(controller, lines, li + 1)
            if (leftover !== null) controller.enqueue(leftover)
            break // exit lines loop; outer loop continues in passthrough mode
          }
          // 'need-more' (or a cross-direction marker like a flash model
          // emitting <<<NEEDS_FLASH>>> — treated defensively as need-more).
          // Keep buffering, but cap to avoid pathological partial prefixes.
          if (sseContentBuf.length >= PEEK_MAX_CONTENT_CHARS) {
            controller.enqueue(contentPeekBytes!)
            contentPeekBytes = null
            mode = 'passthrough'
            flushRemainingLines(controller, lines, li + 1)
            if (leftover !== null) controller.enqueue(leftover)
            break
          }
          continue
        }

        // data line with neither content nor reasoning (role, tool_calls, …) — forward.
        // (If the line had reasoning_content we already forwarded it above.)
        if (!hasReasoning) {
          controller.enqueue(line.bytes)
        }
      }
      // If mode flipped to 'passthrough' inside the loop, the outer while
      // loop will pick it up on the next iteration.
    }
  }

  // ----------------------------------------------------------------------
  // Advisor mode — tool-call interception
  // ----------------------------------------------------------------------

  /**
   * Advisor non-stream dispatcher. Loops: call flash with advisor tool,
   * check the assistant message for an `advisor` tool call, route the
   * question to pro (without `tools`), build a `tool` result message,
   * append it to `messages`, and retry flash. Recursion is bounded only by
   * the model — practical limit is ~2 advisor calls per turn.
   */
  private async dispatchAdvisorNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    const initialMessages = extractMessages(rawBody) ?? []
    // Pre-process: rewrite any advisor tool_calls in the inbound history
    // that arrived without a corresponding `tool` result message into
    // synthetic user messages (so the deepseek upstream doesn't 400).
    let workingMessages: ChatCompletionMessage[] = this.rewriteOrphanedAdvisorCalls(initialMessages)
    const path: Array<'flash' | 'pro'> = []
    let sawAdvisorCall = false

    while (true) {
      path.push('flash')

      const flashBody = this.buildFlashAdvisorBody(rawBody, workingMessages)
      const flashResp = await this.callUpstream(flashBody, clientHeaders)
      if (!flashResp.ok) {
        const errBuf = Buffer.from(await flashResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'error',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: errBuf,
          isStream: false,
        }
      }

      const flashText = await flashResp.text()
      const flashParsed = safeParseChatCompletion(flashText)
      const assistantMsg = flashParsed?.choices?.[0]?.message as ChatCompletionMessage | undefined
      const finishReason = flashParsed?.choices?.[0]?.finish_reason as string | undefined

      const advisorCall = assistantMsg ? extractAdvisorToolCall(assistantMsg) : null
      if (!advisorCall || finishReason !== 'tool_calls') {
        return {
          finalModel: 'flash',
          reason: sawAdvisorCall ? 'advisor' : 'non-stream',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: Buffer.from(flashText, 'utf-8'),
          isStream: false,
        }
      }

      // ---- Advisor call detected: route the question to pro. ----
      // Only handle the FIRST advisor call per flash response. If flash
      // emitted multiple calls, the remaining ones are processed by the
      // recursion loop (flash retries with the tool result, and may call
      // advisor again). This keeps the message history sequential rather
      // than appearing as parallel tool calls.
      sawAdvisorCall = true
      path.push('pro')
      this.logger.info?.(`[escalate] advisor tool call detected (${advisorCall.function.arguments.length} chars) — consulting pro`)

      const advisorQuestion = extractAdvisorQuestion(advisorCall)
      this.logger.info?.(`[escalate] advisor question: ${advisorQuestion ?? '(empty)'}`)

      const advisorUserMsg: ChatCompletionMessage | null = advisorQuestion
        ? { role: 'user', content: `[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] ${advisorQuestion}` }
        : null

      // Strip tool_calls from the assistant message before sending to pro.
      const hasContent = assistantMsg &&
        (typeof assistantMsg.content === 'string' ? assistantMsg.content.length > 0 : assistantMsg.content !== null && assistantMsg.content !== undefined)
      const assistantForPro: ChatCompletionMessage | null = hasContent
        ? { role: 'assistant', content: assistantMsg.content }
        : null
      const proMessages: ChatCompletionMessage[] = [
        ...workingMessages,
        ...(assistantForPro ? [assistantForPro] : []),
        ...(advisorUserMsg ? [advisorUserMsg] : []),
      ]

      const proBody = this.buildProAdvisorBody(rawBody, proMessages)
      const proResp = await this.callUpstream(proBody, clientHeaders)
      if (!proResp.ok) {
        const errBuf = Buffer.from(await proResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'advisor',
          path,
          status: proResp.status,
          headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: errBuf,
          isStream: false,
        }
      }

      const proText = await proResp.text()
      const proParsed = safeParseChatCompletion(proText)
      const proReasoningRaw = proParsed?.choices?.[0]?.message?.['reasoning_content']
      const proReasoning = typeof proReasoningRaw === 'string' && proReasoningRaw.length > 0
        ? proReasoningRaw
        : null
      const proContentRaw = proParsed?.choices?.[0]?.message?.['content']
      const proContent = typeof proContentRaw === 'string'
        ? proContentRaw
        : (proContentRaw == null ? '' : JSON.stringify(proContentRaw))
      const proFullContent = proReasoning
        ? `${proReasoning}

${proContent}`
        : proContent
      this.logger.info?.(`[escalate] pro response (${proFullContent.length} chars): ${proFullContent.slice(0, 200)}${proFullContent.length > 200 ? '...' : ''}`)

      const toolResult: ChatCompletionMessage = {
        role: 'tool',
        tool_call_id: advisorCall.id,
        content: proFullContent,
      }

      // Append the advisor call + its tool result. Non-advisor tool
      // calls from the same assistant message are preserved (e.g. if
      // flash also called read_file in the same turn). The remaining
      // advisor calls are handled by recursion.
      // Preserve reasoning_content — DeepSeek requires it to be passed
      // back to the API in subsequent requests (thinking mode).
      const flashReasoning = assistantMsg?.['reasoning_content']
      const allToolCalls = Array.isArray(assistantMsg?.tool_calls) ? assistantMsg!.tool_calls! : []
      const nonAdvisorCalls = allToolCalls.filter(
        (tc) => tc?.function?.name !== ADVISOR_TOOL_NAME,
      )
      const firstCallOnly: ChatCompletionMessage = {
        role: 'assistant',
        content: assistantMsg?.content ?? null,
        tool_calls: [
          ...nonAdvisorCalls,
          {
            id: advisorCall.id,
            type: 'function' as const,
            function: { name: advisorCall.function.name, arguments: advisorCall.function.arguments },
          },
        ],
        ...(typeof flashReasoning === 'string' && flashReasoning.length > 0
          ? { reasoning_content: flashReasoning }
          : {}),
      }
      workingMessages = [...workingMessages, firstCallOnly, toolResult]
    }
  }

  /**
   * Advisor streaming dispatcher. Loops flash turns, peeking each for an
   * `advisor` tool call. On detection:
   *   1. Inject a "consulting advisor" separator into the reasoning stream.
   *   2. Stream pro's analysis into the reasoning stream (the think panel).
   *   3. Inject a "back to flash" separator.
   *   4. Call flash again with the tool result appended, and pump its
   *      stream to the client.
   *
   * If flash never calls advisor, the buffered content is flushed and we
   * passthrough. Recursion (multiple advisor calls in one turn) is supported.
   */
  private async dispatchAdvisorStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>
  ): Promise<DispatchResult> {
    const initialMessages = extractMessages(rawBody) ?? []
    // Pre-process: rewrite any advisor tool_calls in the inbound history
    // that arrived without a corresponding `tool` result message into
    // synthetic user messages.
    let workingMessages: ChatCompletionMessage[] = this.rewriteOrphanedAdvisorCalls(initialMessages)
    const path: Array<'flash' | 'pro'> = []
    const initialStatus = { value: 200 as number }
    const initialHeaders = { value: {} as Record<string, string> }

    const dispatcher = this
    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // Outer loop: each iteration is one flash turn.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            path.push('flash')
            const flashBody = dispatcher.buildFlashAdvisorBody(rawBody, workingMessages)
            const flashResp = await dispatcher.callUpstream(flashBody, clientHeaders)
            if (!flashResp.ok || !flashResp.body) {
              const errText = flashResp.body ? await flashResp.text().catch(() => '') : ''
              controller.enqueue(buildProxyErrorEvent(flashResp.status, errText))
              controller.close()
              return
            }
            initialStatus.value = flashResp.status
            initialHeaders.value = headersToRecord(flashResp.headers)

            const flashReader = flashResp.body.getReader()
            const peekResult = await dispatcher.peekAdvisorStream(controller, flashReader)
            if (peekResult.outcome === 'passthrough') {
              // No advisor call — flash answered directly; flush & close.
              controller.close()
              return
            }
            if (peekResult.outcome === 'error') {
              controller.close()
              return
            }

            const assistantMsg = peekResult.assistantMsg
            const advisorCall = extractAdvisorToolCall(assistantMsg)
            if (!advisorCall) {
              controller.close()
              return
            }
            path.push('pro')
            dispatcher.logger.info?.(`[escalate] advisor tool call detected in stream (${advisorCall.function.arguments.length} chars) — consulting pro`)

            const advisorQuestion = extractAdvisorQuestion(advisorCall)
            dispatcher.logger.info?.(`[escalate] advisor question: ${advisorQuestion ?? '(empty)'}`)

            const advisorUserMsg: ChatCompletionMessage | null = advisorQuestion
              ? { role: 'user', content: `[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] ${advisorQuestion}` }
              : null

            // Strip tool_calls from the assistant message before sending to pro.
            const hasContent2 = typeof assistantMsg.content === 'string'
              ? assistantMsg.content.length > 0
              : assistantMsg.content !== null && assistantMsg.content !== undefined
            const assistantForPro2: ChatCompletionMessage | null = hasContent2
              ? { role: 'assistant', content: assistantMsg.content }
              : null
            const proMessages: ChatCompletionMessage[] = [
              ...workingMessages,
              ...(assistantForPro2 ? [assistantForPro2] : []),
              ...(advisorUserMsg ? [advisorUserMsg] : []),
            ]

            const proBody = dispatcher.buildProAdvisorBody(rawBody, proMessages)
            const proResp = await dispatcher.callUpstream(proBody, clientHeaders)
            if (!proResp.ok || !proResp.body) {
              const errText = proResp.body ? await proResp.text().catch(() => '') : ''
              controller.enqueue(buildProxyErrorEvent(proResp.status, errText))
              controller.close()
              return
            }

            controller.enqueue(buildAdvisorBeginEvent(advisorQuestion ?? undefined))
            const proReader = proResp.body.getReader()
            const proContent = await dispatcher.streamProAsReasoning(proReader, controller)
            dispatcher.logger.info?.(`[escalate] pro response (${proContent.length} chars): ${proContent.slice(0, 200)}${proContent.length > 200 ? '...' : ''}`)
            controller.enqueue(buildAdvisorEndEvent())

            const toolResult: ChatCompletionMessage = {
              role: 'tool',
              tool_call_id: advisorCall.id,
              content: proContent,
            }

            // Append advisor call + tool result. Preserve non-advisor
            // tool calls from the same assistant message, and
            // reasoning_content for DeepSeek thinking mode requirement.
            const streamReasoning = assistantMsg['reasoning_content']
            const allTCs = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : []
            const nonAdvisorTCs = allTCs.filter(
              (tc: { function?: { name?: string } }) => tc?.function?.name !== ADVISOR_TOOL_NAME,
            )
            const firstCallOnly2: ChatCompletionMessage = {
              role: 'assistant',
              content: assistantMsg.content ?? null,
              tool_calls: [
                ...nonAdvisorTCs,
                {
                  id: advisorCall.id,
                  type: 'function' as const,
                  function: { name: advisorCall.function.name, arguments: advisorCall.function.arguments },
                },
              ],
              ...(typeof streamReasoning === 'string' && streamReasoning.length > 0
                ? { reasoning_content: streamReasoning }
                : {}),
            }
            workingMessages = [...workingMessages, firstCallOnly2, toolResult]
            // Loop continues — call flash again with the tool result.
          }
        } catch (err) {
          try {
            controller.enqueue(buildProxyErrorEvent(500, err instanceof Error ? err.message : String(err)))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
    })

    return {
      finalModel: 'flash',
      reason: 'passthrough',
      path,
      status: initialStatus.value,
      headers: buildResponseHeaders(new Headers(initialHeaders.value), {}),
      body: passthrough,
      isStream: true,
    }
  }

  /**
   * Peek a flash SSE stream for an `advisor` tool call:
   *   - Forward `delta.reasoning_content` immediately.
   *   - Accumulate `delta.tool_calls` across chunks.
   *   - Track `finish_reason` and decide once both conditions are met
   *     (advisor tool name seen AND finish_reason === 'tool_calls').
   *   - On advisor decision: cancel the reader and return the accumulated
   *     assistant message so the caller can replay it as an assistant
   *     message in the next pro call.
   *   - On natural stream end without advisor call: flush buffered content
   *     to the controller and return 'passthrough'.
   */
  private async peekAdvisorStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<
    | { outcome: 'passthrough' }
    | { outcome: 'advisor'; assistantMsg: ChatCompletionMessage }
    | { outcome: 'error' }
  > {
    const sseBuf = new SseLineBuffer()
    // Buffer for data lines with deltas (content, tool_calls, finish_reason).
    // Flushed on passthrough; discarded when advisor is detected.
    let passthroughBytes: Uint8Array | null = null
    let reasoningAcc = ''
    const toolCalls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
    let sawAdvisorToolName = false
    let finishReason: string | null = null

    const flushPassthrough = () => {
      if (passthroughBytes !== null) {
        controller.enqueue(passthroughBytes)
        passthroughBytes = null
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        flushPassthrough()
        return { outcome: 'passthrough' }
      }
      if (!value || value.length === 0) continue

      const { lines } = sseBuf.feed(value)
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]

        if (!line.isData) {
          controller.enqueue(line.bytes)
          continue
        }
        if (line.done) {
          controller.enqueue(line.bytes)
          continue
        }
        if (!line.delta) {
          controller.enqueue(line.bytes)
          continue
        }

        const delta = line.delta as {
          content?: string
          reasoning_content?: string
          role?: string
          tool_calls?: Array<{
            index?: number
            id?: string
            type?: 'function'
            function?: { name?: string; arguments?: string }
          }>
          finish_reason?: unknown
        }

        let lineBuffered = false

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          reasoningAcc += delta.reasoning_content
          controller.enqueue(line.bytes)
        }

        if (typeof delta.content === 'string') {
          passthroughBytes = concatBytes(passthroughBytes, line.bytes)
          lineBuffered = true
        }

        if (Array.isArray(delta.tool_calls)) {
          if (!lineBuffered) passthroughBytes = concatBytes(passthroughBytes, line.bytes)
          lineBuffered = true
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            const existing = toolCalls.get(idx) ?? {
              id: '',
              type: 'function' as const,
              function: { name: '', arguments: '' },
            }
            if (typeof tc.id === 'string' && tc.id.length > 0) existing.id = tc.id
            if (tc.function) {
              if (typeof tc.function.name === 'string' && tc.function.name.length > 0) {
                existing.function.name = tc.function.name
                if (tc.function.name === ADVISOR_TOOL_NAME) sawAdvisorToolName = true
              }
              if (typeof tc.function.arguments === 'string') {
                existing.function.arguments += tc.function.arguments
              }
            }
            toolCalls.set(idx, existing)
          }
        }

        if (typeof delta.finish_reason === 'string' && delta.finish_reason.length > 0) {
          finishReason = delta.finish_reason
          // The finish_reason line itself may not have been buffered yet
          // (e.g. delta: {}). Buffer it so it reaches the client on passthrough.
          if (!lineBuffered) passthroughBytes = concatBytes(passthroughBytes, line.bytes)
        }

        if (sawAdvisorToolName && finishReason === 'tool_calls') {
          const assistantMsg: ChatCompletionMessage = {
            role: 'assistant',
            content: null,
            tool_calls: Array.from(toolCalls.values()).map((tc) => ({
              id: tc.id || undefined,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
            ...(reasoningAcc.length > 0 ? { reasoning_content: reasoningAcc } : {}),
          }
          try { await reader.cancel() } catch { /* noop */ }
          return { outcome: 'advisor', assistantMsg }
        }
      }
    }
  }

  /**
   * Stream pro's response into the controller's reasoning_content stream. Pro
   * is consulted as a passive advisor — we just want its full analysis shown
   * in the think panel. Both pro's `reasoning_content` AND `content` are
   * rewritten into the reasoning stream so the user sees pro's reasoning
   * followed by pro's conclusion, all in the think panel.
   *
   * Returns the combined reasoning + content text so the dispatcher can
   * put the full analysis into the `tool` result message for flash.
   */
  private async streamProAsReasoning(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<string> {
    const sseBuf = new SseLineBuffer()
    let reasoningAcc = ''
    let contentAcc = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        // Combine reasoning + content so flash sees pro's full analysis.
        return reasoningAcc ? `${reasoningAcc}\n\n${contentAcc}` : contentAcc
      }
      if (!value || value.length === 0) continue
      const { lines } = sseBuf.feed(value)
      for (const line of lines) {
        if (!line.isData || !line.delta) {
          controller.enqueue(line.bytes)
          continue
        }
        const delta = line.delta as { content?: string; reasoning_content?: string }
        // Forward reasoning_content as-is AND accumulate for the tool result.
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          reasoningAcc += delta.reasoning_content
          controller.enqueue(line.bytes)
        }
        // Rewrite content -> reasoning_content (so it shows in the think panel).
        if (typeof delta.content === 'string' && delta.content.length > 0) {
                  contentAcc += delta.content
                  try {
                    const original = line.rawLine.startsWith('data:') ? line.rawLine.slice(5).trim() : ''
                    const parsed = JSON.parse(original) as { choices?: Array<{ delta?: Record<string, unknown> }> }
                    const c0 = parsed.choices?.[0]
                    if (c0 && c0.delta) {
                      const newDelta: Record<string, unknown> = { ...c0.delta, reasoning_content: delta.content }
                      delete newDelta['content']
                      const newPayload = JSON.stringify({ choices: [{ ...c0, delta: newDelta }] })
                      controller.enqueue(Buffer.from(`data: ${newPayload}\n`, 'utf-8'))
                    } else {
                      controller.enqueue(line.bytes)
                    }
                  } catch {
                    controller.enqueue(line.bytes)
                  }
                }
      }
    }
  }
}

/** Build the singleton undici Pool for a given config. */
export function buildEscalatePool(apiBase: string, opts?: { connections?: number; keepAliveTimeout?: number }): Pool {
  // undici Pool expects the origin (scheme + host + port), not a full URL.
  // Strip the path portion so `/v1/chat/completions` doesn't get rejected.
  const base = normalizeBase(apiBase)
  let origin = base
  const schemeEnd = base.indexOf('://')
  if (schemeEnd !== -1) {
    const afterScheme = base.slice(schemeEnd + 3)
    const slashIdx = afterScheme.indexOf('/')
    if (slashIdx !== -1) {
      origin = base.slice(0, schemeEnd + 3 + slashIdx)
    }
  }
  return new Pool(origin, {
    connections: opts?.connections ?? 4,
    pipelining: 1,
    keepAliveTimeout: opts?.keepAliveTimeout ?? 30_000,
  })
}

// Re-export for convenience.
export { normalizeBase, headersToRecord }
