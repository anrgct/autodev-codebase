# 缓存系统流程文档

## 概述

本项目实现了**三层缓存机制**，分别服务于不同的功能模块：

| 缓存类型 | 用途 | 存储位置 | 核心文件 |
|---------|------|---------|---------|
| **代码索引缓存** | 文件变更检测 | `~/.autodev-cache/roo-index-cache-{hash}.json` | `cache-manager.ts` |
| **AI摘要缓存** | 避免重复LLM调用 | `~/.autodev-cache/summary-cache/{hash}/files/` | `summary-cache.ts` |
| **依赖分析缓存** | 避免重复解析文件 | `~/.autodev-cache/dependency-cache/{hash}/analysis-cache.json` | `dependency/cache-manager.ts` |

---

## 1. 代码索引缓存 (Code Index Cache)

### 1.1 核心功能

用于**文件变更检测**，存储文件路径到内容哈希的映射关系。

### 1.2 数据结构

```typescript
// 简单键值对结构
{
  "src/index.ts": "sha256_hash_1",
  "src/utils.ts": "sha256_hash_2",
  ...
}
```

### 1.3 流程图

```text-chart
[代码索引缓存流程] (文件索引过程中的缓存使用)
BatchProcessor.processBatch:307
├── 文件删除处理 handleDeletions:342
│   └── 删除缓存 cacheManager.deleteHash:114
└── 批量处理 processItemsInBatches:378
    └── 单批次处理 processSingleBatch:398
        ├── 批量嵌入成功
        │   └── 更新缓存 cacheManager.updateHash:105
        └── 截断回退 _processItemWithTruncation:111
            └── 更新缓存 cacheManager.updateHash:105
```

### 1.4 关键方法

| 方法 | 文件 | 行号 | 功能 |
|-----|------|------|------|
| `initialize` | `cache-manager.ts` | L51-58 | 加载缓存文件到内存 (cache-manager.CacheManager.initialize:51-58) |
| `updateHash` | `cache-manager.ts` | L105-108 | 更新文件哈希并触发防抖保存 (cache-manager.CacheManager.updateHash:105-108) |
| `deleteHash` | `cache-manager.ts` | L114-117 | 删除指定文件哈希 (cache-manager.CacheManager.deleteHash:114-117) |
| `clearCacheFile` | `cache-manager.ts` | L77-89 | 清空所有缓存 (cache-manager.CacheManager.clearCacheFile:77-89) |
| `_performSave` | `cache-manager.ts` | L63-71 | 持久化缓存到磁盘 (cache-manager.CacheManager._performSave:63-71) |

### 1.5 防抖机制

使用 `lodash.debounce` 实现**1.5秒防抖**，避免频繁磁盘写入：

```typescript
this._debouncedSaveCache = debounce(async () => {
    await this._performSave()
}, 1500)
```

---

## 2. AI摘要缓存 (Summary Cache)

### 2.1 核心功能

用于**AI代码摘要**，实现**两级哈希机制**避免冗余LLM调用。

### 2.2 缓存层级

```text-chart
[两级缓存结构] (AI摘要缓存的层级关系)
SummaryCache
├── 文件级哈希 (fileHash) → 快速检测文件是否变化
│   └── 匹配 → 100% 缓存命中
│   └── 不匹配 → 进入块级检测
└── 代码块级哈希 (codeHash) → 精确检测变化块
    ├── 块哈希匹配 → 使用缓存摘要
    └── 块哈希不匹配 → 重新生成摘要
```

### 2.3 数据结构

```typescript
interface SummaryCache {
  version: string;                    // 缓存格式版本
  fingerprint: CacheFingerprint;      // 配置指纹
  fileHash: string;                   // 完整文件SHA256
  fileSummary?: string;               // 文件级摘要
  lastAccessed: string;               // 最后访问时间
  blocks: Record<string, BlockSummary>; // 块级缓存
}

interface BlockSummary {
  codeHash: string;      // 块内容哈希
  contextHash: string;   // 上下文哈希（仅元数据）
  summary: string;       // AI生成的摘要
  metadata: {            // 位置信息
    name?: string;
    startLine: number;
    endLine: number;
  };
}
```

### 2.4 缓存命中判定流程

```text-chart
[缓存命中判定] (filterBlocksNeedingSummarization:265)
加载缓存 loadCache:230
  ↓
Case 1: 无缓存 → 全部需要处理 (invalidReason: 'no-cache')
  ↓
Case 2: 配置指纹不匹配 → 全部需要处理 (invalidReason: 'config-changed')
  ↓
Case 3: 文件哈希匹配 → 100%命中 (hitRate: 1.0)
  ↓
Case 4: 文件哈希变化 → 逐块检测 (invalidReason: 'file-changed')
    ├── 块哈希匹配 → 使用缓存摘要
    └── 块哈希不匹配 → 清除摘要，触发重新生成
```

### 2.5 配置指纹

用于检测影响摘要生成的配置变更：

```typescript
interface CacheFingerprint {
  provider: 'ollama' | 'openai-compatible';
  modelId: string;           // 模型ID
  language: 'English' | 'Chinese';  // 语言设置
  promptVersion: string;     // Prompt版本
  temperature?: number;      // 温度参数
}
```

### 2.6 关键方法

| 方法 | 文件 | 行号 | 功能 |
|-----|------|------|------|
| `loadCache` | `summary-cache.ts` | L230-254 | 加载并验证缓存文件 (summary-cache.SummaryCacheManager.loadCache:230-254) |
| `filterBlocksNeedingSummarization` | `summary-cache.ts` | L265-366 | 核心缓存命中判定逻辑 (summary-cache.SummaryCacheManager.filterBlocksNeedingSummarization:265-366) |
| `updateCache` | `summary-cache.ts` | L371-462 | 原子更新缓存文件 (summary-cache.SummaryCacheManager.updateCache:371-462) |
| `cleanOrphanedCaches` | `summary-cache.ts` | L471-535 | 清理孤立缓存 (summary-cache.SummaryCacheManager.cleanOrphanedCaches:471-535) |
| `cleanOldCaches` | `summary-cache.ts` | L540-606 | 清理过期缓存(LRU) (summary-cache.SummaryCacheManager.cleanOldCaches:540-606) |
| `clearAllCaches` | `summary-cache.ts` | L616-668 | 清空项目所有缓存 (summary-cache.SummaryCacheManager.clearAllCaches:616-668) |

### 2.7 存储路径

```text-chart
[缓存存储路径] (~/.autodev-cache/summary-cache/)
summary-cache/
├── {project-hash-1}/
│   └── files/
│       └── src/
│           ├── cli-tools/
│           │   └── outline.ts.summary.json
│           └── code-index/
│               └── manager.ts.summary.json
└── {project-hash-2}/
    └── files/
        └── lib/
            └── utils.ts.summary.json
```

---

## 3. 依赖分析缓存 (Dependency Cache)

### 3.1 核心功能

用于**代码依赖分析**，避免重复解析未变更的文件。

### 3.2 数据结构

```typescript
interface AnalysisCache {
  version: string;              // 缓存格式版本
  fingerprint: CacheFingerprint; // 配置指纹
  files: Record<string, FileCacheEntry>; // 文件级缓存映射
  createdAt: string;            // 创建时间
  lastUpdated: string;          // 最后更新时间
}

interface FileCacheEntry {
  fileHash: string;             // 文件内容SHA256
  relativePath: string;         // 相对路径
  lastAnalyzed: string;         // 最后分析时间
  nodes: SerializedDependencyNode[]; // 依赖节点
  edges: DependencyEdge[];      // 依赖边
  language: string;             // 语言
  fileSize: number;             // 文件大小
  lineCount: number;            // 行数
}
```

### 3.3 流程图

```text-chart
[依赖分析缓存流程] (analyze:60 主流程)
analyze 函数
```
  ↓
初始化缓存管理器 DependencyCacheManager.initialize:79
  ↓
解析目录 parseDirectory
  ↓
遍历解析结果
  ├── 缓存命中 getCacheEntry:107
  │   ├── 验证配置指纹 isFingerprintValid:293
  │   ├── 验证文件哈希匹配
  │   └── 反序列化节点 deserializeNode:255
  │   └── 使用缓存结果
  └── 缓存未命中
      ├── 加载语言解析器 loadLanguageParser
      ├── 创建分析器并分析
      └── 存储到缓存 setCacheEntry:139
          ├── 序列化节点 serializeNode:244
          ├── 创建缓存条目
          └── 触发防抖保存 _debouncedSave
```

### 3.4 缓存限制

```typescript
const CACHE_LIMITS = {
  VERSION: '1.0',                    // 缓存格式版本
  MAX_CACHE_SIZE_BYTES: 10 * 1024 * 1024,  // 最大10MB
  MAX_NODES_PER_FILE: 1000,          // 单文件最大节点数
  MAX_CACHE_AGE_DAYS: 30,            // 最大缓存天数
}
```

### 3.5 关键方法

| 方法 | 文件 | 行号 | 功能 |
|-----|------|------|------|
| `initialize` | `dependency/cache-manager.ts` | L79-101 | 加载现有缓存 (cache-manager.DependencyCacheManager.initialize:79-101) |
| `getCacheEntry` | `dependency/cache-manager.ts` | L107-134 | 获取并验证缓存条目 (cache-manager.DependencyCacheManager.getCacheEntry:107-134) |
| `setCacheEntry` | `dependency/cache-manager.ts` | L139-177 | 存储分析结果到缓存 (cache-manager.DependencyCacheManager.setCacheEntry:139-177) |
| `isFingerprintValid` | `dependency/cache-manager.ts` | L293-299 | 验证配置指纹 (cache-manager.DependencyCacheManager.isFingerprintValid:293-299) |
| `cleanOldEntries` | `dependency/cache-manager.ts` | L349-360 | 清理过期条目 (cache-manager.DependencyCacheManager.cleanOldEntries:349-360) |
| `cleanOrphanedEntries` | `dependency/cache-manager.ts` | L366-388 | 清理孤立条目 (cache-manager.DependencyCacheManager.cleanOrphanedEntries:366-388) |

### 3.6 原子写入机制

```text-chart
[缓存原子写入] (_performSave:63)
```
构建缓存数据
  ↓
清理旧条目 cleanOldEntries:349
  ↓
序列化为JSON
  ↓
检查大小限制 (10MB)
  ↓
确保目录存在
  ↓
写入临时文件 {cache}.tmp.{pid}
  ↓
原子重命名为正式文件
  └── 失败 → 回退到 copy+delete
```

---

## 4. 缓存清理策略

### 4.1 三种清理机制对比

| 机制 | 依赖缓存 | 摘要缓存 | 索引缓存 |
|-----|---------|---------|---------|
| **过期清理** (超过30天) | ✅ 保存时自动 | ❌ 手动调用 | ❌ 无 |
| **孤立清理** (源文件已删除) | ✅ 支持 | ✅ 支持 | ❌ 无 |
| **完整清空** (整个项目) | ✅ CLI命令 | ✅ CLI命令 | ✅ CLI命令 |

### 4.2 CLI命令

```bash
# 清除摘要缓存
codebase outline --clear-cache

# 清除索引缓存
codebase index --clear-cache
```

---

## 5. 核心接口定义

### 5.1 ICacheManager (代码索引缓存接口)

```typescript
// src/code-index/interfaces/cache.ts
interface ICacheManager {
  initialize(): Promise<void>
  clearCacheFile(): Promise<void>
  getHash(filePath: string): string | undefined
  updateHash(filePath: string, hash: string): void
  deleteHash(filePath: string): void
  getAllHashes(): Record<string, string>
}
```

---

## 6. 文件位置速查

```text-chart
[缓存相关文件结构] (src目录下的缓存实现文件)
src/
├── code-index/
│   ├── cache-manager.ts          # 代码索引缓存实现
│   └── interfaces/
│       └── cache.ts              # 缓存接口定义
├── cli-tools/
│   └── summary-cache.ts          # AI摘要缓存实现
└── dependency/
    ├── cache-manager.ts          # 依赖分析缓存实现
    └── cache-types.ts            # 依赖缓存类型定义
```

---

## 7. 缓存性能指标

| 缓存类型 | 典型命中率 | 存储格式 | 大小限制 |
|---------|-----------|---------|---------|
| 代码索引缓存 | N/A (变更检测) | JSON | 无限制 |
| AI摘要缓存 | >90% | JSON | 1MB/文件 |
| 依赖分析缓存 | >80% | JSON | 10MB/项目 |

---

## 8. 最佳实践

1. **缓存位置**: 所有缓存统一存储在 `~/.autodev-cache/` 目录下
2. **项目隔离**: 使用项目路径SHA256哈希前16位作为隔离标识
3. **原子写入**: 所有缓存文件使用临时文件+重命名机制确保原子性
4. **防抖保存**: 频繁更新使用防抖机制减少磁盘I/O
5. **版本控制**: 缓存格式版本不匹配时自动重建缓存
