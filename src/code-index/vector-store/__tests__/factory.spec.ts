import { describe, it, expect } from 'vitest'
import { resolveVectorStoreBackend } from '../factory'

describe('resolveVectorStoreBackend', () => {
  it('returns the explicit value when set', () => {
    expect(resolveVectorStoreBackend({ vectorStoreBackend: 'qdrant' })).toBe('qdrant')
    expect(resolveVectorStoreBackend({ vectorStoreBackend: 'sqlite' })).toBe('sqlite')
  })

  it('falls back to qdrant when qdrantUrl is set and no explicit backend', () => {
    expect(resolveVectorStoreBackend({ qdrantUrl: 'http://localhost:6333' })).toBe('qdrant')
  })

  it('falls back to sqlite when nothing is set (new user default)', () => {
    expect(resolveVectorStoreBackend({})).toBe('sqlite')
  })

  it('respects an explicit sqlite value even when qdrantUrl is set', () => {
    expect(
      resolveVectorStoreBackend({ vectorStoreBackend: 'sqlite', qdrantUrl: 'http://localhost:6333' }),
    ).toBe('sqlite')
  })

  it('respects an explicit qdrant value even when qdrantUrl is missing', () => {
    // This is a "user knows what they are doing" path; the factory will
    // surface a clear error if Qdrant cannot connect.
    expect(resolveVectorStoreBackend({ vectorStoreBackend: 'qdrant' })).toBe('qdrant')
  })
})
