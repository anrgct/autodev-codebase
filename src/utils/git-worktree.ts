/**
 * Git Worktree Utilities
 *
 * Detects git worktree layout and resolves paths between linked worktrees.
 * A git worktree is a separate working directory sharing the same .git
 * database with the main checkout. Multiple worktrees of the same repo
 * share file contents (via git objects) but have different absolute paths.
 *
 * This module is dependency-injected: `runGit` and `fs` are configurable
 * so unit tests can run without a real git binary or filesystem.
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface GitCommandResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type RunGitCommand = (args: string[], cwd?: string) => GitCommandResult

export interface WorktreeInfo {
  /** Absolute path to the worktree's working directory. */
  path: string
  /** HEAD commit SHA of the worktree. */
  commit: string
  /** Branch name (undefined when in detached HEAD). */
  branch?: string
  /** True for the primary worktree (the one registered with `git init` / `git worktree add` first). */
  isMain: boolean
}

export interface GitWorktreeDependencies {
  runGit: RunGitCommand
  fs: {
    stat: (p: string) => Promise<{ isDirectory(): boolean } | null>
    realpath: (p: string) => Promise<string>
  }
}

const DEFAULT_GIT_TIMEOUT_MS = 15_000

function defaultRunGit(args: string[], cwd?: string): GitCommandResult {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    cwd,
    timeout: DEFAULT_GIT_TIMEOUT_MS,
  })
  return {
    ok: (result.status ?? 1) === 0 && !result.error,
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  }
}

function defaultRealpath(p: string): Promise<string> {
  return fs.realpath(p)
}

async function defaultStat(p: string): Promise<{ isDirectory(): boolean } | null> {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

async function resolveDeps(
  deps?: Partial<GitWorktreeDependencies>,
): Promise<GitWorktreeDependencies> {
  const provided = deps?.fs
  return {
    runGit: deps?.runGit ?? defaultRunGit,
    fs: {
      stat: provided?.stat ?? (defaultStat as GitWorktreeDependencies['fs']['stat']),
      realpath: provided?.realpath ?? (defaultRealpath as GitWorktreeDependencies['fs']['realpath']),
    },
  }
}

async function resolveAbsolutePath(
  rawPath: string,
  deps: GitWorktreeDependencies,
): Promise<string> {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    throw new Error('git returned an empty path')
  }
  // `git rev-parse --path-format=absolute` already returns an absolute path.
  // We still realpath to normalize symlinks.
  return deps.fs.realpath(trimmed)
}

/**
 * Return the path to the shared git directory (the .git dir of the
 * main worktree), or null if `workspacePath` is not inside a git working tree.
 *
 * Uses `git rev-parse --path-format=absolute --git-common-dir`. In a regular
 * (non-worktree) checkout this returns `<workspace>/.git`. In a worktree it
 * returns the main worktree's `.git` (e.g. `/path/to/main/.git`), which is
 * the canonical identifier for the repository.
 */
export async function getGitCommonDir(
  workspacePath: string,
  deps?: Partial<GitWorktreeDependencies>,
): Promise<string | null> {
  const resolved = await resolveDeps(deps)
  const res = resolved.runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    workspacePath,
  )
  if (!res.ok) {
    return null
  }
  const out = res.stdout.split('\n')[0]?.trim() ?? ''
  if (!out) return null
  try {
    return await resolveAbsolutePath(out, resolved)
  } catch {
    return null
  }
}

/**
 * Return the main worktree's working directory (the parent directory of
 * the shared .git dir), or null when not in a git worktree.
 *
 * For a single-worktree repository, this returns the original workspace.
 *
 * @param knownMainPath  Optional pre-computed main worktree path. Pass this
 *                       to avoid an infinite recursion when the main worktree
 *                       directory was deleted on disk (the fallback path
 *                       needs to call `getAllWorktrees`, which itself needs
 *                       the main worktree path to mark the main entry).
 */
export async function getMainWorktreePath(
  workspacePath: string,
  deps?: Partial<GitWorktreeDependencies>,
  knownMainPath?: string | null,
): Promise<string | null> {
  const resolved = await resolveDeps(deps)
  const commonDir = await getGitCommonDir(workspacePath, resolved)
  if (!commonDir) {
    return null
  }
  // Main worktree path = parent directory of the .git directory.
  const mainWorktree = path.dirname(commonDir)
  // Sanity check: the directory should exist. If it doesn't (e.g. repo was
  // moved without fixing gitdir), fall through to listing worktrees.
  const stat = await resolved.fs.stat(mainWorktree)
  if (stat && stat.isDirectory()) {
    return mainWorktree
  }
  // Fallback: ask git for the canonical first worktree entry. Pass the
  // already-known mainWorktree candidate (typically missing on disk) so
  // getAllWorktrees can short-circuit and avoid infinite recursion.
  const all = await getAllWorktrees(workspacePath, {
    ...resolved,
    __skipMainLookup: true,
  } as GitWorktreeDependencies)
  return all[0]?.path ?? knownMainPath ?? mainWorktree
}

/**
 * Return true if `workspacePath` is inside a git worktree (i.e. not the main one).
 *
 * Implementation: compare `git rev-parse --show-toplevel` (the actual
 * worktree containing `workspacePath`) with `git rev-parse --git-common-dir`'s
 * parent (the main worktree). If they differ, this is a linked worktree.
 */
export async function isGitWorktree(
  workspacePath: string,
  deps?: Partial<GitWorktreeDependencies>,
): Promise<boolean> {
  const resolved = await resolveDeps(deps)
  const toplevel = resolved.runGit(
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    workspacePath,
  )
  if (!toplevel.ok) {
    return false
  }
  const main = await getMainWorktreePath(workspacePath, resolved)
  if (!main) {
    return false
  }
  try {
    const a = await resolveAbsolutePath(toplevel.stdout.split('\n')[0] ?? '', resolved)
    return a !== main
  } catch {
    return false
  }
}

/**
 * Parse the output of `git worktree list --porcelain`.
 *
 * Example output:
 * ```
 * worktree /Users/x/repo
 * HEAD abcdef0123456789
 * branch refs/heads/main
 *
 * worktree /Users/x/repo-feature
 * HEAD abcdef0123456789
 * branch refs/heads/feature
 *
 * worktree /Users/x/repo-detached
 * HEAD abcdef0123456789
 * detached
 * ```
 */
function parsePorcelain(stdout: string): Array<{ path: string; commit: string; branch?: string; detached: boolean }> {
  const blocks = stdout
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
  const out: Array<{ path: string; commit: string; branch?: string; detached: boolean }> = []
  for (const block of blocks) {
    const lines = block.split('\n')
    let path: string | undefined
    let commit: string | undefined
    let branch: string | undefined
    let detached = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        commit = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim()
      } else if (line === 'detached') {
        detached = true
      }
    }
    if (path && commit) {
      out.push({ path, commit, branch, detached })
    }
  }
  return out
}

/**
 * List all worktrees of the repository that contains `workspacePath`.
 * Returns an empty array if `workspacePath` is not inside a git repository
 * or if `git worktree list` fails.
 *
 * @internal The `__skipMainLookup` flag breaks the recursion between
 *           getMainWorktreePath and getAllWorktrees in the rare case the
 *           main worktree directory was deleted on disk.
 */
export async function getAllWorktrees(
  workspacePath: string,
  deps?: Partial<GitWorktreeDependencies> & { __skipMainLookup?: boolean },
): Promise<WorktreeInfo[]> {
  const skipMainLookup = (deps as any)?.__skipMainLookup === true
  const resolved = await resolveDeps(deps)
  const res = resolved.runGit(['worktree', 'list', '--porcelain'], workspacePath)
  if (!res.ok) {
    return []
  }
  const parsed = parsePorcelain(res.stdout)
  const mainPath = skipMainLookup
    ? null
    : await getMainWorktreePath(workspacePath, resolved)
  const result: WorktreeInfo[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    let absolute: string
    try {
      absolute = await resolveAbsolutePath(entry.path, resolved)
    } catch {
      continue
    }
    const info: WorktreeInfo = {
      path: absolute,
      commit: entry.commit,
      isMain: mainPath ? absolute === mainPath : i === 0,
    }
    if (!entry.detached && entry.branch) {
      // Strip "refs/heads/" prefix for readability
      info.branch = entry.branch.replace(/^refs\/heads\//, '')
    }
    result.push(info)
  }
  return result
}
