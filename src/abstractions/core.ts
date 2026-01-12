/**
 * Core abstractions for platform-agnostic file system operations
 */
export interface IFileSystem {
  /**
   * Read file contents as bytes
   * @param uri - File URI or path
   * @returns File content as Uint8Array
   */
  readFile(uri: string): Promise<Uint8Array>
  
  /**
   * Write content to a file
   * @param uri - File URI or path
   * @param content - File content as bytes
   */
  writeFile(uri: string, content: Uint8Array): Promise<void>
  
  /**
   * Check if a file or directory exists
   * @param uri - File or directory URI or path
   * @returns true if exists, false otherwise
   */
  exists(uri: string): Promise<boolean>
  
  /**
   * Get file or directory statistics
   * @param uri - File or directory URI or path
   * @returns Statistics including type, size, and modification time
   */
  stat(uri: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }>
  
  /**
   * Read directory contents
   * 
   * Note: This method returns only entry names (not full paths), 
   * following the standard POSIX readdir() semantic.
   * 
   * @param uri - Directory URI or path
   * @returns Array of entry names (basename only, not full paths)
   * 
   * @example
   * ```typescript
   * const entries = await fileSystem.readdir('/path/to/dir')
   * // Returns: ['file1.txt', 'file2.txt', 'subdir']
   * 
   * // To get full paths:
   * const fullPath = pathUtils.join('/path/to/dir', entries[0])
   * ```
   */
  readdir(uri: string): Promise<string[]>
  
  /**
   * Create a directory (recursively if needed)
   * @param uri - Directory URI or path
   */
  mkdir(uri: string): Promise<void>
  
  /**
   * Delete a file or directory (recursively for directories)
   * @param uri - File or directory URI or path
   */
  delete(uri: string): Promise<void>
}

/**
 * Core abstractions for platform-agnostic storage operations
 */
export interface IStorage {
  getGlobalStorageUri(): string
  createCachePath(workspacePath: string): string
  getCacheBasePath(): string
}

/**
 * Core abstractions for platform-agnostic event system
 */
export interface IEventBus<T = any> {
  emit(event: string, data: T): void
  on(event: string, handler: (data: T) => void): () => void
  off(event: string, handler: (data: T) => void): void
  once(event: string, handler: (data: T) => void): () => void
}

/**
 * Core abstractions for logging
 */
export interface ILogger {
  debug(message: string, ...args: any[]): void
  info(message: string, ...args: any[]): void
  warn(message: string, ...args: any[]): void
  error(message: string, ...args: any[]): void
}

/**
 * File system watcher abstraction
 */
export interface IFileWatcher {
  watchFile(uri: string, callback: (event: FileWatchEvent) => void): () => void
  watchDirectory(uri: string, callback: (event: FileWatchEvent) => void): () => void
}

export interface FileWatchEvent {
  type: 'created' | 'changed' | 'deleted'
  uri: string
}

/**
 * Core platform dependencies container
 */
export interface IPlatformDependencies {
  fileSystem: IFileSystem
  storage: IStorage
  eventBus: IEventBus
  logger?: ILogger
  fileWatcher?: IFileWatcher
}