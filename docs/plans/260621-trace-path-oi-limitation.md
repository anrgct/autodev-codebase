# 260621-trace-path-oi-limitation

## 主题/需求

通过真实代码场景（追踪 `src/commands/index.ts` 到 `src/code-index/processors/file-watcher.ts` 的调用联系），对比测试 **两类分析工具** 的能力边界：

1. **`mcp_trace_path`** — 由外部 `codebase-memory-mcp` 项目提供的 MCP 工具，基于预索引的知识图谱 + Cypher 查询
2. **`codebase call`** — `autodev-codebase` 项目自带的 Tree-sitter 静态依赖分析工具

记录两者在实际面向对象 + 依赖注入代码库中的表现、共同盲区与适用场景。

## 测试过程

### 问题

两个文件之间有无直接调用？调用链是怎样的？

| 文件 A | 文件 B |
|--------|--------|
| `src/commands/index.ts` — CLI `index` 子命令入口 | `src/code-index/processors/file-watcher.ts` — `FileWatcher` 类 |

### 工具调用序列

> `mcp_*` 工具由外部项目 `codebase-memory-mcp` 提供，通过对 `autodev-codebase` 进行预索引后查询知识图谱。

| # | 工具 | 参数 | 结果 |
|---|------|------|------|
| 1 | `mcp_trace_path` | outbound, depth=4, function=`indexHandler` | ✅ 找到 `initializeManager` → `CodeIndexManager.startIndexing` → `CodeIndexOrchestrator.startIndexing` → `_startWatcher` 链路 |
| 2 | `mcp_trace_path` | inbound, depth=3, function=`FileWatcher.initialize` | ❌ 返回空 callers，未能发现谁调用了 `initialize()` |
| 3 | `mcp_trace_path` | outbound, depth=3, function=`_startWatcher` | ⚠️ 有 4 个 callees 但不包含 `fileWatcher.initialize()` — 接口调用丢失 |
| 4 | `mcp_trace_path` | outbound, depth=3, function=`CodeIndexManager.startIndexing` | ⚠️ hop 2 显示了 `_startWatcher`，但依然连不到 `FileWatcher.initialize` |
| 5 | `mcp_trace_path` | inbound, depth=3, function=`CodeIndexOrchestrator.constructor` | ❌ 返回空 callers |
| 6 | `mcp_trace_path` | outbound, depth=3, function=`CodeIndexManager._recreateServices` | ✅ hop 3 显示了 `FileWatcher` 构造函数和 `CodeIndexOrchestrator` 构造函数 |
| — | `read_file` + 人工阅读 | 阅读 `orchestrator.ts:94` 和 `service-factory.ts:455-514` | 补全缺失环节 |

### 最终还原的完整调用链

```
src/commands/index.ts:indexHandler
  └─ initializeManager()                     ← commands/shared.ts
      └─ CodeIndexManager.initialize()       ← code-index/manager.ts
          └─ _recreateServices()
              └─ CodeIndexServiceFactory.createServices()   ← code-index/service-factory.ts
                  ├─ createFileWatcher() → new FileWatcher(...)
                  └─ new CodeIndexOrchestrator(fileWatcher, ...)
      └─ CodeIndexManager.startIndexing()
          └─ CodeIndexOrchestrator.startIndexing()           ← code-index/orchestrator.ts
              └─ _startWatcher()
                  └─ fileWatcher.initialize()     ← 接口调用，具体实现在 FileWatcher
```

## 归因分析

### 三种导致图断裂的模式

#### 1. 接口动态派发（Interface dispatch）

```
orchestrator.ts:94   await this.fileWatcher.initialize()
```

`fileWatcher` 的类型是 `ICodeFileWatcher`（接口），运行时实际指向 `FileWatcher` 实例。静态分析无法解析接口方法调用指向哪个具体实现，因此 `_startWatcher` 的 outbound 追踪里没有 `FileWatcher.initialize`。

**缺失图的边类型**：`IMPLEMENTS`（从接口方法到具体实现方法）。

#### 2. 构造函数调用（Constructor/`new`）

```
service-factory.ts:464   return new FileWatcher(...)
```

`new FileWatcher(...)` 在知识图谱中没有作为 inbound call 被关联到 `FileWatcher.constructor`。`FileWatcher.constructor` 的 inbound trace 为空。这个调用只在 `_recreateServices` 的 outbound trace 的 hop 3 中以 callee 形式出现（depth 足够深才命中）。

**缺失图的边类型**：`CREATES`（从工厂/调用方到构造函数）。

#### 3. 参数注入（Dependency injection）

```
const fileWatcher = this.createFileWatcher(...)    // 创建
const orchestrator = new CodeIndexOrchestrator(    // 注入为参数
  ..., fileWatcher
)
```

对象通过工厂创建，再作为构造函数参数注入。图中存在 `createFileWatcher → FileWatcher.constructor` 的边，但不存在 `CodeIndexOrchestrator → FileWatcher` 的 "has-a" 关联。因此 `_startWatcher` 中 `this.fileWatcher.initialize()` 无法连接到 `FileWatcher.initialize`。

**缺失图的边类型**：`INJECTS` 或 `HOLDS`（从注入点成员变量到实现类方法）。

### 对比：`trace_path` 对传统调用链的表现

| 调用方式 | trace_path 效果 | 原因 |
|----------|-----------------|------|
| 模块 A 直接 `import` 模块 B 的函数 | ✅ 完美 | 静态可解析的直接边 |
| `a.foo()` → `a` 是具体类实例 | ✅ 正常 | 如果构造函数被图捕获 |
| `a.foo()` → `a` 是接口类型 | ❌ 丢失 | 无 `IMPLEMENTS` 边 |
| `new Xxx(...)` | ⚠️ 仅 outbound 深 hop 可见 | 无 `CREATES` 边 |
| 对象作为参数注入后调用其方法 | ❌ 丢失 | 参数流不可追踪 |

## 关键发现

### `trace_path` 能力边界总结

```
                    trace_path 能清晰追踪
                    ┌─────────────────────────┐
                    │  模块A → B 的直接函数调用  │
                    │  多层 outbound (depth 够) │
                    └─────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────┐
                    │     依赖注入 + 接口      │ ←── 本项目大量使用
                    │  的代码中图边会断裂       │
                    └─────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────┐
                    │  需配合 read_file 源码阅读 │
                    │  手动补全缺失环节          │
                    └─────────────────────────┘
```

### 本次分析中的实际效率

- **6 次** `trace_path` 调用 + **2 次** `read_file` 源码阅读
- `trace_path` 贡献了 ~60% 的信息量（top-level 调用链），但关键的中间两跳（工厂创建 → orchestator 注入 → 接口调用）全靠人工阅读源码补全

## 与原生 call 工具的对比

> `codebase call` 是 `autodev-codebase` 项目自带的 CLI 子命令，使用 Tree-sitter 做实时静态依赖分析，不需要预索引。

同样的问题，也用 `codebase call` 测试了一遍。

### call 工具实验结果

> `--query=a,b` 多节点模式设计为**路径查找**：尝试在 a、b 之间找连接路径。
> `--query=a` 单节点模式则同时显示 `↑ called by`（调用者）和 `↓ calls`（被调者）。

| 查询 | 结果 |
|------|------|
| `--query=indexHandler,FileWatcher --depth=10` | 两节点都找到，但 **Direct connections: (none), Chains found: (none)**（路径查找模式，DI 导致的断链） |
| `--query=createFileWatcher,FileWatcher --depth=5` | 同：两节点找到但 **Direct connections: (none)**（`new FileWatcher()` 构造函数不被视为调用边） |
| `--query=CodeIndexOrchestrator` (单节点) | 显示 `↓ calls` 但不包含 `this.fileWatcher.initialize()` 接口调用；**`↑ called by` 同样缺失**（构造函数注入导致无静态引用） |
| `--query=createNodeDependencies` (单节点) | ✅ 正确显示两向：5 个 caller 和 15+ 个 callee |
| `--json` (全量统计) | 220 个文件，1747 个节点，5073 条关系 |

### 核心差异对比

| 维度 | `mcp_trace_path` | `codebase call`（原生） |
|------|-------------------|------------------------|
| **分析引擎** | 知识图谱（预索引 + Cypher） | Tree-sitter 静态分析（实时） |
| **接口调用** | ❌ 丢失（无 IMPLEMENTS 边） | ❌ 丢失（静态无法解析） |
| **`new Xxx()` 构造函数** | ⚠️ outbound depth≥3 在 callee 列表偶现，无独立边 | ❌ 完全不体现 |
| **DI 参数注入** | ❌ 丢失 | ❌ 丢失 |
| **inbound 追踪** | 支持（`direction=inbound`），接口方法无效 | 单节点模式默认显示 `↑ called by`；多节点模式切换为路径查找 |
| **查找远程调用者** | 可做，从索引图反向查找 | 单节点模式下直接显示在 `↑ called by` 区域 |
| **噪声控制** | depth 越高噪声越多 | 更聚焦，但覆盖率低 |
| **冷启动** | 需预索引 | 零延迟，即查即用 |
| **depth 穿透力** | 知识图谱额外边（如 hop 3 的 `FileWatcher` 构造函数）略深 | 静态调用链 intact 时也能穿透多层（如 `indexHandler`→`initializeManager`→`CodeIndexManager.getInstance`） |

### 两者共同的盲区

在这个场景下，**两个工具都断在同样的三处**：

1. **`new FileWatcher(...)`** — 两个工具都不把构造函数调用当作调用边
2. **`this.fileWatcher.initialize()`** — 接口类型上的方法调用，静态/图谱都无法确定具体实现
3. **参数注入 `new CodeIndexOrchestrator(..., fileWatcher)`** — 对象传递后，成员方法调用无法追踪到具体类

### 多 Depth 的覆盖效果

将 `_recreateServices` 的 depth 设为 3 时，hop 3 显示了低频的 `FileWatcher` 构造函数调用 — 但 depth 太浅（1~2）时这些信息会被截断。而 depth=4 时的结果信息量很大，但噪声也在增加（大量 logger、event、storage 调用混入）。

```
depth 经验：
- depth=1: 直接调用者/被调者，最精确
- depth=2: 多数场景够用
- depth=3: 可以穿透 1 层中间层
- depth=4: 信息量大但噪声显著增多
```

## 建议改进方向（知识图谱层面）

### 短期（配置/查询层面，无需重索引）

| 改进 | 说明 |
|------|------|
| `trace_path` 增加 `include_edges` 选项 | 允许返回两跳之间的边类型/文件名，帮助理解断裂处的上下文 |
| 在结果中标注接口类型 | 当追踪到接口方法时，给出 `implements` 该接口的已知类列表 |

### 中期（索引层面，需重索引）

| 边类型 | 来源 | 说明 |
|--------|------|------|
| `IMPLEMENTS` | `class X implements Y` | 类/接口方法映射。`fileWatcher.initialize()` → `FileWatcher.initialize` |
| `CREATES` | `new Xxx(...)` | 构造函数调用。`createFileWatcher()` → `FileWatcher.constructor` |
| `INJECTS` | 构造函数参数 | 参数注入。构造函数参数对象注册为从属，子对象的方法调用可解析 |

### 长期

| 改进 | 说明 |
|------|------|
| `HAS_A` 边（编译时） | 根据类成员类型声明建立 "持有" 关系。`orchestrator.fileWatcher: ICodeFileWatcher` → `FileWatcher` |
| 数据流追踪 | 不限于调用关系，跟踪对象的创建 → 传递 → 使用路径，从根本上解决 DI 场景 |

## 实施记录

### 2026-06-21

- 完成 `mcp_trace_path` 在真实面向对象 + DI 代码库中的能力测试
- 发现三类导致图断裂的模式：接口派发、构造函数、参数注入
- 最终通过 6 次 trace_path + 2 次 read_file 补全完整调用链
- 补充 `codebase call` 原生工具的同题对比实验，确认两者有完全相同的盲区
- 形成文档记录工具边界与改进方向

## 总结

### 实际使用建议

1. **先用 outbound depth=2~3 扫大方向**，找到关键中间模块
2. **遇到接口/DI 断点时，切到 `read_file` 阅读源码**，不要死磕 trace_path 参数调整
3. **`codebase call` 单节点查两向，多节点查路径**：`--query=fn` 同时显示 `↑ called by` 和 `↓ calls`；`--query=a,b` 切换为路径查找模式，查两个节点之间的连接
4. **`search_graph` + query 比 `trace_path` 更适合**在 DI 代码中定位连接点（如搜索 `initialize` 方法的所有实现类）
5. **多 depth 结果中混杂大量 logger/event/storage 噪声**，需要人工过滤
6. **`codebase call` 与 `mcp_trace_path` 盲区一致**，DI/接口场景下两者都无法替代人工源码阅读

### 工具组合最佳实践

```
分析 DI 代码调用链：
trace_path outbound depth=2~3   → 扫调用链主干
search_graph + query            → 找接口的实现类
read_file                       → 阅读关键中间源码补全细节

快速确认单跳调用：
codebase call --query=<fn>      → 零延迟查看 outbound callees
```

三者配合才能高效分析 OO + DI 架构的代码调用关系。
