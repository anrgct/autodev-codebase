/**
 * Dependency Analysis Cache Manager
 *
 * Manages persistent cache for dependency analysis results to avoid redundant parsing
 * and analysis of unchanged files.
 *
 * Cache strategy:
 * - File-level caching: cache entire file analysis result
 * - Content-based invalidation: use SHA-256 hash to detect file changes
 * - Configuration fingerprinting: invalidate cache when parser version changes
 *
 * Cache location: ~/.autodev-cache/dependency-cache/{projectHash}/analysis-cache.json
 */

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import debounce from 'lodash.debounce'
import type { IFileSystem } from '../abstractions/core'
import type {
  DependencyNode,
  DependencyEdge,
} from './models'
import type {
  CacheFingerprint,
  SerializedDependencyNode,
  FileCacheEntry,
  AnalysisCache,
  CacheStats,
} from './cache-types'
import { CACHE_LIMITS } from './cache-types'

// Default cache base directory
const DEFAULT_CACHE_BASE = path.join(os.homedir(), '.autodev-cache', 'dependency-cache')

/**
 * Manages dependency analysis cache
 */
export class DependencyCacheManager {
  private cachePath: string
  private cache: AnalysisCache
  private _debouncedSave: () => void

  /**
   * Create a cache manager for a specific project
   * @param projectPath Absolute path to the project root
   * @param fileSystem File system abstraction
   * @param cacheBaseDir Optional custom cache base directory
   */
  constructor(
    private projectPath: string,
    private fileSystem: IFileSystem,
    cacheBaseDir?: string
  ) {
    // Generate project hash for cache isolation
    const projectHash = createHash('sha256')
      .update(projectPath)
      .digest('hex')
      .substring(0, 16)

    this.cachePath = path.join(
      cacheBaseDir || DEFAULT_CACHE_BASE,
      projectHash,
      'analysis-cache.json'
    )

    this.cache = this.createEmptyCache()

    // Debounce save to avoid excessive disk writes
    this._debouncedSave = debounce(async () => {
      await this._performSave()
    }, 1500)
  }

  /**
   * Initialize cache manager by loading existing cache
   */
  async initialize(): Promise<void> {
    try {
      const exists = await this.fileSystem.exists(this.cachePath)
      if (!exists) {
        this.cache = this.createEmptyCache()
        return
      }

      const content = await this.fileSystem.readFile(this.cachePath)
      const loadedCache = JSON.parse(new TextDecoder().decode(content)) as AnalysisCache

      // Validate cache version
      if (loadedCache.version !== CACHE_LIMITS.VERSION) {
        this.cache = this.createEmptyCache()
        return
      }

      this.cache = loadedCache
    } catch (error) {
      // Cache corrupted, start fresh
      this.cache = this.createEmptyCache()
    }
  }

  /**
   * Get cached analysis result for a file
   * Returns null if cache miss or invalid
   */
  getCacheEntry(
    filePath: string,
    fileContent: string
  ): { nodes: DependencyNode[]; edges: DependencyEdge[] } | null {
    // Check configuration fingerprint
    const currentFingerprint = this.createFingerprint()
    if (
      this.cache.fingerprint.version !== currentFingerprint.version ||
      this.cache.fingerprint.parserVersion !== currentFingerprint.parserVersion
    ) {
      return null
    }

    // Calculate file hash
    const fileHash = this.computeHash(fileContent)
    const relativePath = this.getRelativePath(filePath)
    const entry = this.cache.files[relativePath]

    if (!entry || entry.fileHash !== fileHash) {
      return null
    }

    // Cache hit! Deserialize nodes and edges
    const nodes = entry.nodes.map(serialized => this.deserializeNode(serialized))
    const edges = entry.edges

    // Update last accessed time (for LRU cleanup)
    entry.lastAnalyzed = new Date().toISOString()
    this._debouncedSave()

    return { nodes, edges }
  }

  /**
   * Store analysis result in cache
   */
  async setCacheEntry(
    filePath: string,
    fileContent: string,
    nodes: DependencyNode[],
    edges: DependencyEdge[],
    language: string
  ): Promise<void> {
    // Enforce node limit
    if (nodes.length > CACHE_LIMITS.MAX_NODES_PER_FILE) {
      // Don't cache files with too many nodes
      return
    }

    // Calculate file hash
    const fileHash = this.computeHash(fileContent)
    const relativePath = this.getRelativePath(filePath)

    // Serialize nodes (convert Set to array)
    const serializedNodes: SerializedDependencyNode[] = nodes.map(node =>
      this.serializeNode(node)
    )

    // Create cache entry
    const entry: FileCacheEntry = {
      fileHash,
      relativePath,
      lastAnalyzed: new Date().toISOString(),
      nodes: serializedNodes,
      edges,
      language,
      fileSize: new TextEncoder().encode(fileContent).length,
      lineCount: fileContent.split('\n').length,
    }

    this.cache.files[relativePath] = entry
    this.cache.lastUpdated = new Date().toISOString()

    this._debouncedSave()
  }

  /**
   * Delete cache entry for a file
   */
  deleteCacheEntry(filePath: string): void {
    const relativePath = this.getRelativePath(filePath)
    delete this.cache.files[relativePath]
    this.cache.lastUpdated = new Date().toISOString()
    this._debouncedSave()
  }

  /**
   * Clear all cache entries
   */
  async clearCache(): Promise<void> {
    this.cache = this.createEmptyCache()
    await this._performSave()
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalFiles = Object.keys(this.cache.files).length
    const cachedFiles = totalFiles
    const invalidFiles = 0
    const hitRate = totalFiles > 0 ? cachedFiles / totalFiles : 0
    const invalidReasons = {
      fileChanged: 0,
      configChanged: 0,
      notCached: 0,
    }

    // Calculate actual stats by checking fingerprint
    const currentFingerprint = this.createFingerprint()
    const totalFiles_ = Object.keys(this.cache.files).length
    const cachedFiles_ = Object.keys(this.cache.files).filter(relativePath => {
      const entry = this.cache.files[relativePath]
      return (
        this.cache.fingerprint.version === currentFingerprint.version &&
        this.cache.fingerprint.parserVersion === currentFingerprint.parserVersion
      )
    }).length

    const invalidFiles_ = totalFiles_ - cachedFiles_
    const hitRate_ = totalFiles_ > 0 ? cachedFiles_ / totalFiles_ : 1.0

    return {
      totalFiles: totalFiles_,
      cachedFiles: cachedFiles_,
      invalidFiles: invalidFiles_,
      hitRate: hitRate_,
      invalidReasons: {
        fileChanged: invalidFiles_,
        configChanged: 0,
        notCached: 0,
      },
    }
  }

  /**
   * Get cache file path
   */
  getCachePath(): string {
    return this.cachePath
  }

  /**
   * Force immediate cache save
   */
  async flush(): Promise<void> {
    await this._performSave()
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Serialize node (convert Set to array)
   */
  private serializeNode(node: DependencyNode): SerializedDependencyNode {
    const { sourceCode, dependsOn, ...rest } = node
    return {
      ...rest,
      dependsOn: Array.from(dependsOn),
    }
  }

  /**
   * Deserialize node (convert array back to Set)
   */
  private deserializeNode(serialized: SerializedDependencyNode): DependencyNode {
    return {
      ...serialized,
      dependsOn: new Set(serialized.dependsOn),
    }
  }

  /**
   * Create an empty cache structure
   */
  private createEmptyCache(): AnalysisCache {
    const projectHash = createHash('sha256').update(this.projectPath).digest('hex')
    return {
      version: CACHE_LIMITS.VERSION,
      fingerprint: this.createFingerprint(),
      files: {},
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }
  }

  /**
   * Create configuration fingerprint
   */
  private createFingerprint(): CacheFingerprint {
    // Use web-tree-sitter version from package.json
    // Note: This should match the actual parser version being used
    const TREE_SITTER_VERSION = '0.23.0'
    
    return {
      version: CACHE_LIMITS.VERSION,
      parserVersion: TREE_SITTER_VERSION,
    }
  }

  /**
   * Compute SHA-256 hash of content
   */
  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  /**
   * Get relative path from project root
   */
  private getRelativePath(absolutePath: string): string {
    return path.relative(this.projectPath, absolutePath)
  }

  /**
   * Perform actual cache save to disk
   */
  private async _performSave(): Promise<void> {
    try {
      // Clean old entries before saving
      await this.cleanOldEntries()

      // Serialize cache
      const json = JSON.stringify(this.cache, null, 2)
      const sizeBytes = new TextEncoder().encode(json).length

      // Check size limit
      if (sizeBytes > CACHE_LIMITS.MAX_CACHE_SIZE_BYTES) {
        console.warn(`Cache too large (${(sizeBytes / 1024 / 1024).toFixed(2)} MB), skipping save`)
        return
      }

      // Ensure directory exists
      const dir = path.dirname(this.cachePath)
      await fs.mkdir(dir, { recursive: true })

      // Atomic write: write to temp file then rename
      const tempPath = `${this.cachePath}.tmp.${process.pid}`
      await this.fileSystem.writeFile(tempPath, new TextEncoder().encode(json))
      await fs.rename(tempPath, this.cachePath)
    } catch (error) {
      console.error('Failed to save dependency cache:', error)
    }
  }

  /**
   * Remove cache entries older than MAX_CACHE_AGE_DAYS
   */
  private async cleanOldEntries(): Promise<void> {
    const maxAge = CACHE_LIMITS.MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000
    const now = Date.now()

    const entries = Object.entries(this.cache.files)
    const validEntries = entries.filter(([_, entry]) => {
      const age = now - new Date(entry.lastAnalyzed).getTime()
      return age < maxAge
    })

    this.cache.files = Object.fromEntries(validEntries)
  }

  /**
   * Clean orphaned cache entries (files that no longer exist)
   * Returns the number of entries removed
   */
  async cleanOrphanedEntries(): Promise<number> {
    const entries = Object.entries(this.cache.files)
    const validEntries: [string, FileCacheEntry][] = []
    let removedCount = 0

    for (const [relativePath, entry] of entries) {
      const fullPath = path.join(this.projectPath, relativePath)
      const exists = await this.fileSystem.exists(fullPath)
      if (exists) {
        validEntries.push([relativePath, entry])
      } else {
        removedCount++
      }
    }

    this.cache.files = Object.fromEntries(validEntries)
    
    if (removedCount > 0) {
      await this._performSave()
    }

    return removedCount
  }

  /**
   * Clean cache entries older than specified days
   * Returns the number of entries removed
   */
  async cleanOldCacheEntries(maxAgeDays: number = CACHE_LIMITS.MAX_CACHE_AGE_DAYS): Promise<number> {
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000
    const now = Date.now()

    const entries = Object.entries(this.cache.files)
    const validEntries: [string, FileCacheEntry][] = []
    let removedCount = 0

    for (const [relativePath, entry] of entries) {
      const age = now - new Date(entry.lastAnalyzed).getTime()
      if (age < maxAge) {
        validEntries.push([relativePath, entry])
      } else {
        removedCount++
      }
    }

    this.cache.files = Object.fromEntries(validEntries)
    
    if (removedCount > 0) {
      await this._performSave()
    }

    return removedCount
  }
}
