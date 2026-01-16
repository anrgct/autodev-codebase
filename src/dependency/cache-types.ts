/**
 * Type definitions for dependency analysis cache
 */

import type { DependencyNode, DependencyEdge } from './models'

/**
 * Cache configuration fingerprint
 * Used to detect if analysis options have changed
 */
export interface CacheFingerprint {
  /** Cache format version */
  version: string

  /** Tree-sitter parser version (to detect parser updates) */
  parserVersion: string
}

/**
 * Serialized dependency node (for JSON storage)
 * Converts Set to array for JSON serialization
 */
export interface SerializedDependencyNode extends Omit<DependencyNode, 'dependsOn'> {
  /** Array of dependent node IDs (instead of Set) */
  dependsOn: string[]
}

/**
 * Cache entry for a single file's analysis result
 */
export interface FileCacheEntry {
  /** SHA-256 hash of file content */
  fileHash: string

  /** Relative path from repository root */
  relativePath: string

  /** Timestamp when analysis was performed */
  lastAnalyzed: string

  /** Serialized dependency nodes found in this file */
  nodes: SerializedDependencyNode[]

  /** Dependency edges originating from this file */
  edges: DependencyEdge[]

  /** Detected language */
  language: string

  /** File size in bytes */
  fileSize: number

  /** Number of lines */
  lineCount: number
}

/**
 * Complete analysis cache structure
 */
export interface AnalysisCache {
  /** Cache format version */
  version: string

  /** Configuration fingerprint (to detect config changes) */
  fingerprint: CacheFingerprint

  /** Map of relative file paths to their cache entries */
  files: Record<string, FileCacheEntry>

  /** Cache creation timestamp */
  createdAt: string

  /** Last update timestamp */
  lastUpdated: string
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total files in analysis */
  totalFiles: number

  /** Files successfully cached */
  cachedFiles: number

  /** Files that couldn't be cached */
  invalidFiles: number

  /** Cache hit rate (0-1) */
  hitRate: number

  /** Breakdown of why files were invalid */
  invalidReasons: {
    fileChanged: number
    configChanged: number
    notCached: number
  }
}

/**
 * Cache limits configuration
 */
export const CACHE_LIMITS = {
  /** Cache format version */
  VERSION: '1.0',

  /** Maximum cache file size (10MB) */
  MAX_CACHE_SIZE_BYTES: 10 * 1024 * 1024,

  /** Maximum nodes per file (safety limit) */
  MAX_NODES_PER_FILE: 1000,

  /** Maximum cache age in days */
  MAX_CACHE_AGE_DAYS: 30,
}
