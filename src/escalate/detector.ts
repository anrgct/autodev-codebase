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

// ---------------------------------------------------------------------------
// Incremental prefix detection
// ---------------------------------------------------------------------------

/**
 * Decision returned by `detectMarkerPrefix` for incremental content
 * accumulation during the streaming peek loop.
 *
 *  - `no-marker`     — the first line can no longer match any marker; the
 *                      peek loop should flush its content buffer and switch
 *                      to pure passthrough.
 *  - `matched-pro`   — a complete `<<<NEEDS_PRO[...]>>>` marker has arrived;
 *                      the peek loop should cancel the stream and escalate.
 *  - `matched-flash` — a complete `<<<NEEDS_FLASH[...]>>>` marker has arrived;
 *                      the peek loop should cancel the stream and downgrade.
 *  - `need-more`     — the first line is still ambiguous (could still be a
 *                      marker prefix); keep buffering.
 */
export type MarkerPrefixDecision = 'no-marker' | 'matched-pro' | 'matched-flash' | 'need-more'

/** Common lead shared by both marker kinds. */
const MARKER_COMMON_LEAD = '<<<NEEDS_'
const MARKER_PRO_LEAD = '<<<NEEDS_PRO'
const MARKER_FLASH_LEAD = '<<<NEEDS_FLASH'

/**
 * Given the SSE content accumulated so far, decide whether we can already
 * rule the marker in (`matched-*`), rule it out (`no-marker`), or need to
 * wait for more bytes (`need-more`).
 *
 * The contract guarantees the marker — when present — is the very first
 * non-blank line of the assistant `content`. `reasoning_content` (think
 * blocks) is not inspected here; the peek loop forwards those bytes directly
 * and only feeds `content` deltas into this function.
 */
export function detectMarkerPrefix(text: string): MarkerPrefixDecision {
  if (!text) return 'need-more'

  // Skip leading blank lines (the contract tolerates a stray `\n` first).
  let cursor = 0
  while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) {
    cursor++
  }
  if (cursor >= text.length) return 'need-more' // only newlines so far

  const rest = text.slice(cursor)
  // First non-newline char must be `<` for any marker to be possible.
  // (Leading space/tab would also fail this test, per the contract.)
  if (rest[0] !== '<') return 'no-marker'

  const nlIdx = rest.indexOf('\n')
  const firstLine = nlIdx === -1 ? rest : rest.slice(0, nlIdx)
  const firstLineComplete = nlIdx !== -1

  // Full marker detection (covers both bare and `: reason` forms).
  const proHit = detectMarker(firstLine, 'pro', NEEDS_PRO_MARKER)
  if (proHit.matched) return 'matched-pro'
  const flashHit = detectMarker(firstLine, 'flash', NEEDS_FLASH_MARKER)
  if (flashHit.matched) return 'matched-flash'

  // Complete first line that didn't match → definitively no marker.
  if (firstLineComplete) return 'no-marker'

  // First line is still partial — could it still grow into a marker?
  if (isPossibleMarkerPrefix(firstLine)) return 'need-more'
  return 'no-marker'
}

/**
 * Whether a partial first line could still grow into a valid marker prefix.
 * Marker grammar: `<<<NEEDS_(PRO|FLASH)(>>>|: reason>>>)`.
 */
function isPossibleMarkerPrefix(s: string): boolean {
  // Phase 1: shorter than the PRO/FLASH fork point.
  if (s.length < MARKER_PRO_LEAD.length) {
    // Must be a prefix of either lead (or the common lead).
    return MARKER_PRO_LEAD.startsWith(s) || MARKER_FLASH_LEAD.startsWith(s) || MARKER_COMMON_LEAD.startsWith(s)
  }

  // Phase 2: past the fork point — direction must be unambiguous.
  let lead: string
  if (s.startsWith(MARKER_PRO_LEAD)) lead = MARKER_PRO_LEAD
  else if (s.startsWith(MARKER_FLASH_LEAD)) lead = MARKER_FLASH_LEAD
  else return false // e.g. `<<<NEEDS_PROXY...` — not a marker

  const tail = s.slice(lead.length)
  if (tail === '') return true
  // Partial or complete `>>>` terminator (the complete case is normally
  // caught by detectMarker above; treat it as need-more defensively).
  if (tail === '>' || tail === '>>' || tail === '>>>') return true
  // `: reason>>>` form — reason is any run of non-`>` chars followed by `>>>`.
  if (tail.startsWith(':')) {
    const afterColon = tail.slice(1)
    for (let i = 0; i < afterColon.length; i++) {
      const ch = afterColon[i]
      if (ch === '\n') return false // shouldn't happen (firstLine has no \n)
      if (ch === '>') {
        // Once we see `>`, the remainder must be exactly `>`, `>>`, or `>>>`.
        const tail2 = afterColon.slice(i)
        return tail2 === '>' || tail2 === '>>' || tail2 === '>>>'
      }
    }
    return true // reason still accumulating, no `>` yet
  }
  return false
}
