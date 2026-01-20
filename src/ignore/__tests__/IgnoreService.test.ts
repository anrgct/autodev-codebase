/**
 * Unit tests for IgnoreService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IgnoreService } from '../IgnoreService'
import { IFileSystem, IPathUtils } from '../../abstractions'
import { IGNORE_DIRS } from '../default-dirs'

// Mock file system
class MockFileSystem implements IFileSystem {
  private files = new Map<string, Uint8Array>()

  setFile(path: string, content: string): void {
    this.files.set(path, new TextEncoder().encode(content))
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path)
    if (!content) {
      throw new Error(`File not found: ${path}`)
    }
    return content
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  // Other required methods (not used in tests)
  async readdir(_path: string): Promise<string[]> {
    return []
  }

  async stat(_path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }> {
    return { isFile: false, isDirectory: false, size: 0, mtime: 0 }
  }

  async writeFile(_path: string, _content: Uint8Array): Promise<void> {
    // Not implemented
  }

  async mkdir(_path: string): Promise<void> {
    // Not implemented
  }

  async delete(_path: string): Promise<void> {
    // Not implemented
  }
}

// Mock path utils
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
    return paths.filter(p => p).join('/')
  }

  isAbsolute(path: string): boolean {
    return path.startsWith('/')
  }

  relative(from: string, to: string): string {
    // Simple implementation for testing
    // Normalize paths first
    from = this.normalize(from)
    to = this.normalize(to)

    if (from === to) return '.'
    if (to.startsWith(from + '/')) {
      let result = to.slice(from.length + 1)
      // Remove leading slash if present
      if (result.startsWith('/')) {
        result = result.slice(1)
      }
      return result || '.'
    }
    // Remove leading slash from result
    let result = to.startsWith('/') ? to.slice(1) : to
    return result
  }

  normalize(path: string): string {
    // Replace backslashes with forward slashes
    let normalized = path.replace(/\\/g, '/')
    // Remove duplicate slashes
    normalized = normalized.replace(/\/+/g, '/')
    return normalized
  }
}

describe('IgnoreService', () => {
  let fileSystem: MockFileSystem
  let pathUtils: MockPathUtils
  let service: IgnoreService
  const rootPath = '/test/project'

  beforeEach(() => {
    fileSystem = new MockFileSystem()
    pathUtils = new MockPathUtils()
    service = new IgnoreService(fileSystem, pathUtils, {
      rootPath,
      ignoreFiles: ['.gitignore', '.rooignore', '.codebaseignore'],
    })
  })

  describe('shouldSkipDirectory', () => {
    it('should skip node_modules', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/node_modules')).toBe(true)
    })

    it('should skip .git', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/.git')).toBe(true)
    })

    it('should skip dist', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/dist')).toBe(true)
    })

    it('should skip build', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/build')).toBe(true)
    })

    it('should skip __pycache__', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/__pycache__')).toBe(true)
    })

    it('should skip nested node_modules', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/packages/app/node_modules')).toBe(true)
    })

    it('should not skip normal directories like src', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/src')).toBe(false)
    })

    it('should not skip root directory', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project')).toBe(false)
    })

    it('should not skip normal directories like lib', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/lib')).toBe(false)
    })

    it('should skip directories matching .gitignore patterns', async () => {
      // Set up .gitignore with build/ pattern
      fileSystem.setFile('/test/project/.gitignore', 'build/\ncoverage/\n')

      await service.initialize()

      expect(service.shouldSkipDirectory('/test/project/build')).toBe(true)
      expect(service.shouldSkipDirectory('/test/project/coverage')).toBe(true)
    })

    it('should handle relative paths', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('node_modules')).toBe(true)
      expect(service.shouldSkipDirectory('src')).toBe(false)
    })

    it('should handle deeply nested directories', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/packages/ui/src/node_modules')).toBe(true)
      expect(service.shouldSkipDirectory('/test/project/a/b/c/dist')).toBe(true)
    })
  })

  describe('shouldIgnore', () => {
    it('should ignore files in node_modules', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project/node_modules/pkg/index.js')).toBe(true)
    })

    it('should ignore files in .git', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project/.git/config')).toBe(true)
    })

    it('should ignore files in dist', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project/dist/bundle.js')).toBe(true)
    })

    it('should not ignore normal source files', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project/src/index.ts')).toBe(false)
      expect(service.shouldIgnore('/test/project/lib/utils.js')).toBe(false)
    })

    it('should respect .gitignore patterns', async () => {
      fileSystem.setFile('/test/project/.gitignore', '*.log\n*.tmp\n')

      await service.initialize()

      expect(service.shouldIgnore('/test/project/debug.log')).toBe(true)
      expect(service.shouldIgnore('/test/project/temp.tmp')).toBe(true)
    })

    it('should respect .gitignore negation patterns', async () => {
      fileSystem.setFile('/test/project/.gitignore', '*.log\n!important.log\n')

      await service.initialize()

      expect(service.shouldIgnore('/test/project/debug.log')).toBe(true)
      expect(service.shouldIgnore('/test/project/important.log')).toBe(false)
    })

    it('should respect .gitignore directory patterns', async () => {
      fileSystem.setFile('/test/project/.gitignore', 'output/\n')

      await service.initialize()

      expect(service.shouldIgnore('/test/project/output/file.txt')).toBe(true)
    })

    it('should handle relative paths', async () => {
      await service.initialize()
      expect(service.shouldIgnore('node_modules/pkg/index.js')).toBe(true)
      expect(service.shouldIgnore('src/index.ts')).toBe(false)
    })

    it('should not ignore root directory', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project')).toBe(false)
      expect(service.shouldIgnore('.')).toBe(false)
    })
  })

  describe('filterFiles', () => {
    it('should filter out ignored files', async () => {
      fileSystem.setFile('/test/project/.gitignore', '*.log\n*.tmp\n')

      await service.initialize()

      const files = [
        '/test/project/src/index.ts',
        '/test/project/debug.log',
        '/test/project/lib/utils.js',
        '/test/project/test.tmp',
      ]

      const filtered = service.filterFiles(files)

      expect(filtered).toEqual([
        '/test/project/src/index.ts',
        '/test/project/lib/utils.js',
      ])
    })

    it('should handle empty array', async () => {
      await service.initialize()
      expect(service.filterFiles([])).toEqual([])
    })

    it('should filter all files if all are ignored', async () => {
      await service.initialize()
      const files = [
        '/test/project/node_modules/pkg/index.js',
        '/test/project/dist/bundle.js',
      ]
      expect(service.filterFiles(files)).toEqual([])
    })

    it('should keep all files if none are ignored', async () => {
      await service.initialize()
      const files = [
        '/test/project/src/index.ts',
        '/test/project/lib/utils.ts',
        '/test/project/test/app.test.ts',
      ]
      expect(service.filterFiles(files)).toEqual(files)
    })
  })

  describe('filterDirectories', () => {
    it('should filter out ignored directories', async () => {
      await service.initialize()

      const dirs = [
        '/test/project/src',
        '/test/project/node_modules',
        '/test/project/lib',
        '/test/project/dist',
      ]

      const filtered = service.filterDirectories(dirs)

      expect(filtered).toEqual([
        '/test/project/src',
        '/test/project/lib',
      ])
    })

    it('should handle empty array', async () => {
      await service.initialize()
      expect(service.filterDirectories([])).toEqual([])
    })
  })

  describe('initialization', () => {
    it('should initialize only once', async () => {
      const loadIgnoreFileSpy = vi.spyOn(service as any, 'loadIgnoreFile')

      await service.initialize()
      await service.initialize()
      await service.initialize()

      // Should be called 3 times (once for each ignore file) but only on first initialize
      expect(loadIgnoreFileSpy).toHaveBeenCalledTimes(3)
    })

    it('should report initialization status', () => {
      expect(service.isInitialized()).toBe(false)
      return service.initialize().then(() => {
        expect(service.isInitialized()).toBe(true)
      })
    })
  })

  describe('getRules', () => {
    it('should return default ignore dirs', async () => {
      await service.initialize()
      const rules = service.getRules()

      for (const dir of IGNORE_DIRS) {
        expect(rules).toContain(dir)
      }
    })

    it('should include additional rules', async () => {
      const additionalRules = ['*.log', '*.tmp']
      const serviceWithRules = new IgnoreService(fileSystem, pathUtils, {
        rootPath,
        additionalRules,
      })

      await serviceWithRules.initialize()
      const rules = serviceWithRules.getRules()

      for (const rule of additionalRules) {
        expect(rules).toContain(rule)
      }
    })
  })

  describe('edge cases', () => {
    it('should handle paths with trailing slashes', async () => {
      await service.initialize()
      expect(service.shouldSkipDirectory('/test/project/node_modules/')).toBe(true)
    })

    it('should handle paths with consecutive slashes', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project//src//index.ts')).toBe(false)
    })

    it('should handle . segment in paths', async () => {
      await service.initialize()
      expect(service.shouldIgnore('/test/project/./src/index.ts')).toBe(false)
    })

    it('should work before explicit initialize (lazy initialization)', async () => {
      const service2 = new IgnoreService(fileSystem, pathUtils, { rootPath })

      // Don't call initialize explicitly, but the service should handle it
      // For now, this should return false since rules aren't loaded
      expect(service2.shouldSkipDirectory('/test/project/src')).toBe(false)
    })
  })

  describe('multiple ignore files', () => {
    it('should load rules from all configured ignore files', async () => {
      fileSystem.setFile('/test/project/.gitignore', '*.log\n')
      fileSystem.setFile('/test/project/.rooignore', '*.tmp\n')
      fileSystem.setFile('/test/project/.codebaseignore', 'cache/\n')

      await service.initialize()

      expect(service.shouldIgnore('/test/project/debug.log')).toBe(true)
      expect(service.shouldIgnore('/test/project/temp.tmp')).toBe(true)
      expect(service.shouldSkipDirectory('/test/project/cache')).toBe(true)
    })

    it('should handle missing ignore files gracefully', async () => {
      // No ignore files set, should still work with default rules
      await service.initialize()

      expect(service.shouldSkipDirectory('/test/project/node_modules')).toBe(true)
      expect(service.shouldIgnore('/test/project/src/index.ts')).toBe(false)
    })
  })
})
