/**
 * Unit tests for SseLineBuffer — the incremental SSE line parser used by
 * the streaming peek loop. Focus on line-boundary handling across chunks
 * and byte fidelity of re-emitted lines, now using Anthropic SSE format.
 */
import { describe, it, expect } from 'vitest'
import { SseLineBuffer } from '../sse-buffer'

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('SseLineBuffer', () => {
  it('returns complete lines from a single chunk', () => {
    const buf = new SseLineBuffer()
    const { lines, leftover } = buf.feed(enc('data: hello\n\n'))
    expect(lines).toHaveLength(2)
    expect(lines[0].rawLine).toBe('data: hello')
    expect(lines[0].isData).toBe(true)
    expect(lines[1].rawLine).toBe('')
    expect(lines[1].isData).toBe(false)
    expect(leftover).toBeNull()
  })

  it('parses event: lines', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'))
    expect(lines).toHaveLength(3)
    expect(lines[0].isEvent).toBe(true)
    expect(lines[0].eventType).toBe('content_block_delta')
    expect(lines[1].isData).toBe(true)
    expect(lines[1].anthropicEvent).toBeDefined()
    expect(lines[1].anthropicEvent!.type).toBe('content_block_delta')
  })

  it('parses text_delta events', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n'))
    expect(lines).toHaveLength(1)
    const ev = lines[0].anthropicEvent
    expect(ev).toBeDefined()
    if (ev?.type === 'content_block_delta') {
      expect(ev.delta.type).toBe('text_delta')
      expect(ev.delta.text).toBe('hi')
    }
  })

  it('parses thinking_delta events', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thinking..."}}\n'))
    expect(lines).toHaveLength(1)
    const ev = lines[0].anthropicEvent
    expect(ev).toBeDefined()
    if (ev?.type === 'content_block_delta') {
      expect(ev.delta.type).toBe('thinking_delta')
      expect(ev.delta.thinking).toBe('thinking...')
    }
  })

  it('parses message_start events', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"type":"message_start","message":{"role":"assistant","content":[]}}\n'))
    expect(lines).toHaveLength(1)
    const ev = lines[0].anthropicEvent
    expect(ev).toBeDefined()
    if (ev?.type === 'message_start') {
      expect(ev.message.role).toBe('assistant')
    }
  })

  it('parses message_stop events (Anthropic stream end, no [DONE])', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"type":"message_stop"}\n'))
    expect(lines[0].anthropicEvent).toBeDefined()
    expect(lines[0].anthropicEvent!.type).toBe('message_stop')
  })

  it('returns undefined anthropicEvent for non-JSON data lines', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: not-json\n'))
    expect(lines[0].anthropicEvent).toBeUndefined()
  })

  it('combines partial lines across multiple chunks', () => {
    const buf = new SseLineBuffer()
    const r1 = buf.feed(enc('data: {"type":"content_block_delta","ind'))
    expect(r1.lines).toHaveLength(0)
    expect(r1.leftover).not.toBeNull()

    const r2 = buf.feed(enc('ex":0,"delta":{"type":"text_delta","text":"x"}}\n'))
    expect(r2.lines).toHaveLength(1)
    const ev = r2.lines[0].anthropicEvent
    expect(ev).toBeDefined()
    if (ev?.type === 'content_block_delta') {
      expect(ev.delta.type).toBe('text_delta')
      expect(ev.delta.text).toBe('x')
    }
    expect(r2.leftover).toBeNull()
  })

  it('exposes leftover bytes when switching to passthrough mode', () => {
    const buf = new SseLineBuffer()
    const r1 = buf.feed(enc('data: complete\ndata: parti'))
    expect(r1.lines).toHaveLength(1)
    expect(r1.lines[0].rawLine).toBe('data: complete')
    expect(r1.leftover).not.toBeNull()
    expect(new TextDecoder().decode(r1.leftover!)).toBe('data: parti')
  })

  it('preserves byte fidelity of re-emitted lines', () => {
    const buf = new SseLineBuffer()
    const original = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"héllo"}}\n'
    const { lines } = buf.feed(enc(original))
    const roundtrip = new TextDecoder().decode(lines[0].bytes)
    expect(roundtrip).toBe(original)
  })

  it('handles UTF-8 multi-byte characters split across chunks', () => {
    const buf = new SseLineBuffer()
    const fullBytes = enc('data: xé\n')
    const mid = 8
    const r1 = buf.feed(fullBytes.slice(0, mid))
    expect(r1.lines).toHaveLength(0)
    const r2 = buf.feed(fullBytes.slice(mid))
    expect(r2.lines).toHaveLength(1)
    expect(r2.lines[0].rawLine).toBe('data: xé')
  })

  it('strips trailing \\r from lines (CRLF tolerance)', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: hello\r\n'))
    expect(lines[0].rawLine).toBe('data: hello')
    expect(new TextDecoder().decode(lines[0].bytes)).toBe('data: hello\n')
  })

  it('treats comment lines (: keepalive) as non-data', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc(': keepalive\n\ndata: real\n'))
    expect(lines).toHaveLength(3)
    expect(lines[0].isData).toBe(false)
    expect(lines[0].rawLine).toBe(': keepalive')
    expect(lines[2].isData).toBe(true)
  })
})
