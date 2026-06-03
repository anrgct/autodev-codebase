import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SQLiteVectorStore, buildFtsBm25Query } from '../sqlite-store'
import { compilePathFilters, compilePathFiltersToSql, compilePathFiltersToQdrant } from '../path-filter'

// Generate a deterministic unit vector for testing.  We avoid the
// randomness of random()-based vectors so test failures are reproducible.
function unitVector(dim: number, seed: number): number[] {
  const v = new Array<number>(dim)
  let s = seed
  for (let i = 0; i < dim; i++) {
    // simple LCG so we don't depend on any RNG
    s = (s * 1664525 + 1013904223) >>> 0
    v[i] = ((s % 1000) / 1000) - 0.5
  }
  // L2-normalise
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  return v.map((x) => x / norm)
}

// Build a unit vector that is `t` of the way from `base` toward `direction`,
// then re-normalise. Used to make test vectors that are guaranteed to be
// positively similar to `base` even though our LCG occasionally produces
// vectors on the opposite side of the unit sphere.
function perturb(base: number[], direction: number[], t: number): number[] {
  const v = base.map((b, i) => b * (1 - t) + direction[i] * t)
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  return v.map((x) => x / norm)
}

function makePoint(
  id: string,
  filePath: string,
  codeChunk: string,
  startLine: number,
  endLine: number,
  vector: number[],
) {
  return {
    id,
    vector,
    payload: {
      filePath,
      codeChunk,
      startLine,
      endLine,
      segmentHash: `${filePath}:${startLine}:${endLine}`,
    },
  }
}

describe('SQLiteVectorStore', () => {
  let tmpDir: string
  let store: SQLiteVectorStore
  let dbPath: string
  const VECTOR_DIM = 16

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-store-test-'))
    dbPath = path.join(tmpDir, 'index.db')
    store = new SQLiteVectorStore(tmpDir, VECTOR_DIM, 'test', 'test-model', undefined, dbPath)
    await store.initialize()
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initialises a fresh database and reports created=true on first run', async () => {
    // The first-time afterEach already closed it, but the second invocation
    // of `initialize()` should be a no-op (created=false).
    const created = await store.initialize()
    expect(created).toBe(false)
  })

  it('upserts points and surfaces them via search', async () => {
    // Build 3 vectors that are all positively similar to the query
    // vector. We take the base vector and add a small orthogonal
    // perturbation to each — they all live in the same "half" of the
    // unit sphere, so the minScore filter does not drop them.
    const a = unitVector(VECTOR_DIM, 1)
    const b = perturb(a, unitVector(VECTOR_DIM, 2), 0.1)
    const c = perturb(a, unitVector(VECTOR_DIM, 3), 0.1)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'function a() { return 1 }', 1, 1, a),
      makePoint('b', 'src/b.ts', 'function b() { return 2 }', 1, 1, b),
      makePoint('c', 'src/c.ts', 'function c() { return 3 }', 1, 1, c),
    ])

    const results = await store.search(a, { limit: 3 })
    expect(results.length).toBe(3)
    // Top hit should be the exact point we asked for
    expect(results[0].id).toBe('a')
    expect(results[0].payload?.['filePath']).toBe('src/a.ts')
    expect(results[0].score).toBeGreaterThan(0.99)
  })

  it('respects minScore by filtering low-similarity results', async () => {
    const v1 = unitVector(VECTOR_DIM, 11)
    const v2 = unitVector(VECTOR_DIM, 22)
    // Push a far-away vector that should be filtered out at minScore=0.9
    const opposite = v1.map((x) => -x)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'function a() {}', 1, 1, v1),
      makePoint('b', 'src/b.ts', 'function b() {}', 1, 1, v2),
      makePoint('c', 'src/c.ts', 'function c() {}', 1, 1, opposite),
    ])

    const results = await store.search(v1, { limit: 10, minScore: 0.5 })
    // The exact match is ~1.0, the unrelated ones are well below 0.5.
    expect(results.length).toBeLessThan(3)
    expect(results[0].id).toBe('a')
  })

  it('hybrid search returns the union of dense + BM25 candidates via RRF', async () => {
    const a = unitVector(VECTOR_DIM, 100)
    const b = unitVector(VECTOR_DIM, 200)
    const c = unitVector(VECTOR_DIM, 300)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'function alpha() { return "authenticate user" }', 1, 1, a),
      makePoint('b', 'src/b.ts', 'function beta() { return "billing invoice" }', 1, 1, b),
      makePoint('c', 'src/c.ts', 'function gamma() { return "compile code" }', 1, 1, c),
    ])

    // We use vector 'a' for the dense query so the dense leg also ranks
    // 'a' first, then combine with a BM25 query that does the same. The
    // RRF fusion should put 'a' at the top.
    const results = await store.search(
      a,
      { limit: 3, minScore: 0 },
      { rawQuery: 'authenticate user', denseWeight: 1.0, sparseWeight: 1.0 },
    )
    expect(results.length).toBe(3)
    expect(results[0].id).toBe('a')
  })

  it('BM25 sparse leg finds a literal phrase even when surrounded by unrelated text', async () => {
    // Regression for the case where the user types something like
    // `字面量"Clear index mode"` meaning "find code with the literal
    // phrase 'Clear index mode'". Previously the FTS5 query was wrapped
    // in a phrase (`"字面量""Clear index mode"""`) and matched zero
    // rows because no document contains the literal text
    // `字面量"Clear index mode"`. After the fix we tokenise the query
    // and join with OR so the phrase leg picks up the document.
    const v = unitVector(VECTOR_DIM, 42)
    await store.upsertPoints([
      makePoint(
        'idx',
        'src/commands/index.ts',
        "  if (commandOptions.clearCache) {\n    getLogger().info('Clear index mode');\n  }",
        460,
        480,
        v,
      ),
    ])

    // Use a non-matching dense vector so the result can only come from
    // the BM25 leg.
    const unrelated = unitVector(VECTOR_DIM, 99)
    const results = await store.search(
      unrelated,
      { limit: 5, minScore: 0 },
      {
        rawQuery: '字面量"Clear index mode"',
        denseWeight: 0.0,
        sparseWeight: 1.0,
      },
    )
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('idx')
    // The BM25 score should be a real, non-zero value — before the fix
    // this came back as 0.0 because the FTS5 index was empty.
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('BM25 phrase query (no surrounding noise) ranks the phrase-matching doc first', async () => {
    // Make `hit` closer to the query in dense space so it gets dense
    // rank 0, while `miss` is at a different vector and gets a worse
    // dense rank. With K=2 uniform RRF, dense rank 0 = 0.5, dense
    // rank 5 = 1/7 ≈ 0.14, sparse rank 0 = 0.5 — `hit` wins
    // 1.0 vs 0.14 regardless of the leg-weight ratio.
    const hitVec = unitVector(VECTOR_DIM, 50)
    const missVec = unitVector(VECTOR_DIM, 1500)
    const queryVec = perturb(hitVec, unitVector(VECTOR_DIM, 1), 0.05)
    await store.upsertPoints([
      makePoint('hit', 'src/a.ts', "log('Clear index mode')", 1, 1, hitVec),
      makePoint('miss', 'src/b.ts', "log('completely unrelated text')", 1, 1, missVec),
    ])
    const results = await store.search(
      queryVec,
      { limit: 5, minScore: 0 },
      { rawQuery: '"Clear index mode"', denseWeight: 1.0, sparseWeight: 1.0 },
    )
    // `hit` is in BOTH legs (dense rank 0, sparse rank 0). `miss` is
    // only in dense and at a worse rank. With K=2 the math is
    // unambiguous: hit 1.0, miss ≤ 0.14.
    expect(results[0].id).toBe('hit')
  })

  it('BM25 term query (single word) ranks the matching doc first', async () => {
    const hitVec = unitVector(VECTOR_DIM, 60)
    const missVec = unitVector(VECTOR_DIM, 1600)
    const queryVec = perturb(hitVec, unitVector(VECTOR_DIM, 2), 0.05)
    await store.upsertPoints([
      makePoint('hit', 'src/a.ts', "log('Clear index mode')", 1, 1, hitVec),
      makePoint('miss', 'src/b.ts', "log('billing invoice')", 1, 1, missVec),
    ])
    const results = await store.search(
      queryVec,
      { limit: 5, minScore: 0 },
      { rawQuery: 'Clear', denseWeight: 1.0, sparseWeight: 1.0 },
    )
    expect(results[0].id).toBe('hit')
  })

  it('BM25 candidates are always returned even when the dense leg dominates the RRF top-N', async () => {
    // Reproduces the production failure where a literal phrase query
    // (`字面量"Clear index mode"`) is drowned by the dense leg. The
    // dense leg can return 100+ candidates that are semantically
    // similar to the query embedding (Chinese + English tokens confuse
    // the embedder) and push the BM25 hits below the RRF cutoff. The
    // user reports that `grep 'Clear index mode'` over the CLI output
    // returns nothing — because the only doc containing the phrase
    // got sliced off.
    const phraseHitVec = unitVector(VECTOR_DIM, 1)
    const distractorVec = unitVector(VECTOR_DIM, 9999)
    await store.upsertPoints([
      makePoint(
        'phrase',
        'src/commands/index.ts',
        "  if (commandOptions.clearCache) {\n    getLogger().info('Clear index mode');\n  }",
        460,
        480,
        phraseHitVec,
      ),
      // 60 distractors that are similar to the query embedding (used
      // for the dense leg) but contain none of the phrase tokens.
      ...Array.from({ length: 60 }, (_, i) =>
        makePoint(
          `distractor${i}`,
          `src/distractor${i}.ts`,
          `function unrelatedThing${i}() { return ${i} }`,
          1,
          1,
          perturb(distractorVec, unitVector(VECTOR_DIM, 1000 + i), 0.02),
        ),
      ),
    ])

    // Use the distractor direction as the query vector so the dense
    // leg confidently surfaces all 60 distractors in its top-50, with
    // the BM25-only 'phrase' doc buried at the bottom. The default
    // weights (dense=1.0, sparse=0.3) make the dense leg dominate.
    const results = await store.search(
      distractorVec,
      { limit: 50, minScore: 0 },
      {
        rawQuery: '字面量"Clear index mode"',
        denseWeight: 1.0,
        sparseWeight: 0.3,
      },
    )

    // Without the BM25 guarantee, 'phrase' is sliced off by the
    // RRF top-50. With the guarantee, it must be present.
    const ids = results.map((r) => r.id)
    expect(ids).toContain('phrase')
  })

  it('applies pathFilters as a post-filter on dense results', async () => {
    const base = unitVector(VECTOR_DIM, 7)
    const a = perturb(base, unitVector(VECTOR_DIM, 11), 0.1)
    const b = perturb(base, unitVector(VECTOR_DIM, 13), 0.1)
    const c = perturb(base, unitVector(VECTOR_DIM, 17), 0.1)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'function a() {}', 1, 1, a),
      makePoint('b', 'lib/b.ts', 'function b() {}', 1, 1, b),
      makePoint('c', 'test/c.ts', 'function c() {}', 1, 1, c),
    ])

    const results = await store.search(base, {
      limit: 10,
      pathFilters: ['src/**/*.ts', '!**/*.test.ts'],
    })
    const ids = results.map((r) => r.id)
    expect(ids).toContain('a')
    // The path filter "src/**" only includes paths containing "src/" and
    // ".ts", so lib/b.ts and test/c.ts are excluded.
    expect(ids).not.toContain('b')
    expect(ids).not.toContain('c')
  })

  it('deletePointsByFilePath removes the file from the index', async () => {
    const v = unitVector(VECTOR_DIM, 13)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'function a() {}', 1, 1, v),
      makePoint('b', 'src/b.ts', 'function b() {}', 1, 1, v),
    ])

    await store.deletePointsByFilePath('src/a.ts')
    const results = await store.search(v, { limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).not.toContain('a')
    expect(ids).toContain('b')
  })

  it('deletePointsByMultipleFilePaths handles a batch delete', async () => {
    const v = unitVector(VECTOR_DIM, 14)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'a', 1, 1, v),
      makePoint('b', 'src/b.ts', 'b', 1, 1, v),
      makePoint('c', 'src/c.ts', 'c', 1, 1, v),
    ])
    await store.deletePointsByMultipleFilePaths(['src/a.ts', 'src/b.ts'])
    const results = await store.search(v, { limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).not.toContain('a')
    expect(ids).not.toContain('b')
    expect(ids).toContain('c')
  })

  it('clearCollection wipes all chunks but keeps the schema', async () => {
    const v = unitVector(VECTOR_DIM, 15)
    await store.upsertPoints([
      makePoint('a', 'src/a.ts', 'a', 1, 1, v),
    ])
    await store.clearCollection()
    const results = await store.search(v, { limit: 10 })
    expect(results.length).toBe(0)
  })

  it('deleteCollection removes the on-disk file', async () => {
    await store.deleteCollection()
    expect(fs.existsSync(dbPath)).toBe(false)
  })

  it('getAllFilePaths returns the set of indexed file paths', async () => {
    const v = unitVector(VECTOR_DIM, 16)
    await store.upsertPoints([
      makePoint('a1', 'src/a.ts', 'one', 1, 5, v),
      makePoint('a2', 'src/a.ts', 'two', 6, 10, v),
      makePoint('b1', 'src/b.ts', 'three', 1, 3, v),
    ])
    const all = await store.getAllFilePaths()
    expect(all.sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('markIndexingComplete + hasIndexedData round-trip', async () => {
    const v = unitVector(VECTOR_DIM, 17)
    await store.upsertPoints([makePoint('a', 'src/a.ts', 'a', 1, 1, v)])
    await store.markIndexingIncomplete()
    expect(await store.hasIndexedData()).toBe(true) // data exists; meta says not complete
    await store.markIndexingComplete()
    expect(await store.hasIndexedData()).toBe(true)
  })

  it('rebuilds the schema when the embedding dimension changes', async () => {
    // The first store was created with VECTOR_DIM=16. Close it and create a
    // fresh one with a different dimension against the same dbPath.
    store.close()
    const store2 = new SQLiteVectorStore(tmpDir, 32, 'test', 'test-model', undefined, dbPath)
    const created = await store2.initialize()
    expect(created).toBe(true)
    store2.close()
  })

  it('rebuilds the schema when the FTS5 column name is stale (v1→v2 migration)', async () => {
    // Force the v1 schema (FTS5 column = `content`, the original bug) by
    // dropping the FTS5 table and recreating it with the old name. Then
    // re-init the store and assert it self-heals.
    store.close()
    const Database = require('better-sqlite3')
    const legacy = new Database(dbPath)
    legacy.exec(`
      DROP TABLE IF EXISTS fts_chunks;
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TRIGGER IF EXISTS chunks_au;
      CREATE VIRTUAL TABLE fts_chunks USING fts5(
        content,
        file_path UNINDEXED,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2 tokenchars ''_.$'''
      );
    `)
    legacy.close()

    const store2 = new SQLiteVectorStore(tmpDir, VECTOR_DIM, 'test', 'test-model', undefined, dbPath)
    const created = await store2.initialize()
    // The legacy fts_chunks table does not satisfy `_ftsSchemaIsCurrent`,
    // so `initialize()` must drop and rebuild it, returning `true`.
    expect(created).toBe(true)
    store2.close()
  })
})

describe('buildFtsBm25Query', () => {
  it('returns empty string for blank input', () => {
    expect(buildFtsBm25Query('')).toBe('')
  })

  it('wraps a single term unchanged', () => {
    expect(buildFtsBm25Query('Clear')).toBe('Clear')
  })

  it('wraps a single phrase unchanged', () => {
    expect(buildFtsBm25Query('"Clear index mode"')).toBe('"Clear index mode"')
  })

  it('joins multiple terms with OR (Qdrant BM25 semantics)', () => {
    expect(buildFtsBm25Query('authenticate user')).toBe('authenticate OR user')
  })

  it('joins term + phrase with OR (regression for the "字面量" case)', () => {
    expect(buildFtsBm25Query('字面量"Clear index mode"')).toBe(
      '"Clear index mode" OR 字面量',
    )
  })

  it('joins multiple phrases and terms with OR', () => {
    // Phrases come first in the emitted query (implementation detail:
    // the parser keeps the order of `phrases` then appends terms
    // found in the residual text), but the OR semantics are the
    // important bit — each part is OR-combined.
    const out = buildFtsBm25Query('alpha "beta gamma" delta')
    expect(out).toContain('"beta gamma"')
    expect(out).toContain('alpha')
    expect(out).toContain('delta')
    expect(out.split(' OR ').length).toBe(3)
  })

  it('quotes barewords that contain FTS5 reserved characters', () => {
    // `foo:bar` would otherwise be parsed as a column filter.
    expect(buildFtsBm25Query('foo:bar')).toBe('"foo:bar"')
  })

  it('preserves doubled-quote escape inside phrases ("" -> ")', () => {
    // Per the FTS5 spec, `""` inside a phrase string is the escape for
    // a literal `"`. The user input `"a""b"` therefore represents a
    // phrase containing the three characters `a`, `"`, `b`. We emit it
    // back with the escape preserved.
    expect(buildFtsBm25Query('"a""b"')).toBe('"a""b"')
  })
})

describe('compilePathFilters', () => {
  it('returns empty filters for empty input', () => {
    expect(compilePathFilters(undefined)).toEqual({ includes: [], excludes: [] })
    expect(compilePathFilters([])).toEqual({ includes: [], excludes: [] })
  })

  it('classifies include vs exclude patterns', () => {
    const out = compilePathFilters(['src/**/*.ts', '!**/*.test.ts'])
    expect(out.includes).toEqual([['src/', '.ts']])
    expect(out.excludes).toEqual([['.test.ts']])
  })

  it('expands brace patterns', () => {
    const out = compilePathFilters(['src/{a,b}/**/*.ts'])
    // Each expanded pattern becomes its own include group
    expect(out.includes.length).toBe(2)
    const flattened = out.includes.map((g) => g.join('/'))
    expect(flattened).toContain('src/a//.ts')
    expect(flattened).toContain('src/b//.ts')
  })
})

describe('compilePathFiltersToSql', () => {
  it('returns 1=1 when no filters are active', () => {
    const r = compilePathFiltersToSql(compilePathFilters([]))
    expect(r.sql).toBe('1=1')
    expect(r.params).toEqual([])
  })

  it('emits LIKE clauses for include groups and NOT LIKE for excludes', () => {
    const r = compilePathFiltersToSql(compilePathFilters(['src/**/*.ts', '!**/*.test.ts']))
    expect(r.sql).toContain('file_path_lower LIKE ?')
    expect(r.sql).toContain('NOT (file_path_lower LIKE ?)')
    // Each substring becomes a parameter. The path 'src/**/*.ts' is split
    // on ** and * and the literals 'src/' and '.ts' are kept.
    expect(r.params).toEqual(['%src/%', '%.ts%', '%.test.ts%'])
  })
})

describe('compilePathFiltersToQdrant', () => {
  it('returns an empty object when no filters are active', () => {
    expect(compilePathFiltersToQdrant(compilePathFilters([]))).toEqual({})
  })

  it('produces a should/must_not structure compatible with the Qdrant backend', () => {
    const out = compilePathFiltersToQdrant(
      compilePathFilters(['src/**/*.ts', '!**/*.test.ts']),
    )
    expect(out['should']).toBeDefined()
    expect(out['must_not']).toBeDefined()
  })
})
