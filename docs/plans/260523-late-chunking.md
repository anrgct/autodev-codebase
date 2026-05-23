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

## 失败尝试：Embedding 中心化（Centering）

### 动机

纯 dense 搜索下，MiniCPM-V-4.6 的 hidden states 存在巨大 DC 偏移——
所有向量的全局均值 L2 norm 约 100，而单向量 norm 约 135。
L2 归一化后 DC 分量把无关文本（README "## Features"）和代码（`def save()`）
压在超球面的同一区域，cosine 全部挤在 0.30-0.39。

尝试对 Qdrant 向量做后处理：减全局均值 + 重新 L2 normalize，期望拉开向量间距。

### 结果

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

### 代码

`scripts/center-embeddings.ts` — 对已有 Qdrant 索引执行中心化。未合入主分支。

## 修订记录

- 2026-05-23：初始实现完成
- 2026-05-23：发现 MiniCPM-V-4.6 hidden states 存在 DC 偏移，纯 dense 下 embedding 区分度不足
- 2026-05-23：Centering 实验——纯 dense 下噪声减少但 eval 命中从 10 跌到 4，标记为失败尝试

## 总结

Late Chunking 实现完成。通过将所有代码块在 LLM 内部拼接后进行单次 forward pass，每个块的嵌入向量携带了整个文件的上下文信息。这消除了传统分块策略中块间语义断裂的问题，使得搜索结果能发现那些不包含查询关键词但与文件主题高度相关的代码块。

核心机制：
1. **文件原子化**：Scanner 和 FileWatcher 跳过共享累加器，确保同一文件的所有块一起送入 LLM
2. **子序列匹配**：在 token 级别精确定位每个块的边界
3. **Per-chunk mean pooling**：对每个块的 token hidden states 做均值池化
4. **纯代码嵌入**：不使用元数据标注，让 LLM 的 attention 自然建立上下文关联

（待完成后填写）
