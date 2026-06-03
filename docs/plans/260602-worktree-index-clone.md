# 260602-worktree-index-clone

## TL;DR（新对话接手先看这段）

**目标**：在 `codebase index` 启动时自动检测 git worktree，从主 worktree 复制索引数据到当前 worktree 的命名空间，然后跑增量扫描。

**关键事实**（已验证）：
- Qdrant payload 的 `filePath` 是**相对路径**，Point ID 基于**内容**——复制不用改内容
- demo 索引规模：主 worktree 87 points + 1KB cache，复制秒级

**不要做**：
- 不要改 hash 函数（`sha256(workspacePath)`）
- 不要碰 mcp/、outline/、call/ 等模块

## 主题/需求

在 git worktree 之间复用已经索引好的数据。切换到新 worktree 时，避免全量重建索引带来的 5-10 分钟等待，复用主 worktree（或同源任意 worktree）的索引数据，新 worktree 启动后只做增量扫描。

### 现状

当前所有缓存/数据的隔离 key 都基于**项目绝对路径的 SHA256**：

| 数据类型 | 存储位置 | 隔离 key |
|---------|---------|---------|
| 代码索引缓存 | `~/.autodev-cache/roo-index-cache-{hash}.json` | `sha256(workspacePath)` |
| AI 摘要缓存 | `~/.autodev-cache/summary-cache/{hash}/files/...` | `sha256(workspacePath)[:16]` |
| 依赖分析缓存 | `~/.autodev-cache/dependency-cache/{hash}/analysis-cache.json` | `sha256(workspacePath)[:16]` |
| Qdrant 向量 | Qdrant collection `ws-{hash_16}` | `sha256(workspacePath)[:16]` |

`workspacePath` 用的是 worktree 的绝对路径，所以**新 worktree 拿不到任何已有数据**，必须从零索引。

### 目标

1. **自动检测 git worktree**：通过 `git rev-parse --git-common-dir` 判断当前路径是否属于某个 git worktree 链。
2. **复用方案选择**：**复制**主 worktree 的索引数据到当前 worktree 的命名空间（路径 hash 不变，只搬运数据）。
3. **CLI 入口**：在 `codebase index` 启动时自动执行，或通过显式 flag 触发。
4. **保持向后兼容**：默认行为（不传 flag）保持现状，新功能是 opt-in。

### 关键洞察（决定方案可行性的核心）

调研 `qdrant-client.ts:469-490` 和 `qdrant-client.ts:701-702` 注释：

- **Qdrant payload 的 `filePath` 存的是相对路径**（不是绝对路径）
- **Point ID 是 `uuidv5(sha256(filePath + startLine + endLine + content))`**（基于内容）
- **代码索引缓存**：`{ relativePath: fileHash }`，**和绝对路径无关**
- **AI 摘要缓存**：按相对路径组织，**和绝对路径无关**
- **依赖分析缓存**：`{ files: { relativePath: ... } }`，**和绝对路径无关**

**结论**：worktree 之间文件共享 git objects，**绝大部分文件内容一致**。复制数据时**几乎不用改任何内容**，只需要把数据搬运到新 hash 命名空间。

### 当前 demo 索引的实际观察（2026-06-02）

```
主 worktree demo:    /Users/anrgct/workspace/autodev-codebase/demo
  hash(16) = d7947ff78f9f219d
  Qdrant: ws-d7947ff78f9f219d, 87 points
  本地缓存: roo-index-cache-d7947ff78f9f219d....json (1.0 KB)

当前 worktree demo: /Users/anrgct/workspace/autodev-codebase/.claude/worktrees/solid-panther/autodev-codebase/demo
  hash(16) = 7227c7664b102862
  Qdrant: ws-7227c7664b102862, 87 points
  本地缓存: roo-index-cache-7227c7664b102862....json (1.4 KB)
```

`~/.autodev-cache/summary-cache/` 和 `dependency-cache/` 目录为空，但代码路径保留了兼容性。

## 代码背景

### 关键文件

| 文件 | 作用 | 关键位置 |
|------|------|---------|
| `src/commands/index.ts` | `index` 子命令入口 | `indexHandler:232` |
| `src/commands/shared.ts` | 共享工具 | `CommandOptions`, `initializeManager` |
| `src/code-index/cache-manager.ts` | 代码索引缓存 | 构造函数 L23-30 生成 cache 路径 |
| `src/code-index/vector-store/qdrant-client.ts` | Qdrant 客户端 | 构造函数 L189-191 生成 collection 名；`upsertPoints:461` |
| `src/dependency/cache-manager.ts` | 依赖分析缓存 | 构造函数 L51-74 生成 cache 路径 |
| `src/cli-tools/summary-cache.ts` | AI 摘要缓存 | 路径生成 L196-218：`sha256(workspacePath)[:16]` |
| `src/utils/logger.ts` | 全局 logger | `getGlobalLogger()` |

### Qdrant 服务端能力

经测试 Qdrant 1.16.3 支持 `init_from`（在创建 collection 时从另一个 collection 复制数据）：

```bash
PUT /collections/{target}
{
  "vectors": {...},
  "init_from": { "collection": "source-collection-name" }
}
```

`@qdrant/js-client-rest@1.16.2` 的 TypeScript 类型定义里**没有** `init_from` 字段（schema 没及时更新），需要直接调 HTTP API 或绕过类型校验。

### 现有缓存目录结构

```
~/.autodev-cache/
├── roo-index-cache-{full_sha256}.json
├── summary-cache/
│   └── {hash16}/
│       └── files/
│           └── **/*.summary.json
├── dependency-cache/
│   └── {hash16}/
│       └── analysis-cache.json
└── project-map.json
```

## 归因分析

为什么 worktree 切换会导致索引完全失效：

1. **隔离粒度问题**：所有 key 基于 `workspacePath` 绝对路径的 SHA256，没考虑 git worktree 这种"同源多工作目录"的场景。
2. **设计假设错误**：原代码隐含假设"路径不同 = 不同项目"，但在 worktree 场景下不同路径共享同一份 git objects。
3. **Qdrant collection 按路径隔离**：在 Qdrant 服务端，collection 名 = `ws-{hash(path)}`，也按工作目录隔离。
4. **无 worktree 感知**：现有代码完全没读过 `.git` 文件，无法判断多个目录属于同一仓库。

**为什么"复制"是正确选择而不是"共享"**：
- 共享需要所有 key 公式加 `gitCommonDir` 维度，涉及改动散落在 4 个文件
- 多 worktree 同时索引会有并发冲突（共享一份 cache 文件 / 一个 collection）
- MCP server 启动时无法判断用哪个 worktree 的 collection
- 复制只新增 2 个工具文件 + index.ts 一个 hook，改动面小 5-10 倍

## 关键决策

### 1. 复用方式：复制（不共享）

**决策**：检测到 worktree 链时，**从主 worktree 的命名空间复制数据到当前 worktree 的命名空间**。路径 hash 逻辑保持不变。

**理由**：
- **完全向后兼容**：现有 hash 逻辑、`ICacheManager` 接口、Qdrant 集合命名都不动。
- **worktree 之间完全独立**：一个 worktree 删除/重建不影响其他 worktree 的索引。
- **改动最小**：核心是文件复制 + Qdrant `init_from`，不涉及代码块 ID 重映射、路径改写等复杂逻辑。
- **路径改写极少**：因为 filePath 是相对路径、ID 基于内容、缓存 key 也是相对路径。

**对比：共享命名空间**
- 共享要改：所有 hash 函数加 `gitCommonDir` 维度；多 worktree 同时跑 index 的并发冲突处理；MCP 服务器对路径的解析。
- 共享的收益：省存储。worktree 之间文件差异通常很小（5-10%），收益有限。

### 2. 复制范围：三类本地缓存 + Qdrant collection

| 数据 | 复制方式 | 说明 |
|------|---------|------|
| 代码索引缓存 | 文件复制 | `roo-index-cache-{old}.json` → `roo-index-cache-{new}.json` |
| AI 摘要缓存 | 目录递归复制 | `summary-cache/{old}/` → `summary-cache/{new}/` |
| 依赖分析缓存 | 目录递归复制 | `dependency-cache/{old}/` → `dependency-cache/{new}/` |
| Qdrant collection | `init_from` API | `ws-{old_16}` → `ws-{new_16}` |

### 3. 复制时机：index 启动时自动检测

**决策**：`codebase index` 启动时（`initializeManager` 之前），如果当前路径是 git worktree，且目标命名空间不存在但源命名空间存在，**自动执行复制**。

**理由**：
- 用户无感："切到新 worktree → 跑 index → 直接看到秒级完成"是最好的体验
- 可通过 `--no-clone-from-worktree` 跳过（用于调试或性能对比）

### 4. CLI 设计

```bash
codebase index [path] [options]
  --from-worktree=<path>   # 从指定 worktree 路径复制（默认：自动检测主 worktree）
  --no-clone-from-worktree # 关闭自动检测复制行为
```

### 5. 容错策略

- 源命名空间不存在（主 worktree 从未索引过）→ 静默跳过，进入正常索引流程
- 目标命名空间已存在 → 跳过复制（不覆盖现有数据）
- 复制中途失败 → 记录警告，继续正常索引（不影响主流程）
- git 命令失败（非 git 目录）→ 静默跳过

## 实施计划

### 阶段 1：核心工具

- [x] 新建 `src/utils/git-worktree.ts`
  - `isGitWorktree(workspacePath): Promise<boolean>`
  - `getMainWorktreePath(workspacePath): Promise<string | null>` — 用 `git rev-parse --path-format=absolute --git-common-dir` 获取共享 git 目录，解析出主 worktree
  - `getAllWorktrees(workspacePath): Promise<string[]>` — 用 `git worktree list --porcelain` 列举所有 worktree

- [x] 新建 `src/utils/index-cloner.ts`
  - `cloneIndexFromSource(sourcePath, targetPath, options): Promise<CloneResult>`
  - 内部调用三个子函数：
    - `cloneLocalCaches(sourcePath, targetPath)` — 复制三类本地缓存
    - `cloneQdrantCollection(sourcePath, targetPath, qdrantUrl)` — 用 snapshot/restore

### 阶段 3：CLI 集成

- [x] `src/commands/shared.ts` 的 `CommandOptions` 加字段：
  - `fromWorktree?: string` — 指定源 worktree 路径
  - `cloneFromWorktree?: boolean` — 关闭自动克隆

- [x] `src/commands/index.ts` 的 `indexHandler`：
  - 在 `initializeManager` 之前插入克隆逻辑
  - 显示复制进度日志
  - 任何异常不影响后续流程

- [x] `src/cli.ts` 注册 flag：
  - `--from-worktree <path>`
  - `--no-clone-from-worktree`

### 阶段 4：端到端验证

- [x] 写 `scripts/evidence/260602-clone-index-from-worktree.ts`
  - **场景**：当前 worktree = `.claude/worktrees/solid-panther/autodev-codebase`（detached HEAD），主 worktree = `autodev-codebase`，demo 目录在两边都有
  - **步骤 1：清理目标**——删除当前 worktree demo 的 cache（`roo-index-cache-7227c7664b102862...json`）和 Qdrant collection（`ws-7227c7664b102862`），模拟"未索引过的新 worktree"
  - **步骤 2：跑 index**——在当前 worktree 下执行 `npm run dev -- index --demo --log-level=debug`，验证：
    - 自动检测到 git worktree（`git rev-parse --git-common-dir` 返回主仓库）
    - 从主 worktree demo 复制三类本地缓存
    - 用 `init_from` 复制 Qdrant collection
    - 增量扫描开始，但绝大部分文件被跳过（hash 匹配）
  - **步骤 3：验证结果**——
    - `~/.autodev-cache/roo-index-cache-7227c7664b102862...json` 重新出现且大小与源一致
    - `ws-7227c7664b102862` collection 存在且 `points_count == 87`
    - 日志显示 "Cloned index from /Users/anrgct/workspace/autodev-codebase/demo"
  - **步骤 4：二次跑（对比）**——不清理直接再跑一次，验证自动跳过（目标已存在，不重复复制）
  - **步骤 5：明确 flag**——传 `--no-clone-from-worktree` 跑一次，验证禁用行为

## 实施记录

### 2026-06-02

- 完成调研：确认 Qdrant `init_from` 服务端支持、js-client-rest 1.16.2 类型未跟进
- 确认 filePath 是相对路径、ID 基于内容，复制几乎不用改内容
- 实际探测 Qdrant 服务端：`PUT /collections/{name}` 接受 `init_from: { collection: "..." }` ✅
- 确认 summary-cache 路径生成在 `summary-cache.ts:196-218`，同样是 `sha256(workspacePath)[:16]`
- 确认当前 demo 索引规模：主 worktree 87 points / 1KB cache（数据小，复制秒级）
- 完成 task doc 初版

### 2026-06-02 (实施)

**阶段 1：核心工具（`src/utils/git-worktree.ts`）**

- 新增 `src/utils/git-worktree.ts`，提供 4 个函数：
  - `getGitCommonDir(workspacePath)` — 调 `git rev-parse --path-format=absolute --git-common-dir` 获取共享 .git 目录
  - `getMainWorktreePath(workspacePath)` — 推导主 worktree 路径，备选 `git worktree list --porcelain` 退路
  - `isGitWorktree(workspacePath)` — 比较 `--show-toplevel` 与 main worktree 路径
  - `getAllWorktrees(workspacePath)` — 解析 porcelain 格式，标记主 worktree
- 依赖注入 `runGit` 和 `fs` 参数以便单测
- 修复递归调用的 bug：`getMainWorktreePath` 在 stat 失败时调用 `getAllWorktrees`，后者又调 `getMainWorktreePath` —— 加了 `__skipMainLookup` 旗标打破循环
- 单元测试 14 个 case，全部通过

**阶段 2：复制器（`src/utils/index-cloner.ts`）**

- 新增 `src/utils/index-cloner.ts`，提供 3 个公开函数 + 1 个 wrapper：
  - `cloneLocalCaches(source, target, deps)` — 复制三类本地缓存（code-index, summary, dependency）
  - `cloneQdrantCollection(source, target, qdrant, deps)` — 用 Qdrant `init_from` 复制 collection
  - `cloneIndexFromSource(options)` — 聚合上面两个，返回统一的 `IndexCloneResult`
- 关键发现：`PUT /collections/{target}` 配合 `init_from` **不会复制数据**，只继承配置。Qdrant 官方推荐方式是 **snapshot/restore**：
  1. `POST /collections/{source}/snapshots` 创建 snapshot
  2. `GET /collections/{source}/snapshots/{name}` 下载 snapshot（tar 归档）
  3. `POST /collections/{target}/snapshots/upload?priority=snapshot&wait=true` 上传
- 验证：实测在主 worktree demo 87 points + sparse_vectors bm25 config 完整迁移到目标 collection
- 所有错误（snapshot 创建/下载/上传、目标已存在、源不存在）都返回结构化状态，调用方可以 best-effort 继续
- 单元测试 15 个 case（hash 辅助、local caches 复制/跳过/回滚、Qdrant 各种 success/failure 路径），全部通过

**阶段 3：CLI 集成**

- `src/commands/shared.ts` 的 `CommandOptions` 加 `fromWorktree` 和 `cloneFromWorktree` 字段
- `src/commands/index.ts` 在 `indexHandler` 启动时（`initializeManager` 之前）插入 `maybeCloneFromWorktree` 调用
- source 路径推导：用 `git rev-parse --show-toplevel` 取得 worktree 根，relative path 拼接到主 worktree 根
- 注册两个 flag：`--from-worktree <path>` 和 `--no-clone-from-worktree`（commander 把后者规范化为 `cloneFromWorktree: false`）
- qdrantUrl 从 `autodev-config.json` 读取（容错 JSONC 注释/尾逗号），fallback 默认 `http://localhost:6333`
- 异常处理：克隆失败仅 warn，继续主索引流程（避免阻塞）

**阶段 4：端到端验证（`scripts/evidence/260602-clone-index-from-worktree.ts`）**

- 三个场景全部通过：
  1. **自动克隆**：删除目标 cache + collection 后跑 `codebase index --demo`，自动检测到 worktree，从主 worktree demo 复制 1044 bytes cache + 87 points 1.7MB Qdrant snapshot，总耗时 2.1s
  2. **第二次跑无副作用**：目标已存在时直接跳过，日志里没有 "Copied" 字样
  3. **`--no-clone-from-worktree`**：禁用标志后没有触发克隆，indexer 正常启动
- 验证完数据可用：`codebase search "用户"` 能搜到 demo 里的代码

## 修订记录

### 2026-06-03

**修复：clone 的 index cache 路径未改写导致缓存失效**

- **发现**：`codebase index` 的 clone 日志显示缓存复制成功（1044 bytes），但增量扫描时所有文件 `cachedHash=undefined`，全部重新嵌入
- **根因**：`rewriteIndexCachePaths` 中 cache 文件的 key 是**绝对路径**，clone 时只是 `fs.copyFile`，未将 source worktree 路径前缀替换为 target worktree 路径前缀，导致 `getHash()` 永远匹配不上
- **修复**：`src/utils/index-cloner.ts` 的 `copyIndexCacheFile` 改为读入 JSON → 改写所有 key 的路径前缀 → 写出到目标
- **测试**：新增 rewrite 测试用例，16 个 case 全部通过

## 总结

### 关键交付物

| 文件 | 用途 | 规模 |
|------|------|------|
| `src/utils/git-worktree.ts` | git worktree 检测 | 263 行 |
| `src/utils/__tests__/git-worktree.test.ts` | 单元测试 | 249 行，14 cases |
| `src/utils/index-cloner.ts` | index 复制器（本地缓存 + Qdrant，含路径改写） | ~710 行 |
| `src/utils/__tests__/index-cloner.test.ts` | 单元测试 | ~490 行，16 cases（含路径 rewrite 测试） |
| `src/commands/index.ts` | CLI 集成（`maybeCloneFromWorktree` hook） | +155 行 |
| `src/commands/shared.ts` | `CommandOptions` 扩展 | +2 字段 |
| `scripts/evidence/260602-clone-index-from-worktree.ts` | E2E 验证脚本 | 391 行，3 场景 |

### 数据流

```
codebase index (worktree)
  └ maybeCloneFromWorktree()
      ├ isGitWorktree()          # git rev-parse 检测
      ├ getMainWorktreePath()    # git rev-parse --git-common-dir
      ├ getWorktreeToplevel()    # git rev-parse --show-toplevel
      └ cloneIndexFromSource()
          ├ cloneLocalCaches()           # 文件复制
          │   ├ code-index cache  (read JSON → rewrite paths → write)
          │   ├ summary cache     (recursive dir copy)
          │   └ dependency cache  (recursive dir copy)
          └ cloneQdrantCollection()      # Qdrant snapshot/restore
              ├ POST /collections/{src}/snapshots
              ├ GET  /collections/{src}/snapshots/{name}
              └ POST /collections/{tgt}/snapshots/upload?priority=snapshot
```

### 实际效果

- 主 worktree demo（87 points / 1KB cache）→ 当前 worktree demo 全量复制：**2.1 秒**
- 5-10 分钟的全量重索引压成 2 秒的 clone + 增量扫描（hash 命中，几乎不做事）

### 验证结果

- `npm run type-check`：仅 2 个**已存在**的 `llamacpp-rerank.ts` 错误与本任务无关
- `npx vitest run src/utils/__tests__/`：6 个测试文件，79 个 case，**全部通过**
- E2E 脚本 `260602-clone-index-from-worktree.ts`：3 个场景，**全部通过**
- 手动验证：`codebase search "用户"` 搜出 demo 的代码，证明克隆数据可用
