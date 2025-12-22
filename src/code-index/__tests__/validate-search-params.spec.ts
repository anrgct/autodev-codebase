import { describe, it, expect } from 'vitest'
import { validateLimit, validateMinScore } from '../validate-search-params'
import { SEARCH_CONFIG } from '../constants/search-config'

describe('validateLimit', () => {
  it('should return default for invalid inputs', () => {
    expect(validateLimit(null)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(undefined)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(NaN)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(Infinity)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(-5)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(0)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
  })

  it('should handle decimal numbers', () => {
    // (0,1)小数应返回默认，不是0
    expect(validateLimit(0.4)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(0.9)).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit(1.9)).toBe(1)
    expect(validateLimit(10.7)).toBe(10)
  })

  it('should clamp to max limit', () => {
    expect(validateLimit(100)).toBe(SEARCH_CONFIG.MAX_LIMIT)
  })

  it('should return valid integers unchanged', () => {
    expect(validateLimit(1)).toBe(1)
    expect(validateLimit(25)).toBe(25)
    expect(validateLimit(SEARCH_CONFIG.MAX_LIMIT)).toBe(SEARCH_CONFIG.MAX_LIMIT)
  })

  it('should parse string numbers', () => {
    expect(validateLimit('25')).toBe(25)
    expect(validateLimit('0')).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
    expect(validateLimit('0.5')).toBe(SEARCH_CONFIG.DEFAULT_LIMIT)
  })
})

describe('validateMinScore', () => {
  it('should return default for invalid inputs', () => {
    expect(validateMinScore(null)).toBe(SEARCH_CONFIG.DEFAULT_MIN_SCORE)
    expect(validateMinScore(undefined)).toBe(SEARCH_CONFIG.DEFAULT_MIN_SCORE)
    expect(validateMinScore(NaN)).toBe(SEARCH_CONFIG.DEFAULT_MIN_SCORE)
    expect(validateMinScore(Infinity)).toBe(SEARCH_CONFIG.DEFAULT_MIN_SCORE)
  })

  it('should clamp to [0,1] range', () => {
    expect(validateMinScore(-0.5)).toBe(0)
    expect(validateMinScore(1.5)).toBe(1)
    expect(validateMinScore(0.7)).toBe(0.7)
  })

  it('should parse string numbers', () => {
    expect(validateMinScore('0.6')).toBe(0.6)
    expect(validateMinScore('abc')).toBe(SEARCH_CONFIG.DEFAULT_MIN_SCORE)
  })

  it('should handle boundary values', () => {
    expect(validateMinScore(0)).toBe(0)
    expect(validateMinScore(1)).toBe(1)
    expect(validateMinScore(0.5)).toBe(0.5)
  })
})
