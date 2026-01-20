/**
 * Unified Ignore Service
 * Provides standard gitignore semantics for file filtering across all modules
 */

import ignore from 'ignore'
import { IFileSystem } from '../abstractions/core'
import { IPathUtils } from '../abstractions/workspace'
import { IGNORE_DIRS } from './default-dirs'

export interface IgnoreServiceOptions {
  rootPath: string
  ignoreFiles?: string[]        // ['.gitignore', '.rooignore', '.codebaseignore']
  additionalRules?: string[]    // Additional rules
}

/**
 * Unified Ignore service
 * Provides standard gitignore semantics for file filtering
 */
export class IgnoreService {
  private ig: ReturnType<typeof ignore>
  private rootPath: string
  private loaded = false

  constructor(
    private fileSystem: IFileSystem,
    private pathUtils: IPathUtils,
    private options: IgnoreServiceOptions
  ) {
    this.rootPath = options.rootPath
    this.ig = ignore()
  }

  /**
   * Initialize the service (load all ignore rules)
   * Must be called once before using any other methods
   */
  async initialize(): Promise<void> {
    if (this.loaded) return

    // 1. Add default directory rules
    // Note: IGNORE_DIRS is a list of directory names (like 'node_modules')
    // We convert to directory-specific patterns to avoid matching files with the same name
    // Direct add('env') would ignore files named 'env', so we use 'env/' to match only directories
    this.ig.add(IGNORE_DIRS.map(dir => `${dir}/`))

    // 2. Load .gitignore / .rooignore / .codebaseignore files
    const ignoreFiles = this.options.ignoreFiles || ['.gitignore', '.rooignore', '.codebaseignore']
    for (const file of ignoreFiles) {
      await this.loadIgnoreFile(file)
    }

    // 3. Add additional rules
    if (this.options.additionalRules) {
      this.ig.add(this.options.additionalRules)
    }

    this.loaded = true
  }

  private async loadIgnoreFile(filename: string): Promise<void> {
    const filePath = this.pathUtils.join(this.rootPath, filename)
    if (await this.fileSystem.exists(filePath)) {
      const content = await this.fileSystem.readFile(filePath)
      const text = new TextDecoder().decode(content)
      const rules = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      this.ig.add(rules)
    }
  }

  /**
   * Core method 1: Check if a directory should be completely skipped
   * Used for early pruning during directory traversal (avoid entering large directories)
   *
   * @param dirPath Directory path (absolute or relative)
   * @returns true if the entire directory should be skipped (don't recurse into it)
   *
   * @example
   * if (ignoreService.shouldSkipDirectory('/path/to/node_modules')) {
   *   continue  // Don't recurse, skip all 5000 files
   * }
   */
  shouldSkipDirectory(dirPath: string): boolean {
    const basename = this.pathUtils.basename(dirPath)

    // Fast path: check common large directories (avoid calling ignore library)
    // This is a performance optimization to skip the most common cases
    if (IGNORE_DIRS.includes(basename as any)) {
      return true  // Skip node_modules, .git, etc.
    }

    // Full check: gitignore rules
    const relativePath = this.toRelative(dirPath)
    if (!relativePath || relativePath === '.') {
      return false  // Don't skip root directory
    }

    // Normalize path (ignore library requires forward slashes)
    // Note: IPathUtils doesn't have a sep field, use regex for Windows/Unix compatibility
    const normalizedPath = relativePath.replace(/\\/g, '/')

    // Check both the directory itself and directory pattern (trailing slash)
    return this.ig.ignores(normalizedPath) ||
           this.ig.ignores(normalizedPath + '/')
  }

  /**
   * Core method 2: Check if a file should be ignored
   * Used for precise file-level filtering
   *
   * @param filePath File path (absolute or relative)
   * @returns true if this file should be ignored
   */
  shouldIgnore(filePath: string): boolean {
    const relativePath = this.toRelative(filePath)

    // Empty path = root directory, don't ignore
    if (!relativePath || relativePath === '.') {
      return false
    }

    // Normalize path separators (ignore library requires forward slashes)
    const normalizedPath = relativePath.replace(/\\/g, '/')

    return this.ig.ignores(normalizedPath)
  }

  /**
   * Batch filter files (performance optimization)
   * Useful when you have an existing file list
   */
  filterFiles(files: string[]): string[] {
    return files.filter(f => !this.shouldIgnore(f))
  }

  /**
   * Batch filter directories (performance optimization)
   */
  filterDirectories(dirs: string[]): string[] {
    return dirs.filter(d => !this.shouldSkipDirectory(d))
  }

  /**
   * Convert to relative path (private helper method)
   */
  private toRelative(path: string): string {
    let result: string
    if (this.pathUtils.isAbsolute(path)) {
      result = this.pathUtils.relative(this.rootPath, path)
    } else {
      result = path
    }

    // Normalize the path: remove leading ./ and resolve duplicate slashes
    // This handles edge cases like "./src" and "/path//to/file"
    result = this.pathUtils.normalize(result)

    // Remove leading ./ if present (ignore library doesn't like it)
    if (result.startsWith('./')) {
      result = result.slice(2)
    }

    // Handle empty result (when path equals rootPath)
    if (result === '') {
      return '.'
    }

    return result
  }

  /**
   * Get all loaded rules (for debugging)
   */
  getRules(): string[] {
    // ignore library doesn't provide direct access to rules
    // Return what we know about
    return [...IGNORE_DIRS, ...this.options.additionalRules || []]
  }

  /**
   * Check if the service has been initialized
   */
  isInitialized(): boolean {
    return this.loaded
  }
}
