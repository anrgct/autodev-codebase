/// <reference types="vitest" />

/**
 * Global type definitions for Vitest testing framework
 * This file provides TypeScript type declarations for Vitest global functions
 * to resolve type checking issues in test files that are excluded from tsconfig.json
 */

declare global {
  /**
   * Test suite description function
   * Creates a group of related tests
   */
  const describe: {
    <T = void>(name: string, fn: () => T): T
    skip: <T = void>(name: string, fn: () => T) => T
    only: <T = void>(name: string, fn: () => T) => T
    each: typeof vitest.describe.each
  }

  /**
   * Individual test function
   * Creates a single test case
   */
  const it: {
    <T = void>(name: string, fn: () => T | Promise<T>): T
    skip: <T = void>(name: string, fn: () => T | Promise<T>) => T
    only: <T = void>(name: string, fn: () => T | Promise<T>) => T
    each: typeof vitest.it.each
    concurrent: <T = void>(name: string, fn: () => T | Promise<T>) => T
  }

  /**
   * Alias for it function
   */
  const test: typeof it

  /**
   * Expectation function for assertions
   * Returns an assertion object with various matchers
   */
  const expect: {
    <T = unknown>(actual: T): import('vitest').Assertion<T>
    extend(matchers: Record<string, import('vitest').MatcherFunction>): void
    any(constructor: unknown): import('vitest').AsymmetricMatcher
    anything(): import('vitest').AsymmetricMatcher
    arrayContaining<T = unknown>(array: T[]): import('vitest').AsymmetricMatcherContaining<T>
    objectContaining<T = Record<string, unknown>>(obj: T): import('vitest').AsymmetricMatcherContaining<T>
    stringContaining(str: string): import('vitest').AsymmetricMatcher
    stringMatching(str: string | RegExp): import('vitest').AsymmetricMatcher
    closeTo(num: number, delta?: number): import('vitest').AsymmetricMatcher
    defined(): import('vitest').AsymmetricMatcher
    falsy(): import('vitest').AsymmetricMatcher
    truthy(): import('vitest').AsymmetricMatcher
    hasLength(length: number): import('vitest').AsymmetricMatcherContaining<number>
    objectContaining(obj: Record<string, unknown>): import('vitest').AsymmetricMatcherContaining<Record<string, unknown>>
    stringContaining(str: string): import('vitest').AsymmetricMatcher
    stringMatching(str: string | RegExp): import('vitest').AsymmetricMatcher
  }

  /**
   * Hook that runs before each test in the current describe block
   */
  const beforeEach: <T = void>(fn: () => T | Promise<T>) => void

  /**
   * Hook that runs after each test in the current describe block
   */
  const afterEach: <T = void>(fn: () => T | Promise<T>) => void

  /**
   * Hook that runs once before all tests in the current describe block
   */
  const beforeAll: <T = void>(fn: () => T | Promise<T>) => void

  /**
   * Hook that runs once after all tests in the current describe block
   */
  const afterAll: <T = void>(fn: () => T | Promise<T>) => void

  /**
   * Jest compatibility global object
   * Provides Jest-like API compatibility layer
   */
  const jest: {
    fn: typeof vi.fn
    mock: typeof vi.mock
    unmock: typeof vi.unmock
    doMock: typeof vi.doMock
    dontMock: typeof vi.dontMock
    spyOn: typeof vi.spyOn
    clearAllMocks: typeof vi.clearAllMocks
    resetAllMocks: typeof vi.resetAllMocks
    restoreAllMocks: typeof vi.restoreAllMocks
    useFakeTimers: typeof vi.useFakeTimers
    useRealTimers: typeof vi.useRealTimers
    advanceTimersByTime: typeof vi.advanceTimersByTime
    advanceTimersToNextTimer: typeof vi.advanceTimersToNextTimer
    runOnlyPendingTimers: typeof vi.runOnlyPendingTimers
    runAllTimers: typeof vi.runAllTimers
    getTimerCount: typeof vi.getTimerCount
    mocked: typeof vi.mocked
    isMockFunction: (fn: unknown) => fn is import('vitest').Mock
    Mock: typeof vi.fn
  }

  /**
   * Vitest vi object
   * Provides direct access to Vitest utilities
   */
  const vi: typeof import('vitest').vi
}

// Type augmentation for Vitest mock functions to add Jest compatibility methods
declare module 'vitest' {
  interface Mock<TArgs extends any[] = any, TReturn = any> {
    /**
     * Jest compatibility: specifies a resolved value for the mock
     */
    mockResolvedValue<T>(value: T): this

    /**
     * Jest compatibility: specifies a rejected value for the mock
     */
    mockRejectedValue<T>(reason: T): this

    /**
     * Jest compatibility: specifies a resolved value that resolves after a delay
     */
    mockResolvedValueOnce<T>(value: T): this

    /**
     * Jest compatibility: specifies a rejected value that rejects after a delay
     */
    mockRejectedValueOnce<T>(reason: T): this
  }
}

export {}
