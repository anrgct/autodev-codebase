import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

type LoggerLike = Pick<Console, 'warn' | 'error' | 'info'>

export interface GitCommandResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type RunGitCommand = (args: string[]) => GitCommandResult

export interface EnsureGitGlobalIgnoreDependencies {
  runGit: RunGitCommand
  fs: Pick<typeof fs, 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'copyFile' | 'unlink' | 'stat'>
  homedir: () => string
  env: NodeJS.ProcessEnv
  logger: LoggerLike
}

export interface EnsureGitGlobalIgnoreResult {
  excludesFilePath?: string
  didUpdate: boolean
  addedPatterns: string[]
  reason?: 'git_not_available' | 'no_patterns_to_add' | 'failed'
}

function defaultRunGit(args: string[]): GitCommandResult {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return {
    ok: (result.status ?? 1) === 0 && !result.error,
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  }
}

function getConfigHome(homedir: string, env: NodeJS.ProcessEnv): string {
  const xdgConfigHome = env['XDG_CONFIG_HOME']
  return xdgConfigHome && xdgConfigHome.trim() ? xdgConfigHome.trim() : path.join(homedir, '.config')
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  deps: Pick<EnsureGitGlobalIgnoreDependencies, 'fs'>,
): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  await deps.fs.writeFile(tempPath, content, 'utf8')

  try {
    await deps.fs.rename(tempPath, filePath)
  } catch {
    // Cross-platform fallback: copy then unlink temp.
    await deps.fs.copyFile(tempPath, filePath)
    await deps.fs.unlink(tempPath)
  }
}

function detectEol(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n')
}

async function fileExists(filePath: string, deps: Pick<EnsureGitGlobalIgnoreDependencies, 'fs'>): Promise<boolean> {
  try {
    await deps.fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function getExcludesFilePath(runGit: RunGitCommand): string | undefined {
  const res = runGit(['config', '--global', '--path', 'core.excludesfile'])
  if (!res.ok) return undefined
  const value = res.stdout.trim()
  return value ? value : undefined
}

function getExcludesFilePathRaw(runGit: RunGitCommand): string | undefined {
  const res = runGit(['config', '--global', '--get', 'core.excludesfile'])
  if (!res.ok) return undefined
  const value = res.stdout.trim()
  return value ? value : undefined
}

function setExcludesFilePath(runGit: RunGitCommand, excludesFilePath: string): GitCommandResult {
  return runGit(['config', '--global', 'core.excludesfile', excludesFilePath])
}

function unsetExcludesFilePath(runGit: RunGitCommand): GitCommandResult {
  return runGit(['config', '--global', '--unset', 'core.excludesfile'])
}

function isGitAvailable(runGit: RunGitCommand): boolean {
  return runGit(['--version']).ok
}

/**
 * Ensure given ignore patterns exist in Git's *global* excludes file.
 *
 * Behavior:
 * - Uses `git config --global --path core.excludesfile` if set.
 * - Otherwise sets it to `${XDG_CONFIG_HOME:-~/.config}/git/ignore`.
 * - Appends patterns idempotently.
 * - Best-effort rollback if we changed core.excludesfile and/or the file content.
 */
export async function ensureGitGlobalIgnorePatterns(
  patterns: string[],
  partialDeps: Partial<EnsureGitGlobalIgnoreDependencies> = {},
): Promise<EnsureGitGlobalIgnoreResult> {
  const deps: EnsureGitGlobalIgnoreDependencies = {
    runGit: partialDeps.runGit ?? defaultRunGit,
    fs: partialDeps.fs ?? fs,
    homedir: partialDeps.homedir ?? os.homedir,
    env: partialDeps.env ?? process.env,
    logger: partialDeps.logger ?? console,
  }

  const cleanedPatterns = patterns.map(p => p.trim()).filter(Boolean)
  if (cleanedPatterns.length === 0) {
    return { didUpdate: false, addedPatterns: [], reason: 'no_patterns_to_add' }
  }

  const gitAvailable = isGitAvailable(deps.runGit)
  const previousExcludesRaw = gitAvailable ? getExcludesFilePathRaw(deps.runGit) : undefined
  let excludesFilePath = gitAvailable ? getExcludesFilePath(deps.runGit) : undefined
  let didSetExcludesFile = false

  try {
    if (!excludesFilePath) {
      const home = deps.homedir()
      const configHome = getConfigHome(home, deps.env)
      const defaultPath = path.join(configHome, 'git', 'ignore')
      if (gitAvailable) {
        const setRes = setExcludesFilePath(deps.runGit, defaultPath)
        if (!setRes.ok) {
          deps.logger.warn(
            `Failed to set git core.excludesfile; falling back to writing default excludes file only: ${setRes.stderr || setRes.stdout}`.trim(),
          )
        } else {
          didSetExcludesFile = true
          excludesFilePath = getExcludesFilePath(deps.runGit) ?? defaultPath
        }
      }
      excludesFilePath ??= defaultPath
    }

    await deps.fs.mkdir(path.dirname(excludesFilePath), { recursive: true })

    const existed = await fileExists(excludesFilePath, deps)
    const previousContent = existed ? await deps.fs.readFile(excludesFilePath, 'utf8') : ''
    const eol = detectEol(previousContent)

    const existingLines = splitLines(previousContent).map(l => l.trim())
    const existingPatternSet = new Set(existingLines.filter(line => line.length > 0 && !line.startsWith('#')))

    const patternsToAdd = cleanedPatterns.filter(p => !existingPatternSet.has(p))
    if (patternsToAdd.length === 0) {
      return { didUpdate: false, addedPatterns: [], excludesFilePath }
    }

    const header = '# Added by @autodev/codebase'
    const hasHeader = previousContent.includes(header)

    let nextContent = previousContent
    if (nextContent.length > 0 && !nextContent.endsWith('\n') && !nextContent.endsWith('\r\n')) {
      nextContent += eol
    }

    if (!hasHeader) {
      if (nextContent.length > 0 && !nextContent.endsWith(eol + eol)) {
        nextContent += eol
      }
      nextContent += header + eol
    }

    nextContent += patternsToAdd.join(eol) + eol

    try {
      await atomicWriteFile(excludesFilePath, nextContent, deps)
      return { didUpdate: true, addedPatterns: patternsToAdd, excludesFilePath }
    } catch (error) {
      try {
        if (existed) {
          await atomicWriteFile(excludesFilePath, previousContent, deps)
        } else {
          await deps.fs.unlink(excludesFilePath)
        }
      } catch (rollbackError) {
        deps.logger.warn(`Rollback of global excludes file failed: ${String(rollbackError)}`)
      }
      throw error
    }
  } catch (error) {
    if (didSetExcludesFile) {
      try {
        if (previousExcludesRaw) {
          setExcludesFilePath(deps.runGit, previousExcludesRaw)
        } else {
          unsetExcludesFilePath(deps.runGit)
        }
      } catch (rollbackError) {
        deps.logger.warn(`Rollback of git core.excludesfile failed: ${String(rollbackError)}`)
      }
    }

    deps.logger.warn(`Failed to update git global excludes file: ${String(error)}`)
    return { didUpdate: false, addedPatterns: [], excludesFilePath, reason: gitAvailable ? 'failed' : 'git_not_available' }
  }
}
