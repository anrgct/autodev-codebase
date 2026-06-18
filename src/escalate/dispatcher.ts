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
import { injectContract, type ChatCompletionRequestBody, type ChatCompletionMessage } from './contract'
import { detectEscalationMarker, detectMarkerPrefix, stripNeedsProMarker } from './detector'
import { SseLineBuffer } from './sse-buffer'
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

      for (const line of lines) {
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
            // Definitively no marker — flush the content buffer and switch to
            // pure passthrough for the rest of this stream.
            controller.enqueue(contentPeekBytes!)
            contentPeekBytes = null
            mode = 'passthrough'
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
