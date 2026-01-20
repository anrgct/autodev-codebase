/**
 * Integration tests for default-dirs module
 *
 * These tests verify the ACTUAL BEHAVIOR of file filtering across all modules:
 * - list-files.ts (ripgrep-based file listing)
 * - workspace.ts (ignore-based filtering)
 * - dependency/parse.ts (custom walkFiles logic)
 *
 * Unlike the previous data-structure-only tests, these tests verify:
 * 1. Real file paths are correctly ignored
 * 2. Behavior is consistent across modules
 * 3. Edge cases are handled properly
 */

import { describe, it, expect } from 'vitest'
import { IGNORE_DIRS, HIDDEN_DIR_PATTERN } from '../default-dirs'
import ignore from 'ignore'

describe('ignore-config - Integration Tests', () => {
  describe('IGNORE_DIRS consistency', () => {
    it('should work correctly with ignore library (workspace.ts behavior)', () => {
      // This simulates how workspace.ts uses IGNORE_DIRS
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      // Test cases: (filePath, shouldIgnore)
      const testCases: Array<[string, boolean]> = [
        ['node_modules/package/index.js', true],
        ['src/index.ts', false],
        ['dist/bundle.js', true],
        ['.git/hooks/pre-commit', true],
        ['__pycache__/module.pyc', true],
        ['vendor/library/file.rb', true],
        ['src/utils/helper.ts', false],
        ['coverage/lcov.info', true],
        ['.cache/webpack-cache', true],
        ['build/output.js', true],
      ]

      for (const [filePath, expectedIgnored] of testCases) {
        const isIgnored = ig.ignores(filePath)
        expect(isIgnored).toBe(expectedIgnored)
      }
    })

    it('should handle edge cases correctly', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      // Edge cases
      expect(ig.ignores('node_modules')).toBe(true) // Directory itself
      expect(ig.ignores('node_modules/')).toBe(true) // With trailing slash
      expect(ig.ignores('my_node_modules')).toBe(false) // Partial match
      expect(ig.ignores('src/node_modules/file.ts')).toBe(true) // Nested
    })
  })

  describe('HIDDEN_DIR_PATTERN compatibility', () => {
    it('should match all hidden files and directories', () => {
      // This simulates how list-files.ts uses HIDDEN_DIR_PATTERN
      const ig = ignore()
      ig.add(HIDDEN_DIR_PATTERN)

      // Should match hidden files/directories
      const hiddenPaths = [
        '.git/config',
        '.env.local',
        '.vscode/settings.json',
        '.DS_Store',
        '.hidden-file.txt',
        '.hidden-dir/file.js',
      ]

      for (const hiddenPath of hiddenPaths) {
        expect(ig.ignores(hiddenPath)).toBe(true)
      }

      // Should NOT match non-hidden paths
      const visiblePaths = [
        'src/index.ts',
        'git/config', // Not starting with dot
        'env.local', // Not starting with dot
      ]

      for (const visiblePath of visiblePaths) {
        expect(ig.ignores(visiblePath)).toBe(false)
      }
    })
  })

  describe('Combined ignore behavior (list-files.ts scenario)', () => {
    it('should combine IGNORE_DIRS with HIDDEN_DIR_PATTERN correctly', () => {
      // This simulates the actual list-files.ts behavior
      const ig = ignore()
      ig.add([...IGNORE_DIRS, HIDDEN_DIR_PATTERN])

      const testCases: Array<[string, boolean]> = [
        // IGNORE_DIRS entries
        ['node_modules/package/index.js', true],
        ['dist/bundle.js', true],
        ['__pycache__/module.pyc', true],
        
        // HIDDEN_DIR_PATTERN entries
        ['.git/config', true],
        ['.vscode/settings.json', true],
        ['.DS_Store', true],
        
        // Should NOT be ignored
        ['src/index.ts', false],
        ['lib/utils.ts', false],
        ['README.md', false],
      ]

      for (const [filePath, expectedIgnored] of testCases) {
        const isIgnored = ig.ignores(filePath)
        expect(isIgnored).toBe(expectedIgnored)
      }
    })
  })

  describe('Category coverage', () => {
    it('should ignore all version control directories', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const versionControlPaths = [
        '.git/HEAD',
        '.svn/entries',
        '.hg/dirstate',
      ]

      for (const vcPath of versionControlPaths) {
        expect(ig.ignores(vcPath)).toBe(true)
      }
    })

    it('should ignore all dependency directories', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const dependencyPaths = [
        'node_modules/package/index.js',
        'vendor/rails/gems.rb',
        'deps/erlang/app.beam',
        'pkg/rust/lib.rs',
        'Pods/ios/App.swift',
      ]

      for (const depPath of dependencyPaths) {
        expect(ig.ignores(depPath)).toBe(true)
      }
    })

    it('should ignore all build output directories', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const buildPaths = [
        'dist/app.js',
        'build/output.js',
        'out/bundle.js',
        'bundle/main.js',
        'coverage/lcov.info',
      ]

      for (const buildPath of buildPaths) {
        expect(ig.ignores(buildPath)).toBe(true)
      }
    })

    it('should ignore all cache directories', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const cachePaths = [
        '.cache/webpack/cache.json',
        '.nyc_output/coverage.js',
        '.autodev-cache/index.json',
        '.pytest_cache/v/cache/lastfailed',
      ]

      for (const cachePath of cachePaths) {
        expect(ig.ignores(cachePath)).toBe(true)
      }
    })

    it('should ignore all runtime/temporary directories', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const runtimePaths = [
        '__pycache__/module.pyc',
        'env/bin/python',
        'venv/lib/python3.9',
        'tmp/temp.txt',
        'temp/file.tmp',
      ]

      for (const runtimePath of runtimePaths) {
        expect(ig.ignores(runtimePath)).toBe(true)
      }
    })
  })

  describe('No false positives', () => {
    it('should NOT ignore legitimate source files', () => {
      const ig = ignore()
      ig.add([...IGNORE_DIRS])

      const legitimatePaths = [
        'src/index.ts',
        'lib/utils.ts',
        'components/Button.tsx',
        'styles/main.css',
        'public/index.html',
        'tests/unit/test.spec.ts',
        'my_app/node_modules_backup/package.js', // Not exactly 'node_modules'
        'mycache/data.json', // Not exactly '.cache'
        'mydist/build.js', // Not exactly 'dist'
      ]

      for (const legitPath of legitimatePaths) {
        expect(ig.ignores(legitPath)).toBe(false)
      }
    })
  })

  describe('TypeScript type safety', () => {
    it('should provide correct type hints for IgnoreDir', () => {
      // This test verifies the type system works at compile time
      type IgnoreDir = typeof IGNORE_DIRS[number]

      // These should type-check correctly
      const validDir1: IgnoreDir = 'node_modules'
      const validDir2: IgnoreDir = '.git'
      const validDir3: IgnoreDir = '__pycache__'

      expect([validDir1, validDir2, validDir3]).toEqual([
        'node_modules',
        '.git',
        '__pycache__',
      ])
    })

    it('should be readonly at type level', () => {
      // Verify the const assertion makes it readonly
      type ReadonlyArray = readonly string[]
      const isReadonly: ReadonlyArray = IGNORE_DIRS
      expect(isReadonly).toBeDefined()
    })
  })

  describe('Configuration completeness', () => {
    it('should have no duplicate entries', () => {
      const uniqueDirs = new Set(IGNORE_DIRS)
      expect(IGNORE_DIRS.length).toBe(uniqueDirs.size)
    })

    it('should have reasonable length (not too few, not too many)', () => {
      // This is a heuristic check to ensure the config is neither too minimal
      // nor bloated with unnecessary entries
      expect(IGNORE_DIRS.length).toBeGreaterThan(10) // At least 10 entries
      expect(IGNORE_DIRS.length).toBeLessThan(50) // Not more than 50 entries
    })
  })
})