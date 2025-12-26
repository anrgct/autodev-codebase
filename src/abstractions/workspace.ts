/**
 * Workspace abstractions for platform-agnostic workspace operations
 */
export interface IWorkspace {
  /**
   * Get the root path of the workspace
   */
  getRootPath(): string | undefined
  
  /**
   * Get relative path from workspace root
   */
  getRelativePath(fullPath: string): string
  
  /**
   * Get ignore rules for the workspace (from .gitignore, .rooignore, etc.)
   */
  getIgnoreRules(): string[]

  /**
   * Get ignore patterns formatted for fast-glob
   * Returns patterns with proper glob syntax (/** suffix for directories)
   */
  getGlobIgnorePatterns(): Promise<string[]>
  
  /**
   * Check if a path should be ignored
   */
  shouldIgnore(path: string): Promise<boolean>
  
  /**
   * Get workspace name
   */
  getName(): string
  
  /**
   * Get all workspace folders (for multi-root workspaces)
   */
  getWorkspaceFolders(): WorkspaceFolder[]
  
  /**
   * Find files matching a pattern
   */
  findFiles(pattern: string, exclude?: string): Promise<string[]>
}

export interface WorkspaceFolder {
  name: string
  uri: string
  index: number
}

/**
 * Path utilities abstraction
 */
export interface IPathUtils {
  /**
   * Join paths
   */
  join(...paths: string[]): string
  
  /**
   * Get directory name
   */
  dirname(path: string): string
  
  /**
   * Get base name
   */
  basename(path: string, ext?: string): string
  
  /**
   * Get file extension
   */
  extname(path: string): string
  
  /**
   * Resolve relative path to absolute
   */
  resolve(...paths: string[]): string
  
  /**
   * Check if path is absolute
   */
  isAbsolute(path: string): boolean
  
  /**
   * Get relative path between two paths
   */
  relative(from: string, to: string): string
  
  /**
   * Normalize path separators
   */
  normalize(path: string): string
}