# 260515-cache-subcommand

## 主题/需求

实现统一的 `codebase cache` 子命令，集中管理项目中四类缓存和向量数据。当前缓存管理散落在 `index --clear-cache` 和 `outline --clear-cache` 两个子命令中，用户缺乏统一的查看和管理入口。

### 目标

- `codebase cache --list` — 列出所有缓存/数据，带序号
- `codebase cache --clear 1,2-3` — 按序号清除（支持范围、逗号组合、`all`）
- 支持 `--type` 类型过滤、`--path` 项目过滤、`--json` 输出
- 对 Qdrant 远程服务不可达的情况优雅降级

### 四类可管理数据

| # | 类型 | 存储位置 | 性质 | 管理类 |
|---|------|---------|------|--------|
| 1 | 代码索引缓存 | `~/.autodev-cache/roo-index-cache-{sha256}.json` | 本地文件 | `CacheManager` (`src/code-index/cache-manager.ts`) |
| 2 | AI摘要缓存 | `~/.autodev-cache/summary-cache/{hash}/files/...` | 本地目录 | `SummaryCacheManager` (`src/cli-tools/summary-cache.ts`) |
| 3 | 依赖分析缓存 | `~/.autodev-cache/dependency-cache/{hash}/analysis-cache.json` | 本地文件 | `DependencyCacheManager` (`src/dependency/cache-manager.ts`) |
| 4 | Qdrant向量库 | Qdrant Server（默认 `http://localhost:6333`），collection 名 `ws-{sha256_16}` | **远程服务** | `QdrantVectorStore` (`src/code-index/vector-store/qdrant-client.ts`) |

## 代码背景

### CLI 入口

`src/cli.ts` (cli.main) — 使用 commander.js 子命令模式，当前注册了 `search`、`index`、`outline`、`stdio`、`config`、`call` 六个子命令。

### 现有清除逻辑

- `index --clear-cache` → `src/commands/index.ts` (index.indexHandler) → `CacheManager.clearCacheFile()` → 删除索引缓存文件
- `outline --clear-cache` → `src/commands/outline.ts` (outline.outlineHandler) → `SummaryCacheManager.clearAllCaches()` → 递归删除摘要缓存目录
- 依赖分析缓存目前**没有 CLI 清除入口**
- Qdrant 向量库目前**没有 CLI 清除入口**（只有内部 `QdrantVectorStore.deleteCollection()` / `clearCollection()`）

### 关键接口

```
src/code-index/cache-manager.ts    → CacheManager: clearCacheFile(), getAllHashes()
src/cli-tools/summary-cache.ts     → SummaryCacheManager: clearAllCaches(), cleanOrphanedCaches(), cleanOldCaches()
src/dependency/cache-manager.ts    → DependencyCacheManager: clearCache(), cleanOrphanedEntries(), cleanOldCacheEntries(), getStats()
src/code-index/vector-store/qdrant-client.ts → QdrantVectorStore: deleteCollection(), clearCollection(), getCollectionInfo(), collectionExists()
```

### 缓存目录结构

```
~/.autodev-cache/
├── roo-index-cache-{sha256}.json          # 代码索引缓存
├── summary-cache/
│   └── {projectHash}/
│       └── files/
│           └── src/**/*.summary.json       # AI摘要缓存
└── dependency-cache/
    └── {projectHash}/
        └── analysis-cache.json             # 依赖分析缓存
```

## 关键决策

### 1. Qdrant 纳入统一管理

**决策：** 将 Qdrant 向量库作为第 4 类缓存统一列出和清除。

**理由：**
- 从用户视角看，向量数据也是"可以清除的索引数据"
- 之前 `index --clear-cache` 实际上也清除了 Qdrant collection（通过 `clearIndexData()`），证明两者在语义上是关联的
- 统一入口降低认知负担

**风险：** Qdrant 是远程服务，可能不可达。处理方式：`--list` 时标记状态为 `不可达` 但不报错退出；`--clear` 时若不可达则报错。

### 2. Qdrant 发现方式

**决策：** 基于当前项目配置中的 `qdrantUrl` 连接 Qdrant，通过 `--path` 可切换项目。

**理由：**
- Qdrant 的 URL/API Key 存在 `autodev-config.json` 中，不同项目可能指向不同实例
- 扫描所有可能的 Qdrant 实例不现实
- 对本地文件缓存则扫描整个 `~/.autodev-cache/` 目录（与项目无关）

### 3. 保留现有清除入口

**决策：** `index --clear-cache` 和 `outline --clear-cache` **保留不变**，`cache` 作为新的统一入口。

**理由：** 向后兼容，已有的脚本和工作流不受影响。

### 4. `--list` 输出设计

```
=== Cache & Data Store List ===

序号  类型             项目              条目数      大小        状态
──────────────────────────────────────────────────────────────────────────
1     代码索引缓存      my-project        45 文件    12.3 KB     ✓
2     AI摘要缓存        my-project        128 文件   1.2 MB      ✓
3     依赖分析缓存      my-project        32 条目    256 KB      ✓
4     Qdrant向量库      my-project        1,204 pts  15.3 MB     ✓  (localhost:6333)
5     代码索引缓存      another-project   18 文件    4.5 KB      ✓
6     Qdrant向量库      another-project   -          -           ✗ 不可达
```

### 5. `--clear` 语法

支持：
- 单个：`--clear 1`
- 逗号分隔：`--clear 1,3,5`
- 范围：`--clear 2-4`
- 混合：`--clear 1,3-5`
- 全部：`--clear all`

清除前默认打印确认信息，`-y/--yes` 跳过确认。

## 实施计划

- [x] 1. 创建 `src/commands/cache.ts`，定义 `createCacheCommand()` 和 `cacheHandler()`
- [x] 2. 在 `src/cli.ts` 中注册 `cache` 子命令
- [x] 3. 实现本地缓存发现逻辑（扫描 `~/.autodev-cache/` 目录）
- [x] 4. 实现 Qdrant 向量库发现逻辑（通过配置连接 Qdrant 并列出 collections）
- [x] 5. 实现 `--list` 格式化输出（含 `--json` 支持）
- [x] 6. 实现 `--clear` 序号解析（逗号+范围+all）
- [x] 7. 实现 `--clear` 清除执行（本地文件删除 + Qdrant API 调用）
- [x] 8. 实现 `--type` 过滤和 `--path` 过滤
- [x] 9. 编写单元测试

## 实施记录

### 2025-05-15
- 与用户确认需求：新增 `cache` 子命令统一管理四类缓存/Qdrant数据
- 需求确认通过，创建本 task doc
- 关键设计决策已明确：Qdrant纳入统一管理、不可达时优雅降级、保留现有`--clear-cache`入口
- 实现 `src/commands/cache.ts`：
  - `discoverLocalCaches()` — 扫描 `~/.autodev-cache/` 发现三种本地缓存
  - `discoverQdrantCollections()` — 通过 Qdrant API 发现 `ws-*` 集合
  - `printTable()` — 表格格式输出
  - `printJson()` — JSON 格式输出
  - `parseClearIndices()` — 解析 `1,2-3,all` 序号格式
  - `executeClear()` — 执行清除（本地文件删除 + Qdrant API 调用）
  - 支持选项：`--list`、`--clear`、`--type`、`--json`、`-y`
- 在 `src/cli.ts` 中注册 `cache` 子命令
- 验证：`--help`、`--list`、`--type qdrant`、`--json` 均正常运行
- 实现项目名自动解析：
  - `registerProjectToCacheMap()` — 在 `shared.ts` 中，任何命令运行时自动注册 `工作空间路径 → hash`
  - `index`、`outline`、`call` 命令在各 handler 中调用注册函数
  - `cache --list` 从 `project-map.json` 读取，hash 匹配到路径后显示目录名
  - 未注册项目显示 `未知(hash前缀...)`，首次运行后自动注册

## 修订记录

### 2026-06-03 (SQLite 后端支持 + 单元测试)

**新增：cache 子命令支持 SQLite 向量库**

- **背景**：docs/plans/260529-local-vector-store.md 引入 `SQLiteVectorStore` 作为新的默认后端
  （`~/.autodev-cache/vector-store/{ws-hash16}/index.db`），但 cache 子命令当时只管理 Qdrant
  collections。新建 SQLite 后端后，命令式 `cache --list` / `cache --clear` 无法发现 / 清理
  这部分数据
- **实施**：
  - `CacheType` 联合类型扩展为 `'index' | 'summary' | 'dependency' | 'qdrant' | 'sqlite'`
  - `CacheEntry` 新增 `sqliteDbPath?: string` 字段
  - `discoverLocalCaches` 新增第 4 段：扫描 `~/.autodev-cache/vector-store/ws-{hash16}/`
    下 `index.db`（含 `-wal` / `-shm` sidecar 计入大小），不存在 / 目录为空时 status='empty'
  - `executeClear` 新增 `sqlite` 分支：删除整个 `vector-store/ws-{hash16}/` 目录
    （更简洁地处理 sidecar，与 `SQLiteVectorStore.deleteCollection` 行为一致）
  - `formatCount` / `typeMap` / CLI `--type` 帮助文案 / `CacheType` 联合类型补齐 sqlite
  - `discoverLocalCaches(map, cacheBase?)` 增加可选参数，使其可在 tmpdir 下做单测
  - 暴露内部辅助函数 `_test_discoverLocalCaches` / `_test_parseClearIndices` / `_test_cacheBase`
- **单测**（`src/commands/__tests__/cache.spec.ts`，15 个 case，全部通过）：
  - `parseClearIndices`：单值 / 逗号 / 范围 / 混合 / all / 越界 / 格式错误 / 空串
  - `discoverLocalCaches`：缺失缓存目录 / index cache / dependency cache / SQLite .db 存在 /
    SQLite 空目录 / 非 `ws-` 目录名防御 / project map 解析项目名
- **验证**：
  - `npx vitest run src/commands/__tests__/cache.spec.ts`：15 / 15 通过
  - `npx tsc --noEmit`：仅 2 个**已存在**的 `llamacpp-rerank.ts` 错误，与本次无关
  - `--list` 现有行（"Qdrant向量库"）下方新增"SQLite向量库"行
  - `--type sqlite` / `--type all` 切换正常
  - `--clear N` 清理 SQLite db 与 sidecar

## 总结

（待实施完成后填写）
