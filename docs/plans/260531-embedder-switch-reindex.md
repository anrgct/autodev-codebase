# 260531 切换 Embedding 模型后搜索未触发全量重索引

## 主题/需求

**问题**：使用 80M 模型索引后，切换到 160M 模型搜索，系统检测到维度不匹配（320→640）并重建了 Qdrant collection，但实际只重新索引了 `autodev-config.json` 一个文件，其他 7 个文件被错误跳过，导致搜索结果全是配置文件路径而非实际的代码内容。

**预期**：collection 因维度不匹配重建后，应触发全量重索引，确保所有文件都用新模型重新向量化。

## 代码背景

关键文件：

| 文件 | 角色 |
|------|------|
| `src/code-index/manager.ts` | 入口协调，`initialize()` 方法决定搜索/索引路径 |
| `src/code-index/manager.ts` (`_initializeForSearchOnly`) | 搜索专用初始化，调用 `vectorStore.initialize()` |
| `src/code-index/orchestrator.ts` (`startIndexing`) | 实际的索引调度，决定增量 vs 全量扫描 |
| `src/code-index/processors/scanner.ts` (`scanDirectory`) | 扫描文件，通过 cache hash 判断是否跳过 |
| `src/code-index/service-factory.ts` (`createVectorStore`) | 检测维度变化，标记 "collection will be recreated" |
| `src/code-index/cache-manager.ts` | 管理文件 hash 缓存 |

**数据流**：

```
searchOnly 路径:
  initialize()
    → _recreateServices()
      → reconcileIndex()       [向量存储未初始化，查询旧 collection]
      → "Index is already up-to-date."
    → _initializeForSearchOnly()
      → vectorStore.initialize()  [重建 collection，旧数据删除]
      → 但 cache 未清理!

  searchIndex() → "not ready"
    → waitForIndexingCompletion()
      → manager.startIndexing()
        → orchestrator.startIndexing()
          → vectorStore.initialize()  [collection 已存在，无变化]
          → hasExistingData = false
          → 走 full scan
            → scanner 检查 cache hash → 全部匹配 → 全部跳过
```

## 运行现象

### 复现步骤

```bash
# 1. 用 80M 模型强制索引（维度 320）
npm run dev -- config --set "embedderGgufLlmPath=.../F2LLM-v2-80M.Q8_0-pooling-NONE.gguf" --demo
npm run dev -- index --force --demo

# 2. 切换到 160M 模型（维度 640）
npm run dev -- config --set "embedderGgufLlmPath=.../F2LLM-v2-160M.Q8_0-pooling-NONE.gguf" --demo

# 3. 搜索（本应触发自动重索引）
npm run dev -- search "where is the actual train method..." --demo --log-level=debug
```

### 关键日志（修复前）

```
[Reconciling index with filesystem...]
[Index is already up-to-date.]                           ← 假阳性，旧 collection 还在
[Collection exists with vector size 320, but expected 640. Recreating collection.]
[Successfully created new collection with vector size 640]
[SearchOnly 没有清理 cache 的日志]                        ← 缺少清理
[Starting full scan...]
[Scanner] File model.py: cachedHash=56d84..., currentHash=56d84...
[Scanner] Skipping unchanged file: model.py              ← 7 个文件被跳过
[Scanner] Final results: 35 code blocks, processed: 1, skipped: 7, totalBlockCount: 35
```

### 正常日志（修复后）

```
[SearchOnly] New collection created, clearing cache to avoid stale file hashes...  ← 新增清理
[Collection empty but cache may have stale hashes; clearing cache...]              ← 防御清理
[Scanner] File model.py: cachedHash=undefined, currentHash=56d84...
[Scanner] Final results: 86 code blocks, processed: 8, skipped: 0, totalBlockCount: 86
```

### 增量索引验证（修复后）

```
[Index is already up-to-date.]
[Scanner] Final results: 0 code blocks, processed: 0, skipped: 8
[No new or changed files found]
```

## 归因分析

### 根因 1：`_initializeForSearchOnly` 未清理 cache

`_initializeForSearchOnly()` 调用 `vectorStore.initialize()`，后者检测到维度不匹配（320 vs 640）后重建 collection（删除旧数据创建新 collection），返回 `collectionCreated = true`。然而该方法**没有清理本地 cache 文件**，留下 80M 时期计算的文件 hash。

### 根因 2：`reconcileIndex` 时机过早

`_recreateServices()` 在 L521 调用了 `reconcileIndex()`，但此时 vector store **尚未初始化**。`getAllFilePaths()` 查询的是旧的 80M collection（仍然存在且有数据），返回所有文件路径。`reconcileIndex` 判断没有 stale 文件，输出 `"Index is already up-to-date."`。这个假阳性 log 本身没错（旧 collection 确实有数据），但给调试带来了困惑。

### 根本原因链

```
collection 重建（维度不匹配）→ cache 未同步清理
→ full scan 时 scanner 发现 cachedHash === currentHash
→ 跳过 7/8 的文件
→ 只有 config 文件因用户修改 config 导致 hash 变化而被重新索引
```

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| Fix #1 | 在 `_initializeForSearchOnly` 中，当 `vectorStore.initialize()` 返回 `true` 时清理 cache | 与 orchestrator 中已有的 `collectionCreated → clearCache` 模式一致，是最直接的责任归属 |
| Fix #2 | 在 orchestrator full scan 路径中，当 `!collectionCreated` 时防御性清理 cache | 覆盖任何其他可能导致 collection 为空但 cache 未清理的路径（防御纵深）|

**为什么不修改 `reconcileIndex` 的时机**：虽然它在 vector store 初始化前运行，会产生误导性的日志，但不会造成实际数据问题。将其移动到初始化后需要较大重构，收益有限。

## 实施计划

- [x] 修复 `_initializeForSearchOnly`：捕获 `collectionCreated` 并清理 cache
- [x] 修复 orchestrator full scan 路径：防御性清理 cache
- [x] 验证：80M → 160M 搜索触发全量索引

## 实施记录

### 2026-05-31

**修改 1**：`src/code-index/manager.ts` — `_initializeForSearchOnly()` 方法

- 将 `const collectionCreated = await vectorStore.initialize()` 的结果保存
- 当 `collectionCreated === true` 时调用 `this._cacheManager!.clearCacheFile()`
- 新增日志 `[SearchOnly] New collection created, clearing cache to avoid stale file hashes...`

**修改 2**：`src/code-index/orchestrator.ts` — `startIndexing()` 方法的 full scan 分支

- 在 `else` 分支（full scan）开头，当 `!collectionCreated` 时调用 `this.cacheManager.clearCacheFile()`
- 新增日志 `[CodeIndexOrchestrator] Collection empty but cache may have stale hashes; clearing cache...`

**验证**：通过完整的 80M → 160M 切换流程验证修复有效
- 索引结果：`processed: 8, skipped: 0, totalBlockCount: 86`
- 增量扫描：`processed: 0, skipped: 8` — 正确识别无需变更
- 两个修复点日志均正确触发

## 修订记录

### 2026-05-31
**问题：** 切换 embedding 模型后搜索未触发全量重索引，只索引了配置文件
**修复：** 在 `_initializeForSearchOnly` 和 orchestrator full scan 路径中清理 cache

## 总结

### 关键收获

- `_initializeForSearchOnly` 和 `orchestrator.startIndexing` 是两个独立的 code path，cache 清理逻辑需要同步覆盖
- "已检查到问题并修复"并不等于"所有相关 code path 都修复了"——future-proof 最佳实践是在不同层级都加防御
- `reconcileIndex` 在 vector store 初始化前运行的时序问题虽不致命，但值得后续重构时注意

### 后续建议

- 考虑将 `reconcileIndex` 移出 `_recreateServices`，放到 vector store 初始化之后执行，消除假阳性日志
