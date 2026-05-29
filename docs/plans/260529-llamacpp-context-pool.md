# 260529-llamacpp-context-pool

## 主题/需求

解决 `llamacpp-llm` embedder provider 比 `llamacpp` provider 慢 ~15 倍的问题。两个 provider 使用相同模型（F2LLM-v2-80M）、相同池化策略（last-token），但速度从 ~7s 暴涨到 ~1m46s。

**目标：**
- 找出速度差异的根因
- 实施修复使 `llamacpp-llm` 速度与 `llamacpp` 相当
- 连接池化设计使 `embedderConcurrency` 配置真正起效

## 代码背景

### 关键文件

| 文件 | 用途 |
|------|------|
| `src/code-index/embedders/llamacpp.ts` | `LlamaCppEmbedder`（`llamacpp` provider，专用 embedding 模型） |
| `src/code-index/embedders/llamacpp-llm.ts` | `LlamaCppLlmEmbedder`（`llamacpp-llm` provider，通用 LLM 隐藏状态） |

### 相关配置

- `embedderConcurrency: 2` — 并发数
- `embedderPoolingMode: "last-token"` — 池化策略
- `embedderPoolingLayer: -1` — 层选择

### 调用链路

**`LlamaCppEmbedder`（快速 ~7s）：**
```
_ensureModel()
  └─ model.createEmbeddingContext({batchSize})  // 创建 1 次
createEmbeddings(texts)
  └─ 复用 context.getEmbeddingFor(text)          // 每 text 调用
```

**`LlamaCppLlmEmbedder`（慢速 ~106s）：**
```
_ensureModel()
  └─ model 加载（无 context 创建）
createEmbeddings(texts)
  └─ 每 text: model.createEmbeddingContext({embdLayer, batchSize})
    ├─ getEmbeddingsForTokens(text)       // forward pass
    └─ context.dispose()                   // 销毁
```

## 关键决策

### 决策 1：根因 → 每 chunk 创建/销毁 embedding context

**发现：** `LlamaCppLlmEmbedder._lastTokenCreateEmbeddings()` 对每个文本块都调用 `model.createEmbeddingContext()` + `context.dispose()`。`LlamaCppEmbedder` 则只在 `_ensureModel()` 中创建一次。

`createEmbeddingContext()` 内部调用 `model.createContext()`，在 C 层执行：
1. `llama_new_context_with_model()` — 分配 KV cache（`n_ctx × n_layers × d_head × n_kv_head × 2` 的内存）
2. Metal/CUDA buffer 分配
3. 上下文初始化

**每 chunk 一次 = ~hundreds 次 → 1m46s vs 1 次 → 7s**

### 决策 2：连接池模式

**选择：** 预创建 `concurrency` 个 `LlamaEmbeddingContext`，每个 batch 的 `Promise.all` 中通过 `groupIdx` 分配到不同 context。

**理由：**
- 每个 `LlamaEmbeddingContext` 有独立的 `withLock`，可真正并行
- `Promise.all` 的 `groupIdx` 天然对应并发槽位 0..N-1
- 不需要额外的锁/队列机制

**关键代码模式：**
```typescript
// 池创建
this._embeddingContexts = await Promise.all(
  Array.from({ length: this.concurrency }, () =>
    model.createEmbeddingContext({ embdLayer, batchSize })
  )
)

// 分配（groupIdx 在每次 Promise.all 中从 0 递增）
const ctx = this._embeddingContexts[groupIdx % this._embeddingContexts.length]
const perTokenEmbs = await ctx.getEmbeddingsForTokens(text)
```

### 决策 3：去除残留的 try/catch 包装

旧代码 `try { ... } finally { dispose() }` 移除 dispose 后留下 `try { ... } catch(error) { throw error }` 无操作代码，一并清理。

## 实施计划

- [x] 排查：对比 `llamacpp` 和 `llamacpp-llm` 两个 embedder 的实现差异
- [x] 根因确认：`createEmbeddingContext()` 在循环内被频繁调用
- [x] 第一轮修复：缓存单个 context 复用
- [x] 第二轮改进：连接池模式，支持 `embedderConcurrency`
- [x] 类型检查验证

## 实施记录

### 2026-05-29

**第一轮修复：单 context 复用**

在 `_ensureModel()` 中创建一次 context 并缓存到 `_embeddingContext` 字段，所有 `*CreateEmbeddings` 方法改为使用 `this._embeddingContext!` 替代 `model.createEmbeddingContext()`。

修改文件：`src/code-index/embedders/llamacpp-llm.ts`
- `_ensureModel()`：模型加载后创建 `embeddingContext`
- `_lastTokenCreateEmbeddings()`：使用缓存 context
- `_meanPoolingCreateEmbeddings()`：同上
- `_qrAttentionCreateEmbeddings()`：同上
- `_singlePassLateChunking()`：同上
- `validateConfiguration()`：同上
- 移除所有 `dispose()` 调用

但是发现单 context 时 `getEmbeddingsForTokens` 内部的 `withLock` 会串行化 `Promise.all` 并发请求。

**发现 `withLock` 细节：**
```typescript
return await withLock([this, "evaluate"], async () => {
```
其中 `this` 是 `LlamaEmbeddingContext` 实例。不同实例的 `withLock` 互不阻塞，可以实现真正的并发 forward pass。

**第二轮改进：连接池模式**

将 `_embeddingContext` 改为 `_embeddingContexts: LlamaEmbeddingContext[]`。在 `_ensureModel()` 中用 `Promise.all` 并行创建 `concurrency` 个 context。每个 `Promise.all` batch 中的 `groupIdx` 分配到不同 context。

关键改动：
- `_embeddingContext: LlamaEmbeddingContext | null` → `_embeddingContexts: LlamaEmbeddingContext[]`
- 池创建使用 `Promise.all(Array.from({length: concurrency}, () => createEmbeddingContext(...)))`
- 分配使用 `this._embeddingContexts[groupIdx % this._embeddingContexts.length]`

**优化清理：** 去除了遗留的 `try { } catch { throw }` 无操作包装。

### 2026-05-29（续）

**扩展修复：reranker 连接池 + highlighter dispose**

审查 `rerankers/llamacpp-llm-rerank.ts` 和 `highlighters/llamacpp-llm.ts` 后发现类似问题：

| 文件 | 原始问题 | 严重度 | 修复方式 |
|------|---------|:---:|--------|
| `embedders/llamacpp-llm.ts` | 每 chunk 创建/销毁 context | 🔴 索引热路径 | 连接池 ✅ |
| `rerankers/llamacpp-llm-rerank.ts` | 每 batch 创建 context，永不 dispose | 🟡 搜索路径 | 连接池 ✅ |
| `highlighters/llamacpp-llm.ts` | 每 highlight() 创建，不 dispose | 🟢 稀疏调用 | 加 dispose ✅ |

**`rerankers/llamacpp-llm-rerank.ts` 改动：**
- 新增 `_contexts: LlamaContext[]` + `_contextPoolPromise`，懒加载连接池
- `_ensureContexts()`：首次调用时 `Promise.all` 并行创建 `concurrency` 个 context（默认 3）
- `rerank()` 单 batch：`contexts[0]` 替代 `model.createContext()`
- `rerank()` 多 batch：`contexts[j % contexts.length]` 分配给 `processBatchWithRetry`
- `processBatchWithRetry()` 接收外部 context 参数，retry 复用同一 context
- `validateConfiguration()` 使用 `contexts[0]`
- 去掉所有 `model.createContext()` 调用

**`highlighters/llamacpp-llm.ts` 改动：**
- `highlight()` finally 块：`await context.dispose()` 替代空注释
- `validateConfiguration()`：新增 `try/finally { context.dispose() }`

## 修订记录

### 2026-05-29
**问题：** 修复后 `_singlePassLateChunking()` 段落的 `try` 块移除导致缩进偏移（8 空格而非 6 空格）、残留孤立的 `}` 大括号。`validateConfiguration()` 段的 `if` 块缩进偏移。
**修复：** python 脚本批量修正缩进，删除孤立大括号。

### 2026-05-29（v2）
**问题：** `llamacpp-llm-rerank.ts` 每 batch 创建 context + 永不 dispose；`llamacpp-llm.ts` (highlighter) 每次 highlight() 创建 context 不 dispose。
**修复：** reranker 改为连接池模式（与 embedder 一致），highlighter 加 dispose。

## 总结

### 经验教训

1. **永远先看循环内是否在创建重量级对象。** `model.createEmbeddingContext()` / `model.createContext()` 是 C 层上下文创建入口，包含 KV cache 分配。在循环内调用是明显的性能反模式。
2. **`LlamaEmbeddingContext` 的 `withLock` 作用域是实例级别。** 不同实例可以真正并行，同一实例被序列化。利用这一特性设计连接池。
3. **`Promise.all` 的 `groupIdx` 天然是并发槽位索引。** 将其作为连接池分配标识，可以零额外开销实现 round-robin。
4. **搜索路径 > 索引路径。** 修复 embedder 解决秒级问题（~7s → ~106s），reranker 解决毫秒级累积，highlighter 单次创建不构成瓶颈。按影响度排序处理。

### 后续

- 如果将来使用超大模型（如 70B）且 `concurrency` > 1，GPU 显存可能成为瓶颈（每 context 分配一份 KV cache）。可考虑 `contextSize` 动态缩减或轮询复用。
- `validateConfiguration()` 和 `_singlePassLateChunking()` 只用 `_embeddingContexts[0]` —— 这是合理的，因为验证只需要一次 forward pass，late-chunking 天生是单 forward pass 操作。
- highlighter 因调用稀疏不配做池化。如果未来 highlighter 改为批量 pipeline 调用，可再考虑。
