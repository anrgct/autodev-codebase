# 260521-semantic-highlight-unified

## 主题/需求

升级 semantic-highlight 高亮模型为 **Unified GGUF**（backbone + RerankHead + PruningHead 全部嵌入 GGUF metadata），取代旧方案（GGUF backbone + 外置 Pruning Head 硬编码常量）。

参照 `260519-qrranker-highlighter` 的分步推进 + 注意力复用模式，三步走：

1. **Step 1**：新 Unified GGUF 在 Highlight 跑通（Pruning Head 从 GGUF metadata 读取）
2. **Step 2**：新增 `rerankerProvider=semantic-highlight`，用 RerankHead 做 rerank
3. **Step 3**：`rerankerProvider=highlighterProvider=semantic-highlight` 时复用 forward pass，避免两次计算

### 背景

- 旧模型 `semantic-highlight-bilingual-v1-Q8_0.gguf`：仅 backbone，Pruning Head 权重硬编码在 `pruning-head-weights.ts`（Base64 常量），RerankHead 未接入
- 新模型 `semantic-highlight-bilingual-v1-Q8_0-unified.gguf`：backbone + 6 个 head tensor 全部在 GGUF metadata KV 中
- Python demo（`demo_unified.py`）已用 `_read_heads_v4()` 从 GGUF metadata 读取 head 权重，零外部 `.npy` 依赖

### 目标

- TypeScript 侧从 GGUF metadata 动态读取 Pruning Head 权重（移除硬编码常量）
- 新增 `rerankerProvider="semantic-highlight"`，使用 BGE-M3 RerankHead 打分
- 同模型时 reranker → highlighter 通过 payload 传递 Pruning Head keep probs，跳过重复 forward pass
- 三步各自可独立验证

### 预期成果

- 删除 `highlighters/constants/pruning-head-weights.ts`
- `llamacpp.ts` 改用 `readGgufFileInfo()` 读取头权重
- 新增 `rerankers/semantic-highlight.ts`（`IReranker` 实现）
- `HighlightOptions` 新增 `_semanticHighlightTokenProbs` / `_semanticHighlightCodeText` 内部字段
- `search-service.ts` 新增同模型复用逻辑

### 验证方式

```bash
# Step 1: highlight 验证
npm run build
npx tsx src/cli.ts search "train method" --demo

# Step 2: reranker 验证
# 修改 demo/autodev-config.json: rerankerProvider=semantic-highlight
npx tsx src/cli.ts search "train method" --demo --json | jq '.[0].score'

# Step 3: 复用验证
# 同时启用 reranker + highlighter (均为 semantic-highlight)
npx tsx src/cli.ts search "train method" --demo --debug-highlight
```

## 代码背景

### 关键文件

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/code-index/highlighters/semantic-highlight.ts` | semantic-highlight 高亮器 | `_ensureModel()` 加载时解析 GGUF metadata 获取 Pruning Head 权重；`highlight()` 支持 fast path（检测预计算 probs） |
| `src/code-index/highlighters/constants/pruning-head-weights.ts` | 硬编码 Pruning Head 权重 | **删除** |
| `src/code-index/rerankers/semantic-highlight.ts` | 【新建】semantic-highlight reranker | `IReranker` 实现，RerankHead 打分 |
| `src/code-index/rerankers/llamacpp-rerank.ts` | 现有专用 reranker 模型 reranker | 参考其 `createRankingContext` + `rank()` 模式 |
| `src/code-index/interfaces/reranker.ts` | IReranker 接口 | `RerankerProvider` 新增 `"semantic-highlight"` |
| `src/code-index/interfaces/highlighter.ts` | IHighlighter 接口 | `HighlightOptions` 新增 `_semanticHighlightTokenProbs` / `_semanticHighlightCodeText` |
| `src/code-index/service-factory.ts` | 服务工厂 | `createReranker("semantic-highlight")` / `createHighlighter("semantic-highlight")` 模型共享 |
| `src/code-index/search-service.ts` | 搜索服务 | 同模型时从 reranker payload 提取预计算分数传给 highlighter |
| `demo/autodev-config.json` | 演示配置 | `highlighterGgufPath` → unified GGUF；新增 `rerankerProvider=semantic-highlight` 配置 |

### 现有搜索管线

```text-chart
searchIndex(query, filter)  (search-service.CodeIndexSearchService.searchIndex:28)
  │
  ├─ 1. Embedding → Vector Search (Qdrant)
  │      → VectorStoreSearchResult[]
  │
  ├─ 2. [可选] IReranker.rerank()
  │     └─ ollama / openai-compatible / llamacpp / qrranker / 【新增】semantic-highlight
  │
  ├─ 3. [可选] IHighlighter.highlight()
  │     └─ semantic-highlight / llamacpp-llm / qrranker
  │         └─ 同模型时：从 reranker payload 复用 Pruning Head keep probs
  │
  └─ 4. 返回结果
```

### Unified GGUF 结构

```
GGUF metadata KV:
  open_provence.pruning_head.weight    → float32[2048]  (2×1024)
  open_provence.pruning_head.bias      → float32[2]
  open_provence.rerank_head.dense.weight  → float32[1048576]  (1024×1024)
  open_provence.rerank_head.dense.bias    → float32[1024]
  open_provence.rerank_head.out_proj.weight → float32[1024]  (1×1024)
  open_provence.rerank_head.out_proj.bias   → float32[1]
```

`node-llama-cpp` 的 `readGgufFileInfo()` 已验证可读取全部 6 个自定义键。

### RerankHead 公式（BGE-M3）

```
hidden_cls [1024]  (token 0, CLS)
  → Dense(1024→1024) → tanh
  → OutProj(1024→1) → sigmoid
  → relevance_score ∈ (0, 1)
```

### PruningHead 公式

```
hidden [N, 1024]  (全部 token)
  → Linear(1024→2) → softmax
  → keep_probs[:, 1]  (token 保留概率)
```

## 关键决策

### 决策1：使用 `readGgufFileInfo()` 读取权重（而非硬编码常量或手写解析）

**选择：** `node-llama-cpp` 内置的 `readGgufFileInfo()` + `as any` 类型转换访问自定义键。

**理由：**
- 已验证可读取全部 6 个 `open_provence.*` 自定义键
- 零外部依赖，不需要手写 GGUF 二进制解析
- `readTensorInfo: false` 时仅读 metadata，I/O 开销极低（< 10ms）
- 权重读取仅在模型加载时执行一次，不影响 highlight 延迟

**对比方案：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| `readGgufFileInfo` + as any | 零依赖，利用现有库 | 需 `as any` 绕过类型 |
| 手写 GGUF 解析 | 完全独立 | ~100 行代码，需维护 |
| 保留硬编码常量 | 最简单 | 与 GGUF 元数据不一致，Python/TS 两个来源 |

### 决策2：存储 per-token keep probs 而非 full hidden states

**选择：** 第三步复用时通过 payload 传递 `Float32Array`（N floats），而非 `number[][]`（N×1024 floats）。

**理由：**
- PruningHead 计算极轻量（每个 token 仅 2×1024 dot product），reranker 计算 hidden states 后顺手算 probs 几乎零开销
- 传递 probs：4000 tokens × 4 bytes = 16KB
- 传递 full hidden：4000 × 1024 × 4 bytes = 16MB（太大）

### 决策3：Step 3 参照 qrranker 的 payload 复用模式

**选择：** 与 qrranker 一致的 `HighlightOptions._*` 内部字段 + search-service 提取传递。

**理由：**
- 已验证的成熟模式，减少设计风险
- 高亮器接口 `(query, codeChunk, startLine)` 不变，复用逻辑在管线层透明

### 决策4：reranker 不需要并发支持

**选择：** `RerankerHeadReranker` 不使用 concurrency pool。

**理由：**
- RerankHead 计算极快（单个 hidden 做两次 matmul），不像 LLM 需要预热
- 简化实现，后续需要可再加

### 决策5：第三步存储 precomputed token probs

**选择：** 复用 forward pass 时，reranker 对 batch 中所有 token 计算 PruningHead keep probs，存入 `payload._semanticHighlightTokenProbs`。

**理由：**
- 一次 `getEmbeddingsForTokens()` 返回全部 hidden states
- reranker 取 hidden[0] 算 rerank score
- reranker 顺便对所有 hidden 算 PruningHead → keep probs
- highlighter 收到 probs 后跳过 forward pass + PruningHead 计算

## 实施计划

### Step 1: Unified GGUF in Highlight

- [x] **1.1** `llamacpp.ts`：新增 `_loadHeadWeights()` 方法，用 `readGgufFileInfo()` 从 GGUF metadata 读取 Pruning Head 权重，缓存为 `Float32Array`
- [x] **1.2** `llamacpp.ts`：`_ensureModel()` 调用 `_loadHeadWeights()` 初始化权重
- [x] **1.3** `llamacpp.ts`：`_applyPruningHead()` 改用实例字段 `this._pruningHeadWeight` / `this._pruningHeadBias`
- [x] **1.4** 删除 `highlighters/constants/pruning-head-weights.ts`
- [x] **1.5** `demo/autodev-config.json`：`highlighterGgufPath` → `semantic-highlight-bilingual-v1-Q8_0-unified.gguf`
- [x] **1.6** 类型检查 + 构建 + 搜索验证

### Step 2: RerankerProvider=semantic-highlight

- [x] **2.1** `interfaces/reranker.ts`：`RerankerProvider` += `"semantic-highlight"`
- [x] **2.2** `rerankers/semantic-highlight.ts`：新建 `SemanticHighlightReranker`（`IReranker` 实现）
- [x] **2.3** `service-factory.ts`：`createReranker("semantic-highlight")` 分支
- [x] **2.4** `config-manager.ts` / `config.ts` / `metadata.ts`：配置层支持
- [x] **2.5** 类型检查 + 构建 + rerank 验证

### Step 3: Reranker→Highlighter 复用

- [x] **3.1** `interfaces/highlighter.ts`：`HighlightOptions` 新增 `_semanticHighlightTokenProbs` / `_semanticHighlightCodeText`
- [x] **3.2** `rerankers/semantic-highlight.ts`：rerank 时对每个候选计算 PruningHead keep probs，存入 `payload._semanticHighlightTokenProbs`
- [x] **3.3** `highlighters/semantic-highlight.ts`：`highlight()` 检测 `options._semanticHighlightTokenProbs` 非空时走 fast path（跳过 `_ensureModel` + `getEmbeddingsForTokens`）
- [x] **3.4** `search-service.ts`：同模型时从 reranker payload 提取预计算分数传入 `HighlightOptions`
- [x] **3.5** `service-factory.ts`：`createHighlighter("semantic-highlight")` 与 `createReranker("semantic-highlight")` 共享 unified GGUF
- [x] **3.6** 类型检查 + 构建 + 复用验证（同时启用 reranker+highlighter 正常工作）

## 实施记录

### 2026-05-21

- 需求确认：三步走方案，参照 qrranker-highlighter 复用模式
- 验证 `readGgufFileInfo()` 可读取全部 6 个 `open_provence.*` 自定义 metadata 键
- Task doc 创建

#### Step 1 实施

- `_loadHeadWeights()` 实现：使用 `readGgufFileInfo()` 从 GGUF metadata 读取 Pruning Head 权重（`open_provence.pruning_head.*`），转换为 `Float32Array` 缓存
- `_ensureModel()` 并行加载 head 权重和 llama.cpp 模型
- `_applyPruningHead()` 改用实例字段 `_pruningHeadWeight` / `_pruningHeadBias`
- 删除 `highlighters/constants/pruning-head-weights.ts`（硬编码常量）
- 更新 `demo/autodev-config.json`：`highlighterGgufPath` → unified GGUF
- 更新测试：移除 `PRUNING_HEAD_WEIGHT` 导入，改用 `setMockHeadWeights()`
- 类型检查 / 构建 / 17 单元测试 / 端到端搜索验证 全部通过

#### Step 2 + Step 3 实施

- `rerankers/semantic-highlight.ts`：新建 `SemanticHighlightReranker`，~300 行
  - 从 GGUF metadata 读取 RerankHead（Dense + OutProj）和 PruningHead 权重
  - `rerank()`：对每个候选 → XLM-RoBERTa text pair → `getEmbeddingsForTokens()` → `hidden[0]` → RerankHead → score
  - PruningHead batch 计算存入 `payload._semanticHighlightTokenProbs` 供 highlighter 复用
- `highlighters/semantic-highlight.ts` fast path：
  - `highlight()` 顶层检测 `options._semanticHighlightTokenProbs` → 跳过模型加载和 forward pass
  - 新增 `_aggregatePrecomputedProbsToLines()`：使用预计算 probs（Float32Array）做字符偏移→行映射
  - 提取 `_selectAndFormat()` 方法：selection + formatting 逻辑 normal path 和 fast path 共用
- `interfaces/highlighter.ts`：`HighlightOptions` 新增 `_semanticHighlightTokenProbs` / `_semanticHighlightCodeText`
- `interfaces/reranker.ts`：`RerankerProvider` += `"semantic-highlight"`；`config.ts` 三处同步
- `service-factory.ts`：`createReranker("semantic-highlight")` 分支
- `search-service.ts`：添加 `_semanticHighlightTokenProbs` / `_semanticHighlightCodeText` 到 `HighlightOptions` 传递
- `demo/autodev-config.json`：`rerankerProvider: "semantic-highlight"`，`rerankerGgufPath` → unified GGUF
- 类型检查 ✅、构建 ✅、17 单元测试 ✅、端到端验证 ✅（reranker 打分 + highlighter 高亮同时工作）

#### --debug-highlight fast path 修复

- `_buildDebugTokenViewFromProbs()`：fast path 版热力图，直接使用预计算 probs（无需 `_applyPruningHead`）
- `commands/search.ts`：`SearchResult` 类型 + `formatSearchResultsAsJson()` 支持 `debugTokenView`

## 修订记录

### 2026-05-21
**问题：** `_loadHeadWeights()` 手写了 ~70 行 GGUF 二进制解析器，因误判 `readGgufFileInfo` 无法在 ESM 环境导入
**修复：** `readGgufFileInfo` 实际已在 `node-llama-cpp` 主入口 (`dist/index.js`) 中 re-export，改用 `import { readGgufFileInfo } from "node-llama-cpp"`，两个文件各减少 ~70 行代码

**问题：** fast path 模式下 `--debug-highlight` 不输出热力图
**修复：** 新增 `_buildDebugTokenViewFromProbs()` + `commands/search.ts` JSON 输出支持

（待补充）

## 总结

**核心思路：** Unified GGUF 将 backbone + 双 Head 封装在一个文件中，TypeScript 侧通过 `node-llama-cpp` 的 `readGgufFileInfo()` 读取权重，去除硬编码常量依赖。三步走逐步接入：highlight → rerank → 复用。

**关键技术点：**
1. `readGgufFileInfo({ readTensorInfo: false })` 读取 metadata KV 对，`as any` 访问 `open_provence.*` 自定义键
2. PruningHead 权重转换为 `Float32Array` 缓存于实例字段，与原 `_applyPruningHead` 逻辑完全兼容
3. 第三步复用只传 per-token probs（16KB），不传 full hidden（16MB）
4. 参照 qrranker 模式：`HighlightOptions._*` 内部字段 + search-service 管线层提取传递
