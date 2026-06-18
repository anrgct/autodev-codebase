/**
 * Unit tests for SseLineBuffer — the incremental SSE line parser used by
 * the streaming peek loop. Focus on line-boundary handling across chunks
 * and byte fidelity of re-emitted lines.
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

  it('parses delta.content from a chat-completion data line', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n'))
    expect(lines).toHaveLength(1)
    expect(lines[0].delta?.content).toBe('hi')
    expect(lines[0].delta?.reasoning_content).toBeUndefined()
  })

  it('parses delta.reasoning_content (think blocks)', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n'))
    expect(lines[0].delta?.reasoning_content).toBe('thinking...')
    expect(lines[0].delta?.content).toBeUndefined()
  })

  it('parses delta.role (first chunk of a stream)', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: {"choices":[{"delta":{"role":"assistant"}}]}\n'))
    expect(lines[0].delta?.role).toBe('assistant')
    // No content / reasoning — delta is still returned because role is set.
    expect(lines[0].delta?.content).toBeUndefined()
  })

  it('flags data: [DONE] lines', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: [DONE]\n'))
    expect(lines[0].done).toBe(true)
    expect(lines[0].delta).toBeUndefined()
  })

  it('returns no delta for non-JSON data lines', () => {
    const buf = new SseLineBuffer()
    const { lines } = buf.feed(enc('data: not-json\n'))
    expect(lines[0].delta).toBeUndefined()
    expect(lines[0].done).toBeUndefined()
  })

  it('combines partial lines across multiple chunks', () => {
    const buf = new SseLineBuffer()
    const r1 = buf.feed(enc('data: {"choices":['))
    expect(r1.lines).toHaveLength(0)
    expect(r1.leftover).not.toBeNull()

    const r2 = buf.feed(enc('{"delta":{"content":"x"}}]}\n'))
    expect(r2.lines).toHaveLength(1)
    expect(r2.lines[0].delta?.content).toBe('x')
    expect(r2.leftover).toBeNull()
  })

  it('exposes leftover bytes when switching to passthrough mode', () => {
    // Simulate the dispatcher's "no-marker" branch: a chunk that ends with
    // a partial line. The leftover must be flushable so the downstream sees
    // a continuous byte stream.
    const buf = new SseLineBuffer()
    const r1 = buf.feed(enc('data: complete\ndata: parti'))
    expect(r1.lines).toHaveLength(1)
    expect(r1.lines[0].rawLine).toBe('data: complete')
    // The partial line is exposed as leftover bytes.
    expect(r1.leftover).not.toBeNull()
    expect(new TextDecoder().decode(r1.leftover!)).toBe('data: parti')
  })

  it('preserves byte fidelity of re-emitted lines', () => {
    const buf = new SseLineBuffer()
    const original = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n'
    const { lines } = buf.feed(enc(original))
    // Re-emitted bytes must round-trip to the same UTF-8 string.
    const roundtrip = new TextDecoder().decode(lines[0].bytes)
    expect(roundtrip).toBe(original)
  })

  it('handles UTF-8 multi-byte characters split across chunks', () => {
    // 'é' is 0xC3 0xA9 in UTF-8. Split between the two bytes.
    const buf = new SseLineBuffer()
    // 'data: x' + first byte of é, then second byte + '\n'
    const fullBytes = enc('data: xé\n')
    const mid = 8 // split point inside the multi-byte char (0xC3 at index 8)
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
    // The re-emitted bytes use \n only (CRLF is normalized).
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
