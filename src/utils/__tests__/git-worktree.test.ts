import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'

import {
  getGitCommonDir,
  getMainWorktreePath,
  isGitWorktree,
  getAllWorktrees,
  type RunGitCommand,
  type GitCommandResult,
  type GitWorktreeDependencies,
} from '../git-worktree'

function ok(stdout = '', stderr = ''): GitCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr }
}

function fail(exitCode = 1, stdout = '', stderr = ''): GitCommandResult {
  return { ok: false, exitCode, stdout, stderr }
}

interface MockFs {
  stat: (p: string) => Promise<{ isDirectory(): boolean } | null>
  realpath: (p: string) => Promise<string>
}

function createFsMock(overrides: Partial<MockFs> = {}): MockFs {
  return {
    stat: vi.fn(async (p: string) => ({ isDirectory: () => true })) as any,
    realpath: vi.fn(async (p: string) => p) as any,
    ...overrides,
  }
}

/**
 * Build a RunGit mock that returns pre-canned responses per arg signature.
 * Matching is by exact args array (cwd is passed as a separate arg here for
 * simplicity, but we ignore it because real git's output is cwd-independent).
 */
function createGitMock(handlers: Record<string, GitCommandResult>): RunGitCommand {
  const calls: Array<{ args: string[]; cwd?: string }> = []
  const run: RunGitCommand = (args, cwd) => {
    calls.push({ args, cwd })
    const key = args.join(' ')
    if (handlers[key]) return handlers[key]
    return fail(128, '', `unhandled git args: ${key}`)
  }
  ;(run as any).calls = calls
  return run
}

const MAIN = '/Users/x/repo'
const MAIN_GIT = `${MAIN}/.git`
const FEATURE = '/Users/x/repo-feature'
const FEATURE_GIT = `${FEATURE}/.git`

const deps = (runGit: RunGitCommand, fsOverrides: Partial<MockFs> = {}): Partial<GitWorktreeDependencies> => ({
  runGit,
  fs: createFsMock(fsOverrides) as any,
})

describe('getGitCommonDir', () => {
  it('returns the .git directory of the main worktree', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    const result = await getGitCommonDir('/anywhere', deps(runGit))
    expect(result).toBe(MAIN_GIT)
  })

  it('returns null when not in a git repository', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': fail(128, '', 'not a git repository'),
    })
    const result = await getGitCommonDir('/tmp/whatever', deps(runGit))
    expect(result).toBeNull()
  })

  it('returns null on empty output', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok('   \n'),
    })
    const result = await getGitCommonDir('/anywhere', deps(runGit))
    expect(result).toBeNull()
  })

  it('passes workspacePath as cwd to git', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    await getGitCommonDir('/Users/x/feature', deps(runGit))
    const calls = (runGit as any).calls as Array<{ args: string[]; cwd?: string }>
    expect(calls[0].cwd).toBe('/Users/x/feature')
  })
})

describe('getMainWorktreePath', () => {
  it('returns the parent of the shared .git directory', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    const result = await getMainWorktreePath(FEATURE, deps(runGit))
    expect(result).toBe(MAIN)
  })

  it('returns null when not in a git repository', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': fail(128),
    })
    const result = await getMainWorktreePath('/tmp/whatever', deps(runGit))
    expect(result).toBeNull()
  })

  it('falls back to first porcelain entry when main worktree dir was deleted', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
      'worktree list --porcelain': ok(
        [
          `worktree ${MAIN}`,
          `HEAD 0123456789abcdef0123456789abcdef01234567`,
          `branch refs/heads/master`,
          ``,
          `worktree ${FEATURE}`,
          `HEAD 0123456789abcdef0123456789abcdef01234567`,
          `branch refs/heads/feature`,
          ``,
        ].join('\n'),
      ),
    })
    const result = await getMainWorktreePath(FEATURE, {
      runGit,
      fs: createFsMock({
        stat: vi.fn(async (p: string) => (p === MAIN ? null : { isDirectory: () => true })) as any,
      }) as any,
    })
    expect(result).toBe(MAIN)
  })
})

describe('isGitWorktree', () => {
  it('returns true when toplevel differs from the main worktree', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --show-toplevel': ok(`${FEATURE}\n`),
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    const result = await isGitWorktree(FEATURE, deps(runGit))
    expect(result).toBe(true)
  })

  it('returns false when toplevel matches the main worktree', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --show-toplevel': ok(`${MAIN}\n`),
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    const result = await isGitWorktree(MAIN, deps(runGit))
    expect(result).toBe(false)
  })

  it('returns false when toplevel command fails', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --show-toplevel': fail(128),
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
    })
    const result = await isGitWorktree('/anywhere', deps(runGit))
    expect(result).toBe(false)
  })
})

describe('getAllWorktrees', () => {
  it('parses a porcelain list with two worktrees and a detached HEAD', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
      'worktree list --porcelain': ok(
        [
          `worktree ${MAIN}`,
          `HEAD 0a24bd966ac4a29f902a38a01302633c65283b7b`,
          `branch refs/heads/master`,
          ``,
          `worktree ${FEATURE}`,
          `HEAD 0a24bd966ac4a29f902a38a01302633c65283b7b`,
          `detached`,
          ``,
        ].join('\n'),
      ),
    })
    const result = await getAllWorktrees(FEATURE, deps(runGit))
    expect(result).toEqual([
      { path: MAIN, commit: '0a24bd966ac4a29f902a38a01302633c65283b7b', branch: 'master', isMain: true },
      { path: FEATURE, commit: '0a24bd966ac4a29f902a38a01302633c65283b7b', isMain: false },
    ])
  })

  it('returns empty array when git worktree list fails', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
      'worktree list --porcelain': fail(128),
    })
    const result = await getAllWorktrees(FEATURE, deps(runGit))
    expect(result).toEqual([])
  })

  it('marks the first porcelain entry as main when common dir is unavailable', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': fail(128),
      'worktree list --porcelain': ok(
        [
          `worktree ${MAIN}`,
          `HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
          `branch refs/heads/main`,
          ``,
        ].join('\n'),
      ),
    })
    const result = await getAllWorktrees(MAIN, deps(runGit))
    expect(result).toEqual([
      { path: MAIN, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', branch: 'main', isMain: true },
    ])
  })

  it('skips entries whose path cannot be realpath-resolved', async () => {
    const runGit = createGitMock({
      'rev-parse --path-format=absolute --git-common-dir': ok(`${MAIN_GIT}\n`),
      'worktree list --porcelain': ok(
        [
          `worktree ${MAIN}`,
          `HEAD 0a24bd966ac4a29f902a38a01302633c65283b7b`,
          `branch refs/heads/master`,
          ``,
          `worktree ${FEATURE}`,
          `HEAD 0a24bd966ac4a29f902a38a01302633c65283b7b`,
          `branch refs/heads/feature`,
          ``,
        ].join('\n'),
      ),
    })
    const result = await getAllWorktrees(MAIN, {
      runGit,
      fs: createFsMock({
        realpath: vi.fn(async (p: string) => {
          if (p === FEATURE) throw new Error('EACCES')
          return p
        }) as any,
      }) as any,
    })
    expect(result).toEqual([
      { path: MAIN, commit: '0a24bd966ac4a29f902a38a01302633c65283b7b', branch: 'master', isMain: true },
    ])
  })
})
