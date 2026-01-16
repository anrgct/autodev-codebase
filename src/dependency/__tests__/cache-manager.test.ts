/**
 * Tests for DependencyCacheManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DependencyCacheManager } from '../cache-manager'
import type { DependencyNode, DependencyEdge } from '../models'
import type { IFileSystem } from '../../abstractions/core'

describe('DependencyCacheManager', () => {
  let cacheManager: DependencyCacheManager
  let tempDir: string
  let mockFileSystem: IFileSystem

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dep-cache-test-'))

    // Create mock file system
    mockFileSystem = {
      exists: async (path: string) => {
        try {
          await fs.access(path)
          return true
        } catch {
          return false
        }
      },
      readFile: async (path: string) => {
        const buffer = await fs.readFile(path)
        return new Uint8Array(buffer)
      },
      writeFile: async (path: string, data: Uint8Array) => {
        await fs.writeFile(path, data)
      },
    } as IFileSystem

    // Create cache manager
    cacheManager = new DependencyCacheManager(tempDir, mockFileSystem, tempDir)
    await cacheManager.initialize()
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('should initialize empty cache', () => {
    const stats = cacheManager.getStats()
    expect(stats.totalFiles).toBe(0)
    expect(stats.cachedFiles).toBe(0)
    expect(stats.hitRate).toBe(1.0)
  })

  it('should cache file analysis result', async () => {
    const filePath = path.join(tempDir, 'test.ts')
    const fileContent = 'function foo() { bar(); }'
    const nodes: DependencyNode[] = [
      {
        id: 'test.foo',
        name: 'foo',
        componentType: 'function',
        filePath,
        relativePath: 'test.ts',
        startLine: 1,
        endLine: 1,
        dependsOn: new Set(['test.bar']),
      },
    ]
    const edges: DependencyEdge[] = []

    // Store in cache
    await cacheManager.setCacheEntry(filePath, fileContent, nodes, edges, 'typescript')
    await cacheManager.flush()

    // Retrieve from cache
    const cached = cacheManager.getCacheEntry(filePath, fileContent)
    expect(cached).not.toBeNull()
    expect(cached!.nodes).toHaveLength(1)
    expect(cached!.nodes[0].name).toBe('foo')
    expect(cached!.nodes[0].dependsOn).toEqual(new Set(['test.bar']))
  })

  it('should invalidate cache when file content changes', async () => {
    const filePath = path.join(tempDir, 'test.ts')
    const oldContent = 'function foo() { bar(); }'
    const newContent = 'function foo() { baz(); }'
    const nodes: DependencyNode[] = []
    const edges: DependencyEdge[] = []

    // Store old content
    await cacheManager.setCacheEntry(filePath, oldContent, nodes, edges, 'typescript')

    // Try to retrieve with new content
    const cached = cacheManager.getCacheEntry(filePath, newContent)
    expect(cached).toBeNull()
  })

  it('should persist cache to disk', async () => {
    const filePath = path.join(tempDir, 'test.ts')
    const fileContent = 'function foo() {}'
    const nodes: DependencyNode[] = []
    const edges: DependencyEdge[] = []

    // Store in cache
    await cacheManager.setCacheEntry(filePath, fileContent, nodes, edges, 'typescript')
    await cacheManager.flush()

    // Create new manager instance (load from disk)
    const newManager = new DependencyCacheManager(tempDir, mockFileSystem, tempDir)
    await newManager.initialize()

    // Should have the cached entry
    const cached = newManager.getCacheEntry(filePath, fileContent)
    expect(cached).not.toBeNull()
  })
})
