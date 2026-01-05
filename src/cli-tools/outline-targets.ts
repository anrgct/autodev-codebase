import fastGlob from 'fast-glob'
import type { IFileSystem, IPathUtils, IWorkspace } from '../abstractions'
import { isGlobPattern, parsePathFilters } from '../utils/path-filters'

type LoggerLike = {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface ResolveOutlineTargetsOptions {
  input: string
  workspacePath: string
  workspace: IWorkspace
  pathUtils: IPathUtils
  fileSystem: IFileSystem
  skipIgnoreCheckForSingleFile?: boolean
  logger?: LoggerLike
}

export interface ResolveOutlineTargetsResult {
  isGlob: boolean
  /**
   * Absolute file paths, filtered through workspace ignore rules.
   */
  files: string[]
  /**
   * For glob mode only.
   */
  includePatterns?: string[]
  /**
   * For glob mode only (already stripped of `!`).
   */
  excludePatterns?: string[]
}

/**
 * Resolve outline targets from a single file path or glob pattern.
 *
 * Behavior intentionally mirrors the CLI implementation:
 * - Glob detection via `[*?{}[]]` characters
 * - When multiple patterns are provided (comma-separated), `!` patterns are treated as excludes
 * - Two-layer ignore filtering: fast-glob ignore patterns + workspace.shouldIgnore
 */
export async function resolveOutlineTargets(options: ResolveOutlineTargetsOptions): Promise<ResolveOutlineTargetsResult> {
  const trimmedInput = options.input.trim()
  if (!trimmedInput) {
    return { isGlob: false, files: [] }
  }

  const resolveGlob = async (globInput: string): Promise<ResolveOutlineTargetsResult> => {
    const workspaceIgnorePatterns = await options.workspace.getGlobIgnorePatterns()

    const includePatterns: string[] = []
    const excludePatterns: string[] = []

    if (globInput.includes(',')) {
      const parsed = parsePathFilters(globInput)
      for (const p of parsed) {
        if (p.startsWith('!')) excludePatterns.push(p.slice(1))
        else includePatterns.push(p)
      }
    } else {
      includePatterns.push(globInput)
    }

    if (includePatterns.length === 0) {
      options.logger?.warn?.(`No include patterns provided: "${globInput}"`)
      return { isGlob: true, files: [], includePatterns, excludePatterns }
    }

    const allIgnorePatterns = excludePatterns.length > 0
      ? [...workspaceIgnorePatterns, ...excludePatterns]
      : workspaceIgnorePatterns

    const matched = await fastGlob(includePatterns, {
      cwd: options.workspacePath,
      absolute: true,
      onlyFiles: true,
      ignore: allIgnorePatterns
    })

    const filtered: string[] = []
    for (const file of matched) {
      if (!(await options.workspace.shouldIgnore(file))) {
        filtered.push(file)
      }
    }

    return { isGlob: true, files: filtered, includePatterns, excludePatterns }
  }

  if (!isGlobPattern(trimmedInput)) {
    const fullPath = options.pathUtils.isAbsolute(trimmedInput)
      ? trimmedInput
      : options.pathUtils.join(options.workspacePath, trimmedInput)

    try {
      const stats = await options.fileSystem.stat(fullPath)
      if (stats.isDirectory) {
        // Directory input: treat as "dir/*" (one level), keep ignore behavior the same as glob mode.
        const dirGlob = options.pathUtils.join(trimmedInput, '*')
        return await resolveGlob(dirGlob)
      }
    } catch {
      // If stat fails (e.g., path doesn't exist), let downstream handle it (extractOutline will error).
    }

    // Single file: optionally apply ignore check.
    if (!options.skipIgnoreCheckForSingleFile && (await options.workspace.shouldIgnore(fullPath))) {
      return { isGlob: false, files: [] }
    }

    return { isGlob: false, files: [fullPath] }
  }

  return await resolveGlob(trimmedInput)
}
