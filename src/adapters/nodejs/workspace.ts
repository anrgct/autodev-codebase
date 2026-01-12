/**
 * Node.js Workspace Adapter
 * Implements IWorkspace using Node.js file system operations
 */
import * as path from 'path'
import { promises as fs } from 'fs'
import ignore from 'ignore'
import { IWorkspace, WorkspaceFolder, IPathUtils } from '../../abstractions/workspace'
import { IFileSystem } from '../../abstractions/core'

export interface NodeWorkspaceOptions {
  rootPath: string
  ignoreFiles?: string[]
}

export class NodeWorkspace implements IWorkspace {
  private rootPath: string
  private ignoreFiles: string[]
  private ignoreRules: string[] = []
  private ignoreRulesLoaded = false
  private ignoreInstance: ReturnType<typeof ignore>

  // Default ignore patterns (common across all projects)
  private static readonly DEFAULT_IGNORES = [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'coverage',
    '*.log',
    '.env',
    '.env.local',
    '.DS_Store',
    'Thumbs.db'
  ]

  constructor(private fileSystem: IFileSystem, options: NodeWorkspaceOptions) {
    this.rootPath = options.rootPath
    this.ignoreFiles = options.ignoreFiles || ['.gitignore', '.rooignore', '.codebaseignore']
    this.ignoreInstance = ignore()
  }

  getRootPath(): string | undefined {
    return this.rootPath
  }

  getRelativePath(fullPath: string): string {
    if (!this.rootPath) return fullPath
    return path.relative(this.rootPath, fullPath)
  }

  getIgnoreRules(): string[] {
    // Ensure rules are loaded before returning
    if (!this.ignoreRulesLoaded) {
      // Note: This is a sync method, but loadIgnoreRules is async
      // In practice, rules should be loaded by shouldIgnore() before this is called
      // We'll return the current rules (may be empty if not loaded yet)
      console.warn('getIgnoreRules() called before loadIgnoreRules() - rules may be empty')
    }
    return this.ignoreRules
  }

  /**
   * Get ignore patterns formatted for fast-glob
   * Converts simple directory names to glob patterns with /** suffix
   */
  async getGlobIgnorePatterns(): Promise<string[]> {
    await this.loadIgnoreRules()

    const allIgnores = [...NodeWorkspace.DEFAULT_IGNORES, ...this.ignoreRules]

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
    await this.loadIgnoreRules()

    const relativePath = this.getRelativePath(filePath)

    // Handle empty relative path (when filePath equals rootPath)
    if (relativePath === '') {
      return false // Root directory itself is not ignored
    }

    // Use ignore instance for proper gitignore semantics
    this.ignoreInstance = ignore().add(NodeWorkspace.DEFAULT_IGNORES).add(this.ignoreRules)

    // ignore expects paths to use forward slashes
    const normalizedPath = relativePath.split(path.sep).join('/')

    return this.ignoreInstance.ignores(normalizedPath)
  }

  getName(): string {
    return path.basename(this.rootPath) || 'workspace'
  }

  getWorkspaceFolders(): WorkspaceFolder[] {
    return [{
      name: this.getName(),
      uri: this.rootPath,
      index: 0
    }]
  }

  async findFiles(pattern: string, exclude?: string): Promise<string[]> {
    const files: string[] = []
    
    await this.walkDirectory(this.rootPath, async (filePath) => {
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

  private async loadIgnoreRules(): Promise<void> {
    if (this.ignoreRulesLoaded) return

    this.ignoreRules = []
    
    for (const ignoreFile of this.ignoreFiles) {
      const ignoreFilePath = path.join(this.rootPath, ignoreFile)
      
      try {
        if (await this.fileSystem.exists(ignoreFilePath)) {
          const content = await this.fileSystem.readFile(ignoreFilePath)
          const text = new TextDecoder().decode(content)
          const rules = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
          
          this.ignoreRules.push(...rules)
        }
      } catch (error) {
        // Ignore errors when reading ignore files
        console.warn(`Failed to read ignore file ${ignoreFilePath}:`, error)
      }
    }
    
    this.ignoreRulesLoaded = true
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