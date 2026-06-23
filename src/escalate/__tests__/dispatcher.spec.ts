/**
 * Unit tests for the dispatcher — uses a mocked fetch to assert behavior
 * without touching the network.
 *
 * Test scenarios:
 *   1. Non-stream: no escalation → return flash body + X-Escalated-To: flash
 *   2. Non-stream: with bare <<<NEEDS_PRO>>> → retry on pro, return pro body
 *   3. Non-stream: with reason marker → retry on pro + X-Escalation-Reason
 *   4. Non-stream: upstream error → pass through error + flash header
 *   5. Stream: no marker → passthrough (buffered chunk first, then rest)
 *   6. Stream: marker in first chunk → cancel flash, start pro stream
 *   7. Authorization forwarding: client bearer → upstream when no apiKey set
 *   8. Authorization override: apiKey set → uses configured key
 *   9. Body injection: ESCALATION_CONTRACT appended to system prompt
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EscalateDispatcher } from '../dispatcher'
import type { EscalateConfig } from '../types'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'

function makeConfig(overrides: Partial<EscalateConfig> = {}): EscalateConfig {
  return {
    apiBase: 'https://api.example.com/v1',
    apiKey: undefined,
    flashModel: FLASH,
    proModel: PRO,
    port: 8080,
    host: 'localhost',
    stickyProTtlMs: 0,
    ...overrides,
  }
}

/** Build a `Response`-shaped object for the mock fetch. */
function mkResponse(body: string | ReadableStream<Uint8Array>, opts: {
  status?: number
  headers?: Record<string, string>
} = {}): Response {
  const status = opts.status ?? 200
  const headers = new Headers(opts.headers ?? { 'content-type': 'application/json' })
  return new Response(typeof body === 'string' ? body : (body as ReadableStream), { status, headers })
}

interface CapturedCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

describe('EscalateDispatcher', () => {
  let captured: CapturedCall[]
  let fetchMock: ReturnType<typeof vi.fn>
  /** Queue of Response-like objects, each call to the mock pops one off. */
  let responseQueue: Response[]

  beforeEach(() => {
    captured = []
    responseQueue = []
    fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = args[0] as string | URL | Request
      const init = args[1] as { method?: string; headers?: Headers | Record<string, string>; body?: string } | undefined
      const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.toString() : (url as Request).url)
      const headersObj: Record<string, string> = {}
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headersObj[k] = v })
        } else {
          Object.assign(headersObj, init.headers)
        }
      }
      captured.push({ url: urlStr, init: { ...(init ?? {}), headers: headersObj } })
      const next = responseQueue.shift()
      if (!next) throw new Error(`Mock fetch called with no queued response (call #${captured.length})`)
      return next
    })
  })

  /** Convenience: enqueue a response for the next mock call. */
  function queueResponse(body: string | ReadableStream<Uint8Array>, opts?: { status?: number; headers?: Record<string, string> }): void {
    responseQueue.push(mkResponse(body, opts))
  }

  // --------------------------------------------------------------------
  // Non-streaming path
  // --------------------------------------------------------------------
  describe('non-streaming', () => {
    it('returns the flash body unchanged when no marker is present', async () => {
      queueResponse('Hello there!')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'hi' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(out.status).toBe(200)
      expect(out.isStream).toBe(false)
      expect((out.body as Buffer).toString('utf-8')).toBe('Hello there!')
      expect(out.headers['x-escalated-to']).toBe('flash')
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe('https://api.example.com/v1/chat/completions')
    })

    it('retries on pro when the bare marker is present in the flash body', async () => {
      const flashBody = '<<<NEEDS_PRO>>>\nThis task requires deeper reasoning.'
      const proBody = 'OK, here is the deeper answer.'
      queueResponse(flashBody)
      queueResponse(proBody)

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.finalModel).toBe('pro')
      expect(out.reason).toBe('self-report')
      expect((out.body as Buffer).toString('utf-8')).toBe(proBody)
      expect(out.headers['x-escalated-to']).toBe('pro')
      expect(out.headers['x-escalated-from']).toBe('flash')
      expect(out.headers['x-escalation-reason']).toBe('self-report')
      expect(captured).toHaveLength(2)
      // Pro retry must NOT re-inject the contract (pro model needs no ladder).
      const proBodySent = JSON.parse(captured[1].init.body!)
      expect(proBodySent.model).toBe(PRO)
      // Flash body must have the contract injected and model forced to FLASH.
      const flashBodySent = JSON.parse(captured[0].init.body!)
      expect(flashBodySent.model).toBe(FLASH)
      const sys = flashBodySent.messages.find((m: { role: string }) => m.role === 'system')
      expect(sys.content).toContain('Cost-aware tier switching instruction')
    })

    it('passes the marker reason through to the pro retry header', async () => {
      const reason = 'cross-file refactor across 6 modules'
      const flashBody = `<<<NEEDS_PRO: ${reason}>>>\nrest`
      queueResponse(flashBody)
      queueResponse('pro answer')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.finalModel).toBe('pro')
      expect(out.headers['x-escalation-reason']).toBe(reason)
    })

    it('passes through upstream errors with X-Escalated-To: flash', async () => {
      queueResponse('upstream 500', { status: 500 })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.status).toBe(500)
      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('error')
      expect(out.headers['x-escalated-to']).toBe('flash')
    })
  })

  // --------------------------------------------------------------------
  // Streaming path
  // --------------------------------------------------------------------
  describe('streaming', () => {
    function mkSseStream(chunks: string[]): ReadableStream<Uint8Array> {
      const enc = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      })
    }

    /** Fully drain a ReadableStream to a string. */
    async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader()
      const dec = new TextDecoder()
      let acc = ''
      for (let i = 0; i < 200; i++) {
        const { value, done } = await reader.read()
        if (done) break
        acc += dec.decode(value, { stream: true })
      }
      return acc
    }

    /** Parse concatenated SSE text into {content, reasoning} strings. */
    function parseSse(sseText: string): { content: string; reasoning: string } {
      let content = ''
      let reasoning = ''
      for (const line of sseText.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          const delta = parsed?.choices?.[0]?.delta
          if (typeof delta?.content === 'string') content += delta.content
          if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content
        } catch { /* ignore */ }
      }
      return { content, reasoning }
    }

    it('forwards reasoning_content immediately and passes content through when no marker', async () => {
      const stream = mkSseStream([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      // Streaming responses no longer carry X-Escalated-* headers.
      expect(out.headers['x-escalated-to']).toBeUndefined()

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)
      expect(reasoning).toBe('thinking...')
      expect(content).toBe('Hello world')
      // No escalation → only one upstream call.
      expect(captured).toHaveLength(1)
    })

    it('escalates to pro and injects a separator into the reasoning stream', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"flash thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<<<NEEDS_PRO>>>"}}]}\n\n',
      ])
      const proStream = mkSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"pro thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"PRO ANSWER"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      expect(out.headers['x-escalated-to']).toBeUndefined()

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)
      // Flash reasoning forwarded to the client.
      expect(reasoning).toContain('flash thinking')
      // Separator injected between the two tiers.
      expect(reasoning).toContain('now on pro')
      expect(reasoning).toContain('was flash')
      // Pro reasoning forwarded.
      expect(reasoning).toContain('pro thinking')
      // Pro answer (the marker is dropped, not forwarded as content).
      expect(content).toBe('PRO ANSWER')
      expect(content).not.toContain('<<<NEEDS_PRO>>>')
      // Two upstream calls: flash then pro.
      expect(captured).toHaveLength(2)
    })

    it('carries the marker reason into the separator text', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"<<<NEEDS_PRO: needs deep analysis>>>"}}]}\n\n',
      ])
      const proStream = mkSseStream(['data: [DONE]\n\n'])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { reasoning } = parseSse(acc)
      // The separator carries the upgrade reason.
      expect(reasoning).toContain('needs deep analysis')
    })

    it('downgrades pro → flash with a second separator and no marker leak', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"<<<NEEDS_PRO>>>"}}]}\n\n',
      ])
      const proStream = mkSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"pro thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<<<NEEDS_FLASH>>>"}}]}\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"FLASH REUSED"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)
      // Both separators present.
      expect(reasoning).toContain('now on pro')
      expect(reasoning).toContain('now on flash')
      // Pro reasoning forwarded in between.
      expect(reasoning).toContain('pro thinking')
      // Final content from flash retry.
      expect(content).toBe('FLASH REUSED')
      // No markers leak into content.
      expect(content).not.toContain('<<<NEEDS_PRO>>>')
      expect(content).not.toContain('<<<NEEDS_FLASH>>>')
      // Three calls: flash → pro → flash retry.
      expect(captured).toHaveLength(3)
    })

    it('forwards all events when multiple SSE events arrive in a single chunk (no-marker flush line loss bug)', async () => {
      // Regression test: when multiple SSE events are packed into one TCP chunk
      // and the first content line triggers `no-marker`, peekTierStream must
      // not lose the remaining lines in that chunk.
      const chunk1 = [
        // reasoning + first content + more content + tool_calls + DONE — all in one chunk
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"test","arguments":""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ok\""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
        'data: [DONE]\n\n',
      ]
      const stream = mkSseStream(chunk1)
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)
      expect(reasoning).toBe('thinking...')
      // All content tokens must survive, even those after the first no-marker.
      expect(content).toBe('Hello world!')
      // No escalation → only one upstream call.
      expect(captured).toHaveLength(1)
    })

    it('does not hang on non-marker content starting with < (e.g. <html>)', async () => {
      // detectMarkerPrefix must rule this out on the very first chunk.
      const stream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"<html>hello</html>"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content } = parseSse(acc)
      expect(content).toBe('<html>hello</html>')
      expect(captured).toHaveLength(1)
    })

    it('passes through upstream errors as non-stream bodies with the flash header', async () => {
      queueResponse('upstream 500', { status: 500 })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.status).toBe(500)
      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('error')
      expect(out.isStream).toBe(false)
      expect(out.headers['x-escalated-to']).toBe('flash')
    })
  })

  // --------------------------------------------------------------------
  // Header & body construction
  // --------------------------------------------------------------------
  describe('header & body construction', () => {
    it('forwards the client Authorization header when no apiKey is set', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({ messages: [] }, false, { authorization: 'Bearer client-key' })

      const headers = captured[0].init.headers!
      expect(headers['authorization']).toBe('Bearer client-key')
    })

    it('overrides the client Authorization when apiKey is set', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({
        config: makeConfig({ apiKey: 'server-key' }),
        fetchImpl: fetchMock as never,
      })
      await d.dispatch({ messages: [] }, false, { authorization: 'Bearer client-key' })

      const headers = captured[0].init.headers!
      // The dispatcher sets `Authorization` (capital A) when apiKey is configured;
      // case-insensitive lookup is fine here since the test only cares about the value.
      const auth = headers['authorization'] ?? headers['Authorization']
      expect(auth).toBe('Bearer server-key')
    })

    it('strips hop-by-hop headers from the client', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({ messages: [] }, false, {
        'connection': 'keep-alive',
        'host': 'evil.example.com',
        'transfer-encoding': 'chunked',
        'x-custom': 'keep-me',
      } as Record<string, string>)

      const headers = captured[0].init.headers!
      expect(headers['connection']).toBeUndefined()
      expect(headers['host']).toBeUndefined()
      expect(headers['transfer-encoding']).toBeUndefined()
      expect(headers['x-custom']).toBe('keep-me')
    })

    it('forces the model field to the flash ID and injects the contract', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const body = {
        model: 'something-else',
        messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'q' }],
      }
      await d.dispatch(body, false, {})

      const sentBody = JSON.parse(captured[0].init.body!)
      expect(sentBody.model).toBe(FLASH)
      const sys = sentBody.messages.find((m: { role: string }) => m.role === 'system')
      expect(sys.content).toContain('You are helpful.')
      expect(sys.content).toContain('Cost-aware tier switching instruction')
    })

    it('injects the pro-side contract on the pro retry (teaches downgrade)', async () => {
      queueResponse('<<<NEEDS_PRO>>>\nrest')
      queueResponse('pro')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const body = {
        model: 'auto',
        messages: [{ role: 'system', content: 'Hi' }, { role: 'user', content: 'q' }],
      }
      await d.dispatch(body, false, {})

      expect(captured).toHaveLength(2)
      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      const sys = proBody.messages.find((m: { role: string }) => m.role === 'system')
      // The pro retry now injects the pro-side contract (which mentions
      // `<<<NEEDS_FLASH>>>` so the pro model knows it can downgrade).
      expect(sys.content).toContain('Cost-aware tier switching instruction')
      expect(sys.content).toContain('strong tier')
      expect(sys.content).toContain('`<<<NEEDS_FLASH>>>`')
    })

    it('downgrades to flash when the pro response emits <<<NEEDS_FLASH>>> (non-stream)', async () => {
      const flashBody = '<<<NEEDS_PRO>>>\nflash aborted'
      const proBody = '<<<NEEDS_FLASH: trivial lookup>>>\npro aborted'
      const flashRetryBody = 'FLASH REUSED RESPONSE'
      queueResponse(flashBody)
      queueResponse(proBody)
      queueResponse(flashRetryBody)

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('downgrade')
      expect(out.path).toEqual(['flash', 'pro', 'flash'])
      expect((out.body as Buffer).toString('utf-8')).toBe(flashRetryBody)
      expect(out.headers['x-escalated-to']).toBe('flash')
      expect(out.headers['x-escalated-from']).toBe('pro')
      expect(out.headers['x-escalation-path']).toBe('flash->pro->flash')
      expect(out.headers['x-escalation-reason']).toBe('trivial lookup')
      // Three upstream calls: flash → pro → flash
      expect(captured).toHaveLength(3)
    })

    it('passes the downgrade reason through to the response header', async () => {
      const reason = 'simple typo fix; pro would over-engineer this'
      queueResponse('<<<NEEDS_PRO>>>\nrest')
      queueResponse(`<<<NEEDS_FLASH: ${reason}>>>\nrest`)
      queueResponse('flash done')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.headers['x-escalation-reason']).toBe(reason)
    })

    it('does not downgrade when the pro response is normal (no marker)', async () => {
      queueResponse('<<<NEEDS_PRO>>>\nrest')
      queueResponse('PRO ANSWER — no marker, no downgrade')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.finalModel).toBe('pro')
      expect(out.reason).toBe('self-report')
      expect(out.path).toEqual(['flash', 'pro'])
      expect(out.headers['x-escalation-path']).toBe('flash->pro')
      // Two calls: flash → pro (no third flash retry)
      expect(captured).toHaveLength(2)
    })
  })
})
