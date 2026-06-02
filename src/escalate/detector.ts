/**
 * `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>` first-line detector.
 *
 * The contract mandates that any marker — when present — must be the very
 * first line of the model response (no leading whitespace). This module
 * implements the minimal pattern matcher.
 *
 * Two accepted forms per direction:
 *   1. `<<<NEEDS_PRO>>>`                        — bare, ask upstream to escalate to pro
 *   2. `<<<NEEDS_PRO: <one-sentence reason>>>>` — preferred, includes rationale
 *   3. `<<<NEEDS_FLASH>>>`                      — bare, ask upstream to downgrade to flash
 *   4. `<<<NEEDS_FLASH: <one-sentence reason>>>>` — preferred, includes rationale
 *
 * All forms MUST end with exactly three `>` characters.
 */

export interface NeedsProDetection {
  /** True iff the `<<<NEEDS_PRO>>>` marker is present at the very start. */
  matched: boolean
  /** Optional one-sentence reason (only set for the `<<<NEEDS_PRO: ...>>>` form). */
  reason?: string
}

export interface NeedsFlashDetection {
  /** True iff the `<<<NEEDS_FLASH>>>` marker is present at the very start. */
  matched: boolean
  /** Optional one-sentence reason (only set for the `<<<NEEDS_FLASH: ...>>>` form). */
  reason?: string
}

/** Direction the model is asking the dispatcher to switch in. */
export type EscalationDirection = 'pro' | 'flash'

export interface EscalationDetection {
  matched: boolean
  direction?: EscalationDirection
  reason?: string
}

/**
 * The bare `<<<NEEDS_PRO>>>` marker, used as a sentinel for the "with reason" form.
 */
export const NEEDS_PRO_MARKER = '<<<NEEDS_PRO>>>'

/**
 * The bare `<<<NEEDS_FLASH>>>` marker — emitted by the pro model to request
 * a downgrade to the cheaper flash tier.
 */
export const NEEDS_FLASH_MARKER = '<<<NEEDS_FLASH>>>'

/**
 * Detect the first non-blank line of a response, honoring the contract rules:
 *   - Leading blank lines are OK (model might emit a stray newline first).
 *   - The marker line itself MUST have NO leading whitespace.
 *   - Trailing whitespace on the marker line is OK.
 *
 * Returns the raw first line (with `\r` stripped from the tail) and `true`
 * if the line passes the leading-whitespace policy.
 */
function extractFirstLine(text: string): { line: string; ok: boolean } {
  if (typeof text !== 'string' || text.length === 0) return { line: '', ok: false }

  let cursor = 0
  while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) {
    cursor++
  }
  const newlineIdx = text.indexOf('\n', cursor)
  const rawLine = newlineIdx === -1 ? text.slice(cursor) : text.slice(cursor, newlineIdx)
  const firstLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

  if (firstLine.length === 0) return { line: '', ok: false }
  if (firstLine[0] === ' ' || firstLine[0] === '\t') return { line: firstLine, ok: false }
  return { line: firstLine, ok: true }
}

/**
 * Detect a marker of the form `<<<NEEDS_<dir>>>>` or `<<<NEEDS_<dir>: <reason>>>>`
 * at the start of a response. Internal helper.
 */
function detectMarker(line: string, dir: EscalationDirection, marker: string): { matched: boolean; reason?: string } {
  if (line === marker || line.trimEnd() === marker) {
    return { matched: true }
  }
  const prefix = `<<<NEEDS_${dir.toUpperCase()}:`
  if (line.startsWith(prefix) && line.endsWith('>>>')) {
    const reason = line.slice(prefix.length, line.length - 3).trim()
    if (reason.length > 0) {
      return { matched: true, reason }
    }
  }
  return { matched: false }
}

/**
 * Unified detection — returns which direction (if any) was requested.
 */
export function detectEscalationMarker(text: string): EscalationDetection {
  const { line, ok } = extractFirstLine(text)
  if (!ok) return { matched: false }

  // Try pro first (more common case for the flash call), then flash.
  const proHit = detectMarker(line, 'pro', NEEDS_PRO_MARKER)
  if (proHit.matched) return { matched: true, direction: 'pro', reason: proHit.reason }

  const flashHit = detectMarker(line, 'flash', NEEDS_FLASH_MARKER)
  if (flashHit.matched) return { matched: true, direction: 'flash', reason: flashHit.reason }

  return { matched: false }
}

/**
 * Detect the `<<<NEEDS_PRO>>>` marker at the start of a response.
 *
 * @param text  first chunk / first line / full body — anything that
 *              contains at least the first line of the response.
 */
export function detectNeedsPro(text: string): NeedsProDetection {
  const det = detectEscalationMarker(text)
  if (det.matched && det.direction === 'pro') {
    return { matched: true, reason: det.reason }
  }
  return { matched: false }
}

/**
 * Detect the `<<<NEEDS_FLASH>>>` marker at the start of a response.
 *
 * Emitted by the pro model when it judges a task to be trivial enough to
 * downgrade to the cheaper flash model.
 *
 * @param text  first chunk / first line / full body — anything that
 *              contains at least the first line of the response.
 */
export function detectNeedsFlash(text: string): NeedsFlashDetection {
  const det = detectEscalationMarker(text)
  if (det.matched && det.direction === 'flash') {
    return { matched: true, reason: det.reason }
  }
  return { matched: false }
}

/**
 * Strip a `<<<NEEDS_<dir>[...]>>>` marker from the start of a body.
 *
 * Works for both pro and flash markers. Useful when forwarding the rest of
 * the (non-streamed) response back to the client after a non-streamed
 * escalation or downgrade. We DO NOT strip in streaming mode: the first
 * SSE chunk may already include the marker mid-stream, but downstream
 * clients are expected to see the `X-Escalated-To` header and (optionally)
 * inspect the body themselves.
 */
export function stripNeedsProMarker(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  // Require at least one non-> char after the colon (matching detectMarker's
  // `reason.length > 0` guard) so bare markers like `<<<NEEDS_PRO:>>>` are
  // not stripped — they'd never be detected in the first place.
  return text.replace(/^\s*<<<NEEDS_(PRO|FLASH)(?::[^>]+)?>>>\s*\n?/, '')
}

/**
 * Strip a `<<<NEEDS_FLASH[...]>>>` marker from the start of a body.
 * Alias of `stripNeedsProMarker` — both handle PRO and FLASH markers.
 */
export const stripNeedsFlashMarker = stripNeedsProMarker
