/**
 * Integration Tests for Ignore Service
 *
 * Purpose: Verify that all three modules (list-files, dependency/parse, workspace)
 * have consistent ignore behavior when using the unified IgnoreService.
 *
 * Uses memfs (memory filesystem) to test fast-glob with real filesystem operations
 * while keeping tests fast and isolated.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { IgnoreService } from '../IgnoreService'
import { NodeWorkspace } from '../../adapters/nodejs/workspace'
import { NodePathUtils } from '../../adapters/nodejs/workspace'
import { listFiles } from '../../glob/list-files'
import { walkFiles } from '../../dependency/parse'
import { IFileSystem, IPathUtils } from '../../abstractions'
import { fs, vol } from 'memfs'

/**
 * Enhanced Mock File System with directory structure support
 */
class MockFileSystem implements IFileSystem {
  private files = new Map<string, Uint8Array>()
  private directories = new Set<string>()

  setFile(path: string, content: string): void {
    this.files.set(path, new TextEncoder().encode(content))
  }

  setDirectory(path: string): void {
    this.directories.add(path)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path)
    if (!content) {
      throw new Error(`File not found: ${path}`)
    }
    return content
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path)
  }

  async readdir(path: string): Promise<string[]> {
    const entries = new Set<string>()

    // Normalize path
    const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path

    // Add files directly in this directory
    for (const filePath of this.files.keys()) {
      const relativePath = filePath.startsWith(normalizedPath + '/')
        ? filePath.slice(normalizedPath.length + 1)
        : filePath === normalizedPath
        ? filePath
        : null

      if (relativePath) {
        const firstSlash = relativePath.indexOf('/')
        if (firstSlash === -1) {
          entries.add(relativePath)
        } else {
          entries.add(relativePath.slice(0, firstSlash))
        }
      }
    }

    // Add subdirectories
    for (const dirPath of this.directories) {
      if (dirPath === normalizedPath) continue

      const relativePath = dirPath.startsWith(normalizedPath + '/')
        ? dirPath.slice(normalizedPath.length + 1)
        : null

      if (relativePath) {
        const firstSlash = relativePath.indexOf('/')
        if (firstSlash === -1) {
          entries.add(relativePath)
        } else {
          entries.add(relativePath.slice(0, firstSlash))
        }
      }
    }

    return Array.from(entries)
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }> {
    if (this.files.has(path)) {
      const content = this.files.get(path)!
      return { isFile: true, isDirectory: false, size: content.length, mtime: 0 }
    }
    if (this.directories.has(path)) {
      return { isFile: false, isDirectory: true, size: 0, mtime: 0 }
    }
    throw new Error(`Path not found: ${path}`)
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path)
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
    this.directories.delete(path)
  }

  // Helper to check if a path exists
  hasPath(path: string): boolean {
    return this.files.has(path) || this.directories.has(path)
  }
}

/**
 * Mock Path Utils
 */
class MockPathUtils implements IPathUtils {
  join(...paths: string[]): string {
    return paths.filter(p => p).join('/')
  }

  dirname(path: string): string {
    const parts = path.split('/')
    parts.pop()
    return parts.join('/') || '.'
  }

  basename(path: string, ext?: string): string {
    const parts = path.split('/')
    const name = parts[parts.length - 1] || ''
    if (ext && name.endsWith(ext)) {
      return name.slice(0, -ext.length)
    }
    return name
  }

  extname(path: string): string {
    const basename = this.basename(path)
    const dotIndex = basename.lastIndexOf('.')
    return dotIndex > 0 ? basename.slice(dotIndex) : ''
  }

  resolve(...paths: string[]): string {
    let result = paths.filter(p => p).join('/')
    if (!result.startsWith('/')) {
      result = '/' + result
    }
    return result
  }

  isAbsolute(path: string): boolean {
    return path.startsWith('/')
  }

  relative(from: string, to: string): string {
    from = this.normalize(from)
    to = this.normalize(to)

    if (from === to) return '.'
    if (to.startsWith(from + '/')) {
      let result = to.slice(from.length + 1)
      if (result.startsWith('/')) {
        result = result.slice(1)
      }
      return result || '.'
    }
    let result = to.startsWith('/') ? to.slice(1) : to
    return result
  }

  normalize(path: string): string {
    let normalized = path.replace(/\\/g, '/')
    normalized = normalized.replace(/\/+/g, '/')
    return normalized
  }
}

describe('Ignore Service Integration Tests', () => {
  let fileSystem: MockFileSystem
  let pathUtils: MockPathUtils
  let ignoreService: IgnoreService
  let workspace: NodeWorkspace
  let testRootPath: string

  beforeEach(() => {
    fileSystem = new MockFileSystem()
    pathUtils = new MockPathUtils()
    testRootPath = '/test/project'

    // Create IgnoreService instance
    ignoreService = new IgnoreService(fileSystem, pathUtils, {
      rootPath: testRootPath,
      ignoreFiles: ['.gitignore', '.rooignore', '.codebaseignore'],
    })

    // Create NodeWorkspace instance
    workspace = new NodeWorkspace(fileSystem, {
      rootPath: testRootPath,
      ignoreFiles: ['.gitignore', '.rooignore', '.codebaseignore'],
    })
  })

  /**
   * Test Suite: Complete Integration with memfs
   * Tests all three modules (listFiles, walkFiles, workspace) using memfs
   */
  describe('Complete integration with memfs (all three modules)', () => {
    let memfsFileSystem: IFileSystem
    let memfsPathUtils: NodePathUtils
    let memfsIgnoreService: IgnoreService
    let memfsWorkspace: NodeWorkspace
    let tempDir: string

    beforeEach(() => {
      // Setup memory filesystem with nested structure
      tempDir = '/tmp/test-project-' + Math.random().toString(36).slice(2, 10)
      
      vol.fromNestedJSON({
        [tempDir]: {
          'src': {
            'index.ts': 'export {}',
            'utils.ts': 'export const fn = () => {}',
          },
          'lib': {
            'helper.js': 'module.exports = {}',
          },
          'node_modules': {
            'pkg': {
              'index.js': 'module.exports = {}',
              'package.json': '{"name": "pkg"}',
            },
          },
          'dist': {
            'bundle.js': 'bundle content',
            'index.html': '<html></html>',
          },
          '.git': {
            'config': '[core]',
          },
          'build': {
            'output.js': 'build output',
          },
          '.gitignore': '*.log\n*.temp.js\n!important.js\n!debug.temp.ts\n',
          'debug.log': 'log content',
          'important.js': 'important content',
          'test.temp.js': 'test temp',
          'debug.temp.ts': 'debug temp',
        }
      })

      // Create memfs wrapper that implements IFileSystem
      memfsFileSystem = {
        readFile: (path: string) => Promise.resolve(fs.readFileSync(path) as unknown as Uint8Array),
        writeFile: (path: string, content: Uint8Array) => {
          fs.writeFileSync(path, content as any)
          return Promise.resolve()
        },
        exists: (path: string) => Promise.resolve(fs.existsSync(path)),
        stat: (path: string) => {
          const stats = fs.statSync(path)
          return Promise.resolve({
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            size: stats.size,
            mtime: stats.mtimeMs,
          })
        },
        readdir: (path: string) => Promise.resolve(fs.readdirSync(path) as any),
        mkdir: (path: string) => {
          fs.mkdirSync(path, { recursive: true })
          return Promise.resolve()
        },
        delete: (path: string) => {
          fs.rmSync(path, { recursive: true, force: true })
          return Promise.resolve()
        },
      }

      memfsPathUtils = new NodePathUtils()
      memfsIgnoreService = new IgnoreService(memfsFileSystem, memfsPathUtils, {
        rootPath: tempDir,
        ignoreFiles: ['.gitignore'],
      })
      
      memfsWorkspace = new NodeWorkspace(memfsFileSystem, {
        rootPath: tempDir,
        ignoreFiles: ['.gitignore'],
      })
    })

    afterEach(() => {
      vol.reset()
    })

    it('should consistently ignore node_modules across all three modules', async () => {
      const nodeModulesFile = `${tempDir}/node_modules/pkg/index.js`

      // Test 1: listFiles with memfs
      const [listFilesResult] = await listFiles(
        tempDir,
        true,
        10000,
        {
          pathUtils: memfsPathUtils,
          fileSystem: memfsFileSystem,
          workspace: memfsWorkspace,
          fs: fs  // Pass memfs to fast-glob
        }
      )
      expect(listFilesResult).not.toContain(nodeModulesFile)
      expect(listFilesResult.some(f => f.includes('node_modules'))).toBe(false)

      // Test 2: walkFiles with memfs
      const walkFilesResult = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }  // Include .js files
      )
      expect(walkFilesResult).not.toContain(nodeModulesFile)
      expect(walkFilesResult.some(f => f.includes('node_modules'))).toBe(false)

      // Test 3: workspace.shouldIgnore with memfs
      const shouldIgnore = await memfsWorkspace.shouldIgnore(nodeModulesFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently ignore dist directory across all three modules', async () => {
      const distFile = `${tempDir}/dist/bundle.js`

      // Test 1: listFiles
      const [listFilesResult] = await listFiles(
        tempDir,
        true,
        10000,
        {
          pathUtils: memfsPathUtils,
          fileSystem: memfsFileSystem,
          workspace: memfsWorkspace,
          fs: fs  // Pass memfs to fast-glob
        }
      )
      expect(listFilesResult).not.toContain(distFile)
      expect(listFilesResult.some(f => f.includes('/dist/'))).toBe(false)

      // Test 2: walkFiles
      const walkFilesResult = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFilesResult).not.toContain(distFile)
      expect(walkFilesResult.some(f => f.includes('/dist/'))).toBe(false)

      // Test 3: workspace
      const shouldIgnore = await memfsWorkspace.shouldIgnore(distFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently NOT ignore normal source files', async () => {
      const sourceFile = `${tempDir}/src/index.ts`

      // Test 1: listFiles should include
      const [listFilesResult] = await listFiles(
        tempDir,
        true,
        10000,
        {
          pathUtils: memfsPathUtils,
          fileSystem: memfsFileSystem,
          workspace: memfsWorkspace,
          fs: fs  // Pass memfs to fast-glob
        }
      )
      expect(listFilesResult).toContain(sourceFile)

      // Test 2: walkFiles should include
      const walkFilesResult = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFilesResult).toContain(sourceFile)

      // Test 3: workspace should NOT ignore
      const shouldIgnore = await memfsWorkspace.shouldIgnore(sourceFile)
      expect(shouldIgnore).toBe(false)
    })

    it('should consistently handle .gitignore patterns with negation', async () => {
      const debugLog = `${tempDir}/debug.log`
      const importantJs = `${tempDir}/important.js`

      // Test debug.log (should be ignored by *.log pattern)
      const [listFiles1] = await listFiles(
        tempDir,
        true,
        10000,
        { pathUtils: memfsPathUtils, fileSystem: memfsFileSystem, workspace: memfsWorkspace, fs: fs }
      )
      expect(listFiles1).not.toContain(debugLog)

      const walkFiles1 = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFiles1).not.toContain(debugLog)

      const shouldIgnore1 = await memfsWorkspace.shouldIgnore(debugLog)
      expect(shouldIgnore1).toBe(true)

      // Test important.js (should NOT be ignored - negation pattern !important.js)
      const [listFiles2] = await listFiles(
        tempDir,
        true,
        10000,
        { pathUtils: memfsPathUtils, fileSystem: memfsFileSystem, workspace: memfsWorkspace, fs: fs }
      )
      expect(listFiles2).toContain(importantJs)

      const walkFiles2 = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFiles2).toContain(importantJs)

      const shouldIgnore2 = await memfsWorkspace.shouldIgnore(importantJs)
      expect(shouldIgnore2).toBe(false)
    })

    it('should consistently handle *.temp.js pattern with negation', async () => {
      const testTempJs = `${tempDir}/test.temp.js`

      // Should be ignored by *.temp.js pattern
      const [listFilesResult] = await listFiles(
        tempDir,
        true,
        10000,
        { pathUtils: memfsPathUtils, fileSystem: memfsFileSystem, workspace: memfsWorkspace, fs: fs }
      )
      expect(listFilesResult).not.toContain(testTempJs)

      const walkFilesResult = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFilesResult).not.toContain(testTempJs)

      const shouldIgnore = await memfsWorkspace.shouldIgnore(testTempJs)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently handle *.temp.ts pattern with negation', async () => {
      const debugTempTs = `${tempDir}/debug.temp.ts`

      // Should NOT be ignored - negation pattern !debug.temp.ts
      const [listFilesResult] = await listFiles(
        tempDir,
        true,
        10000,
        { pathUtils: memfsPathUtils, fileSystem: memfsFileSystem, workspace: memfsWorkspace, fs: fs }
      )
      expect(listFilesResult).toContain(debugTempTs)

      const walkFilesResult = await walkFiles(
        tempDir,
        memfsFileSystem,
        memfsPathUtils,
        memfsIgnoreService,
        { includeTests: true }
      )
      expect(walkFilesResult).toContain(debugTempTs)

      const shouldIgnore = await memfsWorkspace.shouldIgnore(debugTempTs)
      expect(shouldIgnore).toBe(false)
    })
  })



  /**
   * Test Suite 1: Default Directory Ignoring
   * Verifies that node_modules, dist, .git are consistently ignored
   */
  describe('Default directory ignoring', () => {
    beforeEach(async () => {
      // Setup directory structure
      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/src')
      fileSystem.setDirectory('/test/project/lib')
      fileSystem.setDirectory('/test/project/node_modules')
      fileSystem.setDirectory('/test/project/node_modules/pkg')
      fileSystem.setDirectory('/test/project/dist')
      fileSystem.setDirectory('/test/project/build')
      fileSystem.setDirectory('/test/project/.git')
      fileSystem.setDirectory('/test/project/__pycache__')

      // Create files
      fileSystem.setFile('/test/project/src/index.ts', 'export {}')
      fileSystem.setFile('/test/project/src/utils.ts', 'export const fn = () => {}')
      fileSystem.setFile('/test/project/lib/helper.js', 'module.exports = {}')
      fileSystem.setFile('/test/project/node_modules/pkg/index.js', 'module.exports = {}')
      fileSystem.setFile('/test/project/node_modules/pkg/package.json', '{"name": "pkg"}')
      fileSystem.setFile('/test/project/dist/bundle.js', 'bundle content')
      fileSystem.setFile('/test/project/dist/index.html', '<html></html>')
      fileSystem.setFile('/test/project/build/output.js', 'build output')
      fileSystem.setFile('/test/project/.git/config', '[core]')
      fileSystem.setFile('/test/project/__pycache__/test.pyc', 'bytecode')

      await ignoreService.initialize()
    })

    it('should consistently ignore node_modules across dependency and workspace modules', async () => {
      const nodeModulesFile = '/test/project/node_modules/pkg/index.js'

      // Test 1: walkFiles should not traverse into node_modules
      const walkFilesResult = await walkFiles(
        testRootPath,
        fileSystem,
        pathUtils,
        ignoreService,
        { includeNodeModules: false }
      )
      expect(walkFilesResult).not.toContain(nodeModulesFile)
      expect(walkFilesResult.some(f => f.includes('node_modules'))).toBe(false)

      // Test 2: workspace.shouldIgnore should identify node_modules as ignored
      const shouldIgnore = await workspace.shouldIgnore(nodeModulesFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently ignore dist directory across dependency and workspace modules', async () => {
      const distFile = '/test/project/dist/bundle.js'

      // Test 1: walkFiles should not include dist files
      const walkFilesResult = await walkFiles(
        testRootPath,
        fileSystem,
        pathUtils,
        ignoreService,
        {}
      )
      expect(walkFilesResult).not.toContain(distFile)
      expect(walkFilesResult.some(f => f.includes('/dist/'))).toBe(false)

      // Test 2: workspace should ignore dist
      const shouldIgnore = await workspace.shouldIgnore(distFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently ignore .git directory across dependency and workspace modules', async () => {
      const gitFile = '/test/project/.git/config'

      // Test 1: walkFiles should not traverse into .git
      const walkFilesResult = await walkFiles(
        testRootPath,
        fileSystem,
        pathUtils,
        ignoreService,
        {}
      )
      expect(walkFilesResult).not.toContain(gitFile)

      // Test 2: workspace should ignore .git
      const shouldIgnore = await workspace.shouldIgnore(gitFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently NOT ignore normal source files', async () => {
      const sourceFile = '/test/project/src/index.ts'

      // Test 1: walkFiles should include normal files
      const walkFilesResult = await walkFiles(
        testRootPath,
        fileSystem,
        pathUtils,
        ignoreService,
        {}
      )
      expect(walkFilesResult).toContain(sourceFile)

      // Test 2: workspace should NOT ignore normal files
      const shouldIgnore = await workspace.shouldIgnore(sourceFile)
      expect(shouldIgnore).toBe(false)
    })
  })

  /**
   * Test Suite 2: .gitignore Pattern Handling
   * Verifies that .gitignore patterns are consistently applied
   */
  describe('.gitignore pattern consistency', () => {
    beforeEach(async () => {
      // Setup .gitignore with patterns
      // Using .js and .ts files since walkFiles only returns supported language files
      fileSystem.setFile('/test/project/.gitignore',
        '*.temp.js\n' +
        '*.temp.ts\n' +
        'output/\n' +
        'coverage/\n' +
        '!important.js\n' +
        '!debug.ts\n'
      )

      // Setup directory structure
      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/src')
      fileSystem.setDirectory('/test/project/output')
      fileSystem.setDirectory('/test/project/coverage')

      // Create files (using supported extensions for walkFiles)
      fileSystem.setFile('/test/project/src/index.ts', 'source code')
      fileSystem.setFile('/test/project/test.temp.js', 'test js')
      fileSystem.setFile('/test/project/important.js', 'important js')
      fileSystem.setFile('/test/project/util.temp.ts', 'util ts')
      fileSystem.setFile('/test/project/debug.ts', 'debug ts')
      fileSystem.setFile('/test/project/output/file.txt', 'output file')
      fileSystem.setFile('/test/project/coverage/lcov.info', 'coverage data')

      await ignoreService.initialize()
    })

    it('should consistently ignore *.temp.js files except important.js', async () => {
      const testTempJs = '/test/project/test.temp.js'
      const importantJs = '/test/project/important.js'

      // Test test.temp.js (should be ignored)
      const walkFiles1 = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFiles1).not.toContain(testTempJs)

      const shouldIgnore1 = await workspace.shouldIgnore(testTempJs)
      expect(shouldIgnore1).toBe(true)

      // Test important.js (should NOT be ignored - negation pattern)
      const walkFiles2 = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFiles2).toContain(importantJs)

      const shouldIgnore2 = await workspace.shouldIgnore(importantJs)
      expect(shouldIgnore2).toBe(false)
    })

    it('should consistently ignore *.temp.ts files except debug.ts', async () => {
      const utilTempTs = '/test/project/util.temp.ts'
      const debugTs = '/test/project/debug.ts'

      // Test util.temp.ts (should be ignored)
      const walkFiles1 = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFiles1).not.toContain(utilTempTs)

      const shouldIgnore1 = await workspace.shouldIgnore(utilTempTs)
      expect(shouldIgnore1).toBe(true)

      // Test debug.ts (should NOT be ignored - negation pattern)
      const walkFiles2 = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFiles2).toContain(debugTs)

      const shouldIgnore2 = await workspace.shouldIgnore(debugTs)
      expect(shouldIgnore2).toBe(false)
    })

    it('should consistently ignore output/ directory', async () => {
      const outputFile = '/test/project/output/file.txt'

      // Test 1: walkFiles should not traverse
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(outputFile)

      // Test 2: workspace should ignore
      const shouldIgnore = await workspace.shouldIgnore(outputFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently ignore coverage/ directory', async () => {
      const coverageFile = '/test/project/coverage/lcov.info'

      // Test 1: walkFiles should not include
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(coverageFile)

      // Test 2: workspace should ignore
      const shouldIgnore = await workspace.shouldIgnore(coverageFile)
      expect(shouldIgnore).toBe(true)
    })
  })

  /**
   * Test Suite 3: Complex Pattern Handling
   * Verifies consistency with complex .gitignore patterns
   */
  describe('Complex .gitignore patterns', () => {
    beforeEach(async () => {
      // Setup .gitignore with complex patterns
      fileSystem.setFile('/test/project/.gitignore',
        '**/*.test.js\n' +
        'src/**/*.spec.ts\n' +
        'lib/**/temp/**\n'
      )

      // Setup directory structure
      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/src')
      fileSystem.setDirectory('/test/project/src/components')
      fileSystem.setDirectory('/test/project/lib')
      fileSystem.setDirectory('/test/project/lib/utils')
      fileSystem.setDirectory('/test/project/lib/utils/temp')
      fileSystem.setDirectory('/test/project/lib/utils/temp/data')

      // Create files
      fileSystem.setFile('/test/project/src/index.ts', 'source')
      fileSystem.setFile('/test/project/utils.test.js', 'test')
      fileSystem.setFile('/test/project/src/components/Button.test.js', 'component test')
      fileSystem.setFile('/test/project/src/utils.spec.ts', 'spec test')
      fileSystem.setFile('/test/project/src/components/Header.spec.ts', 'header spec')
      fileSystem.setFile('/test/project/lib/helper.js', 'helper')
      fileSystem.setFile('/test/project/lib/utils/temp/data.json', 'temp data')

      await ignoreService.initialize()
    })

    it('should consistently handle **/*.test.js pattern', async () => {
      const testFile1 = '/test/project/utils.test.js'
      const testFile2 = '/test/project/src/components/Button.test.js'

      // Both test.js files should be ignored
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(testFile1)
      expect(walkFilesResult).not.toContain(testFile2)

      const shouldIgnore1 = await workspace.shouldIgnore(testFile1)
      const shouldIgnore2 = await workspace.shouldIgnore(testFile2)
      expect(shouldIgnore1).toBe(true)
      expect(shouldIgnore2).toBe(true)
    })

    it('should consistently handle src/**/*.spec.ts pattern', async () => {
      const specFile1 = '/test/project/src/utils.spec.ts'
      const specFile2 = '/test/project/src/components/Header.spec.ts'

      // Both .spec.ts files in src/ should be ignored
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(specFile1)
      expect(walkFilesResult).not.toContain(specFile2)

      const shouldIgnore1 = await workspace.shouldIgnore(specFile1)
      const shouldIgnore2 = await workspace.shouldIgnore(specFile2)
      expect(shouldIgnore1).toBe(true)
      expect(shouldIgnore2).toBe(true)
    })

    it('should consistently handle lib/**/temp/** pattern', async () => {
      const tempFile = '/test/project/lib/utils/temp/data.json'

      // File in lib/**/temp/** should be ignored
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(tempFile)

      const shouldIgnore = await workspace.shouldIgnore(tempFile)
      expect(shouldIgnore).toBe(true)
    })

    it('should consistently NOT ignore normal source files', async () => {
      const sourceFile = '/test/project/src/index.ts'

      // Normal source file should NOT be ignored
      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).toContain(sourceFile)

      const shouldIgnore = await workspace.shouldIgnore(sourceFile)
      expect(shouldIgnore).toBe(false)
    })
  })

  /**
   * Test Suite 4: Multiple Ignore Files
   * Verifies that rules from .gitignore, .rooignore, .codebaseignore are merged correctly
   */
  describe('Multiple ignore file handling', () => {
    beforeEach(async () => {
      // Setup multiple ignore files
      fileSystem.setFile('/test/project/.gitignore', '*.log\nbuild/')
      fileSystem.setFile('/test/project/.rooignore', '*.tmp\ntemp/')
      fileSystem.setFile('/test/project/.codebaseignore', 'cache/\n*.bak')

      // Setup directory structure
      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/build')
      fileSystem.setDirectory('/test/project/temp')
      fileSystem.setDirectory('/test/project/cache')
      fileSystem.setDirectory('/test/project/src')

      // Create files
      fileSystem.setFile('/test/project/src/index.ts', 'source')
      fileSystem.setFile('/test/project/debug.log', 'log')
      fileSystem.setFile('/test/project/temp.tmp', 'temp')
      fileSystem.setFile('/test/project/build/output.js', 'build')
      fileSystem.setFile('/test/project/temp/data.txt', 'temp data')
      fileSystem.setFile('/test/project/cache/data.json', 'cache')
      fileSystem.setFile('/test/project/backup.bak', 'backup')

      await ignoreService.initialize()
    })

    it('should consistently apply rules from all ignore files', async () => {
      // Files from different ignore files should all be ignored
      const filesToIgnore = [
        '/test/project/debug.log',      // .gitignore
        '/test/project/temp.tmp',       // .rooignore
        '/test/project/build/output.js', // .gitignore
        '/test/project/temp/data.txt',   // .rooignore
        '/test/project/cache/data.json', // .codebaseignore
        '/test/project/backup.bak',      // .codebaseignore
      ]

      for (const file of filesToIgnore) {
        // Test 1: walkFiles should not include
        const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
        expect(walkFilesResult).not.toContain(file)

        // Test 2: workspace should ignore
        const shouldIgnore = await workspace.shouldIgnore(file)
        expect(shouldIgnore).toBe(true)
      }
    })

    it('should consistently NOT ignore normal files', async () => {
      const sourceFile = '/test/project/src/index.ts'

      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).toContain(sourceFile)

      const shouldIgnore = await workspace.shouldIgnore(sourceFile)
      expect(shouldIgnore).toBe(false)
    })
  })

  /**
   * Test Suite 5: Path Handling Consistency
   * Verifies that absolute/relative paths are handled consistently
   */
  describe('Path handling consistency', () => {
    beforeEach(async () => {
      fileSystem.setFile('/test/project/.gitignore', 'dist/\n')

      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/dist')
      fileSystem.setDirectory('/test/project/src')

      fileSystem.setFile('/test/project/dist/bundle.js', 'bundle')
      fileSystem.setFile('/test/project/src/index.ts', 'source')

      await ignoreService.initialize()
    })

    it('should handle absolute paths consistently', async () => {
      const distFile = '/test/project/dist/bundle.js'

      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(distFile)

      const shouldIgnore = await workspace.shouldIgnore(distFile)
      expect(shouldIgnore).toBe(true)
    })
  })

  /**
   * Test Suite 6: Edge Cases
   */
  describe('Edge cases', () => {
    it('should handle empty directory structure', async () => {
      fileSystem.setDirectory('/test/project')
      await ignoreService.initialize()

      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).toEqual([])
    })

    it('should handle directory with only ignored files', async () => {
      fileSystem.setFile('/test/project/.gitignore', '*.log\n')

      fileSystem.setDirectory('/test/project')
      fileSystem.setFile('/test/project/debug.log', 'log')
      fileSystem.setFile('/test/project/error.log', 'error')

      await ignoreService.initialize()

      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain('/test/project/debug.log')
      expect(walkFilesResult).not.toContain('/test/project/error.log')
    })

    it('should handle nested ignore patterns correctly', async () => {
      fileSystem.setFile('/test/project/.gitignore', '**/node_modules/**\n')

      fileSystem.setDirectory('/test/project')
      fileSystem.setDirectory('/test/project/packages')
      fileSystem.setDirectory('/test/project/packages/app')
      fileSystem.setDirectory('/test/project/packages/app/node_modules')

      fileSystem.setFile('/test/project/packages/app/node_modules/pkg/index.js', 'module')

      await ignoreService.initialize()

      const nestedFile = '/test/project/packages/app/node_modules/pkg/index.js'

      const walkFilesResult = await walkFiles(testRootPath, fileSystem, pathUtils, ignoreService, {})
      expect(walkFilesResult).not.toContain(nestedFile)

      const shouldIgnore = await workspace.shouldIgnore(nestedFile)
      expect(shouldIgnore).toBe(true)
    })
  })
})