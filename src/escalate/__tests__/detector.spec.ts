/**
 * Unit tests for the `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>` first-line detector.
 */
import { describe, it, expect } from 'vitest'
import {
  detectNeedsPro,
  detectNeedsFlash,
  detectEscalationMarker,
  stripNeedsProMarker,
  NEEDS_PRO_MARKER,
  NEEDS_FLASH_MARKER,
} from '../detector'

describe('detectNeedsPro()', () => {
  describe('bare marker', () => {
    it('matches the bare marker on the first line', () => {
      expect(detectNeedsPro(NEEDS_PRO_MARKER)).toEqual({ matched: true })
    })
    it('matches when followed by more text on the next line', () => {
      const out = detectNeedsPro(`<<<NEEDS_PRO>>>\nHello, world!`)
      expect(out.matched).toBe(true)
    })
    it('matches with trailing whitespace before the newline', () => {
      const out = detectNeedsPro(`<<<NEEDS_PRO>>>   \nrest`)
      expect(out.matched).toBe(true)
    })
  })

  describe('marker with reason', () => {
    it('extracts a one-sentence reason', () => {
      const out = detectNeedsPro('<<<NEEDS_PRO: cross-file refactor across 6 modules>>>')
      expect(out.matched).toBe(true)
      expect(out.reason).toBe('cross-file refactor across 6 modules')
    })
    it('trims whitespace around the reason', () => {
      const out = detectNeedsPro('<<<NEEDS_PRO:   tricky concurrency   >>>')
      expect(out.matched).toBe(true)
      expect(out.reason).toBe('tricky concurrency')
    })
  })

  describe('rejection cases', () => {
    it('does not match when the marker is not on the first line', () => {
      const out = detectNeedsPro('Some preamble.\n<<<NEEDS_PRO>>>\nMore text.')
      expect(out.matched).toBe(false)
    })
    it('does not match when the marker is preceded by whitespace on the same line', () => {
      // Contract says "FIRST line, nothing before it" — leading whitespace disqualifies.
      const out = detectNeedsPro(' <<<NEEDS_PRO>>>')
      expect(out.matched).toBe(false)
    })
    it('does not match an empty string', () => {
      expect(detectNeedsPro('').matched).toBe(false)
    })
    it('does not match a non-string', () => {
      // @ts-expect-error — testing runtime robustness
      expect(detectNeedsPro(null).matched).toBe(false)
      // @ts-expect-error
      expect(detectNeedsPro(undefined).matched).toBe(false)
    })
    it('does not match a marker with an empty reason', () => {
      // <<<NEEDS_PRO:>>> is malformed and must be rejected.
      const out = detectNeedsPro('<<<NEEDS_PRO:>>>')
      expect(out.matched).toBe(false)
    })
    it('does not match a marker with too few or too many closing brackets', () => {
      expect(detectNeedsPro('<<<NEEDS_PRO>>').matched).toBe(false)
      expect(detectNeedsPro('<<<NEEDS_PRO>>>>').matched).toBe(false)
    })
    it('does NOT match a <<<NEEDS_FLASH>>> marker', () => {
      const out = detectNeedsPro('<<<NEEDS_FLASH>>>')
      expect(out.matched).toBe(false)
    })
  })

  describe('first-line policy', () => {
    it('allows leading blank lines but takes the first non-empty line', () => {
      // A stray leading newline should NOT disqualify the marker.
      const out = detectNeedsPro('\n\n<<<NEEDS_PRO>>>\nrest')
      expect(out.matched).toBe(true)
    })
    it('does not match if a non-empty line precedes the marker', () => {
      const out = detectNeedsPro('preamble\n<<<NEEDS_PRO>>>')
      expect(out.matched).toBe(false)
    })
  })
})

describe('detectNeedsFlash()', () => {
  it('matches the bare <<<NEEDS_FLASH>>> marker', () => {
    const out = detectNeedsFlash(NEEDS_FLASH_MARKER)
    expect(out).toEqual({ matched: true })
  })
  it('matches when followed by more text on the next line', () => {
    const out = detectNeedsFlash(`<<<NEEDS_FLASH>>>\ntrivial answer here`)
    expect(out.matched).toBe(true)
  })
  it('extracts a reason from the form <<<NEEDS_FLASH: ...>>>', () => {
    const out = detectNeedsFlash('<<<NEEDS_FLASH: simple typo fix>>>')
    expect(out.matched).toBe(true)
    expect(out.reason).toBe('simple typo fix')
  })
  it('trims whitespace around the reason', () => {
    const out = detectNeedsFlash('<<<NEEDS_FLASH:   read-only lookup   >>>')
    expect(out.matched).toBe(true)
    expect(out.reason).toBe('read-only lookup')
  })
  it('does NOT match a <<<NEEDS_PRO>>> marker', () => {
    const out = detectNeedsFlash('<<<NEEDS_PRO>>>')
    expect(out.matched).toBe(false)
  })
  it('does not match the marker when it is not on the first line', () => {
    const out = detectNeedsFlash('intro text\n<<<NEEDS_FLASH>>>')
    expect(out.matched).toBe(false)
  })
  it('does not match when preceded by whitespace on the marker line', () => {
    const out = detectNeedsFlash(' <<<NEEDS_FLASH>>>')
    expect(out.matched).toBe(false)
  })
  it('does not match an empty reason', () => {
    expect(detectNeedsFlash('<<<NEEDS_FLASH:>>>').matched).toBe(false)
  })
})

describe('detectEscalationMarker() (unified)', () => {
  it('returns direction=pro for a <<<NEEDS_PRO>>> marker', () => {
    const out = detectEscalationMarker('<<<NEEDS_PRO>>>')
    expect(out.matched).toBe(true)
    expect(out.direction).toBe('pro')
  })
  it('returns direction=flash for a <<<NEEDS_FLASH>>> marker', () => {
    const out = detectEscalationMarker('<<<NEEDS_FLASH>>>')
    expect(out.matched).toBe(true)
    expect(out.direction).toBe('flash')
  })
  it('returns matched=false for non-string', () => {
    // @ts-expect-error — runtime check
    expect(detectEscalationMarker(null).matched).toBe(false)
  })
  it('returns matched=false for empty input', () => {
    expect(detectEscalationMarker('').matched).toBe(false)
  })
  it('returns matched=false when no marker is present', () => {
    const out = detectEscalationMarker('Hello, world!')
    expect(out.matched).toBe(false)
    expect(out.direction).toBeUndefined()
  })
})

describe('stripNeedsProMarker()', () => {
  it('removes a bare <<<NEEDS_PRO>>> marker at the start', () => {
    expect(stripNeedsProMarker(`<<<NEEDS_PRO>>>\nHello`)).toBe('Hello')
  })
  it('removes a bare <<<NEEDS_FLASH>>> marker at the start (symmetric)', () => {
    expect(stripNeedsProMarker(`<<<NEEDS_FLASH>>>\nHello`)).toBe('Hello')
  })
  it('removes a marker with reason at the start', () => {
    expect(stripNeedsProMarker(`<<<NEEDS_PRO: tricky>>>   \nHello`)).toBe('Hello')
  })
  it('leaves non-marker text alone', () => {
    expect(stripNeedsProMarker('no marker here')).toBe('no marker here')
  })
  it('returns the input unchanged for empty strings', () => {
    expect(stripNeedsProMarker('')).toBe('')
  })
})
