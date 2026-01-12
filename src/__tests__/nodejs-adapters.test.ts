/**
 * Integration tests for Node.js adapters
 * Tests the complete functionality of Node.js platform adapters
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  createNodeDependencies,
  createSimpleNodeDependencies,
  NodeFileSystem,
  NodeStorage,
  NodeEventBus,
  NodeLogger,
  NodeFileWatcher,
  NodeWorkspace,
  NodePathUtils,
  NodeConfigProvider
} from '../adapters/nodejs'
import { EmbedderProvider } from '../code-index/interfaces/manager'

describe('Node.js Adapters Integration', () => {
  let tempDir: string
  let workspacePath: string

  beforeAll(async () => {
    // Create temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autodev-test-'))
    workspacePath = path.join(tempDir, 'workspace')
    await fs.mkdir(workspacePath, { recursive: true })
  })

  afterAll(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('NodeFileSystem', () => {
    let fileSystem: NodeFileSystem

    beforeEach(() => {
      fileSystem = new NodeFileSystem()
    })

    it('should read and write files', async () => {
      const filePath = path.join(tempDir, 'test-file.txt')
      const content = new TextEncoder().encode('Hello, World!')

      await fileSystem.writeFile(filePath, content)
      expect(await fileSystem.exists(filePath)).toBe(true)

      const readContent = await fileSystem.readFile(filePath)
      expect(new TextDecoder().decode(readContent)).toBe('Hello, World!')
    })

    it('should handle file stats', async () => {
      const filePath = path.join(tempDir, 'stats-test.txt')
      const content = new TextEncoder().encode('test content')

      await fileSystem.writeFile(filePath, content)
      const stats = await fileSystem.stat(filePath)

      expect(stats.isFile).toBe(true)
      expect(stats.isDirectory).toBe(false)
      expect(stats.size).toBeGreaterThan(0)
      expect(stats.mtime).toBeTypeOf('number')
    })

    it('should handle directories', async () => {
      const dirPath = path.join(tempDir, 'test-dir')
      await fileSystem.mkdir(dirPath)

      expect(await fileSystem.exists(dirPath)).toBe(true)

      const stats = await fileSystem.stat(dirPath)
      expect(stats.isDirectory).toBe(true)
      expect(stats.isFile).toBe(false)
    })

    it('should list directory contents', async () => {
      const dirPath = path.join(tempDir, 'list-test')
      await fileSystem.mkdir(dirPath)

      // Create test files
      const file1 = path.join(dirPath, 'file1.txt')
      const file2 = path.join(dirPath, 'file2.txt')

      await fileSystem.writeFile(file1, new TextEncoder().encode('content1'))
      await fileSystem.writeFile(file2, new TextEncoder().encode('content2'))

      const entries = await fileSystem.readdir(dirPath)
      expect(entries).toHaveLength(2)
      expect(entries).toContain('file1.txt')
      expect(entries).toContain('file2.txt')
    })
  })

  describe('NodeStorage', () => {
    it('should create cache paths', () => {
      const storage = new NodeStorage({
        globalStoragePath: tempDir,
        cacheBasePath: tempDir
      })

      const cachePath = storage.createCachePath(workspacePath)
      expect(cachePath).toContain(tempDir)
      expect(cachePath).toContain('workspaces')
    })

    it('should provide storage URIs', () => {
      const customPath = path.join(tempDir, 'custom-storage')
      const storage = new NodeStorage({
        globalStoragePath: customPath
      })

      expect(storage.getGlobalStorageUri()).toBe(customPath)
      expect(storage.getCacheBasePath()).toBe(path.join(require('os').homedir(), '.autodev-cache')) // Defaults to .autodev-cache in home directory
    })
  })

  describe('NodeEventBus', () => {
    let eventBus: NodeEventBus

    beforeEach(() => {
      eventBus = new NodeEventBus()
    })

    it('should emit and receive events', async (done) => {
      const testData = { message: 'test event' }

      await new Promise<void>((resolve) => {
        const unsubscribe = eventBus.on('test-event', (data) => {
          expect(data).toEqual(testData)
          unsubscribe()
          resolve()
        })

        eventBus.emit('test-event', testData)
      })
    })

    it('should handle multiple listeners', () => {
      let count = 0
      const testData = { count: 1 }

      const unsubscribe1 = eventBus.on('multi-event', () => count++)
      const unsubscribe2 = eventBus.on('multi-event', () => count++)

      eventBus.emit('multi-event', testData)
      expect(count).toBe(2)

      unsubscribe1()
      unsubscribe2()
    })

    it('should handle once events', () => {
      let count = 0
      const testData = { message: 'once' }

      const unsubscribe = eventBus.once('once-event', () => count++)

      eventBus.emit('once-event', testData)
      eventBus.emit('once-event', testData)

      expect(count).toBe(1)
      unsubscribe() // Should not throw
    })
  })

  describe('NodeLogger', () => {
    it('should log messages at different levels', () => {
      const logger = new NodeLogger({
        name: 'TestLogger',
        level: 'debug',
        colors: false,
        timestamps: false
      })

      // These should not throw
      expect(() => {
        logger.debug('Debug message')
        logger.info('Info message')
        logger.warn('Warning message')
        logger.error('Error message')
      }).not.toThrow()
    })

    it('should respect log level filtering', () => {
      const logger = new NodeLogger({
        level: 'warn',
        colors: false,
        timestamps: false
      })

      // This is a basic test - in a real scenario, you'd mock console methods
      expect(logger.getLevel()).toBe('warn')

      logger.setLevel('error')
      expect(logger.getLevel()).toBe('error')
    })
  })

  describe('NodeWorkspace', () => {
    let workspace: NodeWorkspace
    let fileSystem: NodeFileSystem

    beforeEach(() => {
      fileSystem = new NodeFileSystem()
      workspace = new NodeWorkspace(fileSystem, {
        rootPath: workspacePath
      })
    })

    it('should provide workspace information', () => {
      expect(workspace.getRootPath()).toBe(workspacePath)
      expect(workspace.getName()).toBe('workspace')

      const folders = workspace.getWorkspaceFolders()
      expect(folders).toHaveLength(1)
      expect(folders[0].uri).toBe(workspacePath)
    })

    it('should calculate relative paths', () => {
      const fullPath = path.join(workspacePath, 'src', 'test.ts')
      const relativePath = workspace.getRelativePath(fullPath)

      expect(relativePath).toBe(path.join('src', 'test.ts'))
    })

    it('should find files by pattern', async () => {
      // Create test files
      const srcDir = path.join(workspacePath, 'src')
      await fileSystem.mkdir(srcDir)

      const tsFile = path.join(srcDir, 'test.ts')
      const jsFile = path.join(srcDir, 'test.js')
      const txtFile = path.join(srcDir, 'readme.txt')

      await fileSystem.writeFile(tsFile, new TextEncoder().encode('// TypeScript'))
      await fileSystem.writeFile(jsFile, new TextEncoder().encode('// JavaScript'))
      await fileSystem.writeFile(txtFile, new TextEncoder().encode('Text file'))

      const tsFiles = await workspace.findFiles('*.ts')
      expect(tsFiles).toHaveLength(1)
      expect(tsFiles[0]).toBe(tsFile)

      const allFiles = await workspace.findFiles('*.*')
      expect(allFiles.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('NodePathUtils', () => {
    let pathUtils: NodePathUtils

    beforeEach(() => {
      pathUtils = new NodePathUtils()
    })

    it('should handle path operations', () => {
      const joined = pathUtils.join('a', 'b', 'c')
      expect(joined).toBe(path.join('a', 'b', 'c'))

      const dirname = pathUtils.dirname('/path/to/file.txt')
      expect(dirname).toBe('/path/to')

      const basename = pathUtils.basename('/path/to/file.txt')
      expect(basename).toBe('file.txt')

      const extname = pathUtils.extname('file.txt')
      expect(extname).toBe('.txt')
    })

    it('should handle absolute and relative paths', () => {
      const absolutePath = '/absolute/path'
      const relativePath = 'relative/path'

      expect(pathUtils.isAbsolute(absolutePath)).toBe(true)
      expect(pathUtils.isAbsolute(relativePath)).toBe(false)

      const normalized = pathUtils.normalize('a//b/../c')
      expect(normalized).toBe(path.normalize('a//b/../c'))
    })
  })

  describe('NodeConfigProvider', () => {
    let configProvider: NodeConfigProvider
    let fileSystem: NodeFileSystem
    let eventBus: NodeEventBus
    let configPath: string

    beforeEach(() => {
      fileSystem = new NodeFileSystem()
      eventBus = new NodeEventBus()
      configPath = path.join(tempDir, 'test-config.json')

      configProvider = new NodeConfigProvider(fileSystem, eventBus, {
        configPath,
        defaultConfig: {
          isEnabled: false,
          embedderProvider: "openai" as const,
          embedderModelId: "text-embedding-3-small",
          embedderModelDimension: 1536
        }
      })
    })

    it('should save and load configuration', async () => {
      const testConfig = {
        isEnabled: true,
        embedderProvider: "ollama" as const,
        embedderModelId: "nomic-embed-text",
        embedderModelDimension: 768,
        embedderOllamaBaseUrl: 'http://localhost:11434'
      }

      await configProvider.saveConfig(testConfig)
      const loadedConfig = await configProvider.loadConfig()

      expect(loadedConfig.isEnabled).toBe(true)
      expect(loadedConfig.embedderProvider).toBe("ollama")
      expect(loadedConfig.embedderOllamaBaseUrl).toBe('http://localhost:11434')
    })

    it('should validate configuration', async () => {
      // Test invalid configuration - missing OpenAI API key and Qdrant URL
      await configProvider.saveConfig({
        isEnabled: true,
        embedderProvider: "openai",
        embedderModelId: "text-embedding-3-small",
        embedderModelDimension: 1536,
        qdrantUrl: null as any
        // Missing required embedderOpenAiApiKey, explicitly set qdrantUrl to null
      })

      const validation = await configProvider.validateConfig()
      expect(validation.isValid).toBe(false)
      expect(validation.errors).toContain('OpenAI API key is required')
      expect(validation.errors).toContain('Qdrant URL is required')
    })

    it('should notify configuration changes', async () => {
      let changeReceived = false
      const unsubscribe = configProvider.onConfigChange((config) => {
        expect(config.isEnabled).toBe(true)
        changeReceived = true
        unsubscribe()
      })

      await configProvider.saveConfig({ isEnabled: true })
      // Wait a bit for the change to be processed
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(changeReceived).toBe(true)
    })
  })

  describe('Factory Functions', () => {
    it('should create simple Node.js dependencies', () => {
      const dependencies = createSimpleNodeDependencies(workspacePath)

      expect(dependencies.fileSystem).toBeInstanceOf(NodeFileSystem)
      expect(dependencies.storage).toBeInstanceOf(NodeStorage)
      expect(dependencies.eventBus).toBeInstanceOf(NodeEventBus)
      expect(dependencies.logger).toBeInstanceOf(NodeLogger)
      expect(dependencies.fileWatcher).toBeInstanceOf(NodeFileWatcher)
      expect(dependencies.workspace).toBeInstanceOf(NodeWorkspace)
      expect(dependencies.pathUtils).toBeInstanceOf(NodePathUtils)
      expect(dependencies.configProvider).toBeInstanceOf(NodeConfigProvider)
    })

    it('should create custom Node.js dependencies', () => {
      const dependencies = createNodeDependencies({
        workspacePath,
        storageOptions: {
          globalStoragePath: tempDir
        },
        loggerOptions: {
          name: 'CustomLogger',
          level: 'debug'
        }
      })

      expect(dependencies.storage.getGlobalStorageUri()).toBe(tempDir)
      // expect(dependencies.logger?.getLevel()).toBe('debug') // TODO: Fix ILogger interface
    })
  })

  describe('End-to-End Integration', () => {
    it('should demonstrate complete workflow', async () => {
      const dependencies = createSimpleNodeDependencies(workspacePath)

      // 1. Configure the system
      await dependencies.configProvider.saveConfig({
        isEnabled: true,
        embedderProvider: "openai",
        embedderModelId: "text-embedding-3-small",
        embedderModelDimension: 1536,
        embedderOpenAiApiKey: 'test-key',
        qdrantUrl: 'http://localhost:6333'
      })

      // 2. Create some test files
      const srcDir = path.join(workspacePath, 'src')
      await dependencies.fileSystem.mkdir(srcDir)

      const testFile = path.join(srcDir, 'example.ts')
      const content = new TextEncoder().encode(`
        export class ExampleClass {
          constructor(private name: string) {}

          greet(): string {
            return \`Hello, \${this.name}!\`
          }
        }
      `)

      await dependencies.fileSystem.writeFile(testFile, content)

      // 3. Find and verify files
      const tsFiles = await dependencies.workspace.findFiles('*.ts')
      expect(tsFiles).toContain(testFile)

      // 4. Verify configuration
      const config = await dependencies.configProvider.loadConfig()
      expect(config.isEnabled).toBe(true)

      // 5. Test event system
      let eventReceived = false
      const unsubscribe = dependencies.eventBus.on('test-complete', () => {
        eventReceived = true
      })

      dependencies.eventBus.emit('test-complete', { success: true })
      expect(eventReceived).toBe(true)

      unsubscribe()
    })
  })
})
