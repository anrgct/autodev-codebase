/**
 * Unit tests for the dispatcher — uses a mocked fetch to assert behavior
 * without touching the network.
 *
 * All tests use the Anthropic Messages API format.
 *
 * Test scenarios:
 *   1. Non-stream: no escalation → return flash body + X-Escalated-To: flash
 *   2. Non-stream: with bare <<<NEEDS_PRO>>> → retry on pro, return pro body
 *   3. Non-stream: with reason marker → retry on pro + X-Escalation-Reason
 *   4. Non-stream: upstream error → pass through error + flash header
 *   5. Stream: no marker → passthrough (thinking + text)
 *   6. Stream: marker in flash → cancel flash, start pro stream
 *   7. Stream: marker reason → separator carries reason
 *   8. Stream: downgrade pro→flash → two separators
 *   9. Headers: forward x-api-key when no apiKey set
 *  10. Headers: override x-api-key when apiKey set
 *  11. Headers: strip hop-by-hop
 *  12. Body: inject flash contract (top-level `system` field)
 *  13. Body: inject pro contract
 *  14. Advisor non-stream: flash direct answer
 *  15. Advisor non-stream: intercept advisor tool_use, query pro
 *  16. Advisor non-stream: flash retry has tool_result
 *  17. Advisor non-stream: multiple advisor calls
 *  18. Advisor non-stream: orphaned tool_use rewrite
 *  19. Advisor stream: pass through no tool_use
 *  20. Advisor stream: intercept tool_use, inject pro
 *  21. Pro body has no tools
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EscalateDispatcher, detectForcedAdvisor } from '../dispatcher'
import type { EscalateConfig } from '../types'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'

function makeConfig(overrides: Partial<EscalateConfig> = {}): EscalateConfig {
  return {
    mode: 'self-report',
    apiBase: 'https://api.example.com',
    apiKey: undefined,
    flashModel: FLASH,
    proModel: PRO,
    port: 8080,
    host: 'localhost',
    stickyProTtlMs: 0,
    thinkingBudget: 8000,
    maxTokens: 4096,
    forceAdvisor: false,
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

/** Anthropic response helper for non-stream self-report tests. */
function anThrowResponse(text: string): string {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    model: FLASH,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

/** Anthropic response helper for non-stream advisor tool_use. */
function anThrowToolUse(name: string, input: Record<string, unknown>, id = 'call_abc', stopReason: string = 'tool_use'): string {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: stopReason,
    stop_sequence: null,
    model: FLASH,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
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
      expect(captured[0].url).toBe('https://api.example.com/v1/messages')
    })

    it('retries on pro when the bare marker is present in the flash body', async () => {
      const flashBody = anThrowResponse('<<<NEEDS_PRO>>>\nThis task requires deeper reasoning.')
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
      // System is top-level Anthropic field, not messages[].role:'system'
      expect(flashBodySent.system).toContain('Tier escalation instruction')
    })

    it('passes the marker reason through to the pro retry header', async () => {
      const reason = 'cross-file refactor across 6 modules'
      const flashBody = anThrowResponse(`<<<NEEDS_PRO: ${reason}>>>\nrest`)
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

    /** Parse Anthropic SSE text into {content, thinking} strings. */
    function parseSse(sseText: string): { content: string; thinking: string } {
      let content = ''
      let thinking = ''
      for (const line of sseText.split('\n')) {
        if (line.startsWith('event: ')) {
          // skip, we use data: lines only
        } else if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              content += parsed.delta.text || ''
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
              thinking += parsed.delta.thinking || ''
            }
          } catch { /* ignore */ }
        }
      }
      return { content, thinking }
    }

    it('forwards thinking immediately and passes content through when no marker', async () => {
      const stream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thinking..."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      // Streaming responses no longer carry X-Escalated-* headers.
      expect(out.headers['x-escalated-to']).toBeUndefined()

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)
      expect(thinking).toBe('thinking...')
      expect(content).toBe('Hello world')
      // No escalation → only one upstream call.
      expect(captured).toHaveLength(1)
    })

    it('escalates to pro and injects a separator into the reasoning stream', async () => {
      const flashStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"flash thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"<<<NEEDS_PRO>>>"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pro thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"PRO ANSWER"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      expect(out.headers['x-escalated-to']).toBeUndefined()

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)
      // Flash thinking forwarded to the client.
      expect(thinking).toContain('flash thinking')
      // Separator injected between the two tiers.
      expect(thinking).toContain('now on pro')
      expect(thinking).toContain('was flash')
      // Pro thinking forwarded.
      expect(thinking).toContain('pro thinking')
      // Pro answer (the marker is dropped, not forwarded as content).
      expect(content).toBe('PRO ANSWER')
      expect(content).not.toContain('<<<NEEDS_PRO>>>')
      // Two upstream calls: flash then pro.
      expect(captured).toHaveLength(2)
    })

    it('carries the marker reason into the separator text', async () => {
      const flashStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<<<NEEDS_PRO: needs deep analysis>>>"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pro answer"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { thinking } = parseSse(acc)
      // The separator carries the upgrade reason.
      expect(thinking).toContain('needs deep analysis')
    })

    it('downgrades pro → flash with a second separator and no marker leak', async () => {
      const flashStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<<<NEEDS_PRO>>>"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pro thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"<<<NEEDS_FLASH>>>"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FLASH REUSED"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)

      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)
      // Both separators present.
      expect(thinking).toContain('now on pro')
      expect(thinking).toContain('now on flash')
      // Pro thinking forwarded in between.
      expect(thinking).toContain('pro thinking')
      // Final content from flash retry.
      expect(content).toBe('FLASH REUSED')
      // No markers leak into content.
      expect(content).not.toContain('<<<NEEDS_PRO>>>')
      expect(content).not.toContain('<<<NEEDS_FLASH>>>')
      // Three calls: flash → pro → flash retry.
      expect(captured).toHaveLength(3)
    })

    it('does not hang on non-marker content starting with < (e.g. <html>)', async () => {
      // detectMarkerPrefix must rule this out on the very first chunk.
      const stream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<html>hello</html>"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
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
    it('forwards the client x-api-key header when no apiKey is set', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({ messages: [] }, false, { 'x-api-key': 'client-key' })

      const headers = captured[0].init.headers!
      expect(headers['x-api-key']).toBe('client-key')
    })

    it('overrides the client x-api-key when apiKey is set', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({
        config: makeConfig({ apiKey: 'server-key' }),
        fetchImpl: fetchMock as never,
      })
      await d.dispatch({ messages: [] }, false, { 'x-api-key': 'client-key' })

      const headers = captured[0].init.headers!
      expect(headers['x-api-key']).toBe('server-key')
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

    it('forces the model field to the flash ID and injects the contract into system', async () => {
      queueResponse('hi')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const body = {
        model: 'something-else',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'q' }],
      }
      await d.dispatch(body, false, {})

      const sentBody = JSON.parse(captured[0].init.body!)
      expect(sentBody.model).toBe(FLASH)
      // System is top-level Anthropic field
      expect(sentBody.system).toContain('You are helpful.')
      expect(sentBody.system).toContain('Tier escalation instruction')
    })

    it('injects the pro-side contract on the pro retry (teaches downgrade)', async () => {
      queueResponse(anThrowResponse('<<<NEEDS_PRO>>>\nrest'))
      queueResponse('pro')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const body = {
        model: 'auto',
        system: 'Hi',
        messages: [{ role: 'user', content: 'q' }],
      }
      await d.dispatch(body, false, {})

      expect(captured).toHaveLength(2)
      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      // The pro retry now injects the pro-side contract (which mentions
      // `<<<NEEDS_FLASH>>>` so the pro model knows it can downgrade).
      expect(proBody.system).toContain('Cost-aware tier switching instruction')
      expect(proBody.system).toContain('strong tier')
      expect(proBody.system).toContain('`<<<NEEDS_FLASH>>>`')
    })

    it('downgrades to flash when the pro response emits <<<NEEDS_FLASH>>> (non-stream)', async () => {
      const flashBody = anThrowResponse('<<<NEEDS_PRO>>>\nflash aborted')
      const proBody = anThrowResponse('<<<NEEDS_FLASH: trivial lookup>>>\npro aborted')
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
      queueResponse(anThrowResponse('<<<NEEDS_PRO>>>\nrest'))
      queueResponse(anThrowResponse(`<<<NEEDS_FLASH: ${reason}>>>\nrest`))
      queueResponse('flash done')

      const d = new EscalateDispatcher({ config: makeConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [] }, false, {})

      expect(out.headers['x-escalation-reason']).toBe(reason)
    })

    it('does not downgrade when the pro response is normal (no marker)', async () => {
      queueResponse(anThrowResponse('<<<NEEDS_PRO>>>\nrest'))
      queueResponse(anThrowResponse('PRO ANSWER — no marker, no downgrade'))

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
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'flash direct answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(out.path).toEqual(['flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toBe('flash direct answer')
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
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'flash direct' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({
        messages: [
          { role: 'user', content: 'q' },
        ],
        system: clientSystemPrompt,
      }, false, {})

      const flashBody = JSON.parse(captured[0].init.body!)
      expect(flashBody.model).toBe(FLASH)
      const tools = flashBody.tools
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.some((t: { name?: string }) => t.name === 'advisor')).toBe(true)
      // System prompt is the client's verbatim — no advisor fragment, no
      // self-report contract appended.
      expect(flashBody.system).toBe(clientSystemPrompt)
      expect(flashBody.system).not.toContain('[autodev-escalate-advisor]')
      expect(flashBody.system).not.toContain('Tier escalation instruction')
      expect(flashBody.system).not.toContain('<<<NEEDS_PRO>>>')
      expect(flashBody.system).not.toContain('<<<NEEDS_FLASH>>>')
    })

    it('routes advisor tool call to pro and returns pro content as tool result', async () => {
      queueResponse(anThrowToolUse('advisor', { question: 'how to refactor X?' }))
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'PRO ANALYSIS: use strategy Y' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'synthesized final answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('advisor')
      expect(out.path).toEqual(['flash', 'pro', 'flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toBe('synthesized final answer')
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
      expect(proBody.system).toBeUndefined()
    })

    it('flash retry receives the tool result message and pro sees advisor question as user msg', async () => {
      queueResponse(anThrowToolUse('advisor', { question: 'q1' }, 'call_1'))
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'PRO ANSWER' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      const flashRetryBody = JSON.parse(captured[2].init.body!)
      const messages = flashRetryBody.messages
      const toolMsg = messages[messages.length - 1]
      expect(toolMsg.role).toBe('user')
      expect(Array.isArray(toolMsg.content)).toBe(true)
      expect(toolMsg.content[0].type).toBe('tool_result')
      expect(toolMsg.content[0].tool_use_id).toBe('call_1')
      expect(toolMsg.content[0].content).toBe('PRO ANSWER')

      // Verify pro received the advisor question as a user message
      const proBody = JSON.parse(captured[1].init.body!)
      const proMessages = proBody.messages
      const advisorUserMsg = proMessages.find((m: { role: string; content: string }) =>
        m.role === 'user' && typeof m.content === 'string' && m.content === '[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] q1')
      expect(advisorUserMsg).toBeDefined()
    })

    it('handles multiple advisor calls sequentially via recursion', async () => {
      // Flash returns TWO advisor tool_use blocks in one response.
      // The dispatcher only processes the FIRST call per response; the
      // second is handled when flash retries and calls advisor again.
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'advisor', input: { question: 'question A' } },
          { type: 'tool_use', id: 'call_b', name: 'advisor', input: { question: 'question B' } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      // Pro responds to call_a
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'PRO ANSWER A' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      // Flash retry — sees tool result for call_a, calls advisor for call_b
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_b', name: 'advisor', input: { question: 'question B' } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      // Pro responds to call_b
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'PRO ANSWER B' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      // Flash final answer
      queueResponse(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'synthesised from A and B' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      // flash → pro (call_a) → flash → pro (call_b) → flash
      expect(out.path).toEqual(['flash', 'pro', 'flash', 'pro', 'flash'])
      expect(captured).toHaveLength(5)

      // Verify sequential messages: each flash retry only has ONE tool result
      const retry1 = JSON.parse(captured[2].init.body!)
      const toolMsgs1 = retry1.messages.filter((m: { role: string, content?: any }) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      expect(toolMsgs1).toHaveLength(1)
      expect(toolMsgs1[0].content[0].tool_use_id).toBe('call_a')

      const retry2 = JSON.parse(captured[4].init.body!)
      const toolMsgs2 = retry2.messages.filter((m: { role: string, content?: any }) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      expect(toolMsgs2).toHaveLength(2)
      expect(toolMsgs2[0].content[0].tool_use_id).toBe('call_a')
      expect(toolMsgs2[1].content[0].tool_use_id).toBe('call_b')

      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toBe('synthesised from A and B')
    })

    it('handles recursion — flash calls advisor twice', async () => {
      // flash → advisor → pro → flash → advisor → pro → flash
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'advisor', input: { question: 'q1' } }],
        stop_reason: 'tool_use', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'PRO 1' }],
        stop_reason: 'end_turn', stop_sequence: null, model: PRO, usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_2', name: 'advisor', input: { question: 'q2' } }],
        stop_reason: 'tool_use', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'PRO 2' }],
        stop_reason: 'end_turn', stop_sequence: null, model: PRO, usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'DONE' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.path).toEqual(['flash', 'pro', 'flash', 'pro', 'flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toBe('DONE')
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
      queueResponse(anThrowToolUse('advisor', { question: 'q' }, 'call_x'))
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
        type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_other', name: 'some_other_tool', input: {} }],
        stop_reason: 'tool_use', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
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
      // Inbound messages (note: assistant tool_use WITHOUT a following tool
      // result — the bug scenario the user reported).
      const inboundMessages = [
        { role: 'user', content: 'this is a test of advisor' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'orphan_call_1',
            name: 'advisor',
            input: { question: 'please confirm advisor works' },
          }],
        },
      ]

      // Only one upstream call expected: flash. No pro fill — we don't invent
      // a fake pro response for an unanswered tool call.
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'flash direct answer' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: inboundMessages }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('non-stream')
      expect(captured).toHaveLength(1)

      // The flash request should NOT contain the orphaned assistant tool_use
      // — it should have been rewritten to a user message containing the
      // advisor question. This is what keeps deepseek from 400-ing.
      const flashBody = JSON.parse(captured[0].init.body!)
      const flashMessages = flashBody.messages
      const stillHasOrphanToolCall = flashMessages.some((m: { role: string; content?: Array<{ id?: string }> }) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c.id === 'orphan_call_1'),
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
          content: [{
            type: 'tool_use', id: 'already_done', name: 'advisor', input: {},
          }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'already_done', content: 'existing tool result' }],
        },
      ]

      // Expected: only one upstream call (flash), no orphan-fill.
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'flash final' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
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
        type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_flash_1', name: 'advisor', input: { question: '测试advisor是否正常' } }],
        stop_reason: 'tool_use', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))

      // Step 2: pro returns content normally (no tools to call)
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'PRO: advisor 工具正常工作，可以放心使用。' }],
        stop_reason: 'end_turn', stop_sequence: null, model: PRO, usage: { input_tokens: 10, output_tokens: 5 },
      }))

      // Step 3: flash retry synthesises
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: '结合顾问分析：advisor 工具正常，可以开始你的任务。' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH, usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: '测试下advisor' }] }, false, {})

      // Flash retry body — tool_result must contain pro's analysis
      const flashRetryBody = JSON.parse(captured[2].init.body!)
      const toolResultMsg = flashRetryBody.messages[flashRetryBody.messages.length - 1]
      expect(toolResultMsg.role).toBe('user')
      expect(Array.isArray(toolResultMsg.content)).toBe(true)
      expect(toolResultMsg.content[0].type).toBe('tool_result')
      expect(toolResultMsg.content[0].content).toBe('PRO: advisor 工具正常工作，可以放心使用。')

      // Flash synthesises pro's analysis
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toContain('顾问分析')

      // Pro body MUST NOT have any tools
      const proBody = JSON.parse(captured[1].init.body!)
      expect(proBody.model).toBe(PRO)
      expect(proBody.tools).toBeUndefined()
      expect(proBody.tool_choice).toBeUndefined()
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

    function parseSse(sseText: string): { content: string; thinking: string } {
      let content = ''
      let thinking = ''
      for (const line of sseText.split('\n')) {
        if (line.startsWith('event: ')) {
          // skip, we use data: lines only
        } else if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              content += parsed.delta.text || ''
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
              thinking += parsed.delta.thinking || ''
            }
          } catch { /* ignore */ }
        }
      }
      return { content, thinking }
    }

    it('passes through when flash stream has no advisor tool call', async () => {
      const stream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"flash thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(stream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)
      expect(thinking).toBe('flash thinking')
      expect(content).toBe('Hello')
      expect(captured).toHaveLength(1)
    })

    it('intercepts advisor tool call, streams pro analysis into think panel, then pumps flash retry', async () => {
      const flashStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"flash thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_x","name":"advisor","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"question\\":\\"q?\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pro thinking"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"PRO ANSWER"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FINAL"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashRetryStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeAdvisorConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)

      // Flash thinking forwarded.
      expect(thinking).toContain('flash thinking')
      // Pro thinking + content are injected into the think panel.
      expect(thinking).toContain('pro thinking')
      expect(thinking).toContain('PRO ANSWER')
      // Advisor begin/end separators visible.
      expect(thinking).toContain('consulting advisor')
      expect(thinking).toContain('back to flash')
      // Final flash answer is the only content (pro's content was rewritten as thinking).
      expect(content).toBe('FINAL')
      expect(content).not.toContain('PRO ANSWER')

      // pro 子流的 message_stop 绝不能转发给客户端 —— 否则客户端会
      // 误以为整个 SSE 流结束，丢失后续的 advisor end + flash retry 内容。
      // 只有 flash retry 的最终 message_stop 应出现，且必须在最后。
      const dataLines = acc.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'))
      const stopLines = dataLines.filter(l => {
        try { return JSON.parse(l.slice(5)).type === 'message_stop' } catch { return false }
      })
      expect(stopLines).toHaveLength(1)
      // Manual reverse search instead of findLastIndex (needs ES2023 lib).
      let lastStopIdx = -1
      for (let i = 0; i < dataLines.length; i++) {
        try {
          if (JSON.parse(dataLines[i].slice(5)).type === 'message_stop') lastStopIdx = i
        } catch { /* not a valid JSON data line */ }
      }
      expect(lastStopIdx).toBe(dataLines.length - 1)

      expect(captured).toHaveLength(3)
    })

    it('pro call has no tools and no tool_choice', async () => {
      const flashStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"advisor","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
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
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"advisor","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const proStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRO CONTENT"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const flashRetryStream = mkSseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"final"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
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
      expect(toolMsg.role).toBe('user')
      expect(Array.isArray(toolMsg.content)).toBe(true)
      expect(toolMsg.content[0].type).toBe('tool_result')
      expect(toolMsg.content[0].tool_use_id).toBe('c1')
      expect(toolMsg.content[0].content).toBe('PRO CONTENT')
    })
  })

  // --------------------------------------------------------------------
  // Forced advisor (forceAdvisor: true) — deterministic pre-consultation
  // --------------------------------------------------------------------
  describe('forced advisor trigger detection (pure)', () => {
    it('user-turn: trailing user message with string content', () => {
      const trigger = detectForcedAdvisor([{ role: 'user', content: 'hello' }] as never)
      expect(trigger).toEqual({ type: 'user-turn', question: '用户指令的核心需求与歧义？' })
    })

    it('user-turn: trailing user with text content block (no tool_result)', () => {
      const trigger = detectForcedAdvisor([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ] as never)
      expect(trigger?.type).toBe('user-turn')
    })

    it('tool-error: trailing tool_result with is_error=true', () => {
      const trigger = detectForcedAdvisor([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
      ] as never)
      expect(trigger).toEqual({ type: 'tool-error', question: '工具报错的根因与修复建议？' })
    })

    it('tool-error: trailing tool_result content starts with "Error:"', () => {
      const trigger = detectForcedAdvisor([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: file not found' }] },
      ] as never)
      expect(trigger?.type).toBe('tool-error')
    })

    it('tool-count: exactly 5 real tool_use → trigger', () => {
      const msgs: unknown[] = [{ role: 'user', content: 'q' }]
      for (let i = 0; i < 5; i++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: 'read_file', input: {} }] })
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'ok' }] })
      }
      const trigger = detectForcedAdvisor(msgs as never)
      expect(trigger).toEqual({ type: 'tool-count', question: '当前方向和进度评估与下一步建议？' })
    })

    it('tool-count: advisor tool_use is excluded from the count', () => {
      // 4 real tool_use + 1 advisor tool_use → real count = 4, not divisible by 5
      const msgs: unknown[] = [{ role: 'user', content: 'q' }]
      for (let i = 0; i < 4; i++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: 'read_file', input: {} }] })
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'ok' }] })
      }
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'adv', name: 'advisor', input: {} }] })
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'adv', content: 'pro said' }] })
      expect(detectForcedAdvisor(msgs as never)).toBeNull()
    })

    it('tool-count: 3 real tool_use → no trigger', () => {
      const msgs: unknown[] = [{ role: 'user', content: 'q' }]
      for (let i = 0; i < 3; i++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: 'grep', input: {} }] })
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'ok' }] })
      }
      expect(detectForcedAdvisor(msgs as never)).toBeNull()
    })

    it('priority: tool-error beats tool-count (5 tools + last is error)', () => {
      const msgs: unknown[] = [{ role: 'user', content: 'q' }]
      for (let i = 0; i < 4; i++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: 'read_file', input: {} }] })
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'ok' }] })
      }
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'r4', name: 'read_file', input: {} }] })
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r4', content: 'Error: x', is_error: true }] })
      expect(detectForcedAdvisor(msgs as never)?.type).toBe('tool-error')
    })

    it('no trigger: trailing assistant message', () => {
      expect(detectForcedAdvisor([{ role: 'assistant', content: 'x' }] as never)).toBeNull()
    })

    it('no trigger: empty messages', () => {
      expect(detectForcedAdvisor([] as never)).toBeNull()
    })
  })

  describe('forced advisor (forceAdvisor: true)', () => {
    function makeForcedConfig(overrides: Partial<EscalateConfig> = {}): EscalateConfig {
      return makeConfig({ mode: 'advisor', forceAdvisor: true, ...overrides })
    }

    it('non-stream: user-turn triggers a pro pre-consultation before the flash loop', async () => {
      // pro pre-consultation response
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'PRO ANALYSIS' }],
        stop_reason: 'end_turn', stop_sequence: null, model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      // flash final answer
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))

      const d = new EscalateDispatcher({ config: makeForcedConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})

      expect(out.finalModel).toBe('flash')
      expect(out.reason).toBe('advisor')
      expect(out.path).toEqual(['pro', 'flash'])
      const body = JSON.parse((out.body as Buffer).toString('utf-8'))
      expect(body.content[0].text).toBe('final answer')

      // captured[0] = pro pre-consultation, captured[1] = flash
      expect(captured).toHaveLength(2)
      const proBody = JSON.parse(captured[0].init.body!)
      expect(proBody.model).toBe(PRO)
      const proMessages = proBody.messages
      expect(proMessages[0].content).toBe('q')
      expect(proMessages[1].content).toContain('用户指令的核心需求与歧义？')

      // Flash sees the forced tool_use + tool_result spliced into history.
      const flashBody = JSON.parse(captured[1].init.body!)
      expect(flashBody.model).toBe(FLASH)
      const fm = flashBody.messages
      expect(fm[0].content).toBe('q')
      expect(fm[1].role).toBe('assistant')
      const forcedToolUse = fm[1].content.find((b: { type?: string; name?: string; input?: { question?: string } }) => b.type === 'tool_use' && b.name === 'advisor')
      expect(forcedToolUse).toBeDefined()
      expect(forcedToolUse.input.question).toBe('用户指令的核心需求与歧义？')
      expect(fm[2].role).toBe('user')
      expect(fm[2].content[0].type).toBe('tool_result')
      expect(fm[2].content[0].content).toBe('PRO ANALYSIS')
    })

    it('non-stream: forceAdvisor=false does not trigger pre-consultation', async () => {
      queueResponse(anThrowResponse('direct answer'))
      const d = new EscalateDispatcher({ config: makeConfig({ mode: 'advisor', forceAdvisor: false }), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }] }, false, {})
      expect(captured).toHaveLength(1)
      expect(out.path).toEqual(['flash'])
    })

    it('non-stream: tool-error trigger uses the error preset question', async () => {
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'PRO DEBUG' }],
        stop_reason: 'end_turn', stop_sequence: null, model: PRO,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      queueResponse(JSON.stringify({
        type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
        stop_reason: 'end_turn', stop_sequence: null, model: FLASH,
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
      const d = new EscalateDispatcher({ config: makeForcedConfig(), fetchImpl: fetchMock as never })
      await d.dispatch({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: boom', is_error: true }] },
        ],
      }, false, {})
      const proBody = JSON.parse(captured[0].init.body!)
      expect(proBody.messages[proBody.messages.length - 1].content).toContain('工具报错的根因与修复建议？')
    })

    // ---- streaming helpers (local copies) ----
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
    function parseSse(sseText: string): { content: string; thinking: string } {
      let content = ''
      let thinking = ''
      for (const line of sseText.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') content += parsed.delta.text || ''
            else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') thinking += parsed.delta.thinking || ''
          } catch { /* ignore */ }
        }
      }
      return { content, thinking }
    }

    it('stream: user-turn synthesizes message_start, injects pro analysis into think, pumps flash retry', async () => {
      const proStream = mkSseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","type":"message","role":"assistant","content":[],"model":"pro","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRO ANALYSIS"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      const flashStream = mkSseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_f","type":"message","role":"assistant","content":[],"model":"flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FINAL"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      queueResponse(proStream, { headers: { 'content-type': 'text/event-stream' } })
      queueResponse(flashStream, { headers: { 'content-type': 'text/event-stream' } })

      const d = new EscalateDispatcher({ config: makeForcedConfig(), fetchImpl: fetchMock as never })
      const out = await d.dispatch({ messages: [{ role: 'user', content: 'q' }], stream: true }, true, {})

      expect(out.isStream).toBe(true)
      const acc = await drainStream(out.body as ReadableStream<Uint8Array>)
      const { content, thinking } = parseSse(acc)

      // Forced pro analysis is rewritten into the think panel.
      expect(thinking).toContain('PRO ANALYSIS')
      expect(thinking).toContain('consulting advisor')
      // Flash final answer is the only content.
      expect(content).toBe('FINAL')
      expect(content).not.toContain('PRO ANALYSIS')

      // Exactly one message_start (synthesized) and one message_stop (flash's,
      // at the very end). pro's message_start/message_stop must NOT leak.
      const dataLines = acc.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'))
      const startCount = dataLines.filter(l => { try { return JSON.parse(l.slice(6)).type === 'message_start' } catch { return false } }).length
      const stopCount = dataLines.filter(l => { try { return JSON.parse(l.slice(6)).type === 'message_stop' } catch { return false } }).length
      expect(startCount).toBe(1)
      expect(stopCount).toBe(1)

      // captured[0] = pro, captured[1] = flash
      expect(captured).toHaveLength(2)
      const proBody = JSON.parse(captured[0].init.body!)
      expect(proBody.model).toBe(PRO)
      expect(proBody.messages[1].content).toContain('用户指令的核心需求与歧义？')
    })
  })
})
