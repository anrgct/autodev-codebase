/**
 * Node.js Workspace Adapter
 * Implements IWorkspace using Node.js file system operations
 */
import * as path from 'path'
import { IWorkspace, WorkspaceFolder, IPathUtils } from '../../abstractions/workspace'
import { IFileSystem } from '../../abstractions/core'
import { IgnoreService } from '../../ignore/IgnoreService'
import { IGNORE_DIRS } from '../../ignore/default-dirs'

export interface NodeWorkspaceOptions {
  rootPath: string
  ignoreFiles?: string[]
}

export class NodeWorkspace implements IWorkspace {
  private ignoreService: IgnoreService
  private pathUtils: IPathUtils

  // Default ignore patterns - using unified configuration from ignore-config
  private static readonly DEFAULT_IGNORES = IGNORE_DIRS

  constructor(
    private fileSystem: IFileSystem,
    options: NodeWorkspaceOptions
  ) {
    this.pathUtils = new NodePathUtils()

    // Create IgnoreService instance
    this.ignoreService = new IgnoreService(fileSystem, this.pathUtils, {
      rootPath: options.rootPath,
      ignoreFiles: options.ignoreFiles || ['.gitignore', '.rooignore', '.codebaseignore'],
    })
  }

  getRootPath(): string | undefined {
    return this.ignoreService['rootPath']
  }

  getRelativePath(fullPath: string): string {
    const rootPath = this.getRootPath()
    if (!rootPath) return fullPath
    return path.relative(rootPath, fullPath)
  }

  getIgnoreRules(): string[] {
    return this.ignoreService.getRules()
  }

  /**
   * Get ignore patterns formatted for fast-glob
   * Converts simple directory names to glob patterns with /** suffix
   */
  async getGlobIgnorePatterns(): Promise<string[]> {
    await this.ignoreService.initialize()

    // Get default ignores
    const allIgnores = [...NodeWorkspace.DEFAULT_IGNORES]

    // Convert to fast-glob format
    return allIgnores.map(pattern => {
      // If pattern contains no path separator and no wildcard, treat as directory
      if (!pattern.includes('/') && !pattern.includes('*')) {
        return `${pattern}/**`
      }
      // If pattern ends with /, add **
      if (pattern.endsWith('/')) {
        return `${pattern}**`
      }
      // Otherwise return as-is (already a glob pattern)
      return pattern
    })
  }

  async shouldIgnore(filePath: string): Promise<boolean> {
    await this.ignoreService.initialize()
    return this.ignoreService.shouldIgnore(filePath)
  }

  /**
   * Get the ignore service instance
   * Provides access to unified ignore functionality for advanced use cases
   */
  getIgnoreService(): IgnoreService {
    return this.ignoreService
  }

  getName(): string {
    const rootPath = this.getRootPath()
    return rootPath ? path.basename(rootPath) || 'workspace' : 'workspace'
  }

  getWorkspaceFolders(): WorkspaceFolder[] {
    const rootPath = this.getRootPath()
    return [{
      name: this.getName(),
      uri: rootPath || '',
      index: 0
    }]
  }

  async findFiles(pattern: string, exclude?: string): Promise<string[]> {
    const files: string[] = []
    const rootPath = this.getRootPath()

    if (!rootPath) {
      return files
    }

    await this.walkDirectory(rootPath, async (filePath) => {
      const relativePath = this.getRelativePath(filePath)

      if (this.matchPattern(relativePath, pattern)) {
        if (!exclude || !this.matchPattern(relativePath, exclude)) {
          if (!(await this.shouldIgnore(filePath))) {
            files.push(filePath)
          }
        }
      }
    })

    return files
  }

  /**
   * Simple glob pattern matching for findFiles method
   * Note: This is NOT used for gitignore semantics (shouldIgnore uses ignore library)
   */
  private matchPattern(filePath: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(filePath) || regex.test(path.basename(filePath))
  }

  private async walkDirectory(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
    try {
      const entries = await this.fileSystem.readdir(dir)

      for (const entry of entries) {
        const fullPath = path.join(dir, entry)
        const stat = await this.fileSystem.stat(fullPath)

        if (stat.isDirectory) {
          await this.walkDirectory(fullPath, callback)
        } else if (stat.isFile) {
          await callback(fullPath)
        }
      }
    } catch (error) {
      // Ignore errors when walking directories
      console.warn(`Failed to walk directory ${dir}:`, error)
    }
  }
}

export class NodePathUtils implements IPathUtils {
  join(...paths: string[]): string {
    return path.join(...paths)
  }

  dirname(filePath: string): string {
    return path.dirname(filePath)
  }

  basename(filePath: string, ext?: string): string {
    return path.basename(filePath, ext)
  }

  extname(filePath: string): string {
    return path.extname(filePath)
  }

  resolve(...paths: string[]): string {
    return path.resolve(...paths)
  }

  isAbsolute(filePath: string): boolean {
    return path.isAbsolute(filePath)
  }

  relative(from: string, to: string): string {
    return path.relative(from, to)
  }

  normalize(filePath: string): string {
    return path.normalize(filePath)
  }
}
