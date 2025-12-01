import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // E2E测试需要更长的超时时间
    testTimeout: 120000,    // 2分钟单个测试超时
    hookTimeout: 300000,    // 5分钟beforeAll/afterAll超时
    setupFiles: ['./vitest.setup.ts'],
    // E2E测试需要看到详细日志
    silent: false,
    reporter: ['verbose'],
    // 只运行E2E测试
    include: ['src/__e2e__/**/*.ts', '**/*.e2e.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      '.git/**',
      'src/__tests__/**',    // 排除单元测试
    ],
    // E2E测试串行执行，避免资源冲突
    maxConcurrency: 1,
    // 不使用fork隔离，E2E需要完整的进程环境
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        minForks: 1,
        isolate: false
      }
    }
  },
  esbuild: {
    target: 'node18'
  },
  resolve: {
    alias: {
      // VSCode mock removed - project is CLI-only
    }
  },
  ssr: {
    external: ['vscode', '@types/vscode']
  },
  optimizeDeps: {
    external: ['vscode', '@types/vscode']
  }
})