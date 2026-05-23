# 260523-highlight-subcommand

## 主题/需求

新增 `codebase highlight` 子命令，将高亮功能从搜索管线中解耦，支持对任意代码文件做独立行级语义高亮分析。

### 背景

当前高亮功能**完全耦合在搜索管线中**：
- `codebase search "query"` 自动运行 highlight（若配置启用）
- `codebase search "query" --debug-highlight` 打印 token 级热力图
- 无法对任意文件独立运行高亮分析——用户必须先有索引、再搜索，才能看到高亮结果

两个典型场景无法满足：
1. "我有一个文件 `auth.ts`，想快速看哪些行和'认证'最相关" — 目前必须走完整搜索管线
2. 开发者调试高亮器行为 — 每次需触发搜索 → 等待 embed + vector search + rerank

### 目标

- 新增 `codebase highlight` 子命令，接受 `<query>` + 文件路径作为输入
- 支持三种输入模式：文件路径 / glob 模式 / stdin 管道
- 直接调用 `IHighlighter.highlight()`，跳过 embed + vector search + rerank 管线
- 输出：默认文本模式（行级高亮）、`--json` JSON 模式、`--debug` token 热力图模式
- 支持 `--provider` / `--topk` / `--mode` / `--threshold` CLI 覆盖配置
- 与 `codebase search` 语义清晰分离：search = 发现代码，highlight = 分析代码

### CLI 参数规格

```bash
codebase highlight <query> [paths...] [options]
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `<query>` | string | **必填** | 语义查询，用于计算每行的相关性 |
| `[paths...]` | string[] | stdin | 文件路径或 glob 模式（逗号分隔多个）。为空时从 stdin 读取 |
| `--provider` | string | 来自 `highlighter.provider` 配置 | 高亮模型：`qrranker` / `semantic-highlight` / `llamacpp-llm` |
| `--topk, -k` | number | 来自 `highlighter.topK` 配置（默认 10） | `mode=topk` 时保留的最高分 Top-K 行 |
| `--mode` | string | 来自 `highlighter.mode` 配置（默认 `topk`） | 选取策略：`topk`（取最高 K 行）/ `threshold`（取所有>=阈值的行） |
| `--threshold, -t` | number | 来自 `highlighter.threshold` 配置（默认 0.5） | `mode=threshold` 时的最低分值阈值 (0-1) |
| `--debug, -d` | boolean | false | 打印 token 级 ANSI 256 色热力图（参见决策8） |
| `--json, -j` | boolean | false | JSON 格式输出（含 per-line 分数） |
| `--config, -c` | string | `./autodev-config.json` | 配置文件路径 |
| `--path, -p` | string | `.` | 工作空间根目录 |
| `--demo` | boolean | false | 使用 demo 工作空间 |
| `--log-level` | string | `error` | 日志级别：`debug` / `info` / `warn` / `error` |

**参数传递链路：**
```text-chart
CLI flags                    HighlightOptions            IHighlighter.highlight()
----------                   ----------------            ----------------------
--provider    -> 高亮器选择    (决定用哪个 IHighlighter 实例)
--topk, -k    -> 合并配置     -> options.topK              -> 控制 _selectAndFormat()
--mode        -> 合并配置     -> options.mode              -> 控制 topK/threshold 分支
--threshold   -> 合并配置     -> options.threshold         -> threshold 模式阈值
--debug, -d   -> 直接传递     -> options.debugHighlight    -> 触发 buildTokenHeatmap()
```

**合并规则：** CLI flag > `autodev-config.json` > 默认值（与现有 search 命令一致）。例如：
- 配置 `highlighter.topK=10`，命令行 `--topk 20` → 使用 20
- 配置 `highlighter.mode=topk`，命令行 `--mode threshold --threshold 0.3` → 使用 threshold 模式 + 0.3 阈值
- `--provider` 切换高亮器类型，对应的 GGUF 模型路径仍从配置读取（`highlighter.ggufPath` / `ggufQrrankerPath` / `ggufLlmPath`）

### 预期成果

- 新增 `src/commands/highlight.ts`（highlight 命令实现，~200 行）
- `ICodeIndexManager` / `CodeIndexManager` 新增 `highlight()` 方法
- `src/cli.ts` 注册 `highlight` 子命令
- `AGENTS.md` 更新 CLI 命令文档
- 类型检查 + 构建 + 端到端验证通过

### 验证方式

```bash
# 单文件高亮
npx tsx src/cli.ts highlight "authentication" src/auth.ts --demo

# Glob 模式
npx tsx src/cli.ts highlight "train method" "src/**/*.py" --demo

# stdin 管道
cat src/auth.ts | npx tsx src/cli.ts highlight "authentication" --demo

# Debug 热力图
npx tsx src/cli.ts highlight "login" src/auth.ts --demo --debug

# JSON 输出
npx tsx src/cli.ts highlight "login" src/auth.ts --demo --json

# 覆盖 topK
npx tsx src/cli.ts highlight "login" src/auth.ts --demo --topk 15

# threshold 模式
npx tsx src/cli.ts highlight "login" src/auth.ts --demo --mode threshold --threshold 0.3

# 覆盖 provider + topK + debug 组合
npx tsx src/cli.ts highlight "login" src/auth.ts --demo --provider qrranker --topk 20 --debug
```

## 代码背景

### 关键文件

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/cli.ts` | CLI 入口，注册子命令 | `program.addCommand(createHighlightCommand())` |
| `src/commands/highlight.ts` | 【新建】highlight 命令实现 | ~200 行，参数解析 + 文件读取 + 高亮调用 + 输出格式化 |
| `src/commands/shared.ts` | CLI 共享选项和工具函数 | 可能需新增读取 stdin 的 helper |
| `src/code-index/interfaces/manager.ts` | `ICodeIndexManager` 接口 | 新增 `highlight()` 方法签名 |
| `src/code-index/manager.ts` | `CodeIndexManager` 实现 | 新增 `highlight()` 实现（委托给 search-service 的 highlighter） |
| `src/code-index/search-service.ts` | 搜索服务（持有 highlighter 实例） | 新增 `highlight()` 公开方法，或暴露 highlighter getter |
| `src/code-index/interfaces/highlighter.ts` | `IHighlighter` 接口（已有） | 不改动 |

### 现有搜索管线 vs 新 highlight 管线

```text-chart
codebase search 管线（现有）
  Query → Embedding → Qdrant 向量搜索 → Reranker → Highlighter → 输出

codebase highlight 管线（新增）
  Query + 文件路径 → 读取文件内容 → Highlighter → 输出
```

关键差异：highlight 命令跳过 embed + vector search + rerank，直接进入 highlight 阶段。这意味 highlighter 需要独立做 forward pass（不能复用 reranker 预计算分数），延迟约 1-2 秒（qrranker）或 < 0.5 秒（semantic-highlight）。

### 现有命令模式参考

所有子命令遵循相同模式（`search.ts`, `outline.ts`, `call.ts` 等）：

```typescript
export function createXxxCommand(): Command {
  const command = new Command('xxx');
  command
    .description('...')
    .argument(...)
    .option(...)
    .action(handler);
  return command;
}
```

## 关键决策

### 决策1：独立管线 vs 复用搜索管线

**选择：** 独立管线——`highlight` 命令直接调用 `IHighlighter.highlight()`，不经过 embed/search/rerank。

**理由：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| 独立管线 | 语义清晰（search=发现，highlight=分析）；延迟低（跳过 embed+向量搜索）；不依赖索引就绪 | 不能复用 reranker 预计算分数；highlighter 做独立 forward pass |
| 复用搜索管线 | 复用全部现有代码；可享受 reranker 预计算优化 | 对单文件场景过度设计（embedding+向量搜索无意义）；依赖索引基础设施；语义混淆 |

**选择独立管线。** 用户已有目标文件时不需要"发现"步骤。独立 forward pass 的延迟（1-2 秒）对分析场景可接受。

### 决策2：Manager 层暴露 highlight() 方法

**选择：** 在 `ICodeIndexManager` 接口新增 `highlight(query, codeChunk, startLine, options?)` 方法，`CodeIndexManager` 实现委托给内部 `CodeIndexSearchService` 持有的 highlighter。

**理由：**
- 与 `searchIndex()` 平级，接口语义一致
- 命令处理器通过 `initializeManager()` 获取 manager（与 search 命令相同路径），不需要绕过 manager 直接操作 highlighter
- 后续若 highlight 管线需要扩展（如加入 chunking），改动局限在 manager 层

**备选方案：** 暴露 `manager.highlighter` getter。缺点：打破了封装，命令处理器直接依赖 `IHighlighter` 接口。

### 决策3：输入模式——文件 / glob / stdin

**选择：** 支持三种输入模式，优先级：位置参数 paths > stdin。

```bash
codebase highlight "query" [paths...]     # 文件 + glob，逗号分隔
codebase highlight "query"                # 无 paths 时读 stdin
```

**理由：**
- `outline` 命令已有成熟的 glob + 逗号分隔模式，保持一致
- stdin 支持管道组合：`codebase search "query" --json | jq '.code' | codebase highlight "query"`
- 文件模式和 stdin 模式互斥（有 paths 参数时忽略 stdin），语义清晰无歧义

### 决策4：glob 展开策略

**选择：** 复用 `outline.ts` 的 glob 解析逻辑（`parsePathFilters` + `resolveGlob` 模式），将逗号分隔的字符串拆分为独立 pattern，逐个展开。

**理由：**
- 不引入新的 glob 库或解析逻辑
- `outline` 命令已验证的成熟模式：支持混合 glob 和排除（`src/**/*.ts,!**/*.test.ts`）
- CLI 接口一致（`"src/cli.ts,src/index.ts"` 逗号分隔）

### 决策5：多文件输出格式

**选择：** 文本模式下按文件分组输出，每文件标题 + sections。JSON 模式下 `results[]` 数组，每项含 `filePath` + `sections[]`。

**理由：**
- 文本模式参照 search 命令风格（`====` 文件分隔）
- JSON 模式参照 search 命令的 JSON 结构（`snippets[]`），保持一致
- 多文件时按文件路径排序，确保输出确定性

### 决策6：大文件处理策略（MVP）

**选择：** MVP 阶段传递整个文件内容给 highlighter，不做分块。

**理由：**
- `qrranker`（Qwen3-4B，32K context）可处理 ~2000 行代码
- `semantic-highlight`（XLM-RoBERTa，512 token limit）有上下文限制，但视为 known limitation
- 后续可加入 tree-sitter 分块（按函数/类边界），但不阻塞 MVP

**风险：** semantic-highlight provider 处理 > 512 token 的文件时可能截断。文档注明限制，推荐大文件使用 `qrranker` provider。

### 决策7：与 search --debug-highlight 的关系

**选择：** 两者共存，不做迁移或废弃。

- `search --debug-highlight`：搜索管线内的高亮调试（可复用 reranker 预计算分数）
- `highlight --debug`：独立文件分析 + 调试（独立 forward pass）

**理由：** 两个命令服务于不同场景，不冲突。`search --debug-highlight` 依赖搜索管线上下文（reranker 分数、chunk 边界），迁移到 `highlight` 会丢失这些上下文。

### 决策8：Debug 热力图在独立管线中的实现路径

**选择：** `highlight --debug` 由 highlighter 自身的独立 forward pass 生成热力图，不依赖 reranker 预计算分数。

**理由：** 独立管线中不存在 reranker，无法走 fast path 复用。但所有三个 provider 的 `highlight()` 方法**本身就支持独立 forward pass + debug 输出**：

**qrranker（Qwen3-4B attention-based）— 独立 debug 流程：**
```text-chart
highlight(query, codeChunk, 1, { debugHighlight: true })
  │
  ├─ 无 _qrrankerPerTokenScores → 走 normal path（非 fast path）
  │
  ├─ _runForwardPass()
  │   ├─ 构建 prompt: chatml(query + codeChunk)
  │   ├─ model.tokenize(fullPrompt)
  │   ├─ llama_decode(ctx, batch) → cbEval 收集 16 QR heads attention
  │   └─ computePerTokenScores() → per-token relevance scores
  │
  ├─ tokensToLines() → lineScores（用于 topK 选择）
  │
  ├─ _selectAndFormat() → HighlightResult.formattedText
  │
  └─ [debug] buildTokenHeatmap(model, codeTokens, tokenScores, ...)
      ├─ model.detokenize([tid]) 逐个恢复 token 文本
      ├─ detokenize 字符累积长度做行映射
      ├─ scoreToAnsiFg() 10 级 ANSI 256 色
      ├─ per-token 块着色 + 行级分数条
      └─ → HighlightResult.debugTokenView
```

关键优势：独立 forward pass 中，tokenization 和 attention 计算在**同一上下文**完成，不存在 BPE 边界对齐问题（不像 fast path 需要跨 reranker↔highlighter 对齐 token 序列）。热力图文本对齐精度高于搜索管线中的 fast path debug。

**semantic-highlight（XLM-RoBERTa + PruningHead）— 独立 debug 流程：**
```text-chart
highlight(query, codeChunk, 1, { debugHighlight: true })
  │
  ├─ 无 _semanticHighlightTokenProbs → 走 normal path
  │
  ├─ _ensureModel() → 加载 model + PruningHead 权重
  │
  ├─ model.tokenize(input) → inputTokens（用于 debug text 定位）
  ├─ model.getEmbeddingsForTokens(input) → hiddenStates [N, 1024]
  ├─ _applyPruningHead(hiddenStates) → keepProbs [N]
  │
  ├─ _aggregateTokensToLines() → lineScores（窗口化 indexOf 字符定位）
  ├─ _selectAndFormat() → HighlightResult.formattedText
  │
  └─ [debug] _buildDebugTokenView(model, inputTokens, keepProbs, ...)
      ├─ model.detokenize([tid]) 逐个恢复 token 文本
      ├─ windowed indexOf(codeChunk, searchFrom) 字符定位
      ├─ scoreRatioToAnsiFg() 10 级 ANSI 256 色
      ├─ per-token 块着色 + 多行分段 + ↵ 标记
      └─ → HighlightResult.debugTokenView
```

**llamacpp-llm（0.6B + TOPIC prompt）— 无 debug 热力图：**
LLM prompt 模式只返回行范围，没有 per-token 分数，不生成 debug 热力图。

**命令处理器侧的输出逻辑：**
参照 `search.ts` 中 `--debug-highlight` 的输出模式：
```text-chart
highlightHandler()
  │
  ├─ 1. 格式化 highlight 结果（文本 / JSON）
  │
  └─ 2. if (--debug):
        for each result:
          if (result.debugTokenView):
            print ═══ 分隔线
            print [Debug Highlight] "filePath" (Lstart-Lend)
            print result.debugTokenView  ← ANSI 彩色热力图
            print ═══ 分隔线
```

**与 search --debug-highlight 的差异：**

| | `search --debug-highlight` | `highlight --debug` |
|---|---|---|
| 分数来源 | reranker 预计算（fast path） | highlighter 独立 forward pass |
| BPE 对齐 | 有 ~1-2 token 已知偏差 | 无偏差（同一上下文 tokenize） |
| 延迟 | 0（复用已有分数） | ~1-2秒（独立 llama_decode） |
| 热力图精度 | 略有偏差 | 精确对齐 |

## 实施计划

- [ ] **Step 1: Manager 接口扩展**
  - `interfaces/manager.ts`：`ICodeIndexManager` 新增 `highlight()` 方法签名
  - `manager.ts`：`CodeIndexManager.highlight()` 实现（委托给 search service）
  - `search-service.ts`：暴露 `highlight()` 公共方法（或 highlighter getter）

- [ ] **Step 2: highlight 命令实现**
  - `commands/highlight.ts`：新建文件
    - `createHighlightCommand()` — Command 定义 + 参数/选项
    - `highlightHandler()` — 主处理逻辑
    - `formatHighlightResults()` — 文本格式化
    - `formatHighlightResultsAsJson()` — JSON 格式化
    - stdin 检测逻辑（`process.stdin.isTTY`）
  - `commands/shared.ts`：可选新增 `readStdin()` helper

- [ ] **Step 3: CLI 注册**
  - `cli.ts`：`program.addCommand(createHighlightCommand())`

- [ ] **Step 4: 文档更新**
  - `AGENTS.md`：新增 `codebase highlight` 命令文档

- [ ] **Step 5: 验证**
  - 类型检查 `npm run type-check`
  - 构建 `npm run build`
  - 端到端测试（单文件 / glob / stdin / --debug / --json / --provider）

## 实施记录

（待实施）

## 修订记录

（待修订）

## 总结

**核心思路：** 将高亮功能从搜索管线解耦为独立子命令，`search` = 发现代码，`highlight` = 分析代码。命令直接调用 `IHighlighter.highlight()`，跳过 embed + vector search + rerank。

**关键技术点：**
1. Manager 层新增 `highlight()` 方法，复用现有 highlighter 实例
2. 三种输入模式（文件 / glob / stdin）覆盖所有使用场景
3. 输出格式（文本 / JSON / debug 热力图）与 search 命令保持一致
4. 独立 forward pass（不复用 reranker 分数），延迟可接受

**参考：**
- 现有命令模式：`src/commands/search.ts` (search.createSearchCommand)
- 现有命令模式：`src/commands/outline.ts`
- Highlighter 接口：`src/code-index/interfaces/highlighter.ts` (IHighlighter.highlight)
- Manager 接口：`src/code-index/interfaces/manager.ts` (ICodeIndexManager)
- QRRanker 高亮器设计：`docs/plans/260519-qrranker-highlighter.md`
- Semantic Highlight 设计：`docs/plans/260521-semantic-highlight-unified.md`
