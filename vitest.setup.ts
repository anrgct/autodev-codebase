/**
 * Vitest setup file
 * This file sets up the testing environment for Vitest
 */

// Import Vitest globals to make them available globally in test files
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, test, expect, vi } from 'vitest'

// Make globals available for TypeScript
global.describe = describe
global.it = it
global.test = test
global.expect = expect
global.beforeEach = beforeEach
global.afterEach = afterEach
global.beforeAll = beforeAll
global.afterAll = afterAll
global.vi = vi

// Setup common test utilities with better error handling
// global.console = {
//   ...console,
//   // Suppress console.log in tests unless explicitly needed
//   log: process.env.NODE_ENV === 'test' ? () => {} : console.log,
//   // Suppress console.warn for cleaner output
//   warn: process.env.NODE_ENV === 'test' ? () => {} : console.warn,
// }

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    createTextEditorDecorationType: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({})),
    workspaceFolders: [],
    rootPath: '',
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  languages: {
    registerDocumentSemanticTokensProvider: vi.fn(),
  },
}))

// Suppress network error logs in tests to reduce noise
// NOTE: Do NOT mock fetch for E2E tests - they need real network access
// vi.stubGlobal('fetch', vi.fn())

// Setup global error handlers for tests
process.on('unhandledRejection', (reason) => {
  // Silently ignore unhandled rejections in test environment
  // This prevents test suites from crashing due to expected network errors
})

// Mock environment variables for consistent test behavior
process.env.NODE_ENV = 'test'
