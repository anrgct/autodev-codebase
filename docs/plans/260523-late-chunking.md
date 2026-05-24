# 260523-late-chunking

## 主题/需求

在 `llamacpp-llm` embedder 中实现 **Late Chunking**——将同一文件的代码块拼接后一次 forward pass，再按 chunk 边界分别 mean pooling，使每个 chunk 的嵌入向量包含整个文件的上下文信息。

这是"潜在推理检索"路线的第二步，承接 [260523-llm-embedding-llamacpp](./260523-llm-embedding-llamacpp.md) 的 last-token pooling 实现。

**预期成果：**
- `embedderPoolingMode` 配置项，默认 `"late-chunking"`
- `LlamaCppLlmEmbedder` 支持两种 pooling 模式：`last-token` 和 `late-chunking`
- Scanner/FileWatcher 在 late-chunking 模式下按文件原子派发，保证同文件 chunks 一起 forward pass
- Late chunking 时嵌入文本不使用 metadata（`generateBlockEmbeddingText`），直接用纯代码

**验证方式：**
- `tsc --noEmit` 类型检查通过
- 单元测试通过
- `npx tsx src/cli.ts index --force --demo` 端到端成功
- 对比 `last-token` 和 `late-chunking` 的检索质量差异

## 代码背景

### 关键文件

| 文件 | 用途 |
|------|------|
| `src/code-index/embedders/llamacpp-llm.ts` | `LlamaCppLlmEmbedder`：需要增加 `poolingMode` 参数和 late-chunking 算法 |
| `src/code-index/processors/scanner.ts` | `DirectoryScanner.scanDirectory()`：late-chunking 时跳过共享累加器，逐文件派发 |
| `src/code-index/processors/file-watcher.ts` | `FileWatcher.processBatch()`：late-chunking 时逐文件处理 |
| `src/code-index/interfaces/embedder.ts` | `IEmbedder`：新增 `poolingMode` getter |
| `src/code-index/interfaces/config.ts` | 类型定义：新增 `embedderPoolingMode` |
| `src/code-index/shared/block-text-generator.ts` | `generateBlockEmbeddingText()`：late-chunking 时跳过，用纯代码 |

### 核心 API：`LlamaModel.tokenize()` + `getEmbeddingsForTokens()`

```
model.tokenize(text) → number[]          // token ID 序列
embedContext.getEmbeddingsForTokens(text) → number[][]  // per-token hidden states
```

Late chunking 算法：tokenize 全文 + 各 chunk → 子序列匹配找 span → 一次 forward pass → 按 span mean pool。

### Late Chunking vs Early Chunking

```
Early Chunking（现有 last-token 模式）：
  chunk1 → embedder → vector1  （独立，看不到 chunk2）
  chunk2 → embedder → vector2  （独立，看不到 chunk1）

Late Chunking：
  [chunk1 + chunk2] → LLM forward pass → per-token hidden states
  → chunk1 tokens mean pool → vector1'  （包含 chunk2 的上下文）
  → chunk2 tokens mean pool → vector2'  （包含 chunk1 的上下文）
```

### 上游架构：块的流动路径

```
Scanner.scanDirectory()
  ├─ parseFile() → CodeBlock[]
  ├─ for each block: push to shared accumulator (currentBatchBlocks)
  │   └─ threshold 触发 → processBatch(mixedBlocks)
  │
  └─ 问题：并发解析多文件，block 交错加入累加器
      文件 A 的 30 个 block 可能被切到两个 batch

FileWatcher.processBatch()
  ├─ parseFile() → CodeBlock[]
  ├─ for each event: push to blocksToUpsert（串行，完整）
  │
  └─ processBatch(allBlocks)  ← 所有文件已收集完毕
```

## 关键决策

### 决策 1：Late chunking 在 Scanner/FileWatcher 上游做文件原子化

**选择：** Scanner 在 late-chunking 模式下**跳过共享累加器**，每个文件解析完后直接调用 `processBatch`。FileWatcher 在 late-chunking 模式下逐文件立即处理。

**理由：**
- 如果仅在 `processBatch` 内做 `groupBy`，Scanner 中同一文件的 blocks 可能已被拆分到不同 batch（因为并发解析 + 阈值触发），导致丢失跨 chunk 上下文
- FileWatcher 虽然串行累积、不会被拆分，但统一按文件原子化更清晰
- `processBatch` 仍然复用 BatchProcessor，只是每次传入单文件的 blocks

**关键改动点（Scanner）：**
```
// 现有：blocks 逐块加入共享累加器
for (const block of blocks) { currentBatchBlocks.push(block); ... }

// late-chunking：跳过累加器，直接派发
if (embedder.poolingMode === "late-chunking") {
    batchLimiter(() => this.processBatch(validBlocks, singleFileInfo, ...))
}
```

### 决策 2：Late chunking 时使用纯代码，不加 metadata

**选择：** Late chunking 的嵌入文本用 `block.content`（纯代码），而非 `generateBlockEmbeddingText()`（带 `File:`/`Name:`/`Parent:` 元数据）。

**理由：**
- `File: src/model.py` 在同一文件的所有 chunk 中重复，冗余
- `Name: [function_definition]train` 代码里已有 `def train`
- `Parent: [class_definition]MyModel` 代码里有 `class MyModel`
- LLM 的 attention 在 forward pass 中自然看到代码结构，不需要人工标注
- 省 token，更多上下文用于实际代码

**实现：** Scanner/FileWatcher 的 `itemToText` 回调按模式选择：
```typescript
itemToText: poolingMode === "late-chunking"
  ? (block) => block.content
  : (block) => generateBlockEmbeddingText(...)
```

### 决策 3：Pooling 策略 — per-chunk mean pooling

**选择：** Late chunking 中，每个 chunk 对其所有 token 的 hidden states 做 mean pooling。

**理由：**
- Last-token-per-chunk 会丢失 chunk 内部的细节信息
- Mean pooling 更稳定，对 chunk 长度变化鲁棒
- 与 Jina 等专用 embedding 模型的 mean pooling 行为一致

### 决策 4：配置项命名 `embedderPoolingMode`，默认 `"late-chunking"`

与现有 `highlighterMode` 命名风格一致。

## 实施计划

- [x] 步骤 1：类型系统 & 接口层
  - `IEmbedder` 加 `poolingMode` getter
  - `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 加 `embedderPoolingMode`
  - `DEFAULT_CONFIG` 默认 `"late-chunking"`
  - 其他 9 个 embedder 实现加默认 `poolingMode = "last-token"`

- [x] 步骤 2：`LlamaCppLlmEmbedder` late-chunking 核心算法
  - 构造函数加 `poolingMode` 参数
  - `createEmbeddings()` 加 late-chunking 分支：
    - texts.length ≤ 1 → 退化 last-token
    - 拼接文本 → tokenize 全文 + tokenize 各 chunk
    - 子序列匹配 → spans
    - `getEmbeddingsForTokens(concatText)` → per-token embeddings
    - Per-chunk mean pool + L2 normalize
    - 失败自动 fallback 到 last-token

- [x] 步骤 3：Scanner 文件原子化
  - `scanDirectory()` 中 `isLateChunking` 分支：跳过共享累加器，直接 `batchLimiter` 派发
  - `totalBlockCount`：late-chunking 分支整文件计数一次，last-token 分支修复了旧的 `fileBlockCount` per-block bug
  - `pendingBatchCount` / `MAX_PENDING_BATCHES` 遵守限制

- [x] 步骤 4：FileWatcher 文件原子化
  - `processBatch()` 中 late-chunking 时按 `file_path` 分组逐个处理
  - `itemToText` 按模式选择纯代码 vs metadata
  - `processedBlocksInBatch` 正确累加

- [x] 步骤 5：配置层适配
  - `service-factory.ts`：传入 `embedderPoolingMode`
  - `config-manager.ts`：`REQUIRES_RESTART_KEYS`、`_createConfigSnapshot`、`doesConfigChangeRequireRestart` 加入新字段
  - `config-validator.ts`：枚举校验 `late-chunking` | `last-token`
  - `adapters/nodejs/config.ts`：无需修改（`isConfigured()` 不依赖此字段）
  - `commands/config/metadata.ts`：元数据条目

- [x] 步骤 6：Demo 配置 & 端到端验证
  - `demo/autodev-config.json` 加 `embedderPoolingMode`
  - `tsc --noEmit` 通过
  - 单元测试 111 个全部通过
  - E2E：index + search 对比两种模式

## 实施记录

### 2026-05-23

**改动范围**：22 文件，+1572 / -728 行。

**接口层（2）**
- `IEmbedder` 新增 `poolingMode` getter
- `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 新增 `embedderPoolingMode`

**核心算法（1）**
- `LlamaCppLlmEmbedder`：`_lateChunkingCreateEmbeddings()` 实现拼接-tokenize-子序列匹配-forward pass-mean pool-L2 normalize 完整流程；`_lastTokenCreateEmbeddings()` 保留原逻辑；失败自动 fallback

**其他 Embedder（9）**
- 全部添加 `get poolingMode() { return "last-token" }`

**处理器（2）**
- Scanner：`isLateChunking` 分支跳过共享累加器；`totalBlockCount` bug 修复；`itemToText` 按模式切换
- FileWatcher：按 `file_path` 分组逐文件处理；`itemToText` 同策略

**配置层（5）**
- service-factory、config-manager、config-validator、constants、metadata

**测试修复（2）**
- mock 添加 `poolingMode: "last-token"`

### 验证

| 验证项 | 结果 |
|--------|------|
| `tsc --noEmit` | 零错误 |
| 单元测试 (111) | 全部通过 |
| `index --force --demo` | 索引成功 |
| `search --demo` | 返回相关结果 |

### Berlin 测试

**文件**：`demo/city-facts.md`（无 Berlin/德国 字样，heading 为 One/Two/Three/Four，文件名通用，元数据零泄漏）

**查询**：`"capital of the country"`

**4 个 chunk**：
- One: "The city is the capital and largest urban center..." （含 capital + country）
- Two: "As the seat of government, it hosts the federal parliament..." （不含 capital，不含 country）
- Three: "The metropolitan area is home to approximately six million..." （含 country 不含 capital）
- Four: "Public transit is anchored by an extensive rail network..." （不含 capital，不含 country）

**对比**：

| Chunk | Last-Token | Late-Chunking | 变化 |
|-------|:----------:|:-------------:|:----:|
| One | 0.500 | 0.643 | +28.6% |
| Three | 0.333 | 0.333 | — |
| Two | 未命中 | **0.333** | 从无到有 |
| Four | 未命中 | **0.250** | 从无到有 |

**解读**：
- **Two** 不含任何查询词，last-token 下完全搜索不到。late-chunking 下 4 个 chunk 拼接后一次 forward pass，"it hosts" 中的 "it" 通过 attention 关联到 One 的 "The city is the capital"，embedding 注入了 "it = the capital city" 的语义
- **Four** 为纯公共交通描述，与 capital 无关，但全文字段让 embedding 知道这个 transit 属于前文描述的 capital city
- **One** 得分提升 28.6%，因为 embedding 从其他 chunk 获得了额外上下文
- 这是 Jina AI 论文中 Berlin 例子的代码等价复现，验证了 late chunking 的共指消解能力

### 失败尝试：Embedding 中心化（Centering）

#### 动机

纯 dense 搜索下，MiniCPM-V-4.6 的 hidden states 存在巨大 DC 偏移——
所有向量的全局均值 L2 norm 约 100，而单向量 norm 约 135。
L2 归一化后 DC 分量把无关文本（README "## Features"）和代码（`def save()`）
压在超球面的同一区域，cosine 全部挤在 0.30-0.39。

尝试对 Qdrant 向量做后处理：减全局均值 + 重新 L2 normalize，期望拉开向量间距。

#### 结果

纯 dense 搜索的噪声确实减少了（README 从 #1 降到 #3）：

```
查询: "持久化模型文件时都保存了哪些额外信息"（纯 dense）
  无 centering:  #1 README 0.391, #9 save() 0.331
  有 centering:  #1 model.py 0.220, #3 README 0.174, #5 save() 0.156
```

但对 `src/examples/eval_search.py` 反而更差（纯 dense, --limit 30）：

```
                    无 centering              有 centering
  命中数             10/12 (83.3%)             4/12 (33.3%)
  未命中             #4, #5                    #1,2,4,5,6,8,11,12
  Recall@10          25.0%                     33.3%
  Recall@20          58.3%                     33.3%
  MRR                0.1116                    0.1370
  命中中位数排名      17                        5
```

centering 后命中案例排名更靠前（中位数 #5 vs #17），但总命中从 10 跌到 4——
centering 加大了向量间距，原本勉强挤进 Top-30 的弱相关结果被推开。

#### 代码

`scripts/center-embeddings.ts` — 对已有 Qdrant 索引执行中心化。未合入主分支。

## 修订记录

- 2026-05-23：初始实现完成
- 2026-05-23：发现 MiniCPM-V-4.6 hidden states 存在 DC 偏移，纯 dense 下 embedding 区分度不足
- 2026-05-23：Centering 实验——纯 dense 下噪声减少但 eval 命中从 10 跌到 4，标记为失败尝试
- 2026-05-24：QR-Attention Temperature Sweep 实验——temp=1.0 确认为 Pareto 最优，低/高温度均不如基线

## 探索记录：2026-05-23 优化尝试

以下所有实验均以 `python src/examples/eval_search.py`（12 个查询，model.py 38 chunks）作为评测标准，baseline 为 `optimalBatchSize=1` 时的独立 last-token pooling（10/12 命中）：

| # | 实验 | 命中 | Recall@20 | 结论 |
|:---:|------|:---:|:---:|------|
| 0 | baseline（独立 last-token） | 10/12 | 58.3% | — |
| 1 | z-score 归一化（两路径） | 5/12 | 41.7% | ❌ 除 std 破坏短序列 |
| 2 | mean-only centering | 10/12 | 58.3% | → 中性，分数范围扩展但排名未改善 |
| 3 | centering + instruction prefix | 10/12 | 58.3% | → 前缀无效（裸文本不被 MiniCPM 解释为指令） |
| 4 | chat template（`<|im_start|>user\n...`） | 10/12 | 58.3% | → 无效（hidden state 提取不响应 chat format） |
| 5 | 双向 late chunking（fw+rev） | 0/12 | 0% | ❌ mean pooling 与查询 last-token 不对齐 |
| 6 | 单向 + mean pooling（查询同步改 mean pool） | 1/12 | 8.3% | ❌ mean pooling 对 MiniCPM 完全不行 |
| 7 | 单向 + last-token per chunk | 0/12 | 0% | ❌ 38 个不同函数互相稀释 |

### P0 关键 Bug 修复：`optimalBatchSize=1` 导致 late chunking 从未执行

**问题**：`LlamaCppLlmEmbedder.optimalBatchSize` 返回 `1`，BatchProcessor 的 `processItemsInBatches()` 将每个 chunk 单独作为一个 batch 调用 `createEmbeddings([chunk])`，`texts.length` 始终为 1，`texts.length > 1` 条件永远不满足，late chunking 分支从未进入。

前 4 次实验（#1-#4）结果与 baseline 完全相同，正因为我们一直在修改一段从未被执行的代码。文档中 Berlin 测试的成功是因为 compare 脚本绕过了 BatchProcessor 直接调用 `createEmbeddings`。

**修复**：late-chunking 模式下 `optimalBatchSize` 返回 1024，确保同一文件的所有 chunks 作为一个 batch 送入 `createEmbeddings`。

### P1 Token span 计算修复

原实现使用子序列匹配（`_findTokenSpans`）在 full token sequence 中查找各 chunk 的 token span。当拼接文本包含 `documentPrefix` 时，prefix 的 tokenization 可能导致后续 chunk 边界错位，子序列匹配大量失败（4/5 chunks 使用 heuristic fallback，span 估计严重偏离）。

**修复**：改为 `_computeTokenSpans`——按各 chunk 独立 token 数 + separator/prefix token 数手动累加计算 span，不依赖子序列匹配，确定性正确。

### P2 Context-window 感知分片

demo/model.py 有 38 个 blocks，拼接后约 51,000 字符 ≈ 12,000 tokens。MiniCPM-V-4.6 的 `trainContextSize` 为 128K（未超限），但 `_lateChunkingCreateEmbeddings` 新增 context-window 感知分片逻辑：当总 token 数超过 `trainContextSize - 128` 时，自动拆分为多个子 batch 分别做 late chunking，防止超出 context window 导致静默截断。

### P3 决策修正：Per-chunk mean pooling → Last-token per chunk

原决策 3 选择 mean pooling（对齐 Jina 论文）。实验表明 MiniCPM-V-4.6 的 mean-pooled hidden states 语义区分度极差（实验 #6：1/12）。last-token per chunk 让文档与查询使用相同的 last-token pooling 策略，语义空间对齐。

### P4 适用场景：主题一致性是关键

| 场景 | 文件 | 块数 | 块间关系 | Late Chunking | 独立 Last-Token |
|------|------|:---:|------|:---:|:---:|
| 共指消解（隔离） | city-facts.md | 4 | 同一城市 | ✅ 从无到有 | 0 命中 |
| 通用代码检索 | model.py | 38 | 不同函数 | ❌ 0/12 | ✅ 10/12 |

Late chunking 的跨 chunk attention 是把双刃剑：当 chunks 共享主题时增强语义信号，当 chunks 不相关时互相稀释。因此 `embedderPoolingMode` 保留 `"last-token"` / `"late-chunking"` 两个选项，用户按场景选择。

**但现实更残酷**：上面的 Berlin 测试是隔离条件下做的（只有 city-facts.md 用 late chunking，其他文件用 last-token）。当整个 demo 项目都用 late chunking 时，model.py 的 38 个 chunk 被 late-chunking 处理后 embedding 特异性降低，对无关查询的匹配反而变强了：

```
查询: "capital of the country"（期望命中 city-facts.md）

实际 Top-20（全部开启 late chunking）：
  #1-15  model.py 的 class Model, predict, __init__, save, add_callback ...
  #16    city-facts.md  header_2 Two    ← 被埋在 model.py 的噪声结果下面
  #17    city-facts.md  header_2 Four
  #18    city-facts.md  header_2 One
  #19    city-facts.md  header_2 Three
  #20+   更多 model.py / README 噪声
```

model.py 的 late-chunking embedding 变得"什么都像一点"——原本 `predict` 函数和 "capital" 无关，但拼接 38 个函数后，`predict` 的 last token 看到了前面所有 chunk（包括那些可能间接关联的），embedding 被稀释到能匹配各种查询。结果就是噪音块挤占了正确结果的位置。

**对比：关闭 late chunking 后（独立 last-token 处理）**：

```
查询: "capital of the country"（期望命中 city-facts.md）

实际 Top-10（关闭 late chunking，last-token 模式）：
  #1     city-facts.md  header_2 Three    ← 正确
  #2     city-facts.md  header_2 Two      ← 正确
  #3     city-facts.md  header_2 One      ← 正确
  #4     city-facts.md  header_2 Four     ← 正确
  #5-10  README, UserManager, utils.py ...
  （model.py 完全未出现 — 特异性被保留）
```

同一个查询、同一个索引、同一个模型——唯一变量是 `embedderPoolingMode`：

| 模式 | city-facts.md 最高排名 | model.py 出现在结果中 | 总结果数 |
|------|:---:|:---:|:---:|
| `late-chunking` | #16 | ✅ 充斥前 15 名 | 30 |
| `last-token` | #1 | ❌ 完全不出现 | 16 |

**结论**：Late chunking 只在全体 chunks 共享同一主题时有益。对于包含多种主题的代码文件（绝大多数实际情况），独立 last-token 处理始终优于 late chunking。


## 总结

Late Chunking 实现完成。通过将所有代码块在 LLM 内部拼接后进行单次 forward pass，每个块的嵌入向量携带了整个文件的上下文信息。

核心机制：
1. **文件原子化**：Scanner 和 FileWatcher 跳过共享累加器，确保同一文件的所有块一起送入 LLM
2. **Token 计数法 span 计算**：按各 chunk 独立 token 数累加计算边界（替代易出错的子序列匹配）
3. **Last-token per chunk**：每个块取最后一个 token 的 hidden state，与查询端 last-token 保持一致语义空间
4. **纯代码嵌入**：不使用元数据标注，让 LLM 的 attention 自然建立上下文关联
5. **Context-window 感知分片**：当单文件总 token 数超过模型 context window 时，自动拆分为多个子 batch

**适用场景限制**：Late chunking 仅在 chunks 之间语义相关时有效（如 city-facts.md 都描述同一城市）。当 chunks 属于不同函数/主题时（如 model.py 的 38 个函数），跨 chunk 上下文反而稀释每个块的特异性，独立 last-token 处理效果更好（baseline 10/12 vs late-chunking 0/12）。

## 探索记录：2026-05-24 无 Late Chunking 提升基线

### 背景

不改模型（MiniCPM-V-4.6 GGUF）、不开 hybrid search 的前提下，探索提升搜索召回率基线的方法。初始 baseline：`last-token` pooling，8/12 命中，MRR=0.0415。

测试命令：

```bash
# 1. 修改 demo/autodev-config.json 中的 embedderPoolingMode 和 embedderLlmInstructionPrefix
# 2. 重建索引
npx tsx src/cli.ts index --force --demo

# 3. 运行评估
python src/examples/eval_search.py
```

### 实验矩阵

所有实验使用 `python src/examples/eval_search.py`（12 个查询，model.py ~38 chunks），MiniCPM-V-4.6-Q8_0 GGUF 作为 `llamacpp-llm` embedder。

| # | 实验 | `embedderPoolingMode` | `embedderLlmInstructionPrefix` | 命中 | Recall@10 | Recall@20 | MRR | 中位数排名 | 结论 |
|:---:|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| B0 | **baseline: last-token** | `"last-token"` | `false` | 8/12 | 8.3% | 50.0% | 0.0415 | 20 | 初始基线 |
| 1 | mean pooling | `"mean"` | `false` | 6/12 | 0% | 41.7% | 0.0287 | 17 | ❌ 分数提升但区分度下降 |
| 2 | last-token + 指令前缀 | `"last-token"` | `true` | 5/12 | 0% | 8.3% | 0.0200 | 27 | ❌ 前缀对 MiniCPM 有害 |
| 3 | **qr-attention + Doc前缀** | `"qr-attention"` | `false`（Doc前缀由旧代码无条件注入） | 9/12 | 50.0% | 66.7% | 0.2250 | 4 | ✅ 大幅提升 |
| 4 | qr-attention + 指令全开 | `"qr-attention"` | `true` | 9/12 | 0% | 50.0% | 0.0415 | 16 | ❌ Query 前缀摧毁排名 |
| **5** | **qr-attention, 无前缀（最终）** | `"qr-attention"` | `false`（Doc前缀已由 flag 联动关闭） | **11/12** | **66.7%** | **66.7%** | **0.2820** | **5** | ✅🏆 **全场最佳** |

### QR-Attention 原理

QR-attention 是一种单次前向传播的注意力加权池化策略：

1. Forward pass 获取 per-token hidden states
2. 计算最后 token hidden state 与所有前序 token hidden states 的余弦相似度
3. Softmax 归一化得到 per-token 注意力权重
4. 加权 mean pool + L2 normalize 得到最终 embedding

**直觉**：在因果 transformer 中，最后位置的 hidden state 编码了来自所有前序位置的上下文信息。最后 token 对各位置的相似度近似了注意力重要性——被最后 token "记住"得越多的位置，权重越高。这与 QRRanker 用 cross-attention 衡量 query→document 相关性的精神一致。

**关键参数**：temperature（控制 softmax 锐度），当前默认 1.0。未探索的优化空间：temperature ∈ [0.5, 2.0]。

### 指令前缀教训

`embedderLlmInstructionPrefix` 开关控制 query 和 document 两端的前缀：
- Query: `"Instruct: Given a code search query, retrieve relevant code snippets that answer the query.\nQuery: {query}"`
- Document: `"Document: {context}\n\n{code}"`

对 MiniCPM-V-4.6，**无论哪种 pooling 模式，指令前缀都有害**：
- 虽然绝对分数提升（0.25→0.65+），但区分度显著下降
- 原因：MiniCPM-V-4.6 是通用 VLM，不是 instruction-tuned embedding 模型，前缀 token 改变了 hidden state 分布但不产生有意义的任务引导
- 默认关闭（`false`），对指令感知模型（如 Qwen3-Embedding）可开启

### 结论

在不换模型、不开 hybrid 的条件下，**qr-attention（无前缀）** 将基线从 8/12 提升到 11/12，MRR 从 0.0415 提升到 0.2820（6.8×），Recall@10 从 8.3% 提升到 66.7%（8×）。仅剩 #1 `is_hub_model / __init__` 未命中——这可能是 MiniCPM-V-4.6 hidden states 对该代码模式的固有盲区。

后续可探索：
- QR-attention temperature 调参（0.5 / 2.0）
- 换用专用 embedding 模型（jina-v5 / Qwen3-Embedding）对比
- 开启 reranker 叠加效果

## 探索记录：2026-05-24 QR-Attention Temperature Sweep

### 动机

理论假设：因果 transformer 的不同层编码不同粒度的信息——浅层捕获词法/句法特征，中层捕获通用语义，深层偏向 next-token prediction。QR-attention 的 softmax temperature 控制了注意力权重的锐度，间接模拟了"层深度"效果：

- **低 temperature（< 1.0）**：软 max 更尖锐，少数 token 主导 → 类似深层（特化、窄覆盖）
- **高 temperature（> 1.0）**：软 max 更平滑，更多 token 参与 → 类似浅层（泛化、宽覆盖）

### 实现

将 `_qrAttentionCreateEmbeddings()` 中的硬编码 `QR_TEMPERATURE = 1.0` 改为可通过环境变量覆盖：

```typescript
const QR_TEMPERATURE = (() => {
  if (typeof process !== "undefined" && process.env.QR_TEMPERATURE) {
    const v = parseFloat(process.env.QR_TEMPERATURE)
    if (!isNaN(v) && v > 0) return v
  }
  return 1.0
})()
```

自动化实验脚本：`src/examples/qr-temperature-sweep.sh`，对 6 个温度值各执行一次 索引重建 + eval。

### 实验矩阵

所有实验使用 `python src/examples/eval_search.py`（12 个查询，model.py ~38 chunks），MiniCPM-V-4.6-Q8_0 GGUF，`qr-attention` pooling 模式，无指令前缀。

| # | Temperature | 命中 | Recall@1 | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR | 中位数排名 | 未命中查询 | 结论 |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|------|
| T0 | 0.25 (尖锐) | 9/12 | 16.7% | 25.0% | 41.7% | 58.3% | 66.7% | 0.2751 | 5 | #1, #4, #11 | ❌ 过尖锐丢失泛化 |
| T1 | 0.5 | 9/12 | 16.7% | 33.3% | 50.0% | 66.7% | 66.7% | **0.3105** | **4** | #1, #4, #11 | ⚠️ 最高 MRR 但低召回 |
| T2 | **1.0 (基线)** | **11/12** | 8.3% | 41.7% | 50.0% | 66.7% | 66.7% | 0.2820 | 5 | #1 | ✅🏆 Pareto 最优 |
| T3 | 2.0 | **11/12** | 8.3% | 41.7% | 41.7% | 58.3% | **75.0%** | 0.2797 | 6 | #1 | → 维持命中但排名恶化 |
| T4 | 3.0 | **11/12** | 8.3% | 41.7% | 41.7% | 58.3% | **75.0%** | 0.2665 | 6 | #1 | → MRR 持续下降 |
| T5 | 4.0 (平滑) | **11/12** | 8.3% | 41.7% | 41.7% | 58.3% | **75.0%** | 0.2658 | 6 | #1 | → MRR 最低 |

### 逐查询对比

| # | 查询 | T0 (0.25) | T1 (0.5) | T2 (1.0) | T3 (2.0) | T4 (3.0) | T5 (4.0) |
|:---:|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | HUB/Triton/本地文件分支 (`__init__`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 2 | `is_triton_model` 静态方法 | #5 / 0.322 | #2 / 0.283 | #2 / 0.256 | #2 / 0.241 | #3 / 0.235 | #3 / 0.233 |
| 3 | `predict_cli` vs `predictor()` 分支 | #10 / 0.249 | #9 / 0.203 | #10 / 0.179 | #12 / 0.166 | #13 / 0.162 | #15 / 0.160 |
| 4 | train 末尾 best/last 权重 | ✗ | ✗ | #29 / 0.246 | #29 / 0.236 | #27 / 0.233 | #26 / 0.232 |
| 5 | export format/half/int8 参数 | #15 / 0.317 | #8 / 0.286 | #8 / 0.272 | #7 / 0.265 | #7 / 0.263 | #7 / 0.262 |
| 6 | tune `use_ray` vs Tuner 分支 | #7 / 0.318 | #4 / 0.297 | #3 / 0.287 | #3 / 0.281 | #3 / 0.279 | #3 / 0.278 |
| 7 | 保存模型 license/version/docs | #4 / 0.311 | #5 / 0.260 | #5 / 0.233 | #6 / 0.220 | #6 / 0.215 | #6 / 0.213 |
| 8 | `_reset_ckpt_args` 保留参数 | #1 / 0.495 | #1 / 0.503 | #1 / 0.509 | #1 / 0.512 | #1 / 0.513 | #1 / 0.513 |
| 9 | callback 管理 | #1 / 0.407 | #1 / 0.339 | #2 / 0.297 | #2 / 0.274 | #2 / 0.266 | #2 / 0.262 |
| 10 | embed 取倒数第二层 | #2 / 0.296 | #2 / 0.274 | #2 / 0.264 | #2 / 0.260 | #2 / 0.258 | #2 / 0.258 |
| 11 | track 注册跟踪器 | ✗ | ✗ | #22 / 0.118 | #19 / 0.120 | #16 / 0.121 | #16 / 0.121 |
| 12 | task_map 动态加载 | #24 / 0.216 | #25 / 0.166 | #22 / 0.146 | #23 / 0.137 | #22 / 0.134 | #22 / 0.133 |

### 关键发现

**1. temp=1.0 是 Pareto 最优**

只有 temp=1.0 同时命中 #4 (`train` best/last weight) 和 #11 (`track` register_tracker)。低温度（0.25/0.5）丢失这两个查询，高温度（2.0-4.0）打中了但排名下降。

**2. MRR 呈驼峰状，temp=0.5 是局部最高点**

```
MRR 曲线:
0.32 ┤        ●(0.3105)
0.31 ┤
0.30 ┤
0.29 ┤
0.28 ┤              ●(0.2820)
0.27 ┤    ●(0.2751)              ●(0.2797)
0.26 ┤                              ●(0.2665) ●(0.2658)
     └─────┬──────┬──────┬──────┬──────┬──────
         0.25    0.5    1.0    2.0    3.0    4.0
```

temp=0.5 的 MRR 最高（0.3105）但以丢失 2 个查询为代价——经典的 precision-recall 权衡：9 个命中的排名质量很高（中位数 #4），但完全不召回另外 2 个。

**3. 低 temperature（模拟深层）：召回下降**

| 丢失查询 | 描述 | 原因 |
|:---:|------|------|
| #4 | train 末尾 best/last 权重更新 | 语义较泛，需要更多上下文 token 参与 |
| #11 | track 注册跟踪器、低置信度阈值 | 查询-代码语义距离较大 |

尖锐 attention（低 temp）只给极少数高相关 token 分配权重，导致 embedding 过于"窄"。这印证了纯 last-layer 的问题——过度特化到 next-token prediction 目标，丢失了泛化匹配能力。

**4. 高 temperature（模拟浅层）：排名持续恶化**

temp 从 1.0 → 4.0，MRR 从 0.2820 降到 0.2658（-5.7%），中位数排名从 #5 降到 #6。虽然命中数保持 11/12，但正确结果被推到了更靠后的位置。这是浅层的预期行为——语义覆盖广但区分度不足。

**5. 分数分布随温度变化**

| Temperature | 最低命中分数 | 最高命中分数 | 分数跨度 |
|:---:|:---:|:---:|:---:|
| 0.25 | 0.216 | 0.495 | 0.279 |
| 0.5 | 0.166 | 0.503 | 0.337 |
| 1.0 | 0.118 | 0.509 | 0.391 |
| 2.0 | 0.120 | 0.512 | 0.392 |
| 3.0 | 0.121 | 0.513 | 0.392 |
| 4.0 | 0.121 | 0.513 | 0.392 |

低温度压缩了分数范围（更保守），高温度扩展了范围（更激进），但范围扩大并未带来更好的排序——说明高温度下的分数分布虽然拉开了，但排序准确性反而下降了。

### 对"中间层池化"假设的评估

Temperature 实验是"层深度"的不完美代理（只控制 pooling 注意力分布，不改变 hidden states 语义来源），但给出了有价值的信号：

| 维度 | 低 temp（≈深层） | 高 temp（≈浅层） | 含义 |
|------|:---:|:---:|------|
| 命中数 | ↓ (9) | → (11) | 深层更特化、窄覆盖 |
| MRR | ↑ (0.3105) | ↓ (0.2658) | 深层排序更准 |
| 分数分布 | 窄 | 宽 | 深层更保守 |

**初步结论：temperature sweep 不支持"中间层显著优于最后一层"的假设。** qr-attention 在 temp=1.0 的组合（最后层 hidden state + 标准 softmax 注意力加权）已经是当前最优解。

但这**不是最终结论**——temperature 只是改变了 pooling 的注意力分布，没有改变 hidden states 本身的语义层来源。真正的中间层实验需要从 llama.cpp 层面提取中间层 hidden states：

- 需在 `llama_context_params` 中增加 `embd_layer` 参数
- 需修改 ~30 个模型架构文件的 graph building 代码
- 之后可从第 50%、66%、75% 深度提取 hidden states 做对比实验

后续可探索：
- ✅ llama.cpp `embd_layer` 参数已实现（见 `docs/plans/260524-llamacpp-midlayer-embd.md`）
- ✅ Layer Sweep 已完成——L22 为最佳提取层
- ✅ 层 × 池化交叉实验完成——L22-mean 为全局最佳 (MRR=0.55)
- ✅ 多模型全层扫描完成（修正版）——悬崖是因果 LM 固有属性，与模型大小无关
- 支持"最后 N 层加权平均"（Sentence-BERT 风格 pooling）
- 换用专用 embedding 模型（Qwen3-Embedding / Qwen3.6-27B）跑完整 layer sweep eval

## 探索记录：2026-05-24 中间层 Embedding 提取（Layer Sweep）

### 背景

Temperature sweep 的结论是"不支持中间层显著优于最后一层"，但明确指出这只是 pooling 注意力分布的实验，**没有改变 hidden states 本身的语义层来源**。真正的中间层实验需要从 llama.cpp C++ 层支持层选择。

### 实现

完整实现在 `docs/plans/260524-llamacpp-midlayer-embd.md` 中记录，跨越 3 个代码库：

| 层次 | 改动 | 状态 |
|------|------|:--:|
| llama.cpp C++ | `llama_context_params.embd_layer` + 97 个模型架构 patch | ✅ |
| node-llama-cpp JS | `LlamaEmbeddingContextOptions.embdLayer` → `AddonContext` 参数链路 | ✅ |
| autodev-codebase | `embedderPoolingLayer` 配置项 + `POOLING_LAYER` 环境变量 | ✅ |

### Layer Sweep 实验设计

**前置**：全层 cosine 扫描——对 MiniCPM-V-4.6（24 层）逐层提取 embedding，5 个 prompt mean-pool L2 normalize，计算与最后一层 (L23) 的 cosine similarity。

**全层扫描发现**：最后一层与所有其他层相似度极低（L22=0.41, L18=0.31, L0=0.09），存在明显的"最后一层悬崖"——L22→L23 的 Δcos=0.59，是相邻层平均变化的 14 倍。

**检索评估**：对 9 个关键层（L23-L8）分别运行 `embedderPoolingLayer` + 重建索引 + `eval_search.py`（12 个查询，qr-attention pooling，无指令前缀）。

### 结果

| Layer | 命中 | MRR | R@1 | R@10 | 中位数 | vs L23 MRR |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **L23 (last)** | **11/12** | 0.2820 | 8.3% | 66.7% | 5 | baseline |
| **L22** ★ | 9/12 | **0.5000** | **33.3%** | 75.0% | **2** | **+77%** |
| L20 | 9/12 | 0.4355 | 25.0% | 75.0% | 2 | +54% |
| L18 | 10/12 | 0.4097 | 16.7% | 75.0% | 3 | +45% |
| L16 | 10/12 | 0.3463 | 16.7% | 75.0% | 5 | +23% |
| L15 | 10/12 | 0.2301 | 0% | 58.3% | 8 | -18% |
| L12 | 9/12 | 0.3071 | 16.7% | 58.3% | 4 | +9% |
| L10 | 9/12 | 0.2528 | 16.7% | 50.0% | 9 | -10% |
| L8 | 9/12 | 0.3677 | 25.0% | 58.3% | 2 | +30% |

**★ L22 是最佳层：MRR 提升 77%，R@1 提升 4×**

### 与 Temperature Sweep 结论的对比

Temperature sweep 结论是"temp=1.0（最后层 + 标准 softmax）已是 Pareto 最优"。但 layer sweep 推翻了这一结论：

| 实验 | 方法 | 最优参数 | MRR | vs Last-Layer |
|------|------|:---:|:---:|:---:|
| Temperature Sweep | 改变 QR-attention 温度 | temp=1.0 (last layer) | 0.2820 | — |
| **Layer Sweep** | **改变 hidden states 语义层** | **L22** | **0.5000** | **+77%** |

Temperature sweep 仅仅改变了 pooling 的注意力分布——也就是"如何利用同一个 hidden states"。Layer sweep 从根本上改变了 hidden states 的语义来源——L22 的 hidden states 比 L23 更适合语义检索。

### 丢失查询分析

| Layer | 丢失查询 | 说明 |
|:---:|------|------|
| L23 | #1 (is_hub_model) | 覆盖最广，仅丢 1 个 |
| L22/L20 | #1, #3 (predict_cli), #11 (track) | 丢 3 个，但排序最优 |
| L18/L16 | #1, #4 (train best/last weight) | 丢 2 个，平衡之选 |

L22 丢失的 #3 和 #11 是极难查询（#3 在 L22 下 Top-30 中无任何结果），但换来了其余 9 个查询的排序质量大幅提升。

### 结论

1. **"最后一层悬崖"被检索实验证实**：L22→L23 的 MRR 从 0.50 跌到 0.28（-44%），与全层扫描 cos 0.41↗1.00 的跳跃一致
2. **最佳提取区间为 L18-L22（75-92% 深度）**：MRR 比最后一层高 45-77%
3. **Coverage vs Precision 权衡**：最后一层覆盖最广但排序最差，L22 排序最优但覆盖略降
4. **Temperature sweep 的"不支持中间层"结论被推翻**——当时只是因为还没实现真正的中间层 hidden states 提取

### 后续

- `embedderPoolingLayer` 默认值建议从 `"last"` 改为自动检测（如模型 N 层，取 floor(N × 0.92)）
- 多层平均实验：L20-L23 加权平均是否能同时保持覆盖率和排序质量
- 不同模型验证：Qwen3-Embedding / jina-v5 上重复 layer sweep

### 探索记录：2026-05-24 层 × 池化 交叉实验

在完成单层 sweep（qr-attention 固定，变 layer）后，进一步测试三种池化方式 × 七个层深度的完整交叉矩阵。

**实验设计**：MiniCPM-V-4.6, 7 layers (L23-L8) × 3 pooling modes (last-token, mean, qr-attention) = 21 组合

**完整矩阵**：

```
                     ──────────── 池化方式 ────────────
层                   last-token         mean              qr-attention
──────────────────────────────────────────────────────────────────────────
L23 (last, cos=1.00) 8/12 MRR=0.04      11/12 MRR=0.27    11/12 MRR=0.28
L22 (92%,  cos=0.41) 6/12 MRR=0.12      9/12 MRR=0.55 ★   9/12 MRR=0.50
L20 (83%,  cos=0.35) 2/12 ❌            9/12 MRR=0.43     9/12 MRR=0.44
L18 (75%,  cos=0.31) 2/12 ❌            10/12 MRR=0.41    10/12 MRR=0.41
L15 (62%,  cos=0.27) 1/12 ❌            10/12 MRR=0.33    10/12 MRR=0.23
L12 (50%,  cos=0.23) 0/12 ☠             9/12 MRR=0.31     9/12 MRR=0.31
L8  (33%,  cos=0.14) 0/12 ☠             9/12 MRR=0.36     9/12 MRR=0.37
```

**★ 新全局最佳：L22-mean, MRR=0.5486, 中位数排名 #1**

**三个关键发现**：

1. **last-token 极度依赖最后层**：作为"取一个点"的策略，它要求那个点正好在 lm_head 对齐层。离开 L23 后性能断崖式下跌（L22=6→L20=2→L12=0）。之前 late-chunking 实验中的 8/12 baseline 已经是 last-token 在 MiniCPM 上的天花板。

2. **mean 被低估了**：之前实验中 mean 表现差（6/12），是因为默认用 L23。换到 L22 后，mean 的 MRR 从 0.27 暴涨到 0.55——甚至超过了 qr-attention。mean 的分布式特性使其对"干净但非对齐"的 hidden states（如 L22）有天然容错。

3. **qr-attention 的有效性局限于最后层**：qr-attention 的核心——"最后 token 对前文的 cosine 相似度作为注意力权重"——依赖最后 token 携带真实的注意力信号。L23 时 qr > mean (0.28 > 0.27)，L22 时信号退化被 mean 反超 (0.50 < 0.55)，L8 时所有 token 相似度趋同、权重退化到 1/n、qr ≈ mean (0.37 ≈ 0.36)。

**对池化策略的修正理解**：

| 之前 | 之后 |
|------|------|
| qr-attention > mean > last-token | L22-mean > L22-qr > L23-qr > L23-mean > L23-last-token |
| 池化和层是两个独立维度 | 池化的有效性依赖层的语义质量 |
| 智能加权一定优于等权平均 | 当权重信号退化时，等权平均反而更好 |

**后续**：L22-mean 作为新的默认推荐组合（`embedderPoolingLayer: 22` + `embedderPoolingMode: "mean"`），但覆盖率略低于 L23-qr-attention（9/12 vs 11/12），需在实际场景中权衡。

### 探索记录：2026-05-24 多模型全层扫描（5 因果 LM + 1 嵌入模型，修正版）

**⚠️ 早期扫描因层数检测 bug 只读了前 24 层，得出"悬崖随模型大小衰减"的错误结论。修正后重新扫描。**

| 模型 | 参数量 | 层数 | 训练目标 | L0 | L(N-2) | L(N-1) | Δ(悬崖) |
|------|:--:|:--:|------|:--:|:--:|:--:|:--:|
| MiniCPM-V-4.6 | 0.5B | 24 | 通用 VLM | 0.09 | 0.41 | 0.41 | **0.59** |
| Qwen3.5-4B | 4B | 32 | 通用 LLM | 0.08 | 0.43 | 0.47 | **0.53** |
| Qwen3.5-9B | 9B | 32 | 通用 LLM | 0.17 | 0.41 | 0.60 | **0.40** |
| Qwen3.6-27B | 27B | 64 | 通用 LLM | 0.09 | 0.56 | 0.56 | **0.44** |
| Qwen3.6-35B-A3B | 35B | 40 | MoE LLM | 0.17 | 0.38 | 0.38 | **0.62** |
| Qwen3-Embedding | 0.6B | 28 | 对比学习 | 0.03 | 0.70 | 0.70 | **0.30** |

**修正后的结论：**

1. **悬崖是因果 LM 的固有属性，与模型大小无关**：0.5B 和 35B 的悬崖都在 0.40-0.62 之间。next-token prediction 的 lm_head 对齐对所有大小的因果 LM 都会在最后层产生 hidden states 变形。

2. **嵌入模型悬崖更小但仍存在**：Qwen3-Embedding 的 Δ=0.30，约为因果 LM 的一半。对比学习训练减轻了但仍未完全消除 last-layer 效应。

3. **中层提取对所有因果 LM 都有价值**：不存在"大到不需要"的阈值——之前以为 27B 无悬崖是因为只看了前 24 层（实际有 64 层）。

4. **Qwen3.6-27B 的 L22（36%深度）检索效果（MRR=0.64）优于 L23（MRR=0.55）**——说明即使对大模型，略过最后 1-2 层仍有提升。），但覆盖率略低于 L23-qr-attention（9/12 vs 11/12），需在实际场景中权衡。

## 探索记录：2026-05-24 Chat Template 与 Embedding 提取

### 问题

MiniCPM-V-4.6 是 instruct-tuned VLM，训练时使用完整的 chat template（`<|im_start|>user\n...<|im_end|><|im_start|>assistant\n`）。在提取 hidden states 做 embedding 时，是否应该套用此模板？

### 实际行为

`getEmbeddingsForTokens()` 在 `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js` 中定义，处理流程：

```text
text → tokenizeInput() → resolveBeginningTokenToPrepend (加 BOS)
                       → resolveEndTokenToAppend (加 EOS)
                       → evaluate({_noSampling: true})   // 1 token forward pass
                       → getEmbedding(i)                  // 提取每 token hidden state
```

实际进入模型的文本是：

```
[BOS] raw_text [EOS]
```

**不是**完整的 chat template：

```
<|im_start|>user       ← 没有
raw_text<|im_end|>     ← 没有
<|im_start|>assistant  ← 没有
```

只加了 BOS/EOS 边界 token（由 `tokenizerUtils.js` 中的 `resolveBeginningTokenToPrepend` / `resolveEndTokenToAppend` 根据模型 vocab 类型和 `shouldPrependBosToken` / `shouldAppendEosToken` 标志决定）。

### 实验验证

文档早期实验 #4 测试过套完整 chat template（`<|im_start|>user\n...`），结果与 baseline 完全相同（10/12），对 MiniCPM 无效：

> hidden state 提取不响应 chat format

### 结论

当前做法（裸文本 + BOS/EOS）是正确的。本质上是利用 MiniCPM **预训练 backbone 的语义表示能力**，绕开了 instruct tuning 加上的两层包装：

| MiniCPM 的训练目标 | embedding 提取中的状态 |
|------|------|
| Chat template（role markers） | ❌ 不套，实验证实无效 |
| Next-token generation（最后一层） | ❌ 跳过，用 L22 避开 lm_head 偏置 |
| Backbone 语言理解 | ✅ 这是实际用到的 |

这也解释了 0.5B 模型区分度有限的根本原因：它预训练时没见过"区分代码函数和城市交通文本"这种对比任务。专用 embedding 模型（Qwen3-Embedding、jina-v5）用对比学习训练过，hidden states 在所有层都更适合检索（悬崖仅 0.30 vs MiniCPM 的 0.59）。

## 探索记录：2026-05-24 非对称层配置 & embedderPoolingLayer 拆分

### 背景

之前的 layer sweep 实验中，L22-mean 跑出 MRR=0.5486（全球最佳），但后来改用匹配层（index 和 search 同层）后只能到 MRR=0.37。排查发现历史高分是用**非对称层**（index L22 + search L23）跑出来的，而不是对称层。

### Bug 发现：`"qr-attention"` → `"qr-weighted"` 重命名遗漏

`qr-attention` 是旧名称，已重命名为 `qr-weighted`。代码中所有类型和判断逻辑已更新为新名：

```typescript
// createEmbeddings() 分发逻辑
if (this._poolingMode === "qr-weighted") { ... }
```

但 `demo/autodev-config.json` 的注释行仍残留旧名 `"qr-attention"`。当 config 中误设为旧名时，因不匹配任何分支，静默回退到 `last-token` pooling——导致两次 sweep（误用旧名和 last-token）产生完全相同的指标。

**修复**：更新 demo config 注释行为新名 `"qr-weighted"`。

### 核心发现：非对称层优于对称层

| 配置 | 命中 | MRR | R@1 | 中位数 |
|------|:---:|:---:|:---:|:---:|
| L22 index + **L23 query** (非对称) | 9/12 | **0.5486** | **41.7%** | #1 |
| L22 index + L22 query (对称) | 10/12 | 0.3708 | 16.7% | #2 |
| L20 index + L23 query (非对称) | 9/12 | 0.4286 | 25.0% | #2 |
| L18 index + L23 query (非对称) | 10/12 | 0.4074 | 16.7% | #2 |

**原因**：这是一种非对称双编码器效应——LM 的不同层捕捉不同粒度的语义信息：

- **L22 (92% 深度)**：hidden states 更"干净"，少受 next-token prediction 偏置污染，适合编码"这段代码是什么"
- **L23 (last layer)**：hidden states 经过 lm_head 对齐，更接近"提问/生成"的语义空间，适合编码"用户想问什么"

两者组合比用同一层匹配得分更高（MRR 0.55 vs 0.37，+48%）。

### 配置拆分：`embedderPoolingLayer` → index + query

基于上述发现，将单一的 `embedderPoolingLayer` 拆分为两个独立配置项：

| 配置项 | 用途 | 默认值 |
|------|------|:---:|
| `embedderPoolingLayer` | 索引端（文档 embedding）的提取层 | `"last"` |
| `embedderQueryPoolingLayer` | 查询端（query embedding）的提取层 | `"last"`（回退到 `embedderPoolingLayer`） |

**生产配置推荐**：

```json
{
  "embedderPoolingLayer": 22,
  "embedderQueryPoolingLayer": "last"
}
```

### 环境变量重构

原设计将 `POOLING_LAYER` 环境变量检查放在 `LlamaCppLlmEmbedder` 构造函数中，导致 index 和 query embedder 都受同一个变量影响，无法独立控制。

**修复**：将环境变量逻辑从 constructor 移到 `service-factory.ts`：

| 变量 | 控制 | 解析位置 |
|------|------|------|
| `POOLING_LAYER` | 索引 embedder 层 | `_resolveIndexLayer()` |
| `QUERY_POOLING_LAYER` | 查询 embedder 层 | `_resolveQueryLayer()` |

```typescript
// service-factory.ts
private _resolveIndexLayer(config) {
  return this._resolveLayerFromEnv("POOLING_LAYER") 
      ?? config["embedderPoolingLayer"] ?? "last"
}

private _resolveQueryLayer(config) {
  return this._resolveLayerFromEnv("QUERY_POOLING_LAYER") 
      ?? config["embedderQueryPoolingLayer"] ?? config["embedderPoolingLayer"] ?? "last"
}
```

`LlamaCppLlmEmbedder` 构造函数不再读环境变量，只接受参数。`service-factory.createServices()` 创建两个独立的 embedder——index embedder 传给 scanner/fileWatcher，query embedder 传给 search service。

### 实验脚本更新

`layer-sweep.sh` 新增用法：

```bash
./layer-sweep.sh                    # 非对称：index 层变，search 固定 L23
SYMMETRIC=1 ./layer-sweep.sh        # 对称：index 和 search 同层
QUERY_POOLING_LAYER=20 ./layer-sweep.sh  # 自定义搜索层
```

### 涉及文件（本轮 12 文件）

| 文件 | 改动 |
|------|------|
| `interfaces/config.ts` | `embedderQueryPoolingLayer` 类型定义（3 个 interface/type） |
| `constants/index.ts` | 默认值 |
| `config-manager.ts` | `REQUIRES_RESTART_KEYS`、snapshot 构建、change detection |
| `config-validator.ts` | 类型校验（`"last"` / number / fraction） |
| `metadata.ts` | 配置项元数据 |
| `embedders/llamacpp-llm.ts` | 移除 constructor 中的 `POOLING_LAYER` env 检查 |
| `service-factory.ts` | `_resolveIndexLayer()` / `_resolveQueryLayer()` / `createQueryEmbedder()` |
| `manager.ts` | `createServices()` 返回 `queryEmbedder`，search service 使用它 |
| `demo/autodev-config.json` | `embedderQueryPoolingLayer: "last"`，`qr-attention` → `qr-weighted` |
| `layer-sweep.sh` | 支持 `QUERY_POOLING_LAYER` / `SYMMETRIC` / `LAYERS` 环境变量 |
