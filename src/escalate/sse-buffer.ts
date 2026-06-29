/**
 * Incremental SSE line parser used by the streaming peek loop.
 *
 * The dispatcher needs to decide **per line** whether each SSE event should be
 * forwarded to the client, buffered (for marker detection), or intercepted
 * (on escalation). A raw byte stream doesn't expose line boundaries cleanly
 * across `reader.read()` chunks, so this helper buffers partial bytes and
 * returns complete `\n`-terminated lines with their original byte payload
 * preserved (so re-emitting them keeps the downstream SSE stream valid).
 *
 * Anthropic SSE format:
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *   <blank line>
 *
 * This parser tracks both `event:` and `data:` lines and parses the data
 * payload into an {@link AnthropicStreamEvent} when possible.
 */

import type { AnthropicStreamEvent } from './anthropic-protocol'
import { parseStreamEvent } from './anthropic-protocol'

export interface SseLine {
  /** Raw bytes of this line INCLUDING the trailing `\n`. Safe to `enqueue()`. */
  bytes: Uint8Array
  /** Line text WITHOUT the trailing newline (and without trailing `\r`). */
  rawLine: string
  /** Whether this line starts with `data:`. */
  isData: boolean
  /** Whether this line starts with `event:`. */
  isEvent: boolean
  /** The event type (value after "event: "), e.g. "content_block_delta". */
  eventType?: string
  /** Parsed Anthropic stream event (only for `data:` lines with valid JSON). */
  anthropicEvent?: AnthropicStreamEvent
}

export interface SseFeedResult {
  /** Complete `\n`-terminated lines parsed from this chunk + prior leftover. */
  lines: SseLine[]
  /**
   * Bytes of the trailing partial line that hasn't yet formed a complete line.
   * These bytes have NOT been re-emitted via `lines[].bytes`. The caller must
   * flush `leftover` directly to the downstream when switching from peek mode
   * to "passthrough rest" mode (so the downstream sees a continuous byte
   * stream). In pure peek mode the leftover is automatically combined with
   * the next chunk inside this buffer.
   */
  leftover: Uint8Array | null
}

export class SseLineBuffer {
  private decoder = new TextDecoder('utf-8', { fatal: false })
  private lineBuf = ''

  /**
   * Feed a chunk. Returns parsed lines + any leftover partial-line bytes.
   */
  feed(chunk: Uint8Array): SseFeedResult {
    const text = this.decoder.decode(chunk, { stream: true })
    this.lineBuf += text

    const lines: SseLine[] = []
    let processed = 0

    while (true) {
      const nlIdx = this.lineBuf.indexOf('\n', processed)
      if (nlIdx === -1) break
      const rawLine = this.lineBuf.slice(processed, nlIdx).replace(/\r$/, '')
      processed = nlIdx + 1

      const line: SseLine = {
        bytes: Buffer.from(rawLine + '\n', 'utf-8'),
        rawLine,
        isData: rawLine.startsWith('data:'),
        isEvent: rawLine.startsWith('event:'),
      }

      if (line.isEvent) {
        line.eventType = rawLine.slice(6).trim()
      }

      if (line.isData) {
        const payload = rawLine.slice(5).trim()
        if (payload.length > 0) {
          line.anthropicEvent = parseStreamEvent(payload)
        }
      }

      lines.push(line)
    }

    // Keep the trailing partial line in `lineBuf` so the next feed() can
    // complete it. Also expose its current byte form so callers can flush
    // it when switching to "passthrough rest" mode.
    const leftoverText = this.lineBuf.slice(processed)
    this.lineBuf = leftoverText
    const leftover: Uint8Array | null =
      leftoverText.length > 0 ? Buffer.from(leftoverText, 'utf-8') : null

    return { lines, leftover }
  }

  /** Reset internal state (rarely needed). */
  reset(): void {
    this.lineBuf = ''
    this.decoder = new TextDecoder('utf-8', { fatal: false })
  }
}
