import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  _test_discoverLocalCaches,
  _test_parseClearIndices,
} from '../cache'

describe('cache command — parseClearIndices', () => {
  it('parses a single index', () => {
    expect(_test_parseClearIndices('3', 5)).toEqual(new Set([3]))
  })

  it('parses comma-separated indices', () => {
    expect(_test_parseClearIndices('1,3,5', 5)).toEqual(new Set([1, 3, 5]))
  })

  it('parses a range', () => {
    expect(_test_parseClearIndices('2-4', 5)).toEqual(new Set([2, 3, 4]))
  })

  it('parses mixed ranges and singles', () => {
    expect(_test_parseClearIndices('1,3-5', 5)).toEqual(new Set([1, 3, 4, 5]))
  })

  it('parses "all" as every index 1..maxIndex', () => {
    expect(_test_parseClearIndices('all', 4)).toEqual(new Set([1, 2, 3, 4]))
  })

  it('throws when an index is out of range', () => {
    expect(() => _test_parseClearIndices('6', 5)).toThrow(/无效的序号/)
  })

  it('throws on a malformed token', () => {
    expect(() => _test_parseClearIndices('1-', 5)).toThrow(/无效的范围/)
  })

  it('throws on an empty string', () => {
    expect(() => _test_parseClearIndices('', 5)).toThrow()
  })
})

describe('cache command — discoverLocalCaches', () => {
  let tempRoot: string
  let cacheBase: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-cmd-'))
    cacheBase = path.join(tempRoot, 'autodev-cache')
    await fs.mkdir(cacheBase, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('returns an empty list when the cache base does not exist', async () => {
    const entries = await _test_discoverLocalCaches({}, path.join(tempRoot, 'no-such-dir'))
    expect(entries).toEqual([])
  })

  it('discovers a code-index cache file', async () => {
    await fs.writeFile(
      path.join(cacheBase, 'roo-index-cache-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222.json'),
      JSON.stringify({ 'src/a.ts': 'hash-a', 'src/b.ts': 'hash-b' }),
    )

    const entries = await _test_discoverLocalCaches({}, cacheBase)
    const idx = entries.find((e) => e.type === 'index')
    expect(idx).toBeDefined()
    expect(idx!.typeLabel).toBe('代码索引缓存')
    expect(idx!.itemCount).toBe(2)
    expect(idx!.status).toBe('ok')
  })

  it('discovers a dependency cache file', async () => {
    const hash = 'abcd1234abcd1234'
    const dir = path.join(cacheBase, 'dependency-cache', hash)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'analysis-cache.json'),
      JSON.stringify({ files: { 'src/a.ts': {}, 'src/b.ts': {}, 'src/c.ts': {} } }),
    )

    const entries = await _test_discoverLocalCaches({}, cacheBase)
    const dep = entries.find((e) => e.type === 'dependency')
    expect(dep).toBeDefined()
    expect(dep!.typeLabel).toBe('依赖分析缓存')
    expect(dep!.itemCount).toBe(3)
  })

  it('discovers an SQLite vector store with a populated .db', async () => {
    const collection = 'ws-7227c7664b102862'
    const dir = path.join(cacheBase, 'vector-store', collection)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'index.db'), Buffer.alloc(4096, 0x42))
    // Add a -wal sidecar to make sure directory sizing picks it up.
    await fs.writeFile(path.join(dir, 'index.db-wal'), Buffer.alloc(2048, 0x43))

    const entries = await _test_discoverLocalCaches({}, cacheBase)
    const sqlite = entries.find((e) => e.type === 'sqlite')
    expect(sqlite).toBeDefined()
    expect(sqlite!.typeLabel).toBe('SQLite向量库')
    expect(sqlite!.projectHash).toBe('7227c7664b102862')
    expect(sqlite!.status).toBe('ok')
    // Size = 4096 (db) + 2048 (wal) = 6144
    expect(sqlite!.sizeBytes).toBe(4096 + 2048)
    expect(sqlite!.absolutePath).toBe(path.join(dir, 'index.db'))
    expect(sqlite!.sqliteDbPath).toBe(path.join(dir, 'index.db'))
  })

  it('marks an SQLite vector store as empty when the dir exists but has no .db', async () => {
    const collection = 'ws-deadbeefdeadbeef'
    const dir = path.join(cacheBase, 'vector-store', collection)
    await fs.mkdir(dir, { recursive: true })

    const entries = await _test_discoverLocalCaches({}, cacheBase)
    const sqlite = entries.find((e) => e.type === 'sqlite')
    expect(sqlite).toBeDefined()
    expect(sqlite!.status).toBe('empty')
    expect(sqlite!.sizeBytes).toBe(0)
  })

  it('skips non-ws- directory names in vector-store (defensive)', async () => {
    const dir = path.join(cacheBase, 'vector-store', 'orphan')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'index.db'), Buffer.alloc(64))

    const entries = await _test_discoverLocalCaches({}, cacheBase)
    const sqlite = entries.find((e) => e.type === 'sqlite' && e.projectHash === 'orphan')
    expect(sqlite).toBeDefined()
    // The non-ws- directory is still listed (best-effort), so users can
    // spot and clean it up. We just don't synthesise a "ws-" prefix.
    expect(sqlite!.path).toBe('vector-store/orphan/index.db')
  })

  it('uses the project map to resolve names for all cache types', async () => {
    const projectMap = {
      'abcd1234abcd1234': '/Users/x/cool-project',
      '7227c7664b102862': '/Users/x/another',
    }
    const idxHash = 'abcd1234abcd1234'
    await fs.writeFile(
      path.join(cacheBase, `roo-index-cache-${idxHash}${'0'.repeat(48)}.json`),
      JSON.stringify({}),
    )
    await fs.mkdir(path.join(cacheBase, 'vector-store', 'ws-7227c7664b102862'), { recursive: true })
    await fs.writeFile(
      path.join(cacheBase, 'vector-store', 'ws-7227c7664b102862', 'index.db'),
      Buffer.alloc(64),
    )

    const entries = await _test_discoverLocalCaches(projectMap, cacheBase)
    const idx = entries.find((e) => e.type === 'index')
    const sqlite = entries.find((e) => e.type === 'sqlite')
    expect(idx).toBeDefined()
    expect(sqlite).toBeDefined()
    // Project name resolution should yield a directory-style label, not a
    // truncated hash, when the workspace is known.
    expect(idx!.projectName).toContain('cool-project')
    expect(sqlite!.projectName).toContain('another')
  })
})
