/**
 * Escape C0 control characters to caret notation (^@, ^[ …) so that
 * artifacts like TTY progress-bar redraw sequences in build logs do not
 * corrupt line-numbered terminal output. Mirrors `cat -v` behaviour:
 *   - TAB (0x09), LF (0x0A), CR (0x0D) are preserved
 *   - everything else in 0x00–0x1F / 0x7F is rendered as ^X
 *
 * Use this on text destined for a TTY when the source may contain
 * embedded CSI/OSC sequences (e.g. captured TTY logs). For machine-
 * readable output, prefer JSON, which already escapes these as
 * `\u001b[...]` via the standard serializer.
 */
export function escapeControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => {
    const code = c.charCodeAt(0)
    // DEL (0x7F) is a special case in caret notation: `^?` rather than the
    // `code + 64` formula (which would give 0xBF = `¿`).
    if (code === 0x7F) return '^?'
    return `^${String.fromCharCode(code + 64)}`
  })
}
