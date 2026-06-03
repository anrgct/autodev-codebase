/**
 * Worktree Index Cloner
 *
 * Copies the persisted state of an indexed workspace (local caches +
 * Qdrant collection) from one worktree to another, so that switching
 * to a fresh worktree does not require a full re-index.
 *
 * Files copied:
 *  - `~/.autodev-cache/roo-index-cache-{sha256}.json`             (code-index)
 *  - `~/.autodev-cache/summary-cache/{hash16}/files/...`           (AI summary)
 *  - `~/.autodev-cache/dependency-cache/{hash16}/analysis-cache.json` (deps)
 *
 * Qdrant collection copied via:
 *  - `POST /collections/{source}/snapshots` to create a snapshot
 *  - `GET /collections/{source}/snapshots/{name}` to download
 *  - `POST /collections/{target}/snapshots/upload?priority=snapshot`
 *    with `multipart/form-data` to restore the snapshot under a new name
 *
 * Path hashing is preserved (we do not change how `CacheManager` /
 * `SummaryCacheManager` / `DependencyCacheManager` compute their keys),
 * so the new worktree gets a fresh namespace that just happens to
 * contain a snapshot of the source's data.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

type LoggerLike = {
  debug: (message: string, ...args: any[]) => void
  info: (message: string, ...args: any[]) => void
  warn: (message: string, ...args: any[]) => void
  error: (message: string, ...args: any[]) => void
}

const DEFAULT_QDRANT_URL = 'http://localhost:6333'
const DEFAULT_FETCH_TIMEOUT_MS = 120_000
const DEFAULT_CACHE_BASE = path.join(os.homedir(), '.autodev-cache')

// ---------------------------------------------------------------------------
// Hash helpers — kept in lockstep with CacheManager / SummaryCacheManager /
// DependencyCacheManager / QdrantVectorStore.
// ---------------------------------------------------------------------------

export function hashWorkspaceFull(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex')
}

export function hashWorkspace16(workspacePath: string): string {
  return hashWorkspaceFull(workspacePath).substring(0, 16)
}

export function collectionNameFor(workspacePath: string): string {
  return `ws-${hashWorkspace16(workspacePath)}`
}

export function indexCacheFileName(workspacePath: string): string {
  return `roo-index-cache-${hashWorkspaceFull(workspacePath)}.json`
}

export function summaryCacheDir(workspacePath: string, cacheBase: string): string {
  return path.join(cacheBase, 'summary-cache', hashWorkspace16(workspacePath))
}

export function dependencyCacheDir(workspacePath: string, cacheBase: string): string {
  return path.join(cacheBase, 'dependency-cache', hashWorkspace16(workspacePath))
}

// ---------------------------------------------------------------------------
// Options & result types
// ---------------------------------------------------------------------------

export type LocalCacheStatus =
  | 'copied'
  | 'skipped_missing_source'
  | 'skipped_target_exists'
  | 'failed'

export interface LocalCacheCloneDetails {
  status: LocalCacheStatus
  sourcePath: string
  targetPath: string
  bytesCopied?: number
  filesCopied?: number
  error?: string
}

export type QdrantCloneStatus =
  | 'copied'
  | 'skipped_missing_source'
  | 'skipped_target_exists'
  | 'failed'

export interface QdrantCollectionCloneDetails {
  status: QdrantCloneStatus
  sourceCollection: string
  targetCollection: string
  pointsCopied?: number
  bytesCopied?: number
  error?: string
}

export interface IndexCloneResult {
  indexCache: LocalCacheCloneDetails
  summaryCache: LocalCacheCloneDetails
  dependencyCache: LocalCacheCloneDetails
  qdrantCollection: QdrantCollectionCloneDetails
  localCachesCloned: boolean
  qdrantCollectionCloned: boolean
  durationMs: number
  failureReasons: string[]
}

export interface IndexCloneDependencies {
  fs: Pick<typeof fs, 'stat' | 'mkdir' | 'copyFile' | 'rm' | 'readdir' | 'readFile' | 'writeFile'>
  fetchImpl: typeof fetch
  homedir: () => string
  logger: LoggerLike
  /** Override default cache base (`~/.autodev-cache`). */
  cacheBasePath?: string
}

export interface IndexCloneOptions {
  sourcePath: string
  targetPath: string
  qdrant: {
    url: string
    apiKey?: string
    timeoutMs?: number
  }
  deps?: Partial<IndexCloneDependencies>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function defaultCopyDir(
  source: string,
  target: string,
  fsImpl: IndexCloneDependencies['fs'],
  logger: LoggerLike,
): Promise<{ filesCopied: number; bytesCopied: number }> {
  let filesCopied = 0
  let bytesCopied = 0

  async function walk(currentSource: string, currentTarget: string): Promise<void> {
    const entries = await fsImpl.readdir(currentSource)
    await fsImpl.mkdir(currentTarget, { recursive: true })
    for (const entry of entries) {
      const srcEntry = path.join(currentSource, entry)
      const tgtEntry = path.join(currentTarget, entry)
      const stat = await fsImpl.stat(srcEntry)
      if (stat.isDirectory()) {
        await walk(srcEntry, tgtEntry)
      } else {
        await fsImpl.copyFile(srcEntry, tgtEntry)
        filesCopied += 1
        bytesCopied += stat.size
      }
    }
  }

  await walk(source, target)
  logger.debug(`Copied directory ${source} -> ${target} (${filesCopied} files, ${bytesCopied} bytes)`)
  return { filesCopied, bytesCopied }
}

function authHeader(apiKey?: string): Record<string, string> {
  return apiKey ? { 'api-key': apiKey } : {}
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

/**
 * Copy the three on-disk caches (`roo-index-cache`, `summary-cache`,
 * `dependency-cache`) from the source worktree's namespace to the target
 * worktree's namespace.
 *
 * Each cache is copied independently — failure in one does not abort
 * the others. Sources that don't exist (e.g. summary cache is empty)
 * are skipped silently. Targets that already exist are also skipped
 * (we never overwrite user data).
 */
export async function cloneLocalCaches(
  sourcePath: string,
  targetPath: string,
  deps: Partial<IndexCloneDependencies> = {},
): Promise<{
  indexCache: LocalCacheCloneDetails
  summaryCache: LocalCacheCloneDetails
  dependencyCache: LocalCacheCloneDetails
  localCachesCloned: boolean
}> {
  const logger: LoggerLike = deps.logger ?? console
  const fsImpl = (deps.fs ?? fs) as IndexCloneDependencies['fs']
  const cacheBase = deps.cacheBasePath ?? DEFAULT_CACHE_BASE

  // 1. Code index cache (single file at top of cache base dir)
  const indexSource = path.join(cacheBase, indexCacheFileName(sourcePath))
  const indexTarget = path.join(cacheBase, indexCacheFileName(targetPath))
  const indexCache = await copyIndexCacheFile(indexSource, indexTarget, sourcePath, targetPath, fsImpl, logger)

  // 2. AI summary cache (directory of files)
  const summarySource = summaryCacheDir(sourcePath, cacheBase)
  const summaryTarget = summaryCacheDir(targetPath, cacheBase)
  const summaryCache = await copyCacheDir(summarySource, summaryTarget, 'summary cache', fsImpl, logger)

  // 3. Dependency analysis cache (directory with one file inside)
  const depSource = dependencyCacheDir(sourcePath, cacheBase)
  const depTarget = dependencyCacheDir(targetPath, cacheBase)
  const dependencyCache = await copyCacheDir(depSource, depTarget, 'dependency cache', fsImpl, logger)

  const localCachesCloned =
    indexCache.status === 'copied' ||
    summaryCache.status === 'copied' ||
    dependencyCache.status === 'copied'

  return { indexCache, summaryCache, dependencyCache, localCachesCloned }
}

/**
 * Rewrite absolute-path keys in the index cache JSON from the source
 * workspace path prefix to the target workspace path prefix.
 *
 * The cache file stores absolute paths as keys (e.g.
 * `/home/user/workspace-main/demo/app.js`). When cloning from one
 * worktree to another the path prefix differs, so we must remap the
 * keys for the cache to be effective on the target.
 */
function rewriteIndexCachePaths(
  raw: string,
  sourceWorkspacePath: string,
  targetWorkspacePath: string,
): string {
  const data = JSON.parse(raw) as Record<string, string>
  const rewritten: Record<string, string> = {}

  // Normalise both paths to ensure consistent matching regardless of
  // trailing slashes.
  const src = sourceWorkspacePath.replace(/\/+$/, '')
  const tgt = targetWorkspacePath.replace(/\/+$/, '')

  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith(src + '/')) {
      rewritten[tgt + key.slice(src.length)] = value
    } else {
      // Fallback: keep the original key if it doesn't match the source
      // prefix (shouldn't happen in practice).
      rewritten[key] = value
    }
  }

  return JSON.stringify(rewritten, null, 2)
}

async function copyIndexCacheFile(
  source: string,
  target: string,
  sourceWorkspacePath: string,
  targetWorkspacePath: string,
  fsImpl: IndexCloneDependencies['fs'],
  logger: LoggerLike,
): Promise<LocalCacheCloneDetails> {
  try {
    const sourceStat = await fsImpl.stat(source)
    if (!sourceStat.isFile()) {
      return { status: 'skipped_missing_source', sourcePath: source, targetPath: target }
    }
  } catch {
    return { status: 'skipped_missing_source', sourcePath: source, targetPath: target }
  }

  try {
    const targetStat = await fsImpl.stat(target)
    if (targetStat.isFile()) {
      logger.debug(`Index cache target already exists, skipping: ${target}`)
      return { status: 'skipped_target_exists', sourcePath: source, targetPath: target, bytesCopied: 0 }
    }
  } catch {
    // Target doesn't exist — proceed.
  }

  try {
    // Read source, rewrite absolute paths, write target
    const sourceBytes = await fsImpl.readFile(source)
    const srcText = new TextDecoder().decode(sourceBytes)
    const tgtText = rewriteIndexCachePaths(srcText, sourceWorkspacePath, targetWorkspacePath)
    await fsImpl.writeFile(target, new TextEncoder().encode(tgtText))
    const targetStat = await fsImpl.stat(target)
    logger.info(
      `Copied index cache: ${source} -> ${target}` +
        ` (${targetStat.size} bytes, rewrote ${Object.keys(JSON.parse(tgtText)).length} keys)`,
    )
    return {
      status: 'copied',
      sourcePath: source,
      targetPath: target,
      bytesCopied: targetStat.size,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`Failed to copy index cache ${source} -> ${target}: ${message}`)
    return { status: 'failed', sourcePath: source, targetPath: target, error: message }
  }
}

async function copyCacheDir(
  source: string,
  target: string,
  label: string,
  fsImpl: IndexCloneDependencies['fs'],
  logger: LoggerLike,
): Promise<LocalCacheCloneDetails> {
  let sourceStat
  try {
    sourceStat = await fsImpl.stat(source)
  } catch {
    return { status: 'skipped_missing_source', sourcePath: source, targetPath: target }
  }
  if (!sourceStat.isDirectory()) {
    return { status: 'skipped_missing_source', sourcePath: source, targetPath: target }
  }

  try {
    const targetStat = await fsImpl.stat(target)
    if (targetStat.isDirectory()) {
      logger.debug(`${label} target already exists, skipping: ${target}`)
      return { status: 'skipped_target_exists', sourcePath: source, targetPath: target }
    }
  } catch {
    // Target doesn't exist — proceed.
  }

  try {
    const { filesCopied, bytesCopied } = await defaultCopyDir(source, target, fsImpl, logger)
    logger.info(`Copied ${label}: ${source} -> ${target} (${filesCopied} files, ${bytesCopied} bytes)`)
    return {
      status: 'copied',
      sourcePath: source,
      targetPath: target,
      filesCopied,
      bytesCopied,
    }
  } catch (error) {
    // Roll back partial copy.
    try {
      await fsImpl.rm(target, { recursive: true, force: true })
    } catch {
      // ignore
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`Failed to copy ${label} ${source} -> ${target}: ${message}`)
    return { status: 'failed', sourcePath: source, targetPath: target, error: message }
  }
}

/**
 * Copy the Qdrant collection that backs the source workspace to the
 * namespace of the target workspace.
 *
 * Strategy:
 *  1. Create a snapshot of the source collection.
 *  2. Download the snapshot as a tar archive.
 *  3. Upload it to the target collection (Qdrant creates the collection
 *     on-the-fly with the right vector config and seed data) using
 *     `?priority=snapshot` so existing data is overwritten if any.
 */
export async function cloneQdrantCollection(
  sourcePath: string,
  targetPath: string,
  qdrant: { url: string; apiKey?: string; timeoutMs?: number },
  deps: Partial<IndexCloneDependencies> = {},
): Promise<QdrantCollectionCloneDetails> {
  const logger: LoggerLike = deps.logger ?? console
  const fetchImpl: typeof fetch =
    deps.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch)
  const sourceCollection = collectionNameFor(sourcePath)
  const targetCollection = collectionNameFor(targetPath)
  const url = qdrant.url || DEFAULT_QDRANT_URL
  const timeoutMs = qdrant.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const headers = authHeader(qdrant.apiKey)

  if (typeof fetchImpl !== 'function') {
    const message = 'No fetch implementation available; cannot clone Qdrant collection'
    logger.warn(message)
    return {
      status: 'failed',
      sourceCollection,
      targetCollection,
      error: message,
    }
  }

  // 1. Verify the source collection exists and the target doesn't.
  try {
    const sourceExists = await qdrantCollectionExists(fetchImpl, url, sourceCollection, headers, timeoutMs)
    if (!sourceExists) {
      logger.debug(`Source Qdrant collection ${sourceCollection} does not exist; skipping`)
      return {
        status: 'skipped_missing_source',
        sourceCollection,
        targetCollection,
      }
    }
    const targetExists = await qdrantCollectionExists(fetchImpl, url, targetCollection, headers, timeoutMs)
    if (targetExists) {
      logger.debug(`Target Qdrant collection ${targetCollection} already exists; skipping`)
      return {
        status: 'skipped_target_exists',
        sourceCollection,
        targetCollection,
      }
    }
  } catch (error) {
    return failQdrantClone(logger, sourceCollection, targetCollection, error)
  }

  // 2. Create snapshot on the source.
  let snapshotName: string
  try {
    const create = await fetchImpl(`${url}/collections/${encodeURIComponent(sourceCollection)}/snapshots`, {
      method: 'POST',
      headers,
    })
    if (!create.ok) {
      return failQdrantClone(
        logger,
        sourceCollection,
        targetCollection,
        new Error(`Snapshot creation failed: ${create.status} ${create.statusText} ${await safeText(create)}`),
      )
    }
    const json = (await create.json()) as { result?: { name?: string } }
    snapshotName = json.result?.name ?? ''
    if (!snapshotName) {
      return failQdrantClone(
        logger,
        sourceCollection,
        targetCollection,
        new Error('Snapshot creation returned empty name'),
      )
    }
  } catch (error) {
    return failQdrantClone(logger, sourceCollection, targetCollection, error)
  }

  // 3. Download snapshot bytes.
  let buffer: Buffer
  try {
    buffer = await downloadQdrantSnapshot(fetchImpl, url, sourceCollection, snapshotName, headers, timeoutMs, logger)
  } catch (error) {
    return failQdrantClone(logger, sourceCollection, targetCollection, error)
  } finally {
    // Best-effort cleanup of the source snapshot.
    try {
      await fetchImpl(`${url}/collections/${encodeURIComponent(sourceCollection)}/snapshots/${encodeURIComponent(snapshotName)}`, {
        method: 'DELETE',
        headers,
      })
    } catch {
      // ignore
    }
  }

  // 4. Upload the snapshot to the target collection.
  try {
    const form = new FormData()
    // Convert Node Buffer to a fresh ArrayBuffer-backed Uint8Array to satisfy
    // the BlobPart type contract on Node 24 (Buffer<ArrayBufferLike> is not
    // accepted directly as a BlobPart).
    const ab = new ArrayBuffer(buffer.byteLength)
    const view = new Uint8Array(ab)
    view.set(buffer)
    form.append('snapshot', new Blob([view], { type: 'application/octet-stream' }), snapshotName)
    const uploadUrl = `${url}/collections/${encodeURIComponent(targetCollection)}/snapshots/upload?priority=snapshot&wait=true`
    const t = withTimeout(timeoutMs)
    let upload: Response
    try {
      upload = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers,
        body: form,
        signal: t.signal,
      })
    } finally {
      t.cancel()
    }
    if (!upload.ok) {
      return failQdrantClone(
        logger,
        sourceCollection,
        targetCollection,
        new Error(`Snapshot upload failed: ${upload.status} ${upload.statusText} ${await safeText(upload)}`),
      )
    }
  } catch (error) {
    return failQdrantClone(logger, sourceCollection, targetCollection, error)
  }

  // 5. Verify the new collection has the same point count.
  let pointsCopied: number | undefined
  try {
    const info = await qdrantCollectionInfo(fetchImpl, url, targetCollection, headers, timeoutMs)
    pointsCopied = info?.points_count
  } catch (error) {
    logger.warn(
      `Cloned collection ${targetCollection} created but point count check failed: ${String(error)}`,
    )
  }

  logger.info(
    `Copied Qdrant collection: ${sourceCollection} -> ${targetCollection}` +
      (pointsCopied !== undefined ? ` (${pointsCopied} points, ${buffer.byteLength} bytes)` : ''),
  )

  return {
    status: 'copied',
    sourceCollection,
    targetCollection,
    pointsCopied,
    bytesCopied: buffer.byteLength,
  }
}

function failQdrantClone(
  logger: LoggerLike,
  sourceCollection: string,
  targetCollection: string,
  error: unknown,
): QdrantCollectionCloneDetails {
  const message = error instanceof Error ? error.message : String(error)
  logger.warn(`Failed to clone Qdrant collection ${sourceCollection} -> ${targetCollection}: ${message}`)
  return {
    status: 'failed',
    sourceCollection,
    targetCollection,
    error: message,
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    const text = await resp.text()
    return text ? text.slice(0, 500) : ''
  } catch {
    return ''
  }
}

async function qdrantCollectionExists(
  fetchImpl: typeof fetch,
  url: string,
  collection: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  const t = withTimeout(timeoutMs)
  try {
    const resp = await fetchImpl(`${url}/collections/${encodeURIComponent(collection)}/exists`, {
      method: 'GET',
      headers,
      signal: t.signal,
    })
    if (resp.status === 200) {
      const body = (await resp.json()) as { result?: { exists?: boolean } }
      return body.result?.exists === true
    }
    if (resp.status === 404) return false
    return false
  } finally {
    t.cancel()
  }
}

async function qdrantCollectionInfo(
  fetchImpl: typeof fetch,
  url: string,
  collection: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ points_count?: number } | null> {
  const t = withTimeout(timeoutMs)
  try {
    const resp = await fetchImpl(`${url}/collections/${encodeURIComponent(collection)}`, {
      method: 'GET',
      headers,
      signal: t.signal,
    })
    if (!resp.ok) return null
    const body = (await resp.json()) as { result?: { points_count?: number } }
    return body.result ?? null
  } finally {
    t.cancel()
  }
}

async function downloadQdrantSnapshot(
  fetchImpl: typeof fetch,
  url: string,
  collection: string,
  snapshot: string,
  headers: Record<string, string>,
  timeoutMs: number,
  logger: LoggerLike,
): Promise<Buffer> {
  const t = withTimeout(timeoutMs)
  try {
    const resp = await fetchImpl(
      `${url}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshot)}`,
      { method: 'GET', headers, signal: t.signal },
    )
    if (!resp.ok) {
      throw new Error(`Snapshot download failed: ${resp.status} ${resp.statusText}`)
    }
    if (!resp.body) {
      throw new Error('Snapshot download returned an empty body')
    }
    logger.debug(`Downloaded Qdrant snapshot ${collection}/${snapshot} (${resp.headers.get('content-length') ?? '?'} bytes)`)
    return await streamToBuffer(resp.body)
  } finally {
    t.cancel()
  }
}

async function streamToBuffer(stream: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!stream) {
    return Buffer.alloc(0)
  }
  const nodeStream = stream as unknown as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> }
  if (typeof nodeStream.getReader === 'function') {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)), total)
  }
  // Node 18 fallback: response.body is a Node stream
  const legacyStream = stream as unknown as NodeJS.ReadableStream
  const chunks: Buffer[] = []
  for await (const chunk of Readable.from(legacyStream as Readable)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * Convenience wrapper: clone local caches + Qdrant collection in one call.
 */
export async function cloneIndexFromSource(options: IndexCloneOptions): Promise<IndexCloneResult> {
  const start = Date.now()
  const logger: LoggerLike = options.deps?.logger ?? console
  const failures: string[] = []

  logger.info(
    `Cloning index from ${options.sourcePath} -> ${options.targetPath}`,
  )

  const local = await cloneLocalCaches(options.sourcePath, options.targetPath, options.deps)
  for (const detail of [local.indexCache, local.summaryCache, local.dependencyCache] as const) {
    if (detail.status === 'failed' && detail.error) {
      failures.push(detail.error)
    }
  }

  const qdrant = await cloneQdrantCollection(
    options.sourcePath,
    options.targetPath,
    options.qdrant,
    options.deps,
  )
  if (qdrant.status === 'failed' && qdrant.error) {
    failures.push(qdrant.error)
  }

  const durationMs = Date.now() - start
  const result: IndexCloneResult = {
    indexCache: local.indexCache,
    summaryCache: local.summaryCache,
    dependencyCache: local.dependencyCache,
    qdrantCollection: qdrant,
    localCachesCloned: local.localCachesCloned,
    qdrantCollectionCloned: qdrant.status === 'copied',
    durationMs,
    failureReasons: failures,
  }

  if (result.localCachesCloned || result.qdrantCollectionCloned) {
    logger.info(
      `Index clone complete in ${durationMs}ms (caches: ${local.indexCache.status}/${local.summaryCache.status}/${local.dependencyCache.status}, qdrant: ${qdrant.status})`,
    )
  } else {
    logger.debug(
      `Index clone completed in ${durationMs}ms with no-op results (caches: ${local.indexCache.status}/${local.summaryCache.status}/${local.dependencyCache.status}, qdrant: ${qdrant.status})`,
    )
  }
  return result
}
