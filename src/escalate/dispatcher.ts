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
import { detectEscalationMarker, stripNeedsProMarker } from './detector'
import type { DispatchResult, EscalateConfig } from './types'
import { StickyStore } from './sticky'

/** Default peek buffer — at most this many characters of assistant content before deciding. */
const PEEK_MAX_CHARS = 256

/** Default upstream request timeout (2 minutes). */
const UPSTREAM_TIMEOUT_MS = 120_000

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

/**
 * Extract the assistant delta content from an SSE `data:` payload.
 * Returns the new content fragment (or empty string).
 */
function extractSseDelta(dataLine: string): string {
  if (!dataLine) return ''
  try {
    const parsed = JSON.parse(dataLine)
    const c0 = parsed?.choices?.[0]
    if (c0) {
      const content = c0?.delta?.content ?? c0?.message?.content ?? c0?.text
      if (typeof content === 'string') return content
    }
  } catch {
    // Not JSON; ignore.
  }
  return ''
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
    const path: Array<'flash' | 'pro'> = ['pro']

    if (!proResp.ok || !proResp.body) {
      const errBuf = proResp.body ? Buffer.from(await proResp.arrayBuffer()) : Buffer.from('')
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

    // Peek pro stream for downgrade (reuses checkProStreamForDowngrade logic).
    return this.checkProStreamForDowngrade(proResp, clientHeaders, rawBody, path, undefined, true)
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
    const path: Array<'flash' | 'pro'> = ['flash']
    const flashBody = this.buildFlashBody(rawBody)
    const flashResp = await this.callUpstream(flashBody, clientHeaders)

    // Upstream error — pass through as a non-stream body.
    if (!flashResp.ok || !flashResp.body) {
      const errBuf = flashResp.body
        ? Buffer.from(await flashResp.arrayBuffer())
        : Buffer.from('')
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

    const flashReader = flashResp.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    /** Accumulated assistant content from SSE deltas — what we run the marker detector on. */
    let sseContentBuf = ''
    let peekBytes: Uint8Array | null = null
    let firstReadDone = false
    let sseLineBuf = ''
    /** Offset into sseLineBuf up to which we have already processed lines. Persists across reads. */
    let sseLineProcessed = 0

    // Read chunks until we have at least one newline OR PEEK_MAX_CHARS of content.
    outer: while (true) {
      const { value, done } = await flashReader.read()
      if (done) break
      if (!value || value.length === 0) continue
      if (peekBytes === null) {
        peekBytes = value
      } else {
        // Concatenate into peekBytes (rare since we usually stop at the first chunk)
        const nextLen = peekBytes.length + value.length
        const merged: Uint8Array = new Uint8Array(nextLen)
        merged.set(peekBytes, 0)
        merged.set(value, peekBytes.length)
        peekBytes = merged
      }
      sseLineBuf += decoder.decode(value, { stream: true })
      firstReadDone = true

      // Process any complete `data:` lines we now have (only NEW ones since last iteration).
      while (sseLineProcessed < sseLineBuf.length) {
        const nlIdx = sseLineBuf.indexOf('\n', sseLineProcessed)
        if (nlIdx === -1) break
        const rawLine = sseLineBuf.slice(sseLineProcessed, nlIdx).replace(/\r$/, '')
        sseLineProcessed = nlIdx + 1
        if (rawLine.startsWith('data:')) {
          const payload = rawLine.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            sseContentBuf += extractSseDelta(payload)
          }
        }
        if (sseContentBuf.length >= PEEK_MAX_CHARS) break outer
      }
    }

    if (!firstReadDone) {
      // Empty stream — nothing to detect; pass through empty.
      try { await flashReader.cancel() } catch { /* noop */ }
      return {
        finalModel: 'flash',
        reason: 'passthrough',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.close() },
        }),
        isStream: true,
      }
    }

    const flashDetect = detectEscalationMarker(sseContentBuf)

    if (flashDetect.matched && flashDetect.direction === 'pro') {
      this.logger.info?.(`[escalate] <<<NEEDS_PRO>>> detected in stream (${flashDetect.reason ?? 'bare'}) — cancelling flash, retrying on pro`)
      // Abort the flash stream and start a pro stream.
      try { await flashReader.cancel() } catch { /* noop */ }
      path.push('pro')
      const proBody = this.buildProBody(rawBody)
      const proResp = await this.callUpstream(proBody, clientHeaders)
      if (!proResp.ok || !proResp.body) {
        const errBuf = proResp.body ? Buffer.from(await proResp.arrayBuffer()) : Buffer.from('')
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

      // Check the pro stream for a NEEDS_FLASH marker. This adds one more
      // peek roundtrip on the upgrade path, but it lets the pro model
      // self-correct if it realizes mid-stream that the task is trivial.
      // Sticky pro: record the upgrade before the potentially-downgrading peek.
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.storeUpgrade(msgs)
      const proStream = await this.checkProStreamForDowngrade(proResp, clientHeaders, rawBody, path, flashDetect.reason)
      return proStream
    }

    // No escalation — return a new ReadableStream that:
    //   - yields peekBytes first (so the client gets the first chunk without delay)
    //   - then pumps the rest of the SAME upstream reader (no second getReader()).
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (peekBytes !== null) {
          controller.enqueue(peekBytes)
          peekBytes = null
          return
        }
        const { value, done } = await flashReader.read()
        if (done) {
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
      },
      async cancel(reason) {
        try { await flashReader.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'flash',
      reason: 'passthrough',
      path,
      status: flashResp.status,
      headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
      body: passthrough,
      isStream: true,
    }
  }

  /**
   * After we detect `<<<NEEDS_PRO>>>` in the flash stream and start a pro
   * stream, peek the pro stream's first chunk for a `<<<NEEDS_FLASH>>>`
   * marker. If matched, cancel the pro stream and start a flash retry.
   *
   * Returns the final `DispatchResult` (flash or pro). When the pro stream
   * is kept (no downgrade), we return a new ReadableStream that re-emits
   * the peek bytes plus pumps the rest of the pro stream — the upstream
   * `ReadableStream` cannot be returned directly because it is already
   * locked by our internal reader.
   */
  private async checkProStreamForDowngrade(
    proResp: Response,
    clientHeaders: Record<string, string | string[] | undefined>,
    rawBody: unknown,
    path: Array<'flash' | 'pro'>,
    upgradeReason: string | undefined,
    /** True when this is a direct pro call (sticky hit), not an escalation. */
    isDirect: boolean = false
  ): Promise<DispatchResult> {
    if (!proResp.body) {
      return {
        finalModel: 'pro',
        reason: 'self-report',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({
          finalModel: 'pro', switchedFrom: 'flash', path, reason: upgradeReason ?? (isDirect ? 'passthrough' : 'self-report'),
        })),
        body: new ReadableStream<Uint8Array>({ start(c) { c.close() } }),
        isStream: true,
      }
    }

    const proReader = proResp.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let sseContentBuf = ''
    let sseLineBuf = ''
    let sseLineProcessed = 0
    let firstReadDone = false
    /** Raw bytes already read from proReader — need to re-emit if no downgrade. */
    let proPeekBytes: Uint8Array | null = null

    // Peek pro stream until we see a marker or exceed the cap.
    outer: while (true) {
      const { value, done } = await proReader.read()
      if (done) break
      if (!value || value.length === 0) continue
      firstReadDone = true
      // Accumulate raw bytes for re-emission.
      if (proPeekBytes === null) {
        proPeekBytes = value
      } else {
        const nextLen = proPeekBytes.length + value.length
        const merged: Uint8Array = new Uint8Array(nextLen)
        merged.set(proPeekBytes, 0)
        merged.set(value, proPeekBytes.length)
        proPeekBytes = merged
      }
      sseLineBuf += decoder.decode(value, { stream: true })

      while (sseLineProcessed < sseLineBuf.length) {
        const nlIdx = sseLineBuf.indexOf('\n', sseLineProcessed)
        if (nlIdx === -1) break
        const rawLine = sseLineBuf.slice(sseLineProcessed, nlIdx).replace(/\r$/, '')
        sseLineProcessed = nlIdx + 1
        if (rawLine.startsWith('data:')) {
          const payload = rawLine.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            sseContentBuf += extractSseDelta(payload)
          }
        }
        if (sseContentBuf.length >= PEEK_MAX_CHARS) break outer
      }
    }

    if (!firstReadDone) {
      try { await proReader.cancel() } catch { /* noop */ }
      return {
        finalModel: 'pro',
        reason: 'self-report',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({
          finalModel: 'pro', switchedFrom: 'flash', path, reason: upgradeReason ?? (isDirect ? 'passthrough' : 'self-report'),
        })),
        body: new ReadableStream<Uint8Array>({ start(c) { c.close() } }),
        isStream: true,
      }
    }

    const detect = detectEscalationMarker(sseContentBuf)
    if (detect.matched && detect.direction === 'flash') {
      this.logger.info?.(`[escalate] <<<NEEDS_FLASH>>> detected in pro stream (${detect.reason ?? 'bare'}) — downgrading to flash`)
      // Clear sticky state so next request starts from flash.
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      try { await proReader.cancel() } catch { /* noop */ }
      path.push('flash')

      // Start a flash retry stream.
      const flashBody = this.buildFlashRetryBody(rawBody)
      const flashResp = await this.callUpstream(flashBody, clientHeaders)
      if (!flashResp.ok || !flashResp.body) {
        const errBuf = flashResp.body ? Buffer.from(await flashResp.arrayBuffer()) : Buffer.from('')
        return {
          finalModel: 'flash',
          reason: 'downgrade',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
            finalModel: 'flash', switchedFrom: 'pro', path, reason: detect.reason ?? 'downgrade',
          })),
          body: errBuf,
          isStream: false,
        }
      }
      return {
        finalModel: 'flash',
        reason: 'downgrade',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
          finalModel: 'flash', switchedFrom: 'pro', path, reason: detect.reason ?? 'downgrade',
        })),
        body: flashResp.body,
        isStream: true,
      }
    }

    // No downgrade — build a new ReadableStream that re-emits the peeked
    // bytes (so the client gets the full SSE payload) and then pumps the
    // remainder of the (locked) proReader.
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (proPeekBytes !== null) {
          controller.enqueue(proPeekBytes)
          proPeekBytes = null
          return
        }
        const { value, done } = await proReader.read()
        if (done) {
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
      },
      async cancel(reason) {
        try { await proReader.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'pro',
      reason: isDirect ? 'passthrough' : 'self-report',
      path,
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, annotationHeaders({
        finalModel: 'pro', switchedFrom: 'flash', path, reason: upgradeReason ?? (isDirect ? 'passthrough' : 'self-report'),
      })),
      body: passthrough,
      isStream: true,
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
