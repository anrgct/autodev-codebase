import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./vitest.setup.ts'],
    // Jest compatibility settings
    fakeTimers: {
      shouldAdvanceTime: true,
    },
    // Use concise reporter configuration
    reporters: ['default'],
    // Suppress console output from tests
    silent: true,
    // Only show test failures
    hideSkippedTests: true,
    // Include test files with these patterns
    include: ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
    // Exclude common non-test directories
    exclude: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.git/**',
      'vendor/link/**',
      '.autodev-cache/**',
      // Skip worktree snapshots — they have stale source (e.g. old
      // MAX_FILE_SIZE_BYTES) and would shadow the active test runs.
      '.claude/**',
      'src/__e2e__/**/*.ts',
      // Known to cause V8 Zone memory overflow in Node v24
      'src/tree-sitter/__tests__/inspectSwift.test.ts'
    ],
    // Memory optimization settings
    pool: 'forks',  // Use process forks instead of threads for better memory isolation
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
        isolate: true     // Isolate each test file
      }
    },
    // Reduce concurrency to prevent memory spikes
    maxConcurrency: 4,    // Run tests sequentially
    // Disable heap usage logging to reduce output
    logHeapUsage: false,
    // Enable isolation to prevent memory leaks between tests
    isolate: true,        // Re-enable isolation
    // Force garbage collection between test files
    sequence: {
      hooks: 'stack'
    }
  },
  esbuild: {
    target: 'node18'
  },
  resolve: {
    alias: {
      // No VSCode mock needed - project is CLI-only
    }
  },
  optimizeDeps: {
  }
})
