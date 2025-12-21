/**
 * Tests for JSONC helper utilities
 */
import { describe, it, expect } from 'vitest'
import {
  saveJsoncPreservingComments,
  isValidJsonc,
  mergeConfig
} from '../jsonc-helpers'

describe('jsonc-helpers', () => {
  describe('saveJsoncPreservingComments', () => {
    it('should preserve comments when updating configuration', () => {
      const original = `{
  // Main configuration
  "codeIndex": {
    "embedder": {
      "provider": "ollama",  // Local provider
      "model": "nomic-embed-text"
    }
  },
  "search": { "maxResults": 10 }
}`

      const update = {
        codeIndex: { embedder: { provider: "openai" } },
        search: { maxResults: 20 }
      }

      const result = saveJsoncPreservingComments(original, update)

      expect(result).toContain('// Main configuration')
      expect(result).toContain('// Local provider')
      expect(result).toContain('"openai"')
      expect(result).toContain('"maxResults": 20')
      expect(isValidJsonc(result)).toBe(true)
    })

    it('should fallback to standard JSON for invalid original', () => {
      const invalid = `{
  "codeIndex": {
    "embedder": {
      "provider": "ollama"  // Missing comma
      "model": "nomic-embed-text"
    }
  }
}`

      const update = { codeIndex: { embedder: { provider: "openai" } } }
      const result = saveJsoncPreservingComments(invalid, update)

      // Should not contain comments since it fell back
      expect(result).not.toContain('//')
      expect(isValidJsonc(result)).toBe(true)
      expect(result).toContain('"openai"')
    })

    it('should handle empty original content', () => {
      const update = { test: "value", nested: { a: 1 } }
      const result = saveJsoncPreservingComments('', update)

      expect(result).toBe(JSON.stringify(update, null, 2))
      expect(isValidJsonc(result)).toBe(true)
    })

    it('should handle whitespace-only original', () => {
      const update = { test: "value" }
      const result = saveJsoncPreservingComments('   \n  \t  ', update)

      expect(result).toBe(JSON.stringify(update, null, 2))
    })

    it('should merge nested objects recursively', () => {
      const original = `{
  "level1": {
    "level2": {
      "keep": "this",
      "replace": "old"
    }
  }
}`

      const update = {
        level1: {
          level2: {
            replace: "new",
            add: "value"
          }
        }
      }

      const result = saveJsoncPreservingComments(original, update)
      const parsed = JSON.parse(result)

      expect(parsed.level1.level2.keep).toBe('this')
      expect(parsed.level1.level2.replace).toBe('new')
      expect(parsed.level1.level2.add).toBe('value')
    })

    it('should replace arrays, not merge them', () => {
      const original = `{
  "items": ["a", "b"],
  "config": { "value": 1 }
}`

      const update = {
        items: ["x", "y", "z"],
        config: { value: 2 }
      }

      const result = saveJsoncPreservingComments(original, update)
      const parsed = JSON.parse(result)

      expect(parsed.items).toEqual(["x", "y", "z"])
      expect(parsed.config.value).toBe(2)
    })

    it('should handle null values', () => {
      const original = `{
  "existing": "value",
  "toRemove": "something"
}`

      const update = {
        existing: "new",
        toRemove: null,
        added: null
      }

      const result = saveJsoncPreservingComments(original, update)
      const parsed = JSON.parse(result)

      expect(parsed.existing).toBe('new')
      expect(parsed.toRemove).toBe(null)
      expect(parsed.added).toBe(null)
    })

    it('should handle Date objects by converting to ISO string', () => {
      const original = `{"value": 1}`
      const date = new Date('2024-01-01T00:00:00.000Z')
      const update = { date }

      const result = saveJsoncPreservingComments(original, update)
      const parsed = JSON.parse(result)

      expect(parsed.date).toBe('2024-01-01T00:00:00.000Z')
    })

    it('should preserve comments at different nesting levels', () => {
      const original = `{
  // Top level comment
  "a": {
    // A comment
    "b": {
      // B comment
      "c": 1
    }
  },
  // Another comment
  "d": 2
}`

      const update = {
        a: { b: { c: 2 } },
        d: 3
      }

      const result = saveJsoncPreservingComments(original, update)

      expect(result).toContain('// Top level comment')
      expect(result).toContain('// A comment')
      expect(result).toContain('// B comment')
      expect(result).toContain('// Another comment')
    })

    it('should handle custom formatting options', () => {
      const original = `{
  "test": "value"
}`

      const update = { test: "new", added: "value" }

      const result = saveJsoncPreservingComments(original, update, {
        insertSpaces: true,
        tabSize: 4
      })

      // Should still be valid
      expect(isValidJsonc(result)).toBe(true)
      expect(result).toContain('"added"')
    })
  })

  describe('isValidJsonc', () => {
    it('should return true for valid JSON', () => {
      expect(isValidJsonc('{"test": "value"}')).toBe(true)
    })

    it('should return true for valid JSONC with comments', () => {
      const jsonc = `{
  // Comment
  "test": "value"
}`
      expect(isValidJsonc(jsonc)).toBe(true)
    })

    it('should return false for invalid JSON', () => {
      expect(isValidJsonc('{"test": "value"')).toBe(false)
      expect(isValidJsonc('not json')).toBe(false)
      expect(isValidJsonc('{"test": undefined}')).toBe(false)
    })

    it('should return false for JSONC with syntax errors', () => {
      const invalid = `{
  "test": "value"  // Missing comma
  "other": 1
}`
      expect(isValidJsonc(invalid)).toBe(false)
    })

    it('should handle empty string', () => {
      expect(isValidJsonc('')).toBe(false)
    })

    it('should handle whitespace only', () => {
      expect(isValidJsonc('   \n  ')).toBe(false)
    })
  })

  describe('mergeConfig', () => {
    it('should deeply merge plain objects', () => {
      const base = { a: 1, b: { c: 2, d: 3 } }
      const update = { b: { d: 4, e: 5 }, f: 6 }

      const result = mergeConfig(base, update)

      expect(result).toEqual({
        a: 1,
        b: { c: 2, d: 4, e: 5 },
        f: 6
      })
    })

    it('should replace non-plain objects', () => {
      const base = {
        plain: { a: 1 },
        array: [1, 2],
        string: "old",
        date: new Date('2023-01-01'),
        nullValue: null
      }

      const update = {
        plain: { b: 2 },  // Should merge
        array: [3, 4],    // Should replace
        string: "new",    // Should replace
        date: "2024-01-01", // Should replace
        nullValue: null   // Should replace with null
      }

      const result = mergeConfig(base, update)

      expect(result['plain']).toEqual({ a: 1, b: 2 }) // Merged
      expect(result['array']).toEqual([3, 4])         // Replaced
      expect(result['string']).toBe("new")           // Replaced
      expect(result['date']).toBe("2024-01-01")      // Replaced
      expect(result['nullValue']).toBe(null)         // Replaced
    })

    it('should handle base being non-object but update being object', () => {
      const base = { key: "string" }
      const update = { key: { nested: "value" } }

      const result = mergeConfig(base, update)

      expect(result['key']).toEqual({ nested: "value" })
    })

    it('should handle update being non-object but base being object', () => {
      const base = { key: { nested: "value" } }
      const update = { key: "string" }

      const result = mergeConfig(base, update)

      expect(result['key']).toBe("string")
    })

    it('should handle null values correctly', () => {
      const base = { a: 1, b: 2 }
      const update = { b: null, c: null }

      const result = mergeConfig(base, update)

      expect(result['a']).toBe(1)
      expect(result['b']).toBe(null)
      expect(result['c']).toBe(null)
    })

    it('should handle undefined in update (skipped by Object.entries)', () => {
      const base = { a: 1 }
      const update = { a: 2, b: undefined }

      const result = mergeConfig(base, update)

      expect(result['a']).toBe(2)
      expect(result['b']).toBe(undefined)
    })

    it('should handle empty objects', () => {
      const base = {}
      const update = {}

      const result = mergeConfig(base, update)

      expect(result).toEqual({})
    })

    it('should handle complex nested structures', () => {
      const base = {
        level1: {
          level2: {
            keep: "value",
            replace: "old"
          },
          array: [1, 2]
        }
      }

      const update = {
        level1: {
          level2: {
            replace: "new",
            add: "value"
          },
          array: [3, 4, 5]
        }
      }

      const result = mergeConfig(base, update)

      expect(result['level1'].level2['keep']).toBe("value")
      expect(result['level1'].level2['replace']).toBe("new")
      expect(result['level1'].level2['add']).toBe("value")
      expect(result['level1']['array']).toEqual([3, 4, 5])
    })
  })
})
