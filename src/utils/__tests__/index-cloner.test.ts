import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  hashWorkspace16,
  hashWorkspaceFull,
  collectionNameFor,
  indexCacheFileName,
  summaryCacheDir,
  dependencyCacheDir,
  sqliteVectorStoreDbPath,
  cloneLocalCaches,
  cloneQdrantCollection,
  cloneSqliteVectorStore,
  cloneIndexFromSource,
  observeSourceBackend,
  resolveTargetBackend,
  detectBackendMismatch,
  type IndexCloneDependencies,
  type LocalCacheCloneDetails,
  type QdrantCollectionCloneDetails,
  type SqliteVectorStoreCloneDetails,
} from '../index-cloner'

// Fixed workspace paths used throughout these tests. The expected Qdrant
// collection names below are derived from these paths.
const SOURCE_WORKSPACE = '/Users/x/source'
const TARGET_WORKSPACE = '/Users/x/target'
const SOURCE_COLLECTION = collectionNameFor(SOURCE_WORKSPACE)
const TARGET_COLLECTION = collectionNameFor(TARGET_WORKSPACE)

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

interface FetchCall {
  url: string
  init?: RequestInit
}

interface MockFetchResult {
  status?: number
  ok?: boolean
  statusText?: string
  body?: BodyInit | null
  json?: any
  text?: string
  contentType?: string
  /**
   * Headers to expose (e.g. content-length). For convenience, anything
   * matching `content-length` is also returned by `.headers.get()`.
   */
  contentLength?: string
}

function createMockFetch(handler: (call: FetchCall) => MockFetchResult | Promise<MockFetchResult>): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    calls.push({ url, init })
    const result = await handler({ url, init })
    const status = result.status ?? (result.ok === false ? 500 : 200)
    const ok = result.ok ?? (status >= 200 && status < 300)
    const headers = new Headers()
    if (result.contentType) headers.set('content-type', result.contentType)
    if (result.contentLength) headers.set('content-length', result.contentLength)
    let body: BodyInit | null = result.body ?? null
    if (body === null && result.json !== undefined) {
      body = JSON.stringify(result.json)
      if (!result.contentType) headers.set('content-type', 'application/json')
    } else if (body === null && result.text !== undefined) {
      body = result.text
    }
    return new Response(body, { status, statusText: result.statusText ?? '', headers })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function qdrantHandlers(opts: {
  sourceExists?: boolean
  targetExists?: boolean
  createSnapshotStatus?: number
  createSnapshotJson?: any
  downloadStatus?: number
  downloadBody?: Buffer
  uploadStatus?: number
  uploadJson?: any
  pointsCount?: number
}) {
  const source = SOURCE_COLLECTION
  const target = TARGET_COLLECTION
  return {
    source,
    target,
    handler: async (call: FetchCall): Promise<MockFetchResult> => {
      // Decode the collection name from the URL — the actual code computes
      // hash-based names from workspace paths, so we must match by encoded
      // string. Accept any collection that is *not* the fixed source/target
      // names we expose (i.e. the real hash-based ones the code uses).
      const collMatch = call.url.match(/\/collections\/([^/]+)/)
      const coll = collMatch ? decodeURIComponent(collMatch[1]) : ''

      // /collections/X/exists
      if (call.url.includes('/exists')) {
        if (coll === source) {
          return { status: 200, json: { result: { exists: opts.sourceExists ?? true } } }
        }
        if (coll === target) {
          return { status: 200, json: { result: { exists: opts.targetExists ?? false } } }
        }
        // The real hash-based collection names that the code uses: the
        // first /exists call in a test session is for the source, the
        // second is for the target. Track the order.
        if (!handlerState.seenSource) {
          handlerState.seenSource = true
          handlerState.realSource = coll
          return { status: 200, json: { result: { exists: opts.sourceExists ?? true } } }
        }
        handlerState.realTarget = coll
        return { status: 200, json: { result: { exists: opts.targetExists ?? false } } }
      }

      // POST /collections/X/snapshots (no body args, no file)
      const createMatch = call.url.match(/\/collections\/([^/]+)\/snapshots$/)
      if (call.init?.method === 'POST' && createMatch) {
        if (opts.createSnapshotStatus && opts.createSnapshotStatus >= 400) {
          return { status: opts.createSnapshotStatus, statusText: 'Err', text: 'create failed' }
        }
        return {
          status: opts.createSnapshotStatus ?? 200,
          json: opts.createSnapshotJson ?? { result: { name: 'snap-1.snapshot' } },
        }
      }

      // GET /collections/X/snapshots/Y
      const downloadMatch = call.url.match(/\/collections\/([^/]+)\/snapshots\/([^/]+)$/)
      if (call.init?.method !== 'POST' && downloadMatch) {
        if (opts.downloadStatus && opts.downloadStatus >= 400) {
          return { status: opts.downloadStatus, statusText: 'Err' }
        }
        return {
          status: opts.downloadStatus ?? 200,
          body: opts.downloadBody ? new Uint8Array(opts.downloadBody) : 'snapshot-bytes',
          contentLength: String(opts.downloadBody?.byteLength ?? 13),
        }
      }

      // DELETE /collections/X/snapshots/Y
      if (call.init?.method === 'DELETE' && downloadMatch) {
        return { status: 200, json: { result: true } }
      }

      // POST /collections/X/snapshots/upload?priority=snapshot&wait=true
      const uploadMatch = call.url.match(/\/collections\/([^/]+)\/snapshots\/upload/)
      if (call.init?.method === 'POST' && uploadMatch) {
        if (opts.uploadStatus && opts.uploadStatus >= 400) {
          return { status: opts.uploadStatus, statusText: 'Err', text: 'upload failed' }
        }
        return { status: opts.uploadStatus ?? 200, json: opts.uploadJson ?? { result: true } }
      }

      // GET /collections/X (info)
      const infoMatch = call.url.match(/\/collections\/([^/]+)$/)
      if (call.init?.method !== 'POST' && infoMatch) {
        const coll = decodeURIComponent(infoMatch[1])
        if (coll === target || coll === handlerState.realTarget) {
          return { status: 200, json: { result: { points_count: opts.pointsCount ?? 87 } } }
        }
        return { status: 200, json: { result: { points_count: 0 } } }
      }

      return { status: 404, statusText: 'Not Found', text: `unhandled ${call.init?.method ?? 'GET'} ${call.url}` }
    },
  }
}

// Per-handler state for matching real (hash-based) collection names.
const handlerState: { seenSource: boolean; realSource: string; realTarget: string } = {
  seenSource: false,
  realSource: '',
  realTarget: '',
}
function resetHandlerState() {
  handlerState.seenSource = false
  handlerState.realSource = ''
  handlerState.realTarget = ''
}

describe('hash helpers', () => {
  it('hashWorkspaceFull returns a 64-char hex string', () => {
    const hash = hashWorkspaceFull('/Users/x/repo')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashWorkspace16 returns the first 16 chars', () => {
    const full = hashWorkspaceFull('/Users/x/repo')
    expect(hashWorkspace16('/Users/x/repo')).toBe(full.substring(0, 16))
  })

  it('collectionNameFor uses the 16-char hash', () => {
    expect(collectionNameFor('/Users/x/repo')).toBe(`ws-${hashWorkspace16('/Users/x/repo')}`)
  })

  it('indexCacheFileName uses the full hash', () => {
    const name = indexCacheFileName('/Users/x/repo')
    expect(name).toBe(`roo-index-cache-${hashWorkspaceFull('/Users/x/repo')}.json`)
  })

  it('summaryCacheDir/dependencyCacheDir compose the expected paths', () => {
    const base = '/tmp/cache'
    expect(summaryCacheDir('/Users/x/repo', base)).toBe(
      path.join(base, 'summary-cache', hashWorkspace16('/Users/x/repo')),
    )
    expect(dependencyCacheDir('/Users/x/repo', base)).toBe(
      path.join(base, 'dependency-cache', hashWorkspace16('/Users/x/repo')),
    )
  })
})

describe('cloneLocalCaches', () => {
  let tempRoot: string
  let cacheBase: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'index-cloner-test-'))
    cacheBase = path.join(tempRoot, 'autodev-cache')
    await fs.mkdir(cacheBase, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  const sourcePath = SOURCE_WORKSPACE
  const targetPath = TARGET_WORKSPACE

  function deps(logger: ReturnType<typeof makeLogger>): Partial<IndexCloneDependencies> {
    return {
      fs,
      logger,
      cacheBasePath: cacheBase,
    }
  }

  async function writeIndexCache(workspacePath: string, content: Record<string, string>) {
    const file = path.join(cacheBase, indexCacheFileName(workspacePath))
    await fs.writeFile(file, JSON.stringify(content, null, 2))
  }

  async function writeSummaryCache(workspacePath: string, files: Array<{ rel: string; payload: any }>) {
    const dir = summaryCacheDir(workspacePath, cacheBase)
    await fs.mkdir(path.join(dir, 'files', path.dirname(files[0]?.rel ?? '_')), { recursive: true })
    for (const f of files) {
      const out = path.join(dir, 'files', `${f.rel}.summary.json`)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, JSON.stringify(f.payload, null, 2))
    }
  }

  async function writeDependencyCache(workspacePath: string, payload: any) {
    const dir = dependencyCacheDir(workspacePath, cacheBase)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'analysis-cache.json'), JSON.stringify(payload, null, 2))
  }

  it('copies all three local caches when source has them', async () => {
    await writeIndexCache(sourcePath, { 'src/a.ts': 'hash-a' })
    await writeSummaryCache(sourcePath, [{ rel: 'src/a.ts', payload: { version: '1.0', blocks: {} } }])
    await writeDependencyCache(sourcePath, { version: '1', files: {} })

    const result = await cloneLocalCaches(sourcePath, targetPath, deps(makeLogger()))

    expect(result.indexCache.status).toBe<LocalCacheCloneDetails['status']>('copied')
    expect(result.summaryCache.status).toBe<LocalCacheCloneDetails['status']>('copied')
    expect(result.dependencyCache.status).toBe<LocalCacheCloneDetails['status']>('copied')
    expect(result.localCachesCloned).toBe(true)

    const targetIndex = JSON.parse(
      await fs.readFile(path.join(cacheBase, indexCacheFileName(targetPath)), 'utf8'),
    )
    expect(targetIndex).toEqual({ 'src/a.ts': 'hash-a' })

    const targetSummary = await fs.readFile(
      path.join(summaryCacheDir(targetPath, cacheBase), 'files/src/a.ts.summary.json'),
      'utf8',
    )
    expect(JSON.parse(targetSummary)).toEqual({ version: '1.0', blocks: {} })

    const targetDeps = await fs.readFile(
      path.join(dependencyCacheDir(targetPath, cacheBase), 'analysis-cache.json'),
      'utf8',
    )
    expect(JSON.parse(targetDeps)).toEqual({ version: '1', files: {} })
  })

  it('skips caches whose source does not exist', async () => {
    await writeIndexCache(sourcePath, { 'src/a.ts': 'hash-a' })
    // No summary or dependency cache written

    const result = await cloneLocalCaches(sourcePath, targetPath, deps(makeLogger()))

    expect(result.indexCache.status).toBe<LocalCacheCloneDetails['status']>('copied')
    expect(result.summaryCache.status).toBe<LocalCacheCloneDetails['status']>('skipped_missing_source')
    expect(result.dependencyCache.status).toBe<LocalCacheCloneDetails['status']>('skipped_missing_source')
    expect(result.localCachesCloned).toBe(true)
  })

  it('rewrites absolute paths in index cache from source to target workspace', async () => {
    const absData = {
      [`${SOURCE_WORKSPACE}/demo/app.js`]: 'hash-a',
      [`${SOURCE_WORKSPACE}/demo/hello.js`]: 'hash-b',
      [`${SOURCE_WORKSPACE}/demo/deep/nested/file.ts`]: 'hash-c',
    }
    await writeIndexCache(sourcePath, absData)

    const result = await cloneLocalCaches(sourcePath, targetPath, deps(makeLogger()))

    expect(result.indexCache.status).toBe<LocalCacheCloneDetails['status']>('copied')

    const targetIndex = JSON.parse(
      await fs.readFile(path.join(cacheBase, indexCacheFileName(targetPath)), 'utf8'),
    )
    // Keys should have been rewritten from source workspace path to target workspace path
    expect(targetIndex).toEqual({
      [`${TARGET_WORKSPACE}/demo/app.js`]: 'hash-a',
      [`${TARGET_WORKSPACE}/demo/hello.js`]: 'hash-b',
      [`${TARGET_WORKSPACE}/demo/deep/nested/file.ts`]: 'hash-c',
    })
    // Source should be unchanged
    const sourceIndex = JSON.parse(
      await fs.readFile(path.join(cacheBase, indexCacheFileName(sourcePath)), 'utf8'),
    )
    expect(sourceIndex).toEqual(absData)
  })

  it('skips caches whose target already exists', async () => {
    await writeIndexCache(sourcePath, { 'src/a.ts': 'old' })
    await writeIndexCache(targetPath, { 'src/a.ts': 'fresh' })

    const result = await cloneLocalCaches(sourcePath, targetPath, deps(makeLogger()))

    expect(result.indexCache.status).toBe<LocalCacheCloneDetails['status']>('skipped_target_exists')
    const untouched = JSON.parse(
      await fs.readFile(path.join(cacheBase, indexCacheFileName(targetPath)), 'utf8'),
    )
    expect(untouched).toEqual({ 'src/a.ts': 'fresh' })
  })

  it('rolls back partial directory copy on failure', async () => {
    // Write a single source file that we will try to copy.
    const srcDir = summaryCacheDir(sourcePath, cacheBase)
    await fs.mkdir(path.join(srcDir, 'files', 'src'), { recursive: true })
    await fs.writeFile(path.join(srcDir, 'files', 'src', 'a.ts.summary.json'), '{}')

    // Pre-create a target *file* at the path of the leaf file. The walk
    // will reach the file, stat it (not a directory), then try to copy
    // the source file over the existing target file. copyFile refuses
    // to overwrite a directory but does overwrite a file by default;
    // so we additionally stub copyFile to throw on the leaf copy.
    const tgtFile = path.join(summaryCacheDir(targetPath, cacheBase), 'files', 'src', 'a.ts.summary.json')
    const originalCopyFile = fs.copyFile
    const stubFs = {
      ...fs,
      copyFile: vi.fn(async (src: string, dest: string) => {
        if (dest === tgtFile) {
          throw new Error('EACCES: simulated leaf copy failure')
        }
        return originalCopyFile(src, dest)
      }),
    } as any

    const result = await cloneLocalCaches(sourcePath, targetPath, {
      ...deps(makeLogger()),
      fs: stubFs,
    })

    expect(result.summaryCache.status).toBe<LocalCacheCloneDetails['status']>('failed')
    // The target should have been rolled back
    const exists = await fs
      .stat(summaryCacheDir(targetPath, cacheBase))
      .then(() => true)
      .catch(() => false)
    // After rollback, the target dir is force-removed
    expect(exists).toBe(false)
  })
})

describe('cloneQdrantCollection', () => {
  beforeEach(() => {
    resetHandlerState()
  })

  it('returns skipped_missing_source when source collection is absent', async () => {
    const { source, target, handler } = qdrantHandlers({ sourceExists: false })
    const { fetchImpl, calls } = createMockFetch(handler)

    const result = await cloneQdrantCollection(
      SOURCE_WORKSPACE,
      TARGET_WORKSPACE,
      { url: 'http://q:6333' },
      { fetchImpl, logger: makeLogger() },
    )

    expect(result.status).toBe<QdrantCollectionCloneDetails['status']>('skipped_missing_source')
    expect(result.sourceCollection).toBe(source)
    expect(result.targetCollection).toBe(target)
    // No snapshot/upload call should have been made
    expect(calls.find((c) => /\/snapshots$/.test(c.url) && c.init?.method === 'POST')).toBeUndefined()
  })

  it('returns skipped_target_exists when target already exists', async () => {
    const { handler } = qdrantHandlers({ sourceExists: true, targetExists: true })
    const { fetchImpl, calls } = createMockFetch(handler)

    const result = await cloneQdrantCollection(
      SOURCE_WORKSPACE,
      TARGET_WORKSPACE,
      { url: 'http://q:6333' },
      { fetchImpl, logger: makeLogger() },
    )

    expect(result.status).toBe<QdrantCollectionCloneDetails['status']>('skipped_target_exists')
    expect(calls.find((c) => /\/snapshots$/.test(c.url) && c.init?.method === 'POST')).toBeUndefined()
  })

  it('creates a snapshot, downloads, uploads, and verifies the point count', async () => {
    const { source, target, handler } = qdrantHandlers({
      sourceExists: true,
      targetExists: false,
      pointsCount: 87,
    })
    const { fetchImpl, calls } = createMockFetch(handler)

    const result = await cloneQdrantCollection(
      SOURCE_WORKSPACE,
      TARGET_WORKSPACE,
      { url: 'http://q:6333' },
      { fetchImpl, logger: makeLogger() },
    )

    expect(result.status).toBe<QdrantCollectionCloneDetails['status']>('copied')
    expect(result.sourceCollection).toBe(source)
    expect(result.targetCollection).toBe(target)
    expect(result.pointsCopied).toBe(87)

    const createCall = calls.find((c) => /\/snapshots$/.test(c.url) && c.init?.method === 'POST')
    expect(createCall).toBeDefined()
    const downloadCall = calls.find(
      (c) => /\/snapshots\/snap-1\.snapshot$/.test(c.url) && c.init?.method !== 'POST',
    )
    expect(downloadCall).toBeDefined()
    const uploadCall = calls.find((c) => /\/snapshots\/upload/.test(c.url) && c.init?.method === 'POST')
    expect(uploadCall).toBeDefined()
  })

  it('cleans up the source snapshot even when upload fails', async () => {
    const { handler } = qdrantHandlers({
      sourceExists: true,
      targetExists: false,
      uploadStatus: 500,
    })
    const { fetchImpl, calls } = createMockFetch(handler)

    const result = await cloneQdrantCollection(
      SOURCE_WORKSPACE,
      TARGET_WORKSPACE,
      { url: 'http://q:6333' },
      { fetchImpl, logger: makeLogger() },
    )

    expect(result.status).toBe<QdrantCollectionCloneDetails['status']>('failed')
    expect(result.error).toContain('500')
    // DELETE should have been issued to remove the source snapshot
    const deleteCalls = calls.filter(
      (c) => c.init?.method === 'DELETE' && /\/snapshots\/snap-1\.snapshot$/.test(c.url),
    )
    expect(deleteCalls.length).toBe(1)
  })

  it('returns failed when snapshot creation fails', async () => {
    const { handler } = qdrantHandlers({
      sourceExists: true,
      targetExists: false,
      createSnapshotStatus: 503,
    })
    const { fetchImpl } = createMockFetch(handler)

    const result = await cloneQdrantCollection(
      SOURCE_WORKSPACE,
      TARGET_WORKSPACE,
      { url: 'http://q:6333' },
      { fetchImpl, logger: makeLogger() },
    )

    expect(result.status).toBe<QdrantCollectionCloneDetails['status']>('failed')
    expect(result.error).toContain('503')
  })
})

describe('cloneIndexFromSource (integration shape)', () => {
  beforeEach(() => {
    resetHandlerState()
  })

  it('aggregates local + qdrant results and tracks failure reasons', async () => {
    const { handler } = qdrantHandlers({
      sourceExists: true,
      targetExists: false,
      uploadStatus: 500,
    })
    const { fetchImpl } = createMockFetch(handler)

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'index-cloner-int-'))
    const cacheBase = path.join(tempRoot, 'autodev-cache')
    await fs.mkdir(cacheBase, { recursive: true })

    try {
      // Source index cache present; target empty
      const sourcePath = SOURCE_WORKSPACE
      const targetPath = TARGET_WORKSPACE
      const indexFile = path.join(cacheBase, indexCacheFileName(sourcePath))
      await fs.writeFile(indexFile, JSON.stringify({ 'src/a.ts': 'hash-a' }))

      const result = await cloneIndexFromSource({
        sourcePath,
        targetPath,
        qdrant: { url: 'http://q:6333' },
        deps: {
          fs,
          fetchImpl,
          logger: makeLogger(),
          cacheBasePath: cacheBase,
        },
      })

      expect(result.indexCache.status).toBe<LocalCacheCloneDetails['status']>('copied')
      expect(result.qdrantCollection.status).toBe<QdrantCollectionCloneDetails['status']>('failed')
      expect(result.localCachesCloned).toBe(true)
      expect(result.qdrantCollectionCloned).toBe(false)
      expect(result.failureReasons.length).toBe(1)
      expect(result.failureReasons[0]).toContain('500')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('sqliteVectorStoreDbPath', () => {
  it('places the db under the cache base in a collection-name subdir', () => {
    const cacheBase = '/Users/x/.autodev-cache'
    const dbPath = sqliteVectorStoreDbPath('/Users/x/source', cacheBase)
    expect(dbPath).toBe(
      path.join(cacheBase, 'vector-store', collectionNameFor('/Users/x/source'), 'index.db'),
    )
  })
})

describe('cloneSqliteVectorStore', () => {
  let tempRoot: string
  let cacheBase: string
  let sourcePath: string
  let targetPath: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-clone-'))
    cacheBase = path.join(tempRoot, 'autodev-cache')
    await fs.mkdir(cacheBase, { recursive: true })
    sourcePath = path.join(tempRoot, 'source')
    targetPath = path.join(tempRoot, 'target')
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('skips when the source db does not exist', async () => {
    const result = await cloneSqliteVectorStore(
      sourcePath,
      targetPath,
      cacheBase,
      { fs, logger: makeLogger() },
    )
    expect(result.status).toBe<SqliteVectorStoreCloneDetails['status']>('skipped_missing_source')
  })

  it('copies the main db file and reports bytes copied', async () => {
    const sourceDb = sqliteVectorStoreDbPath(sourcePath, cacheBase)
    await fs.mkdir(path.dirname(sourceDb), { recursive: true })
    const payload = Buffer.from('SQLite-format-placeholder'.repeat(128))
    await fs.writeFile(sourceDb, payload)

    const result = await cloneSqliteVectorStore(
      sourcePath,
      targetPath,
      cacheBase,
      { fs, logger: makeLogger() },
    )

    expect(result.status).toBe<SqliteVectorStoreCloneDetails['status']>('copied')
    expect(result.bytesCopied).toBe(payload.length)
    const targetDb = sqliteVectorStoreDbPath(targetPath, cacheBase)
    const written = await fs.readFile(targetDb)
    expect(written.equals(payload)).toBe(true)
  })

  it('also copies the -wal / -shm side files when present', async () => {
    const sourceDb = sqliteVectorStoreDbPath(sourcePath, cacheBase)
    await fs.mkdir(path.dirname(sourceDb), { recursive: true })
    await fs.writeFile(sourceDb, Buffer.from('main-db'))
    await fs.writeFile(sourceDb + '-wal', Buffer.from('wal-data'))
    await fs.writeFile(sourceDb + '-shm', Buffer.from('shm-data'))

    const result = await cloneSqliteVectorStore(
      sourcePath,
      targetPath,
      cacheBase,
      { fs, logger: makeLogger() },
    )

    expect(result.status).toBe<SqliteVectorStoreCloneDetails['status']>('copied')
    // 7 ('main-db') + 8 ('wal-data') + 8 ('shm-data') = 23
    expect(result.bytesCopied).toBe(23)
    expect((await fs.readFile(sqliteVectorStoreDbPath(targetPath, cacheBase) + '-wal')).toString()).toBe('wal-data')
    expect((await fs.readFile(sqliteVectorStoreDbPath(targetPath, cacheBase) + '-shm')).toString()).toBe('shm-data')
  })

  it('skips when the target db already exists', async () => {
    const sourceDb = sqliteVectorStoreDbPath(sourcePath, cacheBase)
    const targetDb = sqliteVectorStoreDbPath(targetPath, cacheBase)
    await fs.mkdir(path.dirname(sourceDb), { recursive: true })
    await fs.mkdir(path.dirname(targetDb), { recursive: true })
    await fs.writeFile(sourceDb, Buffer.from('source-data'))
    await fs.writeFile(targetDb, Buffer.from('existing-data'))

    const result = await cloneSqliteVectorStore(
      sourcePath,
      targetPath,
      cacheBase,
      { fs, logger: makeLogger() },
    )

    expect(result.status).toBe<SqliteVectorStoreCloneDetails['status']>('skipped_target_exists')
    const targetContents = await fs.readFile(targetDb)
    expect(targetContents.toString()).toBe('existing-data')
  })

  it('returns a failed status with an error message when copyFile throws', async () => {
    const sourceDb = sqliteVectorStoreDbPath(sourcePath, cacheBase)
    await fs.mkdir(path.dirname(sourceDb), { recursive: true })
    await fs.writeFile(sourceDb, Buffer.from('source-data'))

    // Inject a failing copyFile so the success path cannot run.
    const fakeFs = {
      ...fs,
      copyFile: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }
    const result = await cloneSqliteVectorStore(
      sourcePath,
      targetPath,
      cacheBase,
      { fs: fakeFs as any, logger: makeLogger() },
    )

    expect(result.status).toBe<SqliteVectorStoreCloneDetails['status']>('failed')
    expect(result.error).toContain('disk full')
  })
})

// ---------------------------------------------------------------------------
// Backend-mismatch diagnostic helpers
// ---------------------------------------------------------------------------

describe('resolveTargetBackend', () => {
  it('returns the explicit vectorStoreBackend value when set', () => {
    const readConfig = () => JSON.stringify({ vectorStoreBackend: 'sqlite', qdrantUrl: 'http://x' })
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('sqlite')
  })

  it('returns qdrant when only qdrantUrl is configured (legacy fallback)', () => {
    const readConfig = () => JSON.stringify({ qdrantUrl: 'http://localhost:6333' })
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('qdrant')
  })

  it('returns unknown when neither is set', () => {
    const readConfig = () => JSON.stringify({ embedderProvider: 'openai' })
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('unknown')
  })

  it('returns unknown when the config file is missing', () => {
    const readConfig = () => null
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('unknown')
  })

  it('returns unknown when the JSON is malformed', () => {
    const readConfig = () => '{ this is not json'
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('unknown')
  })

  it('strips JSONC comments before parsing', () => {
    const readConfig = () =>
      '{\n  // comment with "qdrantUrl" string\n  "vectorStoreBackend": "qdrant",\n}'
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('qdrant')
  })

  it('propagates throws from the readConfig callback as unknown', () => {
    const readConfig = () => {
      throw new Error('disk error')
    }
    expect(resolveTargetBackend('/whatever', { readConfig })).toBe('unknown')
  })
})

describe('observeSourceBackend', () => {
  let tempRoot: string
  let cacheBase: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'observe-backend-'))
    cacheBase = path.join(tempRoot, 'autodev-cache')
    await fs.mkdir(cacheBase, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('returns sqlite when index.db exists for the source workspace', async () => {
    const sourcePath = '/Users/x/source'
    const dbDir = path.join(cacheBase, 'vector-store', collectionNameFor(sourcePath))
    await fs.mkdir(dbDir, { recursive: true })
    await fs.writeFile(path.join(dbDir, 'index.db'), Buffer.alloc(64))

    const mock = createMockFetch(() => ({ status: 404 }))
    const result = await observeSourceBackend(sourcePath, {
      qdrant: { url: 'http://localhost:6333' },
      cacheBasePath: cacheBase,
      fetchImpl: mock.fetchImpl,
    })
    expect(result).toBe('sqlite')
    // Qdrant should NOT have been probed once sqlite was found.
    expect(mock.calls).toHaveLength(0)
  })

  it('returns qdrant when the source collection exists and no SQLite db', async () => {
    const sourcePath = '/Users/x/source'
    const mock = createMockFetch(() => ({ status: 200 }))
    const result = await observeSourceBackend(sourcePath, {
      qdrant: { url: 'http://localhost:6333' },
      cacheBasePath: cacheBase,
      fetchImpl: mock.fetchImpl,
    })
    expect(result).toBe('qdrant')
    expect(mock.calls).toHaveLength(1)
  })

  it('returns none when neither backend has data', async () => {
    const sourcePath = '/Users/x/source'
    const mock = createMockFetch(() => ({ status: 404 }))
    const result = await observeSourceBackend(sourcePath, {
      qdrant: { url: 'http://localhost:6333' },
      cacheBasePath: cacheBase,
      fetchImpl: mock.fetchImpl,
    })
    expect(result).toBe('none')
  })

  it('returns qdrant even when SQLite sidecar (-wal) is missing', async () => {
    // Defensive: an empty vector-store dir (no index.db) should fall
    // through to the Qdrant probe and not be mis-reported as sqlite.
    const sourcePath = '/Users/x/source'
    const dbDir = path.join(cacheBase, 'vector-store', collectionNameFor(sourcePath))
    await fs.mkdir(dbDir, { recursive: true })
    // No index.db written.

    const mock = createMockFetch(() => ({ status: 200 }))
    const result = await observeSourceBackend(sourcePath, {
      qdrant: { url: 'http://localhost:6333' },
      cacheBasePath: cacheBase,
      fetchImpl: mock.fetchImpl,
    })
    expect(result).toBe('qdrant')
  })
})

describe('detectBackendMismatch', () => {
  const ctx = { sourcePath: '/src', targetPath: '/tgt' }

  it('does not report a mismatch when both backends match', () => {
    expect(detectBackendMismatch('qdrant', 'qdrant', ctx).mismatch).toBe(false)
    expect(detectBackendMismatch('sqlite', 'sqlite', ctx).mismatch).toBe(false)
  })

  it('reports a mismatch when source is qdrant but target is sqlite', () => {
    const r = detectBackendMismatch('qdrant', 'sqlite', ctx)
    expect(r.mismatch).toBe(true)
    expect(r.reason).toContain('qdrant')
    expect(r.reason).toContain('sqlite')
  })

  it('reports a mismatch when source is sqlite but target is qdrant', () => {
    const r = detectBackendMismatch('sqlite', 'qdrant', ctx)
    expect(r.mismatch).toBe(true)
    expect(r.reason).toContain('sqlite')
    expect(r.reason).toContain('qdrant')
  })

  it('does not report a mismatch when the source has no data on either backend', () => {
    expect(detectBackendMismatch('none', 'sqlite', ctx).mismatch).toBe(false)
    expect(detectBackendMismatch('none', 'qdrant', ctx).mismatch).toBe(false)
  })

  it('does not report a mismatch when the target backend cannot be determined', () => {
    // Better to be silent than to mis-diagnose: unknown target means
    // we have no information, so skip the warning entirely.
    expect(detectBackendMismatch('qdrant', 'unknown', ctx).mismatch).toBe(false)
    expect(detectBackendMismatch('sqlite', 'unknown', ctx).mismatch).toBe(false)
  })
})
