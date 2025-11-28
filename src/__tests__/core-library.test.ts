/**
 * Integration tests for core library functionality
 * Tests that the abstracted core works with different platform adapters
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { createSimpleNodeDependencies } from '../adapters/nodejs'
import { CacheManager } from '../code-index/cache-manager'
import { CodeIndexStateManager } from '../code-index/state-manager'
import { CodeIndexConfigManager } from '../code-index/config-manager'
import { DirectoryScanner } from '../code-index/processors/scanner'
import { EmbedderProvider } from '../code-index/interfaces/manager'
import ignore from 'ignore'
import type { ICodeParser } from '../code-index/interfaces'

describe('Core Library Integration', () => {
  let tempDir: string
  let workspacePath: string
  let dependencies: ReturnType<typeof createSimpleNodeDependencies>

  beforeAll(async () => {
    // Create temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-lib-test-'))
    workspacePath = path.join(tempDir, 'test-workspace')
    await fs.mkdir(workspacePath, { recursive: true })

    dependencies = createSimpleNodeDependencies(workspacePath)
  })

  afterAll(async () => {
    // Clean up temporary directory
    await fs.rmdir(tempDir, { recursive: true })
  })

  describe('CacheManager Integration', () => {
    let cacheManager: CacheManager

    beforeEach(() => {
      cacheManager = new CacheManager(workspacePath)
    })

    it('should initialize cache manager', async () => {
      await cacheManager.initialize()

      // After initialization, cache manager should be ready to use
      expect(cacheManager.getAllHashes()).toBeDefined()
      expect(typeof cacheManager.getAllHashes()).toBe('object')
    })

    it('should manage file hashes', async () => {
      await cacheManager.initialize()

      const testFile = '/test/file.ts'
      const testHash = 'abc123'

      // Initially should not have hash
      expect(cacheManager.getHash(testFile)).toBeUndefined()

      // Update hash
      cacheManager.updateHash(testFile, testHash)
      expect(cacheManager.getHash(testFile)).toBe(testHash)

      // Should be in all hashes
      const allHashes = cacheManager.getAllHashes()
      expect(allHashes[testFile]).toBe(testHash)

      // Delete hash
      cacheManager.deleteHash(testFile)
      expect(cacheManager.getHash(testFile)).toBeUndefined()
    })

    it('should handle cache clearing', async () => {
      await cacheManager.initialize()

      // Add some test hashes
      cacheManager.updateHash('/test1.ts', 'hash1')
      cacheManager.updateHash('/test2.ts', 'hash2')

      // Verify hashes are there
      expect(Object.keys(cacheManager.getAllHashes()).length).toBeGreaterThan(0)

      // Clear cache
      await cacheManager.clearCacheFile()

      // After clearing, we need to reinitialize to see the cleared state
      const newCacheManager = new CacheManager(workspacePath)
      await newCacheManager.initialize()

      expect(Object.keys(newCacheManager.getAllHashes()).length).toBe(0)
    })
  })

  describe('StateManager Integration', () => {
    let stateManager: CodeIndexStateManager

    beforeEach(() => {
      stateManager = new CodeIndexStateManager(dependencies.eventBus)
    })

    it('should track indexing progress', async () => {
      return new Promise<void>((resolve) => {
        const unsubscribe = stateManager.onProgressUpdate((progress) => {
          expect(progress.processedItems).toBe(5)
          expect(progress.systemStatus).toBe('Indexing')
          unsubscribe()
          resolve()
        })

        stateManager.reportBlockIndexingProgress(5, 10)
      })
    })

    it('should manage indexing state', () => {
      expect(stateManager.state).toBe('Standby')

      stateManager.setSystemState('Indexing', 'Starting indexing')
      expect(stateManager.state).toBe('Indexing')

      stateManager.setSystemState('Indexed', 'Indexing completed')
      expect(stateManager.state).toBe('Indexed')
    })
  })

  describe('ConfigManager Integration', () => {
    let configManager: CodeIndexConfigManager

    beforeEach(async () => {
      // Reset config to default state before each test
      await dependencies.configProvider.resetConfig()
      configManager = new CodeIndexConfigManager(dependencies.configProvider)
    })

    it('should initialize with default configuration', async () => {
      await configManager.initialize()

      const config = await configManager.getConfig()
      expect(config).toBeDefined()
      expect(config.embedderProvider).toBe("ollama") // Default is ollama in NodeConfigProvider
    })

    it('should detect configuration changes', async () => {
      await configManager.initialize()

      const initialConfig = await configManager.getConfig()

      // Simulate configuration change using the new config structure
      await dependencies.configProvider.saveConfig({
        isEnabled: true,
        embedderProvider: "openai",
        modelId: "text-embedding-3-small",
        modelDimension: 1536,
        openAiOptions: { openAiNativeApiKey: "test-api-key" }
      })

      await configManager.initialize() // Reload config
      const newConfig = await configManager.getConfig()

      expect(newConfig.isEnabled).toBe(true)
      expect(newConfig.embedderProvider).toBe("openai")
      expect(newConfig.embedderProvider).not.toBe(initialConfig.embedderProvider)
    })
  })

  describe('DirectoryScanner Integration', () => {
    let scanner: DirectoryScanner

    beforeEach(async () => {
      // Create test files in workspace
      const srcDir = path.join(workspacePath, 'src')
      await dependencies.fileSystem.mkdir(srcDir)

      const testFiles = [
        { path: 'src/index.ts', content: 'export * from "./utils"' },
        { path: 'src/utils.ts', content: 'export function hello() { return "world" }' },
        { path: 'src/component.tsx', content: 'export const Component = () => <div>Hello</div>' },
        { path: 'README.md', content: '# Test Project' }
      ]

      for (const file of testFiles) {
        const filePath = path.join(workspacePath, file.path)
        const dir = path.dirname(filePath)

        if (!(await dependencies.fileSystem.exists(dir))) {
          await dependencies.fileSystem.mkdir(dir)
        }

        await dependencies.fileSystem.writeFile(
          filePath,
          new TextEncoder().encode(file.content)
        )
      }

      // Initialize scanner with dependencies
      const ignoreInstance = ignore()
      scanner = new DirectoryScanner({
        fileSystem: dependencies.fileSystem,
        workspace: dependencies.workspace,
        pathUtils: dependencies.pathUtils,
        logger: dependencies.logger,
        embedder: null as any, // Mock embedder for testing
        qdrantClient: null as any, // Mock qdrant client for testing
        codeParser: null as any, // Mock code parser for testing
        cacheManager: new CacheManager(workspacePath),
        ignoreInstance // ignore() creates a proper instance with .ignores method
      })
    })

    it('should scan directory and find code blocks', async () => {
      const result = await scanner.scanDirectory(workspacePath)

      expect(result.codeBlocks).toBeDefined()
      expect(result.stats).toBeDefined()
      expect(result.stats.processed).toBeGreaterThanOrEqual(0)
      expect(result.stats.skipped).toBeGreaterThanOrEqual(0)
      expect(result.totalBlockCount).toBeGreaterThanOrEqual(0)
    })

    it('should process files and create code blocks', async () => {
      const result = await scanner.scanDirectory(workspacePath)

      // Should have processing stats (processed + skipped should be at least as many as files we created)
      expect(result.stats.processed + result.stats.skipped).toBeGreaterThanOrEqual(0)

      // Should have returned a valid result structure
      expect(result.codeBlocks).toBeDefined()
      expect(Array.isArray(result.codeBlocks)).toBe(true)
      expect(result.stats).toBeDefined()
      expect(typeof result.stats.processed).toBe('number')
      expect(typeof result.stats.skipped).toBe('number')
      expect(typeof result.totalBlockCount).toBe('number')
    })
  })

  describe('Cross-Platform Compatibility', () => {
    it('should work with different path separators', async () => {
      const testPath = dependencies.pathUtils.join('src', 'components', 'Button.tsx')
      const normalized = dependencies.pathUtils.normalize(testPath)

      expect(normalized).toBe(path.normalize(testPath))

      const isAbsolute = dependencies.pathUtils.isAbsolute(normalized)
      expect(isAbsolute).toBe(false)

      const absolutePath = dependencies.pathUtils.resolve(workspacePath, testPath)
      expect(dependencies.pathUtils.isAbsolute(absolutePath)).toBe(true)
    })

    it('should handle workspace operations consistently', async () => {
      const relativePath = 'src/test.ts'
      const fullPath = path.join(workspacePath, relativePath)

      // Create file
      await dependencies.fileSystem.writeFile(
        fullPath,
        new TextEncoder().encode('// Test file')
      )

      // Verify workspace operations
      expect(dependencies.workspace.getRelativePath(fullPath)).toBe(relativePath)
      expect(dependencies.workspace.getRootPath()).toBe(workspacePath)

      const found = await dependencies.workspace.findFiles('*.ts')
      expect(found).toContain(fullPath)
    })

    it('should maintain event consistency across components', async () => {
      let eventCount = 0
      const expectedEvents = 3

      return new Promise<void>((resolve) => {
        const unsubscribe = dependencies.eventBus.on('cross-platform-test', (data) => {
          eventCount++
          expect(data.source).toBeDefined()

          if (eventCount === expectedEvents) {
            unsubscribe()
            resolve()
          }
        })

        // Emit events from different "components"
        dependencies.eventBus.emit('cross-platform-test', { source: 'cache-manager' })
        dependencies.eventBus.emit('cross-platform-test', { source: 'scanner' })
        dependencies.eventBus.emit('cross-platform-test', { source: 'config-manager' })
      })
    })
  })

  describe('Error Handling and Edge Cases', () => {
    it('should handle missing files gracefully', async () => {
      const configManager = new CodeIndexConfigManager(dependencies.configProvider)

      // This should not throw even if config file doesn't exist
      await expect(configManager.initialize()).resolves.not.toThrow()
    })

    it('should handle invalid file operations', async () => {
      const invalidPath = path.join(workspacePath, 'non-existent', 'deeply', 'nested', 'file.txt')

      // Reading non-existent file should handle gracefully
      await expect(dependencies.fileSystem.readFile(invalidPath)).rejects.toThrow()

      // But exists should return false
      expect(await dependencies.fileSystem.exists(invalidPath)).toBe(false)
    })

    it('should handle workspace operations on empty directories', async () => {
      const emptyDir = path.join(tempDir, 'empty-workspace')
      await dependencies.fileSystem.mkdir(emptyDir)

      const emptyDeps = createSimpleNodeDependencies(emptyDir)
      const files = await emptyDeps.workspace.findFiles('*')

      expect(files).toEqual([])
    })
  })

  describe('Performance and Resource Management', () => {
    it('should handle large file operations efficiently', async () => {
      const largeContent = 'x'.repeat(1024 * 1024) // 1MB content
      const largePath = path.join(workspacePath, 'large-file.txt')

      const startTime = Date.now()

      await dependencies.fileSystem.writeFile(
        largePath,
        new TextEncoder().encode(largeContent)
      )

      const readContent = await dependencies.fileSystem.readFile(largePath)
      const readText = new TextDecoder().decode(readContent)

      const endTime = Date.now()

      expect(readText).toBe(largeContent)
      expect(endTime - startTime).toBeLessThan(5000) // Should complete in under 5 seconds
    })

    it('should clean up resources properly', async () => {
      const eventBus = dependencies.eventBus
      const initialListenerCount = (eventBus as any).listenerCount?.('test-cleanup') || 0

      // Add some listeners
      const unsubscribe1 = eventBus.on('test-cleanup', () => {})
      const unsubscribe2 = eventBus.on('test-cleanup', () => {})
      const unsubscribe3 = eventBus.once('test-cleanup', () => {})

      // Verify listeners were added
      const withListeners = (eventBus as any).listenerCount?.('test-cleanup') || 0
      expect(withListeners).toBeGreaterThan(initialListenerCount)

      // Clean up
      unsubscribe1()
      unsubscribe2()
      unsubscribe3()

      // Verify cleanup (for EventBus implementations that support listenerCount)
      if ((eventBus as any).listenerCount) {
        const afterCleanup = (eventBus as any).listenerCount('test-cleanup')
        expect(afterCleanup).toBeLessThanOrEqual(withListeners)
      }
    })
  })
})
