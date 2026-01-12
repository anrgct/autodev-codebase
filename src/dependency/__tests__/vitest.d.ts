/// <reference types="vitest" />

import type { DependencyEdge } from '../models'

declare module 'vitest' {
  interface Assertion<T = any> {
    /**
     * Custom matcher to check if edges contain a specific callee
     */
    toContainCallee(calleeName: string): void

    /**
     * Custom matcher to check if edges do not contain a specific callee
     */
    notToContainCallee(calleeName: string): void
  }

  interface AsymmetricMatchersContaining {
    toContainCallee(calleeName: string): void
    notToContainCallee(calleeName: string): void
  }
}