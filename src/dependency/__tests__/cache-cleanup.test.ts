/**
 * Tests for cache cleanup functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DependencyCacheManager } from '../cache-manager'
import type { IFileSystem } from '../../abstractions/core'

describe('Cache Cleanup', () => {
  let cacheManager: DependencyCacheManager
  let tempDir: string
  let mockFileSystem: IFileSystem

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-cleanup-test-'))

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

    cacheManager = new DependencyCacheManager(tempDir, mockFileSystem, tempDir)
    await cacheManager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('should clean old cache entries', async () => {
    // Create cache entries with old timestamps
    const filePath = path.join(tempDir, 'test.ts')
    await fs.writeFile(filePath, 'function foo() {}')

    // Add entry with current timestamp
    await cacheManager.setCacheEntry(filePath, 'function foo() {}', [], [], 'typescript')

    // Manually modify cache to have old timestamp BEFORE flushing
    const cache: any = (cacheManager as any).cache
    const oldEntry = Object.values(cache.files)[0] as any
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 35) // 35 days old
    oldEntry.lastAnalyzed = oldDate.toISOString()

    // Save the modified cache (create directory first)
    const cachePath = cacheManager.getCachePath()
    const cacheDir = path.dirname(cachePath)
    await fs.mkdir(cacheDir, { recursive: true })
    const cacheJson = JSON.stringify(cache, null, 2)
    await fs.writeFile(cachePath, cacheJson)

    // Reload the cache
    await cacheManager.initialize()

    // Verify we have 1 old entry
    const statsBefore = cacheManager.getStats()
    expect(statsBefore.totalFiles).toBe(1)

    // Clean old entries (default: 30 days)
    const removed = await cacheManager.cleanOldCacheEntries()

    // Should have removed 1 entry
    expect(removed).toBe(1)

    // Stats should show 0 cached files
    const stats = cacheManager.getStats()
    expect(stats.totalFiles).toBe(0)
  })

  it('should clean orphaned cache entries', async () => {
    // Create a file and cache it
    const filePath = path.join(tempDir, 'test.ts')
    await fs.writeFile(filePath, 'function foo() {}')
    await cacheManager.setCacheEntry(filePath, 'function foo() {}', [], [], 'typescript')
    await cacheManager.flush()

    // Delete the source file
    await fs.rm(filePath)

    // Clean orphaned entries
    const removed = await cacheManager.cleanOrphanedEntries()

    // Should have removed 1 entry
    expect(removed).toBe(1)

    // Stats should show 0 cached files
    const stats = cacheManager.getStats()
    expect(stats.totalFiles).toBe(0)
  })

  it('should not remove valid cache entries', async () => {
    // Create a file and cache it
    const filePath = path.join(tempDir, 'test.ts')
    await fs.writeFile(filePath, 'function foo() {}')
    await cacheManager.setCacheEntry(filePath, 'function foo() {}', [], [], 'typescript')
    await cacheManager.flush()

    // Clean old entries (should not remove recent entries)
    const removed = await cacheManager.cleanOldCacheEntries(30)
    expect(removed).toBe(0)

    // Clean orphaned entries (should not remove existing files)
    const orphaned = await cacheManager.cleanOrphanedEntries()
    expect(orphaned).toBe(0)

    // Stats should still show 1 cached file
    const stats = cacheManager.getStats()
    expect(stats.totalFiles).toBe(1)
  })
})
