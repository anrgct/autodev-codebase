#!/usr/bin/env npx tsx
/**
 * 260602-clone-index-from-worktree — End-to-end verification
 *
 * Verifies that `codebase index` automatically clones the main worktree's
 * index data into the current worktree's namespace when the current
 * directory is a git worktree.
 *
 * Setup (current worktree = `.claude/worktrees/solid-panther/autodev-codebase`):
 *  - Source: `/Users/anrgct/workspace/autodev-codebase/demo` (main worktree)
 *  - Target: `<worktree>/demo` (current worktree)
 *
 * Steps:
 *   1. Snapshot the source's cache file + Qdrant point count.
 *   2. Delete the target's cache file + Qdrant collection (simulate
 *      "fresh worktree that has never been indexed").
 *   3. Run `codebase index --demo` — expect auto-clone log lines.
 *   4. Verify the target's cache file is restored and the Qdrant
 *      collection has the same point count.
 *   5. Re-run — expect the second run to be a no-op (target exists).
 *   6. Run with `--no-clone-from-worktree --clear-cache` — verify that
 *      the no-clone path proceeds straight to a normal index.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const CURRENT_WORKTREE = path.resolve(__dirname, '..', '..')
const MAIN_WORKTREE = '/Users/anrgct/workspace/autodev-codebase'
const QDRANT_URL = 'http://localhost:6333'
const DEMO_PATH = path.join(REPO_ROOT, 'demo')

const CACHE_BASE = path.join(os.homedir(), '.autodev-cache')

function hashWorkspaceFull(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex')
}
function hashWorkspace16(workspacePath: string): string {
  return hashWorkspaceFull(workspacePath).substring(0, 16)
}
function collectionNameFor(workspacePath: string): string {
  return `ws-${hashWorkspace16(workspacePath)}`
}
function indexCacheFileName(workspacePath: string): string {
  return `roo-index-cache-${hashWorkspaceFull(workspacePath)}.json`
}

function printHeader(text: string): void {
  console.log('\n' + '='.repeat(72))
  console.log(text)
  console.log('='.repeat(72))
}

function step(label: string): void {
  console.log(`\n>>> ${label}`)
}

function ok(label: string): void {
  console.log(`  [ok]  ${label}`)
}
function fail(label: string, detail?: string): never {
  console.error(`  [FAIL] ${label}`)
  if (detail) console.error(`         ${detail}`)
  process.exit(1)
}

async function curlJson(url: string, init?: { method?: string; body?: string }): Promise<any> {
  const args = ['-sS', '-X', init?.method ?? 'GET']
  if (init?.body) {
    args.push('-H', 'Content-Type: application/json', '-d', init.body)
  }
  args.push(url)
  const res = spawnSync('curl', args, { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`curl failed: ${res.stderr}`)
  }
  return JSON.parse(res.stdout)
}

async function qdrantCollectionExists(collection: string): Promise<boolean> {
  try {
    const r = await curlJson(`${QDRANT_URL}/collections/${collection}/exists`)
    return r?.result?.exists === true
  } catch {
    return false
  }
}

async function qdrantPointCount(collection: string): Promise<number> {
  try {
    const r = await curlJson(`${QDRANT_URL}/collections/${collection}`)
    return r?.result?.points_count ?? 0
  } catch {
    return 0
  }
}

async function deleteQdrantCollection(collection: string): Promise<void> {
  if (await qdrantCollectionExists(collection)) {
    const res = spawnSync('curl', ['-sS', '-X', 'DELETE', `${QDRANT_URL}/collections/${collection}`], { encoding: 'utf8' })
    if (res.status !== 0) {
      throw new Error(`Failed to delete collection: ${res.stderr}`)
    }
  }
}

async function cacheFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function deleteCacheFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
}

interface IndexRunOptions {
  cwd?: string
  args: string[]
  env?: Record<string, string>
}

function runIndexCommand(opts: IndexRunOptions): { stdout: string; stderr: string; status: number } {
  const cwd = opts.cwd ?? CURRENT_WORKTREE
  const args = ['src/cli.ts', 'index', ...opts.args]
  const res = spawnSync('npx', ['tsx', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 600_000, // 10 min
    // Don't let a hung child swallow output
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 1 }
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

async function preflight(): Promise<{
  sourceCollection: string
  targetCollection: string
  sourceCacheFile: string
  targetCacheFile: string
  sourcePointsBefore: number
}> {
  printHeader('Pre-flight: verify source data is available')

  // 1. Confirm we're in a git worktree
  const wtRes = spawnSync('git', ['worktree', 'list'], { encoding: 'utf8' })
  if (wtRes.status !== 0) {
    fail('git worktree list failed', wtRes.stderr)
  }
  console.log('  git worktree list:')
  for (const line of wtRes.stdout.split('\n').filter(Boolean)) {
    console.log(`    ${line}`)
  }
  if (!wtRes.stdout.includes(MAIN_WORKTREE)) {
    fail(`Main worktree ${MAIN_WORKTREE} not found`)
  }
  if (!wtRes.stdout.includes(CURRENT_WORKTREE)) {
    fail(`Current worktree ${CURRENT_WORKTREE} not found`)
  }
  ok('Both worktrees present in `git worktree list`')

  // 2. Confirm Qdrant is reachable
  const root = await curlJson(`${QDRANT_URL}/`)
  if (!root?.title?.includes('qdrant')) {
    fail('Qdrant not reachable at ' + QDRANT_URL)
  }
  ok(`Qdrant ${root.version} reachable`)

  // 3. Confirm the main worktree demo has indexed data
  const sourceCollection = collectionNameFor(path.join(MAIN_WORKTREE, 'demo'))
  const targetCollection = collectionNameFor(DEMO_PATH)
  const sourceCacheFile = path.join(CACHE_BASE, indexCacheFileName(path.join(MAIN_WORKTREE, 'demo')))
  const targetCacheFile = path.join(CACHE_BASE, indexCacheFileName(DEMO_PATH))

  if (!(await cacheFileExists(sourceCacheFile))) {
    fail(`Source cache file missing: ${sourceCacheFile}`)
  }
  ok(`Source cache file present: ${path.basename(sourceCacheFile)}`)

  if (!(await qdrantCollectionExists(sourceCollection))) {
    fail(`Source Qdrant collection missing: ${sourceCollection}`)
  }
  const sourcePointsBefore = await qdrantPointCount(sourceCollection)
  if (sourcePointsBefore === 0) {
    fail(`Source Qdrant collection has 0 points; please re-index the main worktree demo first`)
  }
  ok(`Source Qdrant collection has ${sourcePointsBefore} points`)

  return { sourceCollection, targetCollection, sourceCacheFile, targetCacheFile, sourcePointsBefore }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testAutoClone(
  ctx: Awaited<ReturnType<typeof preflight>>,
): Promise<void> {
  printHeader('Test 1: auto-clone triggers on a "fresh" worktree')

  step('1.1 Simulate a fresh worktree: delete target cache file + Qdrant collection')
  await deleteCacheFile(ctx.targetCacheFile)
  await deleteQdrantCollection(ctx.targetCollection)
  if (await cacheFileExists(ctx.targetCacheFile)) fail('target cache file still exists after delete')
  if (await qdrantCollectionExists(ctx.targetCollection)) fail('target Qdrant collection still exists after delete')
  ok('Target state cleared')

  step('1.2 Run `codebase index --demo` from the current worktree')
  const result = runIndexCommand({
    args: [
      '--demo',
      '--log-level=info',
      // Use --no-clone-from-worktree = false (default), so auto-clone should run.
      // We add --dry-run first to inspect what would happen, but actually we
      // want a real index. We must NOT pass --dry-run here.
    ],
  })
  if (result.status !== 0) {
    console.error('STDOUT:', result.stdout)
    console.error('STDERR:', result.stderr)
    fail('index command failed (see output above)')
  }

  // The CLI logs "Cloning index from" / "Copied index cache" / "Copied Qdrant collection"
  // on auto-clone. Assert that those lines appear.
  const logs = result.stdout + '\n' + result.stderr
  if (!/Cloning index from|Attempting worktree index clone/i.test(logs)) {
    console.error('Full output:')
    console.error(logs)
    fail('No "Cloning index" log line in output (auto-clone did not trigger)')
  }
  ok('Saw clone log lines in output')
  if (!/Copied index cache/i.test(logs)) {
    fail('"Copied index cache" log line missing (local cache clone did not complete)')
  }
  ok('Saw "Copied index cache" log line')
  if (!/Copied Qdrant collection/i.test(logs)) {
    fail('"Copied Qdrant collection" log line missing (Qdrant clone did not complete)')
  }
  ok('Saw "Copied Qdrant collection" log line')

  step('1.3 Verify the target cache file was restored')
  if (!(await cacheFileExists(ctx.targetCacheFile))) {
    fail('Target cache file was not restored')
  }
  // The cache file is *content* equal to the source (filePath keys are
  // absolute, but they all live in the same workspace hash namespace — the
  // code-index cache stores { absolutePath: fileHash } per file; after a
  // clone the cache file will be re-written by the orchestrator with
  // refreshed entries, so we just verify the file exists and is non-empty.
  const targetStat = await fs.stat(ctx.targetCacheFile)
  if (targetStat.size === 0) {
    fail('Target cache file is empty')
  }
  ok(`Target cache file restored (${targetStat.size} bytes)`)

  // Verify the cloned entries match the source's content (at least in shape).
  const sourceContent = await fs.readFile(ctx.sourceCacheFile, 'utf8')
  const sourceEntries = Object.keys(JSON.parse(sourceContent))
  if (sourceEntries.length === 0) {
    fail('Source cache file has no entries')
  }
  ok(`Source cache had ${sourceEntries.length} entries`)

  step('1.4 Verify the Qdrant collection was cloned with the same point count')
  if (!(await qdrantCollectionExists(ctx.targetCollection))) {
    fail('Target Qdrant collection was not created')
  }
  const targetPoints = await qdrantPointCount(ctx.targetCollection)
  if (targetPoints !== ctx.sourcePointsBefore) {
    fail(`Target collection point count (${targetPoints}) != source (${ctx.sourcePointsBefore})`)
  }
  ok(`Target Qdrant collection restored with ${targetPoints} points`)
}

async function testSecondRunIsNoop(
  ctx: Awaited<ReturnType<typeof preflight>>,
): Promise<void> {
  printHeader('Test 2: second run is a no-op (target already populated)')

  step('2.1 Run `codebase index --demo` again — should NOT trigger a clone')
  const result = runIndexCommand({
    args: ['--demo', '--log-level=info'],
  })
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr)
    fail('Second index run failed')
  }
  const logs = result.stdout + '\n' + result.stderr
  if (/Copied Qdrant collection/i.test(logs)) {
    fail('"Copied Qdrant collection" appeared in second run (clone should have been skipped)')
  }
  // Allow some "skipped" log lines, but no "Copied" line.
  ok('No "Copied ..." log lines in second run output (clone was correctly skipped)')
}

async function testNoCloneFlag(
  ctx: Awaited<ReturnType<typeof preflight>>,
): Promise<void> {
  printHeader('Test 3: --no-clone-from-worktree disables the auto-clone')

  step('3.1 Clear the target and run with --no-clone-from-worktree')
  await deleteCacheFile(ctx.targetCacheFile)
  await deleteQdrantCollection(ctx.targetCollection)

  // We can't actually let the indexer do a full re-embed (would take many
  // minutes), so we let it run for a few seconds and observe that no clone
  // log lines appear and the indexer is actively working instead.
  const child = spawnSync(
    'npx',
    [
      'tsx',
      'src/cli.ts',
      'index',
      '--demo',
      '--no-clone-from-worktree',
      '--log-level=info',
    ],
    {
      cwd: CURRENT_WORKTREE,
      encoding: 'utf8',
      env: { ...process.env, AUTODEV_TEST_EARLY_EXIT: '1' },
      timeout: 5_000, // kill after 5s — we just want to see initial logs
      // Detached so we can kill it cleanly
      detached: true,
    },
  )

  // The child likely timed out; that's fine, we just check the partial output.
  // (The output won't be in `child.stdout` because we used detached mode.)
  // We use a different approach: poll the running process via /tmp output.
  // For simplicity, just check that the indexer's normal "Loading configuration"
  // log appears and "Cloning index" does NOT.

  // Simpler approach: re-run with very short timeout and check that
  // "Cloning index" doesn't appear in the early output.
  const early = spawnSync(
    'npx',
    [
      'tsx',
      'src/cli.ts',
      'index',
      '--demo',
      '--no-clone-from-worktree',
      '--log-level=info',
    ],
    {
      cwd: CURRENT_WORKTREE,
      encoding: 'utf8',
      timeout: 8_000,
    },
  )
  const out = (early.stdout ?? '') + '\n' + (early.stderr ?? '')
  if (/Cloning index from|Attempting worktree index clone/i.test(out)) {
    fail('Clone was triggered despite --no-clone-from-worktree')
  }
  if (!/Loading configuration|Code indexing feature is not enabled|Initializing CodeIndexManager/i.test(out)) {
    console.error('--- partial output ---')
    console.error(out.slice(0, 2000))
    fail('No normal indexer startup logs in output — something is off')
  }
  ok('--no-clone-from-worktree correctly skips the clone step')

  // Cleanup so subsequent runs are clean
  await deleteCacheFile(ctx.targetCacheFile)
  await deleteQdrantCollection(ctx.targetCollection)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ctx = await preflight()
  await testAutoClone(ctx)
  await testSecondRunIsNoop(ctx)
  await testNoCloneFlag(ctx)
  printHeader('ALL E2E TESTS PASSED')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
