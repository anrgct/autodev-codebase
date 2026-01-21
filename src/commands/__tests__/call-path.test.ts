/// <reference types="vitest" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import * as path from 'path'
import { analyze, DependencyAnalyzerDeps } from '../../dependency'
import { IFileSystem, IPathUtils } from '../../abstractions'
import { NodePathUtils } from '../../adapters/nodejs/workspace'
import { IgnoreService } from '../../ignore/IgnoreService'

/**
 * Integration tests for --path parameter using memfs
 * 
 * These tests verify real behavior without touching the actual file system
 */
describe('call command --path with memfs', () => {
  const testWorkspace = '/test-workspace'
  
  // Create a wrapper for memfs that matches IFileSystem interface
  const createMemFileSystem = (): IFileSystem => ({
    async readFile(filePath: string): Promise<Uint8Array> {
      const content = vol.readFileSync(filePath, 'utf-8') as string
      return new TextEncoder().encode(content)
    },
    
    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
      vol.writeFileSync(filePath, Buffer.from(data))
    },
    
    async exists(filePath: string): Promise<boolean> {
      return vol.existsSync(filePath)
    },
    
    async stat(filePath: string) {
      const stats = vol.statSync(filePath)
      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtimeMs
      }
    },
    
    async readdir(dirPath: string): Promise<string[]> {
      return vol.readdirSync(dirPath) as string[]
    },
    
    async mkdir(dirPath: string): Promise<void> {
      vol.mkdirSync(dirPath, { recursive: true })
    },
    
    async delete(filePath: string): Promise<void> {
      vol.unlinkSync(filePath)
    }
  })
  
  const pathUtils = new NodePathUtils()

  beforeEach(() => {
    // Reset memfs before each test
    vol.reset()
    
    // Create test workspace structure
    vol.mkdirSync(path.join(testWorkspace, 'src', 'utils'), { recursive: true })
    vol.mkdirSync(path.join(testWorkspace, 'lib'), { recursive: true })
    vol.mkdirSync(path.join(testWorkspace, 'demo'), { recursive: true })
    
    // Create source files
    vol.writeFileSync(
      path.join(testWorkspace, 'src', 'main.ts'),
      `import { helper } from './utils/helper'\nexport function main() { helper() }\n`
    )
    
    vol.writeFileSync(
      path.join(testWorkspace, 'src', 'utils', 'helper.ts'),
      `export function helper() { console.log('helper') }\n`
    )
    
    vol.writeFileSync(
      path.join(testWorkspace, 'lib', 'util.ts'),
      `export function util() { return 42 }\n`
    )
    
    // Create demo files
    vol.writeFileSync(
      path.join(testWorkspace, 'demo', 'test.js'),
      `function test() { console.log('test') }\n`
    )
  })

  afterEach(() => {
    vol.reset()
  })

  /**
   * Helper: Simulate callHandler logic with memfs
   */
  async function simulateCallHandler(
    workspacePath: string,
    targetPath?: string
  ): Promise<{ files: number; nodes: number }> {
    const fileSystem = createMemFileSystem()
    
    // Determine path to analyze
    let pathToAnalyze: string
    if (targetPath) {
      if (path.isAbsolute(targetPath)) {
        pathToAnalyze = targetPath
      } else {
        pathToAnalyze = path.join(workspacePath, targetPath)
      }
    } else {
      pathToAnalyze = workspacePath
    }
    
    // Create dependencies with workspace
    const ignoreService = new IgnoreService(fileSystem, pathUtils, {
      rootPath: workspacePath
    })
    await ignoreService.initialize()
    
    const deps: DependencyAnalyzerDeps = {
      fileSystem,
      pathUtils,
      workspace: {
        getRootPath: () => workspacePath,
        getRelativePath: (fullPath: string) => pathUtils.relative(workspacePath, fullPath),
        getIgnoreRules: () => [],
        getGlobIgnorePatterns: async () => [],
        shouldIgnore: async (filePath: string) => ignoreService.shouldIgnore(filePath),
        getIgnoreService: () => ignoreService,
        getName: () => 'test-workspace',
        getWorkspaceFolders: () => [],
        findFiles: async () => []
      }
    }
    
    // Run analysis
    const result = await analyze(pathToAnalyze, deps, {
      enableCache: false
    })
    
    return {
      files: result.summary.totalFiles,
      nodes: result.summary.totalNodes
    }
  }

  it('should analyze single file when target path is provided', async () => {
    const workspacePath = path.join(testWorkspace, 'src')
    const result = await simulateCallHandler(workspacePath, 'main.ts')
    
    expect(result.files).toBe(1)
    expect(result.nodes).toBeGreaterThan(0)
  })

  it('should analyze entire workspace when no target path provided', async () => {
    const workspacePath = path.join(testWorkspace, 'src')
    const result = await simulateCallHandler(workspacePath)
    
    expect(result.files).toBe(2) // main.ts and utils/helper.ts
    expect(result.nodes).toBeGreaterThan(0)
  })

  it('should analyze subdirectory when target is a directory', async () => {
    const result = await simulateCallHandler(testWorkspace, 'src')
    
    expect(result.files).toBe(2) // main.ts and utils/helper.ts
  })

  it('should resolve relative path from workspace', async () => {
    const result = await simulateCallHandler(testWorkspace, 'src/utils/helper.ts')
    
    expect(result.files).toBe(1)
  })

  it('should handle absolute path in target', async () => {
    const absolutePath = path.join(testWorkspace, 'lib', 'util.ts')
    const workspacePath = path.join(testWorkspace, 'src')
    
    const result = await simulateCallHandler(workspacePath, absolutePath)
    
    expect(result.files).toBe(1)
  })

  it('should respect .gitignore rules from workspace', async () => {
    // Create .gitignore in workspace
    vol.writeFileSync(
      path.join(testWorkspace, '.gitignore'),
      'lib/\n'
    )
    
    const result = await simulateCallHandler(testWorkspace)
    
    // Should find src files and demo file, but not lib files
    expect(result.files).toBe(3) // src/main.ts, src/utils/helper.ts, demo/test.js
    // lib/util.ts should be excluded by .gitignore
  })

  it('should handle nested workspace paths', async () => {
    const nestedPath = path.join(testWorkspace, 'src', 'utils')
    const result = await simulateCallHandler(nestedPath)
    
    expect(result.files).toBe(1) // Only helper.ts
  })

  it('should analyze demo directory correctly', async () => {
    const demoPath = path.join(testWorkspace, 'demo')
    const result = await simulateCallHandler(demoPath)
    
    expect(result.files).toBe(1) // test.js
  })

  it('should handle multiple files in workspace', async () => {
    // Add more files
    vol.writeFileSync(
      path.join(testWorkspace, 'src', 'index.ts'),
      `export * from './main'\n`
    )
    
    vol.writeFileSync(
      path.join(testWorkspace, 'src', 'utils', 'logger.ts'),
      `export function log(msg: string) { console.log(msg) }\n`
    )
    
    const workspacePath = path.join(testWorkspace, 'src')
    const result = await simulateCallHandler(workspacePath)
    
    expect(result.files).toBe(4) // main.ts, index.ts, helper.ts, logger.ts
  })

  it('should respect gitignore when analyzing specific file', async () => {
    // Create .gitignore
    vol.writeFileSync(
      path.join(testWorkspace, '.gitignore'),
      'src/utils/\n'
    )
    
    // Try to analyze a file in ignored directory
    const result = await simulateCallHandler(testWorkspace, 'src/main.ts')
    
    // The specific file should still be analyzed (not in ignored dir)
    expect(result.files).toBe(1)
  })

  it('should handle empty directory', async () => {
    vol.mkdirSync(path.join(testWorkspace, 'empty'), { recursive: true })
    
    const result = await simulateCallHandler(path.join(testWorkspace, 'empty'))
    
    expect(result.files).toBe(0)
  })

  it('should correctly count files across multiple directories', async () => {
    const result = await simulateCallHandler(testWorkspace)
    
    // Should find all TypeScript and JavaScript files
    expect(result.files).toBe(4) // src/main.ts, src/utils/helper.ts, lib/util.ts, demo/test.js
  })
})
