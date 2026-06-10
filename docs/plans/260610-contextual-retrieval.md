# 260610-contextual-retrieval

## 主题/需求

在索引阶段，用 `LlamaCppSummarizer`（MiniCPM-V-4_6 / Qwen3.5-0.8B）对每个代码块生成简短上下文描述，拼接到嵌入文本前，再入向量库。目标是提升语义搜索的召回质量。

**当前状态：暂不实施（索引太慢），先存档思路。**

## 代码背景

### 当前索引管线

```
tree-sitter 解析 → CodeBlock[]
  ↓
itemToText: block.content (late-chunking) 或 generateBlockEmbeddingText(block) (非 late-chunking)
  ↓
embedder.createEmbeddings(texts)
  ↓
vectorStore.upsertPoints
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/code-index/processors/scanner.ts:395-402` | `itemToText` / `itemToPoint` — 嵌入文本生成和 Payload 构建 |
| `src/code-index/shared/block-text-generator.ts` | `generateBlockEmbeddingText` — 当前的结构上下文拼接（File/Name/Parent） |
| `src/code-index/summarizers/llamacpp.ts` | `LlamaCppSummarizer` — 已有 prefix caching，同文件 batch 共享 KV cache |
| `src/code-index/interfaces/vector-store.ts:111-117` | `Payload` — 支持 `[key: string]: any`，可加 `contextChunk` 字段 |
| `src/commands/config/metadata.ts` | 配置项元数据定义 |

### 当前配置（`autodev-config.json`）

- **Embedder**: `llamacpp-llm` + `F2LLM-v2-80M`，pooling = `late-chunking`
- **Summarizer**: `llamacpp` + `MiniCPM-V-4_6-Q8_0.gguf`（Qwen3.5-0.8B 训练）
- **SummarizerBatchSize**: 2，**SummarizerConcurrency**: 2

### Prefix Caching 现状（方案 F）

`docs/plans/260609-llamacpp-prefix-caching.md` 已实现：
- system prompt 分离（shared context 放 system prompt，snippets 放 user message）
- 同文件 batch 串行化，共享 sequence，KV cache 复用
- 55.40s → ~20s（2.75x），0 失败

## 关键决策

### 决策 1：如果做 contextual retrieval，就放弃 late-chunking

**理由：**

- late-chunking 模式下 `itemToText = block.content`（裸代码），所有 chunk 拼成一个大序列再做 forward pass
- 如果要在每个 chunk 前加 LLM 生成的上下文，就破坏了 late-chunking 的拼接语义
- 改为每个 chunk 独立索引：`itemToText = contextChunk + "\n" + block.content`

**影响：**

- 失去 late-chunking 的跨 chunk 注意力交互
- 但获得 LLM 生成的语义上下文，理论上能弥补甚至超越

### 决策 2：复用 LlamaCppSummarizer，而非新建组件

**理由：**

- prefix caching 已经把 per-batch 成本压到很低
- `summarizeBatch` 接口天然支持 document + filePath + blocks[]
- 只需调整 prompt（从"生成摘要"改为"生成检索上下文"），其他基础设施全部复用

### 决策 3：暂不实施

**理由：**

- MiniCPM-V-4_6（Qwen3.5-0.8B）代码上下文生成质量待验证，0.8B 参数对代码理解偏弱
- 即使 prefix caching 把单 chunk 成本压到 ~0.2-0.3s，大规模项目（2000+ chunks）仍要增加 10-17 分钟索引时间
- 当前 late-chunking + QRRanker 的重排序管线已经提供了不错的检索质量
- 优先做 A/B 实验验证收益，而非直接全量上线

## 实施计划

- [ ] **A/B 实验**：选 10-20 个典型查询，对比有/无 contextual retrieval 的 top-10 召回质量
- [ ] **配置开关**：新增 `contextualRetrievalEnabled`、`contextualRetrievalBatchSize` 配置项
- [ ] **预处理步骤**：在 `DirectoryScanner.processBatch` 前插入 `ContextualRetrievalPreprocessor`
  - 按文件分组 blocks
  - 调用 `LlamaCppSummarizer.summarizeBatch` 生成短上下文
  - 注入到 block 的新字段（如 `contextChunk`）
- [ ] **itemToText 适配**：非 late-chunking 模式下，`contextChunk + "\n" + generateBlockEmbeddingText(block)`
- [ ] **Payload 存储**：把 `contextChunk` 存入 Payload，供搜索结果展示

### 可选探索

- 换更强的纯文本模型（当前 MiniCPM-V 是视觉模型，有视觉 head 的 overhead）
- 检索时扩展 query 替代索引时扩展 chunk（成本只在查询时发生）
- 只对顶层声明（class、export function）做 contextual retrieval，跳过实现细节

## 成本估算

基于 prefix caching 后实测速度（24 blocks / 12 batches / ~20s）推算：

| 场景 | 增加耗时 |
|------|----------|
| 单文件 24 chunks | +5s |
| 中型项目 500 chunks | +3~4 分钟 |
| 大型项目 2000 chunks | +13~17 分钟 |
| 增量更新（几个文件） | 接近零 |

## 总结

Contextual retrieval 在理论上能提升 late-chunking 模式下的检索质量（因为 late-chunking 的嵌入文本不含 File/Name/Parent 等元数据）。前缀缓存把 per-chunk LLM 成本压到了可接受范围，但 0.8B 模型的代码上下文生成质量是最大不确定因素。建议先做 A/B 实验再决定是否全量上线。

## 修订记录

### 2026-06-10
**动作：** 创建文档，记录 contextual retrieval 思路
**背景：** prefix caching 方案 F 成功后（55s → 20s），讨论是否利用加速后的 summarizer 做 contextual retrieval
**决策：** 暂不实施，先存档
