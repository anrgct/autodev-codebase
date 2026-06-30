/**
 * End-to-end test for the `codebase escalate` proxy.
 *
 * Spins up a real h3 server on an ephemeral port and a mock upstream server,
 * then drives the proxy with HTTP requests and asserts escalation behavior.
 *
 * Mock upstream is a tiny in-process HTTP server that:
 *   - serves `/v1/messages` differently depending on the model in the body
 *     (flash or pro).
 *   - echoes back the model name and the request body so we can assert what
 *     the proxy actually sent.
 *
 * Uses the Anthropic Messages API format exclusively.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createNodeServer, type Server as NodeServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startEscalateServer, type EscalateServerHandle } from '../server'
import type { EscalateConfig } from '../types'
import type { AddressInfo } from 'node:net'

const FLASH_MODEL = 'deepseek-v4-flash'
const PRO_MODEL = 'deepseek-v4-pro'
const MOCK_TOKEN = 'sk-mock-test-token'

interface CapturedRequest {
  body: string
  contentType: string
  xApiKey: string | undefined
}

let upstream: NodeServer
let upstreamPort: number
const captured: Record<'flash' | 'pro', CapturedRequest[]> = { flash: [], pro: [] }

beforeAll(async () => {
  upstream = createNodeServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 400
      res.end()
      return
    }
    const url = req.url
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf-8') })
    req.on('end', () => {
      // Differentiate by the model in the body so we can simulate flash vs pro
      // responses without relying on URL query params.
      let target: 'flash' | 'pro' = 'flash'
      try {
        const parsed = JSON.parse(body)
        if (parsed?.model === PRO_MODEL) target = 'pro'
      } catch {
        // Non-JSON body; default to flash.
      }
      captured[target].push({
        body,
        contentType: String(req.headers['content-type'] ?? ''),
        xApiKey: req.headers['x-api-key'] as string | undefined,
      })
      res.setHeader('content-type', 'application/json')

      if (url.startsWith('/v1/messages')) {
        if (target === 'flash') {
          // Simulate the model emitting the NEEDS_PRO marker.
          res.end(JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '<<<NEEDS_PRO>>>\n[flash aborted]' }],
            stop_reason: 'end_turn',
            model: FLASH_MODEL,
            usage: { input_tokens: 10, output_tokens: 5 },
          }))
        } else {
          res.end(JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'PRO DEEP ANALYSIS HERE' }],
            stop_reason: 'end_turn',
            model: PRO_MODEL,
            usage: { input_tokens: 10, output_tokens: 8 },
          }))
        }
      } else if (url.startsWith('/v1/models')) {
        res.end(JSON.stringify({ data: [{ id: FLASH_MODEL }, { id: PRO_MODEL }] }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
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
    // apiBase WITHOUT /v1 suffix — callUpstream appends /v1/messages
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    apiKey: MOCK_TOKEN,
    flashModel: FLASH_MODEL,
    proModel: PRO_MODEL,
    port: 0, // ephemeral
    host: '127.0.0.1',
    stickyProTtlMs: 0,
    thinkingBudget: 8000,
    maxTokens: 4096,
    forceAdvisor: false,
  }
}

async function postJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; bodyText: string; headers: Record<string, string> }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
  const bodyText = await resp.text()
  const headers: Record<string, string> = {}
  resp.headers.forEach((v, k) => { headers[k] = v })
  return { status: resp.status, bodyText, headers }
}

describe('escalate proxy e2e', () => {
  let handle: EscalateServerHandle
  let proxyUrl: string

  beforeAll(async () => {
    handle = await startEscalateServer({ config: makeConfig() })
    proxyUrl = `http://127.0.0.1:${handle.port}`
  })

  afterAll(async () => {
    await handle.stop()
  })

  it('GET /health returns the proxy config', async () => {
    const r = await fetch(`${proxyUrl}/health`)
    const j = await r.json() as Record<string, unknown>
    expect(j['ok']).toBe(true)
    expect((j['model'] as Record<string, string>)['flash']).toBe(FLASH_MODEL)
    expect((j['model'] as Record<string, string>)['pro']).toBe(PRO_MODEL)
  })

  it('POST /v1/messages injects the contract and escalates on marker', async () => {
    captured.flash = []
    captured.pro = []

    // Note: the mock upstream always returns the NEEDS_PRO marker for the flash
    // path, so we expect the proxy to transparently retry on pro.
    const r = await postJson(`${proxyUrl}/v1/messages`, {
      model: 'auto',
      system: 'You are a helpful coding agent.',
      messages: [{ role: 'user', content: 'Solve a tricky problem' }],
    })

    expect(r.status).toBe(200)
    expect(r.headers['x-escalated-to']).toBe('pro')
    expect(r.headers['x-escalated-from']).toBe('flash')
    expect(r.headers['x-escalation-reason']).toBe('self-report')
    const j = JSON.parse(r.bodyText)
    expect(j.type).toBe('message')
    expect(j.role).toBe('assistant')
    expect(j.content[0].type).toBe('text')
    expect(j.content[0].text).toBe('PRO DEEP ANALYSIS HERE')
    expect(j.stop_reason).toBe('end_turn')

    // Upstream saw the flash call with the contract injected.
    expect(captured.flash).toHaveLength(1)
    const flashBody = JSON.parse(captured.flash[0].body)
    expect(flashBody.model).toBe(FLASH_MODEL)
    // System is top-level field, not messages[].role:'system'
    expect(flashBody.system).toContain('Tier escalation instruction')
    // The client's original system prompt is preserved alongside the contract.
    expect(flashBody.system).toContain('You are a helpful coding agent.')
    // Authorization was forwarded via x-api-key header.
    expect(captured.flash[0].xApiKey).toBe(MOCK_TOKEN)

    // Upstream saw the pro call with the pro-side contract injected.
    expect(captured.pro).toHaveLength(1)
    const proBody = JSON.parse(captured.pro[0].body)
    expect(proBody.model).toBe(PRO_MODEL)
    // The pro-side contract teaches the pro model about the downgrade
    // marker (<<<NEEDS_FLASH>>>) so it can voluntarily step down.
    expect(proBody.system).toContain('Cost-aware tier switching instruction')
    expect(proBody.system).toContain('strong tier')
    expect(proBody.system).toContain('`<<<NEEDS_FLASH>>>`')
    // Client system prompt is also preserved on the pro retry.
    expect(proBody.system).toContain('You are a helpful coding agent.')

    // Incoming body format should be Anthropic Messages API shape.
    expect(flashBody).toHaveProperty('messages')
    expect(flashBody).toHaveProperty('system')
    expect(Array.isArray(flashBody.messages)).toBe(true)
  })

  it('passes through /v1/models to the upstream', async () => {
    const r = await fetch(`${proxyUrl}/v1/models`)
    const j = await r.json() as { data: Array<{ id: string }> }
    expect(j.data).toHaveLength(2)
    expect(j.data.map((d) => d.id)).toEqual([FLASH_MODEL, PRO_MODEL])
  })
})
