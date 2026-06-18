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
 * Design notes:
 *   - Lines are re-encoded via `Buffer.from(line + '\n', 'utf-8')`. For UTF-8
 *     input this is byte-identical to the original chunk; the only lossy
 *     transform is stripping a trailing `\r` (which SSE allows).
 *   - The `delta` field is parsed lazily and only carries the fields the
 *     dispatcher cares about: `content`, `reasoning_content`, `role`,
 *     `tool_calls`. Anything else is still forwarded via `bytes`.
 */

export interface SseDelta {
  content?: string
  reasoning_content?: string
  role?: string
  tool_calls?: unknown
}

export interface SseLine {
  /** Raw bytes of this line INCLUDING the trailing `\n`. Safe to `enqueue()`. */
  bytes: Uint8Array
  /** Line text WITHOUT the trailing newline (and without trailing `\r`). */
  rawLine: string
  /** Whether this line starts with `data:`. */
  isData: boolean
  /** Parsed delta (only for `data:` lines that look like chat-completion chunks). */
  delta?: SseDelta
  /** True iff this is a `data: [DONE]` line. */
  done?: boolean
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
      }

      if (line.isData) {
        const payload = rawLine.slice(5).trim()
        if (payload === '[DONE]') {
          line.done = true
        } else if (payload.length > 0) {
          line.delta = parseDelta(payload)
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

function parseDelta(payload: string): SseDelta | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const c0 = choices[0] as Record<string, unknown> | undefined
  if (!c0) return undefined
  const delta = (c0['delta'] ?? c0['message']) as Record<string, unknown> | undefined
  if (!delta || typeof delta !== 'object') return undefined

  const out: SseDelta = {}
  if (typeof delta['content'] === 'string') out.content = delta['content']
  if (typeof delta['reasoning_content'] === 'string') out.reasoning_content = delta['reasoning_content']
  if (typeof delta['role'] === 'string') out.role = delta['role']
  if (delta['tool_calls'] !== undefined) out.tool_calls = delta['tool_calls']

  if (!out.content && !out.reasoning_content && !out.role && out.tool_calls === undefined) {
    return undefined
  }
  return out
}
