/**
 * Unit tests for the `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>` first-line detector.
 */
import { describe, it, expect } from 'vitest'
import {
  detectNeedsPro,
  detectNeedsFlash,
  detectEscalationMarker,
  detectMarkerPrefix,
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

describe('detectMarkerPrefix() — incremental prefix detection', () => {
  it('returns need-more for empty input', () => {
    expect(detectMarkerPrefix('')).toBe('need-more')
  })

  it('returns need-more for only-newline input', () => {
    expect(detectMarkerPrefix('\n\n')).toBe('need-more')
  })

  describe('short prefixes (before the PRO/FLASH fork)', () => {
    it.each([
      '<',
      '<<',
      '<<<',
      '<<<N',
      '<<<NE',
      '<<<NEE',
      '<<<NEED',
      '<<<NEEDS',
      '<<<NEEDS_',
      '<<<NEEDS_P',
      '<<<NEEDS_PR',
      '<<<NEEDS_F',
      '<<<NEEDS_FL',
    ])('returns need-more for %s', (prefix) => {
      expect(detectMarkerPrefix(prefix)).toBe('need-more')
    })
  })

  describe('definitive no-marker (first char is not <)', () => {
    it.each([
      'Hello',
      'hello world',
      'The answer is...',
      ' plain text',
      '\ttabbed',
    ])('returns no-marker for %s', (text) => {
      expect(detectMarkerPrefix(text)).toBe('no-marker')
    })

    it('returns no-marker for HTML-like content starting with <', () => {
      // <html> starts with < but is not a marker prefix — must bail out fast.
      expect(detectMarkerPrefix('<html>hello</html>')).toBe('no-marker')
    })

    it('returns no-marker for <<<NEEDS_PROXY (past PRO lead but wrong shape)', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PROXY')).toBe('no-marker')
    })
  })

  describe('complete markers', () => {
    it('detects bare <<<NEEDS_PRO>>>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PRO>>>')).toBe('matched-pro')
    })
    it('detects <<<NEEDS_PRO: reason>>>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PRO: cross-file refactor>>>')).toBe('matched-pro')
    })
    it('detects bare <<<NEEDS_FLASH>>>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_FLASH>>>')).toBe('matched-flash')
    })
    it('detects <<<NEEDS_FLASH: reason>>>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_FLASH: trivial>>>')).toBe('matched-flash')
    })
    it('detects a marker preceded by a stray newline', () => {
      expect(detectMarkerPrefix('\n<<<NEEDS_PRO>>>')).toBe('matched-pro')
    })
  })

  describe('partial : reason forms', () => {
    it('returns need-more for a partial reason', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PRO: partial reason')).toBe('need-more')
    })
    it('returns need-more for <<<NEEDS_PRO:>>>', () => {
      // Empty reason is malformed; detectMarker would reject it, but the
      // prefix check treats the closing >>> as still-arriving.
      // Actually '<<<NEEDS_PRO:>>>' has detectMarker reject (empty reason),
      // and isPossibleMarkerPrefix sees tail=':>>>' which is ':' + '>>>'
      // → the loop hits '>' immediately, tail2='>>>' → need-more.
      expect(detectMarkerPrefix('<<<NEEDS_PRO:>>>')).toBe('need-more')
    })
  })

  describe('partial >>> terminators', () => {
    it('returns need-more for <<<NEEDS_PRO>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PRO>')).toBe('need-more')
    })
    it('returns need-more for <<<NEEDS_PRO>>', () => {
      expect(detectMarkerPrefix('<<<NEEDS_PRO>>')).toBe('need-more')
    })
  })

  describe('complete first line without marker', () => {
    it('returns no-marker when the first line ends with a newline and is not a marker', () => {
      expect(detectMarkerPrefix('Hello\n<<<NEEDS_PRO>>>')).toBe('no-marker')
    })
    it('returns no-marker when marker appears on the second line', () => {
      expect(detectMarkerPrefix('some text\n<<<NEEDS_PRO>>>')).toBe('no-marker')
    })
  })
})
