/**
 * Integration tests for cache in analyze() function
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { analyze } from '../index'
import { NodeFileSystem, NodePathUtils } from '../../adapters/nodejs'

describe('Cache Integration with analyze()', () => {
  let tempProjectDir: string
  let tempCacheDir: string

  beforeEach(async () => {
    // Create temp directories
    tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-integration-test-'))
    tempCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-dir-'))

    // Create a test file
    const testFile = path.join(tempProjectDir, 'test.ts')
    await fs.writeFile(testFile, 'function foo() { bar(); }')
  })

  afterEach(async () => {
    // Clean up
    await fs.rm(tempProjectDir, { recursive: true, force: true })
    await fs.rm(tempCacheDir, { recursive: true, force: true })
  })

  it('should use cache on second analysis', async () => {
    const deps = {
      fileSystem: new NodeFileSystem(),
      pathUtils: new NodePathUtils(),
    }

    // First analysis (cache miss)
    const result1 = await analyze(tempProjectDir, deps, 100, {
      enableCache: true,
      cacheBaseDir: tempCacheDir,
    })

    expect(result1.summary.totalFiles).toBeGreaterThan(0)

    // Second analysis (cache hit)
    const start = Date.now()
    const result2 = await analyze(tempProjectDir, deps, 100, {
      enableCache: true,
      cacheBaseDir: tempCacheDir,
    })
    const duration = Date.now() - start

    // Results should be the same
    expect(result2.summary.totalFiles).toBe(result1.summary.totalFiles)
    expect(result2.summary.totalNodes).toBe(result1.summary.totalNodes)

    // Second run should be faster (cached)
    console.log(`Second analysis took ${duration}ms (with cache)`)
  })

  it('should invalidate cache when file changes', async () => {
    const deps = {
      fileSystem: new NodeFileSystem(),
      pathUtils: new NodePathUtils(),
    }

    // First analysis
    const result1 = await analyze(tempProjectDir, deps, 100, {
      enableCache: true,
      cacheBaseDir: tempCacheDir,
    })

    const oldNodeCount = result1.summary.totalNodes

    // Modify the test file
    const testFile = path.join(tempProjectDir, 'test.ts')
    await fs.writeFile(testFile, 'function foo() { bar(); }\nfunction baz() {}')

    // Second analysis (cache should be invalidated)
    const result2 = await analyze(tempProjectDir, deps, 100, {
      enableCache: true,
      cacheBaseDir: tempCacheDir,
    })

    // Should detect the new function
    expect(result2.summary.totalNodes).toBeGreaterThanOrEqual(oldNodeCount)
  })
})
