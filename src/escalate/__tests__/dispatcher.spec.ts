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
    mode: 'self-report',
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
      expect(sys.content).toContain('Tier escalation instruction')
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
      expect(sys.content).toContain('Tier escalation instruction')
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

  // --------------------------------------------------------------------
  // Advisor mode — non-streaming
  // --------------------------------------------------------------------
  describe('advisor mode (non-stream)', () => {
    function makeAdvisorConfig(overrides: Partial<EscalateConfig> = {}): EscalateConfig {
      return makeConfig({ mode: 'advisor', ...overrides })
    }

    it('passes through flash response when flash does not call advisor', async () => {
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'flash direct answer' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(out.path).toEqual(['flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.choices[0].message.content).toBe('flash direct answer')
      expect(captured).toHaveLength(1)
    })

    it('injects the advisor tool definition on the flash call without modifying system', async () => {
      // The client's system message is the user's actual agent prompt
      // (e.g. "You are the Zed coding agent..."). We must NOT pollute it
      // with proxy internals like the advisor fragment or the self-report
      // tier contract. Advisor guidance lives entirely in the tool's
      // description.
      const clientSystemPrompt = 'You are a coding assistant. Be helpful.'
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'flash direct' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({
        messages: [
          { role: 'system', content: clientSystemPrompt },
          { role: 'user', content: 'q' },
        ],
      }, false, {})

      const flashBody = JSON.parse(captured[0].init.body!)
      expect(flashBody.model).toBe(FLASH)
      const tools = flashBody.tools
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.some((t: { function?: { name?: string } }) => t.function?.name === 'advisor')).toBe(true)
      // System prompt is the client's verbatim — no advisor fragment, no
      // self-report contract appended.
      const sys = flashBody.messages.find((m: { role: string }) => m.role === 'system')
      expect(sys.content).toBe(clientSystemPrompt)
      expect(sys.content).not.toContain('[autodev-escalate-advisor]')
      expect(sys.content).not.toContain('Tier escalation instruction')
      expect(sys.content).not.toContain('<<<NEEDS_PRO>>>')
      expect(sys.content).not.toContain('<<<NEEDS_FLASH>>>')
    })

    it('routes advisor tool call to pro and returns pro content as tool result', async () => {
      queueResponse(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'advisor', arguments: '{"question":"how to refactor X?"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }))
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'PRO ANALYSIS: use strategy Y' }, finish_reason: 'stop' }],
      }))
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'synthesized final answer' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('advisor')
      expect(out.path).toEqual(['flash', 'pro', 'flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.choices[0].message.content).toBe('synthesized final answer')
      expect(captured).toHaveLength(3)

      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      // Pro is a passive advisor — NO tools (not even advisor). Flash owns
      // the advisor tool exclusively.
      expect(proBody.tools).toBeUndefined()
      expect(proBody.tool_choice).toBeUndefined()
      const proMessages = proBody.messages
      // The advisor question is surfaced as a user message appended after
      // the original conversation. Pro sees: original user msg + advisor
      // question as a standalone user message.
      expect(proMessages.length).toBe(2)
      expect(proMessages[0].role).toBe('user')
      expect(proMessages[0].content).toBe('q')
      expect(proMessages[1].role).toBe('user')
      expect(proMessages[1].content).toBe('[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] how to refactor X?')

      // Advisor mode does NOT inject any system-prompt contract into pro's
      // request — advisor mode is fully decoupled from the self-report
      // `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>` markers, so pro should not
      // see explanations of markers it will never use. If the client supplied
      // a `system` message it carries through untouched.
      const proSystemMsgs = proMessages.filter((m: { role: string }) => m.role === 'system')
      for (const sm of proSystemMsgs) {
        const text = typeof sm.content === 'string' ? sm.content : ''
        expect(text).not.toContain('Two markers are available across the system')
        expect(text).not.toContain('<<<NEEDS_FLASH>>>')
        expect(text).not.toContain('Cost-aware tier switching instruction')
      }
    })

    it('flash retry receives the tool result message and pro sees advisor question as user msg', async () => {
      queueResponse(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'advisor', arguments: '{"question":"q1"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }))
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'PRO ANSWER' }, finish_reason: 'stop' }],
      }))
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'final' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      const flashRetryBody = JSON.parse(captured[2].init.body!)
      const messages = flashRetryBody.messages
      const toolMsg = messages[messages.length - 1]
      expect(toolMsg.role).toBe('tool')
      expect(toolMsg.tool_call_id).toBe('call_1')
      expect(toolMsg.content).toBe('PRO ANSWER')

      // Verify pro received the advisor question as a user message
      const proBody = JSON.parse(captured[1].init.body!)
      const proMessages = proBody.messages
      const advisorUserMsg = proMessages.find((m: { role: string; content: string }) =>
        m.role === 'user' && typeof m.content === 'string' && m.content === '[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] q1')
      expect(advisorUserMsg).toBeDefined()
    })

    it('handles multiple advisor calls sequentially via recursion', async () => {
      // Flash returns TWO advisor tool_calls in one message.
      // The dispatcher only processes the FIRST call per response; the
      // second is handled when flash retries and calls advisor again.
      queueResponse(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'advisor', arguments: '{"question":"question A"}' } },
              { id: 'call_b', type: 'function', function: { name: 'advisor', arguments: '{"question":"question B"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      }))
      // Pro responds to call_a
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'PRO ANSWER A' }, finish_reason: 'stop' }],
      }))
      // Flash retry — sees tool result for call_a, calls advisor for call_b
      queueResponse(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_b', type: 'function', function: { name: 'advisor', arguments: '{"question":"question B"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      }))
      // Pro responds to call_b
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'PRO ANSWER B' }, finish_reason: 'stop' }],
      }))
      // Flash final answer
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'synthesised from A and B' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      // flash → pro (call_a) → flash → pro (call_b) → flash
      expect(out.path).toEqual(['flash', 'pro', 'flash', 'pro', 'flash'])
      expect(captured).toHaveLength(5)

      // Verify sequential messages: each flash retry only has ONE tool result
      const retry1 = JSON.parse(captured[2].init.body!)
      const toolMsgs1 = retry1.messages.filter((m: { role: string }) => m.role === 'tool')
      expect(toolMsgs1).toHaveLength(1)
      expect(toolMsgs1[0].tool_call_id).toBe('call_a')

      const retry2 = JSON.parse(captured[4].init.body!)
      const toolMsgs2 = retry2.messages.filter((m: { role: string }) => m.role === 'tool')
      expect(toolMsgs2).toHaveLength(2)
      expect(toolMsgs2[0].tool_call_id).toBe('call_a')
      expect(toolMsgs2[1].tool_call_id).toBe('call_b')

      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.choices[0].message.content).toBe('synthesised from A and B')
    })

    it('handles recursion — flash calls advisor twice', async () => {
      // flash → advisor → pro → flash → advisor → pro → flash
      queueResponse(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'advisor', arguments: '{"question":"q1"}' } }] },
          finish_reason: 'tool_calls',
        }],
      }))
      queueResponse(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'PRO 1' }, finish_reason: 'stop' }] }))
      queueResponse(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'advisor', arguments: '{"question":"q2"}' } }] },
          finish_reason: 'tool_calls',
        }],
      }))
      queueResponse(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'PRO 2' }, finish_reason: 'stop' }] }))
      queueResponse(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }] }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.path).toEqual(['flash', 'pro', 'flash', 'pro', 'flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.choices[0].message.content).toBe('DONE')
      expect(captured).toHaveLength(5)
    })

    it('returns error when flash upstream fails', async () => {
      queueResponse('upstream 500', { status: 500 })
      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})
      expect(out.status).toBe(500)
      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('error')
      expect(captured).toHaveLength(1)
    })

    it('returns error when pro upstream fails on advisor call', async () => {
      queueResponse(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'advisor', arguments: '{"question":"q"}' } }] },
          finish_reason: 'tool_calls',
        }],
      }))
      queueResponse('pro 502', { status: 502 })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.status).toBe(502)
      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('advisor')
      expect(captured).toHaveLength(2)
    })

    it('passes through when flash emits tool calls but no advisor call', async () => {
      // Some other tool name — the proxy should NOT intercept.
      queueResponse(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_other', type: 'function', function: { name: 'some_other_tool', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(captured).toHaveLength(1)
    })


    it('rewrites orphaned advisor tool_calls in history as user prompts (non-stream)', async () => {
      // Client re-sends a prior turn where flash already called advisor but
      // the tool result message is missing. The proxy must NOT forward the
      // orphaned tool_call to deepseek (which would 400), instead it should
      // rewrite the orphan into a user prompt that surfaces the question.
      //
      // Inbound messages (note: assistant tool_call WITHOUT a following tool
      // result — the bug scenario the user reported).
      const inboundMessages = [
        { role: 'user', content: 'this is a test of advisor' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'orphan_call_1',
            type: 'function',
            function: { name: 'advisor', arguments: '{"question":"please confirm advisor works"}' },
          }],
        },
      ]

      // Only one upstream call expected: flash. No pro fill — we don't invent
      // a fake pro response for an unanswered tool call.
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'flash direct answer' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: inboundMessages }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(captured).toHaveLength(1)

      // The flash request should NOT contain the orphaned assistant tool_call
      // — it should have been rewritten to a user message containing the
      // advisor question. This is what keeps deepseek from 400-ing.
      const flashBody = JSON.parse(captured[0].init.body!)
      const flashMessages = flashBody.messages
      const stillHasOrphanToolCall = flashMessages.some((m: { role: string; tool_calls?: Array<{ id?: string }> }) =>
        m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === 'orphan_call_1'),
      )
      expect(stillHasOrphanToolCall).toBe(false)

      // The user prompt that surfaces the question must be present.
      const userPromptMsg = flashMessages.find((m: { role: string; content: string }) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes('please confirm advisor works'),
      )
      expect(userPromptMsg).toBeDefined()
      expect(userPromptMsg!.content).toMatch(/Earlier you attempted to call the advisor tool/)
    })

    it('skips orphaned advisor calls that already have tool results', async () => {
      // Client sends a turn where flash already called advisor AND supplied
      // the tool result — proxy should NOT re-call pro for this one.
      const inboundMessages = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'already_done',
            type: 'function',
            function: { name: 'advisor', arguments: '{}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'already_done',
          content: 'existing tool result',
        },
      ]

      // Expected: only one upstream call (flash), no orphan-fill.
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'flash final' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: inboundMessages }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream') // no advisor call made this turn
      expect(captured).toHaveLength(1) // just flash, no orphan-fill
    })

    // ══════════════════════════════════════════════════════════════════
    // VERIFY FIX: pro has NO tools → returns content → tool result has content
    //
    // buildProAdvisorBody() now strips ALL tools. Pro cannot call advisor.
    // Pro sees user's question and returns analysis as content, which the
    // dispatcher puts into the tool result for flash to synthesize.
    // ══════════════════════════════════════════════════════════════════
    it('pro returns content normally (no advisor tool → no tool_calls loop)', async () => {
      // Step 1: flash calls advisor
      queueResponse(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_flash_1',
              type: 'function',
              function: { name: 'advisor', arguments: '{"question":"测试advisor是否正常"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }))

      // Step 2: pro returns content normally (no tools to call)
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'PRO: advisor 工具正常工作，可以放心使用。' }, finish_reason: 'stop' }],
      }))

      // Step 3: flash retry synthesises
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '结合顾问分析：advisor 工具正常，可以开始你的任务。' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: '测试下advisor' }] }, false, {})

      // Flash retry body — tool_result must contain pro's analysis
      const flashRetryBody = JSON.parse(captured[2].init.body!)
      const toolResultMsg = flashRetryBody.messages[flashRetryBody.messages.length - 1]
      expect(toolResultMsg.role).toBe('tool')
      expect(toolResultMsg.content).toBe('PRO: advisor 工具正常工作，可以放心使用。')

      // Flash synthesises pro's analysis
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.choices[0].message.content).toContain('顾问分析')

      // Pro body MUST NOT have any tools
      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      expect(proBody.tools).toBeUndefined()
      expect(proBody.tool_choice).toBeUndefined()
    })

    it('preserves client-provided tools on flash call (advisor is appended)', async () => {
      queueResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ type: 'function', function: { name: 'client_tool' } }],
      }, false, {})

      const flashBody = JSON.parse(captured[0].init.body!)
      const tools = flashBody.tools
      expect(tools).toHaveLength(2)
      const names = tools.map((t: { function?: { name?: string } }) => t.function?.name)
      expect(names).toContain('client_tool')
      expect(names).toContain('advisor')
    })
  })

  // --------------------------------------------------------------------
  // Advisor mode — streaming
  // --------------------------------------------------------------------
  describe('advisor mode (stream)', () => {
    function makeAdvisorConfig(overrides: Partial<EscalateConfig> = {}): EscalateConfig {
      return makeConfig({ mode: 'advisor', ...overrides })
    }

    function mkSseStream(chunks: string[]): ReadableStream<Uint8Array> {
      const enc = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      })
    }

    async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader()
      const dec = new TextDecoder()
      let acc = ''
      for (let i = 0; i < 500; i++) {
        const { value, done } = await reader.read()
        if (done) break
        acc += dec.decode(value, { stream: true })
      }
      return acc
    }

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

    it('passes through when flash stream has no advisor tool call', async () => {
      const stream = mkSseStream([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"flash thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)
      expect(reasoning).toBe('flash thinking')
      expect(content).toBe('Hello')
      expect(captured).toHaveLength(1)
    })

    it('intercepts advisor tool call, streams pro analysis into think panel, then pumps flash retry', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"flash thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"advisor","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"question\\":\\"q?\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ])
      const proStream = mkSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"pro thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"PRO ANSWER"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"FINAL"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, reasoning } = parseSse(acc)

      // Flash reasoning forwarded.
      expect(reasoning).toContain('flash thinking')
      // Pro thinking + content are injected into the think panel.
      expect(reasoning).toContain('pro thinking')
      expect(reasoning).toContain('PRO ANSWER')
      // Advisor begin/end separators visible.
      expect(reasoning).toContain('consulting advisor')
      expect(reasoning).toContain('back to flash')
      // Final flash answer is the only content (pro's content was rewritten as reasoning).
      expect(content).toBe('FINAL')
      expect(content).not.toContain('PRO ANSWER')

      // pro 子流的 `data: [DONE]` 绝不能转发给客户端 —— 否则客户端会
      // 误以为整个 SSE 流结束，丢失后续的 advisor end + flash retry 内容。
      // 只有 flash retry 的最终 [DONE] 应出现，且必须在最后。
      const dataLines = acc.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'))
      expect(dataLines.filter(l => l === 'data: [DONE]')).toHaveLength(1)
      expect(dataLines.findIndex(l => l === 'data: [DONE]')).toBe(dataLines.length - 1)

      expect(captured).toHaveLength(3)
    })

    it('pro call has no tools and no tool_choice', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"advisor","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ])
      const proStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"y"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }], stream: true }, true, {})
      // The advisor stream dispatcher fires fetchMock calls from inside the stream's
      // start(); drain the stream so the side effects run.
      if (out.isStream) {
        const reader = (out.body as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }

      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      // Pro is a passive advisor — NO tools at all.
      expect(proBody.tools).toBeUndefined()
      expect(proBody.tool_choice).toBeUndefined()
      // Advisor question is surfaced as a user message
      const proMsgs = proBody.messages
      const advisorUserMsgs = proMsgs.filter((m: { role: string }) => m.role === 'user')
      expect(advisorUserMsgs.length).toBeGreaterThanOrEqual(1)
    })

    it('flash retry receives the tool result message in messages', async () => {
      const flashStream = mkSseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"advisor","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ])
      const proStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"PRO CONTENT"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'data: {"choices":[{"delta":{"content":"final"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }], stream: true }, true, {})
      if (out.isStream) {
        const reader = (out.body as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }

      const flashRetryBody = JSON.parse(captured[2].init.body!)
      const messages = flashRetryBody.messages
      const toolMsg = messages[messages.length - 1]
      expect(toolMsg.role).toBe('tool')
      expect(toolMsg.tool_call_id).toBe('c1')
      expect(toolMsg.content).toBe('PRO CONTENT')
    })
  })
})
