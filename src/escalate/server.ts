/**
 * Escalate HTTP proxy — `createServer` + `eventHandler`-based router built on h3.
 *
 * Routes:
 *   - `POST /v1/messages`              — main entry point (Anthropic Messages API).
 *   - `POST /v1/chat/completions`      — alias for backward compat (OpenAI clients).
 *   - `POST /chat/completions`         — alias, since some clients omit the `/v1` prefix.
 *   - `GET  /health`                   — health check, returns `{ ok: true, model: { flash, pro } }`.
 *   - `GET  /v1/models`                 — passthrough to upstream.
 *   - `* /v1/*`                         — generic passthrough to the upstream.
 *   - `* /*`                            — fallback 404 with a helpful hint.
 *
 * The server is intentionally minimal: every endpoint is an `eventHandler`,
 * every I/O function is `defineEventHandler`/h3-native, and streaming uses
 * `sendStream` (zero-copy pipe from undici ReadableStream to the h3 response).
 */

import {
  createApp,
  createRouter,
  defineEventHandler,
  getRequestHeader,
  getRouterParam,
  readRawBody,
  sendStream,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
  type EventHandler,
  type H3Event,
} from 'h3'
import { createServer as createNodeServer, type Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EscalateDispatcher, buildEscalatePool } from './dispatcher'
import type { EscalateConfig } from './types'

export interface EscalateServerOptions {
  config: EscalateConfig
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void; debug?: (msg: string) => void }
}

export interface EscalateServerHandle {
  /** The actual `http.Server` instance. */
  server: NodeServer
  /** The resolved port the server is listening on (after EPHEMERAL resolution). */
  port: number
  /** Resolved host. */
  host: string
  /** Stop the server and close all idle connections / the undici Pool. */
  stop: () => Promise<void>
}

/**
 * Create and start the escalate proxy.
 *
 * Resolves once the server is actually listening (so `port` is final).
 */
export async function startEscalateServer(opts: EscalateServerOptions): Promise<EscalateServerHandle> {
  const logger = opts.logger ?? {}
  const pool = buildEscalatePool(opts.config.apiBase)
  const dispatcher = new EscalateDispatcher({ config: opts.config, logger, dispatcher: pool })

  const app = createApp()
  const router = createRouter()

  // ----- /health -----
  router.get('/health', defineEventHandler(() => ({
    ok: true,
    proxy: 'codebase-escalate',
    model: { flash: opts.config.flashModel, pro: opts.config.proModel },
    upstream: opts.config.apiBase,
  })))

  // ----- /v1/messages (Anthropic Messages API) -----
  const chatHandler: EventHandler = async (event) => {
    return handleChat(event, dispatcher, logger)
  }
  // Primary route: Anthropic Messages API format.
  router.post('/v1/messages', chatHandler)
  // Aliases for backward compat (OpenAI clients).
  router.post('/v1/chat/completions', chatHandler)
  // Some clients omit the `/v1` prefix; support both.
  router.post('/chat/completions', chatHandler)

  // ----- passthrough routes for /v1/* (e.g. /v1/models, /v1/embeddings) -----
  // We register a wildcard handler that proxies non-chat paths to the upstream.
  // h3 router doesn't have an `all` method, so we register every common method.
  const passthroughHandler: EventHandler = async (event) => {
    return handlePassthrough(event, opts.config, logger)
  }
  const PASSTHROUGH_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'] as const
  // h3's Router uses dynamic method names; cast once to keep the loop terse.
  const routerAny = router as unknown as Record<string, (path: string, h: EventHandler) => void>
  for (const method of PASSTHROUGH_METHODS) {
    routerAny[method]('/v1/**', passthroughHandler)
  }

  app.use(router)

  // ----- 404 fallback -----
  app.use(defineEventHandler((event) => {
    setResponseStatus(event, 404)
    setResponseHeader(event, 'content-type', 'application/json')
    return {
      error: 'not_found',
      message: `No route for ${event.method} ${event.path}. Supported: POST /v1/chat/completions, GET /health`,
    }
  }))

  const nodeServer = createNodeServer(toNodeListener(app))
  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', (err) => reject(err))
    nodeServer.listen(opts.config.port, opts.config.host, () => resolve())
  })

  const addr = nodeServer.address() as AddressInfo | null
  const port = addr?.port ?? opts.config.port
  const host = addr?.address ?? opts.config.host
  logger.info?.(`[escalate] proxy listening on http://${host}:${port} → ${opts.config.apiBase}`)
  logger.info?.(`[escalate] flash=${opts.config.flashModel}  pro=${opts.config.proModel}`)

  return {
    server: nodeServer,
    port,
    host,
    stop: async () => {
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()))
      await pool.close().catch(() => undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleChat(
  event: H3Event,
  dispatcher: EscalateDispatcher,
  logger: NonNullable<EscalateServerOptions['logger']>
): Promise<unknown> {
  // Read the raw body bytes (don't pre-parse — we pass the parsed object to
  // the dispatcher, but want to preserve client-provided content faithfully).
  const raw = await readRawBody(event, 'utf-8')
  if (!raw) {
    setResponseStatus(event, 400)
    setResponseHeader(event, 'content-type', 'application/json')
    return { error: 'empty_body', message: 'Request body is required' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    setResponseStatus(event, 400)
    setResponseHeader(event, 'content-type', 'application/json')
    return {
      error: 'invalid_json',
      message: `Request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const isStream = !!(parsed as { stream?: unknown })?.stream
  const clientHeaders = collectClientHeaders(event)

  // Create an AbortController that fires when the client disconnects.
  // This signal is threaded through to the upstream fetch so that the
  // remote API request is cancelled promptly instead of running to
  // completion for a response nobody will receive.
  //
  // We listen on `res.on('close')` (not `req`) and check `writableEnded`
  // because `close` fires both on normal completion AND on abnormal
  // disconnect — only the latter (response not fully sent yet) should
  // trigger an abort. The listener is intentionally NOT removed in a
  // `finally` block: for streaming responses, dispatch() returns long
  // before the stream finishes transferring, so the listener must stay
  // registered for the entire response lifecycle. Each request has its
  // own `res` object, so there's no leak across requests.
  const abortController = new AbortController()
  const clientSignal = abortController.signal
  const res = event.node.res

  res.on('close', () => {
    if (!res.writableEnded && !clientSignal.aborted) {
      abortController.abort(new Error('client disconnected'))
    }
  })

  let result
  try {
    result = await dispatcher.dispatch(parsed, isStream, clientHeaders, clientSignal)
  } catch (err) {
    logger.error?.(`[escalate] dispatcher error: ${err instanceof Error ? err.message : String(err)}`)
    setResponseStatus(event, 502)
    setResponseHeader(event, 'content-type', 'application/json')
    return {
      error: 'upstream_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  // Mirror upstream status.
  setResponseStatus(event, result.status)
  for (const [k, v] of Object.entries(result.headers)) {
    try {
      setResponseHeader(event, k, v)
    } catch {
      // Fallback: URL-encode the entire value if it contains non-ASCII chars.
      try {
        setResponseHeader(event, k, encodeURIComponent(v))
      } catch {
        // Last resort: strip non-ASCII and try again.
        const asciiOnly = v.replace(/[^\x20-\x7E]/g, '')
        setResponseHeader(event, k, asciiOnly || 'sanitized')
      }
    }
  }

  if (result.isStream) {
    const stream = result.body as ReadableStream<Uint8Array>
    return sendStream(event, stream)
  }

  // Non-stream body — convert to a string for h3 to return.
  const buf = result.body as Buffer
  return buf.toString('utf-8')
}

async function handlePassthrough(
  event: H3Event,
  config: EscalateConfig,
  logger: NonNullable<EscalateServerOptions['logger']>
): Promise<unknown> {
  // Passthrough route is `/v1/**`; `**` captures everything after `/v1/`.
  // We manually prepend `/v1/` because `apiBase` no longer includes the version
  // prefix — that prefix is added by `callUpstream` at `/v1/messages`.
  // h3's radix3-based router exposes the `**` catch-all under the `_` key
  // (single underscore) when no name is given via `**name`.
  const targetPath = (getRouterParam(event, '_') ?? '').toString()
  const url = `${config.apiBase.replace(/\/+$/, '')}/v1/${targetPath}`.replace(/\/+$/, '')
  const headers = collectClientHeaders(event)
  // Replace Authorization if apiKey is set.
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`
  delete headers['host']
  delete headers['content-length']

  let body: string | undefined
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    const raw = await readRawBody(event, 'utf-8')
    body = raw ?? undefined
  }

  try {
    const resp = await fetch(url, { method: event.method, headers, body })
    setResponseStatus(event, resp.status)
    resp.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'transfer-encoding') return
      setResponseHeader(event, k, v)
    })
    if (resp.body) {
      return sendStream(event, resp.body as ReadableStream<Uint8Array>)
    }
    return ''
  } catch (err) {
    logger.error?.(`[escalate] passthrough error: ${err instanceof Error ? err.message : String(err)}`)
    setResponseStatus(event, 502)
    return { error: 'upstream_error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** Pull request headers into a plain object for the dispatcher. */
function collectClientHeaders(event: H3Event): Record<string, string> {
  const out: Record<string, string> = {}
  // h3 event.node.req.headers is a plain object.
  const raw = event.node?.req?.headers ?? {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Test-only helper: build a server bound to an ephemeral port without going
// through `startEscalateServer`. Used by integration tests.
// ---------------------------------------------------------------------------

/**
 * Bind a dispatcher to a fresh h3 app. Exported for tests; production code
 * should call `startEscalateServer`.
 */
export function buildEscalateApp(config: EscalateConfig, logger?: EscalateServerOptions['logger']) {
  const dispatcher = new EscalateDispatcher({ config, logger })
  const app = createApp()
  const router = createRouter()

  router.get('/health', defineEventHandler(() => ({
    ok: true,
    proxy: 'codebase-escalate',
    model: { flash: config.flashModel, pro: config.proModel },
    upstream: config.apiBase,
  })))
  const chatHandler: EventHandler = async (event) => handleChat(event, dispatcher, logger ?? {})
  router.post('/v1/messages', chatHandler)
  router.post('/v1/chat/completions', chatHandler)
  router.post('/chat/completions', chatHandler)
  app.use(router)
  return app
}
