# 260603 llamacpp-llm embedding context size 调优

## 主题/需求

`llamacpp-llm` embedder 使用通用 LLM 做 embedding 时，late-chunking 模式下的 `_embeddingContextSize` 硬编码在源代码中，无法通过配置文件调节。需要：

1. **抽离为配置参数** `embedderLateChunkingContextSize`，默认值 = 模型实际 context size（自动适配）
2. 允许用户手动缩小该值以加快索引速度（代价：降低跨 chunk 上下文效果）
3. 记录不同 context size 下的索引速度对比

## 代码背景

- `src/code-index/embedders/llamacpp-llm.ts` — 第 153~154 行：
  ```ts
  this._embeddingContextSize = (this._embeddingContexts[0] as any)?._llamaContext?.contextSize ?? this._contextSize
  this._embeddingContextSize = 16000  // ← 硬编码，需要移除/配置化
  ```
- 该值在 `_lateChunkingCreateEmbeddings()` 中控制子批次拆分阈值（第 283 行）：
  ```ts
  const contextSize = this._embeddingContextSize > 0 ? this._embeddingContextSize : this._contextSize
  const maxBatchTokens = Math.max(Math.floor(contextSize * 0.95), 512)
  ```
- 配置链路：`interfaces/config.ts` → `config-validator.ts` → `config-manager.ts` → `service-factory.ts` → `llamacpp-llm.ts`

## 运行现象

### 测试模型

- **模型**: `F2LLM-v2-80M.Q8_0-pooling-NONE.gguf`（80M 参数）
- **提供者**: `embedderProvider: "llamacpp-llm"`
- **Pooling**: `late-chunking`
- **并发**: 2
- **batchSize**: 5500（Metal GPU bug 绕行）
- **Chunk 大小**: 2000–2300 chars / chunk（由 `MAX_BLOCK_CHARS=2000` + `MAX_CHARS_TOLERANCE_FACTOR=1.15` 决定）
- **代码库**: ~55k 行 TypeScript

#### 不同 `_embeddingContextSize` 的耗时对比

| contextSize | 总耗时 | 子批次分布 |
|-------------|--------|-----------|
| 40960（模型原生） | 5:23 | 557 chunks / 109419 tokens |
| 16000 | 3:27 | — |
| 8000 | 2:37 | — |
| 4000 | 2:02 | — |
| 2000 | **1:29** | — |

`ctxSize=2000` 耗时（1:29）已与 `llamacpp` 专用 embedding 模型持平，但此时 late-chunking 退化为逐块处理。

#### embedderProvider=llamacpp 基准

专用 embedding 模型（jina-embeddings-v5 等）处理相同代码库 **1:30**，与 `ctxSize=2000` 的 `llamacpp-llm` 持平。

#### 耗时曲线

```
ctxSize   耗时    相比 baseline
─────────────────────────────────
40960     5:23    3.7x (baseline)
16000     3:27    2.3x
 8000     2:37    1.7x
 4000     2:02    1.4x
 2000     1:29    1.0x  ← 与 llamacpp 持平
```

### 理解

- `llamacpp-llm` 使用自回归 decoder 做 embedding，架构决定了比专用 encoder-only embedding 模型慢
- 缩小 `_embeddingContextSize` → 子批次更小 → 单次 forward pass 更轻 → 总耗时下降
- 过小的 contextSize（如 ≤2000）会丧失 late-chunking 跨 chunk 上下文优势，退化为逐块处理

## 归因分析

### 慢的原因

1. **架构**: Decoder-only LLM 做 embedding 需要完整前向传播，不像 encoder-only 模型那样高效
2. **Metal GPU bug**: `batchSize=5500` 绕行值限制了单次 decode 的 token 数（见 `docs/plans/260531-nan-root-fix.md`）
3. **大 context 序列**: late-chunking 拼接多个 chunks 为长序列，attention 复杂度平方增长

### 配置化的价值

硬编码在源码中不利于实验调优。每个用户（模型/硬件不同）的最佳值不同，需要配置暴露。

## 关键决策

| 决策 | 选项 | 结论 |
|------|------|------|
| 配置名 | `embedderContextSize` vs `embedderLateChunkingContextSize` | `embedderLateChunkingContextSize` — 明确只影响 late-chunking 模式 |
| 默认值 | 0（=auto）vs 直接设一个 | **0 = auto**（回退到模型实际 context size），不破坏现有行为 |
| 语义 | 覆盖 `_embeddingContextSize` vs 覆盖 `maxBatchTokens` | 直接覆盖 `_embeddingContextSize`，保持现有逻辑不变，仅用配置值替换硬编码 |
| 重启 | contextSize 变化影响模型上下文分配 | 标记为 `REQUIRES_RESTART` |
| 查询端 | 查询 embedder 是否也需要传 | **传**。查询端不用到 late-chunking 分支（单文本查询 `length=1`），但参数一致性更重要，两个构造调用都传

## 实施计划

- [x] 1. `interfaces/config.ts` — 添加 `embedderLateChunkingContextSize?: number` 字段
- [x] 2. `config-validator.ts` — 添加类型验证（number, > 0）
- [x] 3. `config-manager.ts` — 添加到重启检测和配置快照
- [x] 4. `service-factory.ts` — 从 config 读取并传递给 LlamaCppLlmEmbedder
- [x] 5. `llamacpp-llm.ts` — 构造函数新增参数，`_ensureModel()` 中使用
- [x] 6. `autodev-config.json` — 可以添加注释说明这个配置项
- [x] 7. `metadata.ts` — 配置元数据（type-check 要求）

## 实施记录

### 2026-06-03

- 发现 `_embeddingContextSize` 在第 154 行被硬编码为 16000
- 验证了不同 contextSize 对索引速度的影响（见运行现象）
- 确认 `batchSize=5500` 是 Metal GPU bug 的绕行值，与 `_embeddingContextSize` 是两个独立维度
- 记录了 `llamacpp`（专用 embedding 模型）与 `llamacpp-llm`（通用 LLM）的性能基准对比

#### 实施详情

**修改的文件：**
- `interfaces/config.ts` — `CodeIndexConfig`、`PreviousConfigSnapshot`、`ConfigSnapshot` 三个类型各加 `embedderLateChunkingContextSize?: number`
- `config-validator.ts` — 添加验证：必须是非负整数
- `config-manager.ts` — `REQUIRES_RESTART_KEYS`、配置快照、重启检测三处更新
- `service-factory.ts` — `createEmbedder` 和 `createQueryEmbedder` 两个构造调用都传 `config.embedderLateChunkingContextSize ?? 0`
- `llamacpp-llm.ts` — 构造函数新增 `lateChunkingContextSize` 参数；`_ensureModel()` 中用 `_lateChunkingContextSize > 0` 替换硬编码 `2000`
- `commands/config/metadata.ts` — 添加元数据以满足 `Record<ConfigKey, ConfigKeyMetadata>` 约束

**语义：**
- `embedderLateChunkingContextSize = 0`（或 undefined，默认）= 自动适配模型实际 context size
- `embedderLateChunkingContextSize > 0` = 手动覆盖，控制 late-chunking 子批次切分上限

### 查询向量流程分析 (F2LLM-v2-80M)

确认**查询不走 late-chunking 路径**。完整流程如下：

```
用户输入 query
│
▼
SearchService.searchIndex(query)
 │ resolveQueryPrefix → "Instruct: find relevant passages\nQuery: {query}"
 │ （+ 可选 ChatML 包装：<|im_start|>user\n...<|im_end|>\n<|im_start|>assistant\n）
│
▼
embedder.createEmbeddings([singleQuery])
 │ texts.length === 1 → ❌ 不走 _lateChunkingCreateEmbeddings
 │ 路由判断：
 │   late-chunking && length > 1 → ❌
 │   mean / qr-weighted → ❌  (poolingMode = late-chunking)
 │
 │ 落到底层：
 │   _lastTokenCreateEmbeddings(model, [query])
 │    → forward pass 获取 per-token hidden states
 │    → 取 last token (layer=-1)
 │    → L2 normalize
 │    → 返回 queryVec
│
▼
vectorStore.search(queryVec, filter)
  → ANN 搜索
  → [可选] reranker.rerank(query, candidates)
  → 返回结果
```

**关键结论：**
- 对 `llamacpp-llm` 这个 provider，queryEmbedder 与索引 embedder 是**同一个实例**（`localProviders` 共享策略，`service-factory.ts:485-486`）
- `_embeddingContextSize` 对查询**完全无影响**，因为它只用于 `_lateChunkingCreateEmbeddings` 的子批次切分
- `embedderQueryPoolingLayer: -1` 与索引端 `embedderPoolingLayer: -1` 相同，layer 对称
- 索引端和查询端都使用 `last-token` pooling 的**原始 hidden states**（pooling_type=NONE），只是索引端多了一步按 span mean pool

## 修订记录

<!-- 留空 -->

## 总结

- `_embeddingContextSize` 控制 late-chunking 子批次切分阈值，越大单批 token 越多、越慢
- 配置化后用户可以自由权衡速度 vs 跨 chunk 上下文效果
- 80M 模型速度瓶颈不在 chunk 大小（2000 chars），而在 LLM 推理本身的吞吐
