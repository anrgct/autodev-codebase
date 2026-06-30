/**
 * Verifies that when a client disconnects mid-request, the proxy propagates
 * the cancellation to the upstream API (aborting the in-flight fetch).
 *
 * Strategy:
 *   1. Mock upstream that holds the request open for a long time and records
 *      whether its incoming connection was closed (aborted) before the response
 *      was sent.
 *   2. Client sends a request to the proxy, then aborts after a short delay.
 *   3. Assert that the upstream saw its connection close (abort propagated).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createNodeServer, type Server as NodeServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startEscalateServer, type EscalateServerHandle } from '../server'
import type { EscalateConfig } from '../types'
import type { AddressInfo } from 'node:net'

const FLASH_MODEL = 'deepseek-v4-flash'
const PRO_MODEL = 'deepseek-v4-pro'

let upstream: NodeServer
let upstreamPort: number

/**
 * Records the lifecycle of each upstream request:
 *   - `aborted`: true if the upstream connection was closed by the proxy
 *     (abort propagated) before the upstream finished responding.
 *   - `completed`: true if the upstream got to send its response.
 */
interface UpstreamLifecycle { aborted: boolean; completed: boolean }
let lastLifecycle: UpstreamLifecycle = { aborted: false, completed: false }

beforeAll(async () => {
  upstream = createNodeServer((req: IncomingMessage, res: ServerResponse) => {
    const lifecycle: UpstreamLifecycle = { aborted: false, completed: false }
    lastLifecycle = lifecycle

    // Detect the proxy aborting this connection.
    req.on('close', () => {
      if (!res.writableEnded) {
        lifecycle.aborted = true
      }
    })

    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf-8') })
    req.on('end', () => {
      let isStream = false
      try {
        const parsed = JSON.parse(body)
        isStream = !!parsed?.stream
      } catch { /* ignore */ }

      if (isStream) {
        // Start streaming immediately so dispatch() returns (handing the
        // ReadableStream back to the server) BEFORE the client aborts.
        res.setHeader('content-type', 'text/event-stream')
        res.writeHead(200)
        // Send one chunk without the NEEDS_PRO marker so the proxy peeks,
        // detects 'no-marker', and enters passthrough.
        res.write('data: ' + JSON.stringify({
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
        }) + '\n\n')
        // Hold the connection open — don't call res.end().
        // If the abort propagates, `res` will be destroyed (lifecycle.aborted=true).
        return
      }

      // Non-stream: hold the response open so the client has time to abort.
      setTimeout(() => {
        if (!res.destroyed) {
          lifecycle.completed = true
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            choices: [{ message: { content: 'slow response' } }],
          }))
        }
      }, 5000)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

function makeConfig(): EscalateConfig {
  return {
    mode: 'self-report',
    apiBase: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'sk-mock',
    flashModel: FLASH_MODEL,
    proModel: PRO_MODEL,
    port: 0,
    host: '127.0.0.1',
    stickyProTtlMs: 0,
    thinkingBudget: 8000,
    maxTokens: 4096,
    forceAdvisor: false,
  }
}

describe('escalate proxy — client-disconnect abort propagation', () => {
  let handle: EscalateServerHandle
  let proxyUrl: string

  beforeAll(async () => {
    handle = await startEscalateServer({ config: makeConfig() })
    proxyUrl = `http://127.0.0.1:${handle.port}`
  })

  afterAll(async () => {
    await handle.stop()
  })

  it('non-stream: aborts the upstream fetch when the client disconnects', async () => {
    lastLifecycle = { aborted: false, completed: false }

    const ac = new AbortController()
    const fetchPromise = fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      signal: ac.signal,
    })

    // Give the proxy time to forward the request to the upstream, then abort.
    await new Promise((r) => setTimeout(r, 200))
    ac.abort()

    // The client fetch should reject with AbortError.
    await expect(fetchPromise).rejects.toThrow()

    // Wait a bit for the abort to propagate through the proxy to the upstream.
    await new Promise((r) => setTimeout(r, 300))

    // The upstream should have seen its connection close (abort propagated).
    expect(lastLifecycle.aborted).toBe(true)
    expect(lastLifecycle.completed).toBe(false)
  }, 10_000)

  it('stream: aborts the upstream fetch when the client disconnects mid-stream', async () => {
    lastLifecycle = { aborted: false, completed: false }

    const ac = new AbortController()
    const respPromise = fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      signal: ac.signal,
    })

    // Wait for the response headers to arrive — at this point dispatch() has
    // already returned and (in the buggy version) the close listener was
    // removed. The upstream is still streaming its body.
    const resp = await respPromise
    expect(resp.status).toBe(200)
    expect(resp.body).not.toBeNull()

    // Start reading the stream so the proxy begins piping.
    const reader = resp.body!.getReader()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    expect(firstChunk.value!.length).toBeGreaterThan(0)

    // NOW abort mid-stream — this is the scenario the old code missed.
    ac.abort()

    // Wait for abort propagation to the upstream.
    await new Promise((r) => setTimeout(r, 300))

    expect(lastLifecycle.aborted).toBe(true)
    expect(lastLifecycle.completed).toBe(false)
  }, 10_000)
})
