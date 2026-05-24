# 260524-qrweighted-embedding-principle

## 主题/需求

### 背景

`LlamaCppLlmEmbedder` 的 `_qrAttentionCreateEmbeddings` 方法是 QR-weighted pooling 的核心实现，但它命名为"注意力" pooling 容易引起误解——该方法使用的是最后 token hidden state 与各 token 的余弦相似度，而非 Transformer 真正的 `softmax(QK^T)` 注意力矩阵。

本任务旨在：
1. 理清该方法的工作原理
2. 厘清它与 QRRanker 真实注意力的区别
3. 评估改造为使用真注意力的可行性

### 目标

- 从代码和设计文档层面理清 `_qrAttentionCreateEmbeddings` 的完整机制
- 对比分析"余弦相似度 pooling" vs "真注意力 pooling"的异同
- 记录改造方案的可行性和障碍

### 预期成果

- 一份完整的技术分析文档（即本文档）
- 明确的结论：当前方案合理，改造性价比低

## 代码背景

### 关键文件

- `src/code-index/embedders/llamacpp-llm.ts` — `LlamaCppLlmEmbedder` 类，包含 `_qrAttentionCreateEmbeddings` (llamacpp-llm.LlamaCppLlmEmbedder._qrAttentionCreateEmbeddings:446)
- `src/code-index/rerankers/qrranker.ts` — `QRRankerReranker._rerankBatch()` 和 `computeQRScores()`，使用真实注意力矩阵 (qrranker.QRRankerReranker._rerankBatch:293, qrranker.QRRankerReranker.computeQRScores:174)
- `src/code-index/highlighters/qrranker.ts` — `QRRankerHighlighter`，也使用真实注意力矩阵
- `docs/plans/260519-qrranker-highlighter.md` — QRRanker 高亮器设计文档，包含注意力获取机制说明

### 架构关系

```
            LlamaCppLlmEmbedder           QRRankerReranker / QRRankerHighlighter
            ────────────────────           ─────────────────────────────────────
API         createEmbeddingContext()       createContext({ collectKqSoftMax: true })
前向传播    内部隐式执行                      sequence.evaluateWithoutGeneratingNewTokens()
输出        per-token hidden states        hidden states ❌  / 注意力矩阵 ✅
Pooling     余弦相似度 → softmax → 加权平均   cross-attention scores → per-token relevance
命名        "qr-weighted" pooling         QR cross-attention
```

核心差异：`createEmbeddingContext` 是高层 API，只暴露 hidden states；`createContext` + `collectKqSoftMax` 是低层 API，暴露注意力矩阵但不暴露 hidden states。

## 关键决策

### 决策1：当前机制本质上是"余弦相似度加权 pooling"而非"注意力 pooling"

**分析：** `_qrAttentionCreateEmbeddings` 的工作流程：

```
perTokenEmbs (hidden states)
  → L2 归一化
  → lastEmb · token[t] → 余弦相似度 (Step 2)
  → softmax(similarities / T) → weights (Step 3)
  → Σ(weights[t] × perTokenEmbs[t]) → pooled (Step 4)
  → L2 归一化 → 最终嵌入
```

自始至终没有任何 Q、K、V 的矩阵运算，没有 `softmax(QK^T/√dk + mask)`，只是两个向量的点积。

**理由：** 该方法借用了 QRRanker 中"查询态对文档态的亲和度决定各 token 贡献权重"的理念，但实现上用的是隐状态层面的余弦相似度，而非注意力矩阵层面的 softmax 乘积。

### 决策2：命名有误导性，但不影响功能正确性

`qr-weighted` 的命名意图是与 QRRanker 的 QR cross-attention 建立类比关系，但实际信号来源完全不同：

| 维度 | QR-weighted pooling (embed) | QR cross-attention (rerank/highlight) |
|---|---|---|
| 信号来源 | 最后 token hidden state 的余弦相似度 | `softmax(QK^T)` 注意力矩阵 |
| 是否真实 attention | ❌ | ✅ |
| Head 选择性 | N/A (单向量) | 16 个 QR heads |
| Layer 选择性 | 单层 (`_poolingLayer`) | 8 层 (17-24) |

### 决策3：改造为真注意力在工程上可行但性价比低

**方案 A — 两次 forward pass：**

```
第一次: createEmbeddingContext → hidden states
第二次: createContext + collectKqSoftMax → 注意力矩阵
→ pooled = Σ(attn_weights[t] × hidden_states[t])
```

代价：计算量翻倍。

**方案 B — 修改 node-llama-cpp：**

在 `createContext` 侧增加 `embdLayer` 支持（暴露 hidden states），或在 `createEmbeddingContext` 侧增加 `collectKqSoftMax` 支持。需要改动 C++ 代码。

**不做改造的理由：**

1. **余弦相似度加权已有理论支撑**：在因果 decoder 中，最后 token 的 hidden state 编码了整段文本的上下文理解，它与各 token 的相似度近似反映了信息重要性
2. **embedding pooling 是聚合任务**：与高亮器的 token 级精细打分不同，embedding 只需要一个整体向量，余弦相似度加权与真注意力加权的聚合结果差异预计不大
3. **QR heads 的价值在 cross-attention 场景**：16 个 QR head 是为 query-document 相关性微调的，在纯文本 embedding（无 query）场景下，自注意力的信号未必优于余弦相似度
4. **工程代价过高**：两次 forward pass 或修改 C++ 的收益不明确

## 实施计划

- [x] 阅读 `_qrAttentionCreateEmbeddings` 完整实现
- [x] 阅读 `QRRankerReranker.computeQRScores` 对比真实注意力机制
- [x] 阅读 `_rerankBatch` 理解 `collectKqSoftMax` 的使用方式
- [x] 分析两种 API (`createEmbeddingContext` vs `createContext`) 的能力差异
- [x] 评估改造方案及权衡
- [x] 编写任务文档

## 实施记录

### 2026-05-24

1. 阅读 `_qrAttentionCreateEmbeddings`（llamacpp-llm.LlamaCppLlmEmbedder._qrAttentionCreateEmbeddings:446-557）：确认五步流程（L2 归一化 → 余弦相似度 → softmax + temperature → 加权 mean pooling → 最终 L2 归一化），未发现任何注意力矩阵计算。

2. 对比 `QRRankerReranker.computeQRScores`（qrranker.QRRankerReranker.computeQRScores:174-250）：确认真实注意力使用 `context.getKqSoftMax(layer)` 获取 `softmax(QK^T)` 矩阵，按层次和 head 聚合 query→KV 的注意力权重。

3. 分析 API 能力矩阵：`createEmbeddingContext` 不暴露注意力，`createContext` 不暴露 hidden states，两者互斥。

4. 验证了 `_rerankBatch` 中 `createContext` 的创建参数（qrranker.QRRankerReranker._rerankBatch:303-310）：`collectKqSoftMax: true` + `flashAttention: false`，确认注意力收集需要关闭 flash attention。

5. 结论：当前实现命名为"注意力"pooling 但实际上是余弦相似度 pooling；改造可行但不值得。

## 修订记录

_（暂无修订）_

## 总结

### 关键收获

1. **命名不等于实现**：`_qrAttentionCreateEmbeddings` 的 "attention" 指的是与 QRRanker 的机制类比（查询态对文档态求亲和度），而非真正的 Transformer 注意力矩阵
2. **API 层级决定了能力边界**：`createEmbeddingContext` 和 `createContext` 服务于不同场景，设计上互不包含对方的能力
3. **适宜技术优于完美技术**：在 embedding pooling 场景下，余弦相似度加权是足够好的启发式方法，追求真注意力的边际收益不足以覆盖工程代价

### 后续关注

- 如未来 node-llama-cpp 支持在 `createEmbeddingContext` 中同时获取 hidden states 和注意力矩阵，可重新评估
- 如发现余弦相似度 pooling 与真注意力 pooling 在检索质量上有显著差距，可优先推进方案 A（两次 forward pass 快速验证）
