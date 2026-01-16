# 依赖分析缓存使用指南

## 概述

依赖分析缓存功能通过缓存已分析文件的结果，避免重复解析和分析未改变的文件，显著提升大型代码库的分析速度。

## 特性

- **文件级缓存**: 缓存每个文件的完整分析结果（节点和边）
- **内容哈希验证**: 使用 SHA-256 哈希检测文件变更
- **配置指纹**: 自动检测解析器版本变化，确保缓存有效性
- **自动清理**: 自动清理过期缓存（默认 30 天）
- **增量分析**: 仅重新分析修改过的文件
- **优化存储**: 缓存不包含 `sourceCode` 字段以减少体积，仅存储依赖关系信息

## 使用方法

### 基础使用（默认启用缓存）

**注意**: 缓存默认是**启用**的，以获得更好的性能。第二次分析相同项目时，速度会快 10-50 倍。

```typescript
import { analyze } from './dependency'
import { createNodeDependencies } from './adapters/nodejs'

const deps = createNodeDependencies()

// 默认启用缓存（无需显式指定）
const result = await analyze('/path/to/project', deps, 100)

console.log(`分析了 ${result.summary.totalFiles} 个文件`)
console.log(`发现 ${result.summary.totalNodes} 个组件`)

// 也可以显式启用缓存
const result2 = await analyze('/path/to/project', deps, 100, {
  enableCache: true
})
```

### 禁用缓存

如果你需要禁用缓存（例如测试或调试），可以显式设置：

```typescript
// 禁用缓存
const result = await analyze('/path/to/project', deps, 100, {
  enableCache: false
})
```

### 自定义缓存目录

```typescript
// 使用自定义缓存目录
const result = await analyze('/path/to/project', deps, 100, {
  enableCache: true,
  cacheBaseDir: '/custom/cache/path'
})
```

### 手动管理缓存

```typescript
import { DependencyCacheManager } from './dependency'

const cacheManager = new DependencyCacheManager(
  '/path/to/project',
  fileSystem,
  '/custom/cache/dir'
)

await cacheManager.initialize()

// 获取缓存统计
const stats = cacheManager.getStats()
console.log(`缓存命中率: ${(stats.hitRate * 100).toFixed(1)}%`)
console.log(`已缓存文件: ${stats.cachedFiles}/${stats.totalFiles}`)

// 清理孤立的缓存条目（源文件已删除）
const removed = await cacheManager.cleanOrphanedEntries()
console.log(`清理了 ${removed} 个孤立缓存条目`)

// 清理旧缓存（超过 30 天）
const oldRemoved = await cacheManager.cleanOldCacheEntries(30)
console.log(`清理了 ${oldRemoved} 个过期缓存条目`)

// 完全清空缓存
await cacheManager.clearCache()
```

## 缓存结构

### 存储位置

默认缓存目录：`~/.autodev-cache/dependency-cache/{projectHash}/analysis-cache.json`

- `{projectHash}`: 项目路径的 SHA-256 哈希（前 16 位），用于隔离不同项目
- 单文件 JSON 格式，便于管理和传输

### 缓存格式

```json
{
  "version": "1.0",
  "fingerprint": {
    "version": "1.0",
    "parserVersion": "1.0.0"
  },
  "files": {
    "src/index.ts": {
      "fileHash": "abc123...",
      "relativePath": "src/index.ts",
      "lastAnalyzed": "2025-01-16T12:00:00.000Z",
      "nodes": [...],
      "edges": [...],
      "language": "typescript",
      "fileSize": 1024,
      "lineCount": 50
    }
  },
  "createdAt": "2025-01-16T10:00:00.000Z",
  "lastUpdated": "2025-01-16T12:00:00.000Z"
}
```

## 性能优化

### 缓存命中率优化

1. **第一次分析**: 无缓存，全量解析（较慢）
2. **第二次分析**: 缓存命中率 100%（极快，通常快 10-50 倍）
3. **修改部分文件**: 仅重新分析修改的文件（增量更新）

### 缓存限制

```typescript
export const CACHE_LIMITS = {
  VERSION: '1.0',                      // 缓存格式版本
  MAX_CACHE_SIZE_BYTES: 10 * 1024 * 1024,  // 最大缓存文件大小 (10MB)
  MAX_NODES_PER_FILE: 1000,            // 单文件最大节点数
  MAX_CACHE_AGE_DAYS: 30,              // 最大缓存年龄（天）
}
```

**说明**: 缓存文件大小限制为 10MB，这对大多数项目来说已足够。如果项目特别大，缓存会自动清理旧条目以保持在限制内。

## 故障排除

### 缓存未命中

如果缓存命中率低，检查：

1. **文件内容是否变化**: 缓存使用 SHA-256 哈希，任何字符变化都会导致缓存失效
2. **配置是否变化**: 解析器版本更新会使所有缓存失效
3. **缓存是否过期**: 超过 30 天的缓存会被自动清理

### 清空损坏的缓存

```typescript
const cacheManager = new DependencyCacheManager(projectPath, fileSystem)
await cacheManager.initialize()
await cacheManager.clearCache()
```

## API 参考

### DependencyCacheManager

**构造函数**

```typescript
constructor(
  projectPath: string,      // 项目根目录
  fileSystem: IFileSystem,  // 文件系统抽象
  cacheBaseDir?: string     // 可选的自定义缓存目录
)
```

**主要方法**

- `initialize(): Promise<void>` - 初始化并加载缓存
- `getCacheEntry(filePath, content): { nodes, edges } | null` - 获取缓存条目
- `setCacheEntry(filePath, content, nodes, edges, language): Promise<void>` - 存储缓存条目
- `deleteCacheEntry(filePath): void` - 删除缓存条目
- `clearCache(): Promise<void>` - 清空所有缓存
- `getStats(): CacheStats` - 获取缓存统计信息
- `cleanOrphanedEntries(): Promise<number>` - 清理孤立条目
- `cleanOldCacheEntries(maxAgeDays): Promise<number>` - 清理过期条目
- `flush(): Promise<void>` - 强制保存缓存到磁盘

### 类型定义

```typescript
interface AnalysisOptions {
  includeNodeModules?: boolean
  includeTests?: boolean
  maxDepth?: number
  followSymlinks?: boolean
  fileFilter?: FileFilter
  enableCache?: boolean      // 启用缓存
  cacheBaseDir?: string      // 自定义缓存目录
}

interface CacheStats {
  totalFiles: number         // 总文件数
  cachedFiles: number        // 已缓存文件数
  invalidFiles: number       // 无效文件数
  hitRate: number            // 缓存命中率 (0-1)
  invalidReasons: {
    fileChanged: number      // 文件内容变化
    configChanged: number    // 配置变化
    notCached: number        // 未缓存
  }
}
```

## 示例：性能对比

```typescript
import { analyze } from './dependency'

// 第一次分析（无缓存）
console.time('First analysis')
const result1 = await analyze(projectPath, deps, 100, { enableCache: true })
console.timeEnd('First analysis')
// 输出: First analysis: 5000ms

// 第二次分析（使用缓存）
console.time('Second analysis')
const result2 = await analyze(projectPath, deps, 100, { enableCache: true })
console.timeEnd('Second analysis')
// 输出: Second analysis: 100ms

console.log(`性能提升: ${(5000 / 100).toFixed(1)}x`)
// 输出: 性能提升: 50.0x
```
