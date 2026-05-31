# 260531-llamacpp-instance-leak-fix

## 主题/需求

修复 autodev-codebase 中 llama.cpp 实例泄漏和 VRAM 管理问题，消除搜索流程中的 `InsufficientMemoryError` 和 `Eval has failed` 崩溃，并系统性地补全所有组件的内存释放链路。

## 代码背景

| 文件 | 角色 |
|------|------|
| `src/code-index/service-factory.ts` | 创建所有 embedder/reranker/highlighter/summarizer 实例 |
| `src/code-index/manager.ts` | 管理服务生命周期、`_recreateServices()` 重建逻辑 |
| `src/code-index/search-service.ts` | 搜索流程编排（embed → search → rerank → highlight） |
| `src/code-index/embedders/llamacpp-llm.ts` | `LlamaCppLlmEmbedder` — F2LLM 通用 LLM embedder |
| `src/code-index/embedders/llamacpp.ts` | `LlamaCppEmbedder` — 专用 embedding 模型（jina-v5） |
| `src/code-index/highlighters/qrranker.ts` | `QRRankerHighlighter` — MiniCPM 行级高亮 |
| `src/code-index/highlighters/llamacpp-llm.ts` | `LlamaCppLLMHighlighter` — LLM 高亮 |
| `src/code-index/highlighters/semantic-highlight.ts` | `SemanticHighlightHighlighter` — 专用模型高亮 |
| `src/code-index/rerankers/llamacpp-llm-rerank.ts` | `LlamaCppLLMReranker` — LLM reranker |
| `src/code-index/rerankers/qrranker.ts` | `QRRankerReranker` — 已有完整 dispose ✅ |
| `src/code-index/summarizers/llamacpp.ts` | `LlamaCppSummarizer` — LLM 摘要生成 |
| `src/code-index/interfaces/highlighter.ts` | `IHighlighter` 接口 |
| `src/code-index/interfaces/reranker.ts` | `IReranker` 接口 |

**关键依赖**：`@realtimex/node-llama-cpp`（内置 llama.cpp Metal 后端）。embedding context 分配 VRAM，不及时释放会导致后续模型加载失败。

## 运行现象

### 现象 1：搜索崩溃 — `InsufficientMemoryError`

```log
InsufficientMemoryError: A context size of 24 is too large for the available VRAM
GGML_ASSERT([rsets->data count] == 0) failed
```

执行 `npm run dev -- search "train method" --demo` 时 F2LLM 第三次加载失败，随后 Metal 后端崩溃。

### 现象 2：索引失败 — `Eval has failed`

```log
Late chunking failed, falling back to last-token: Error: Eval has failed
[BatchProcessor] Error processing batch (attempt 3): [Error: Eval has failed]
```

embedding context auto-detect 分配了 40960 token 的超大 context，`llama_decode()` 时 attention 计算 buffer 分配失败。

### 现象 3：每次 `summarize()` 泄漏一个 context

无直接错误日志，但 `LlamaCppSummarizer.summarizeBatch()` 每次创建 `LlamaContext` 后从未释放，长期运行（MCP server）会 OOM。

## 归因分析

### 根因 1：3 个 F2LLM 实例同时加载

`createServices()` 调用链中创建了 3 个独立的 `LlamaCppLlmEmbedder` 实例，每个加载 F2LLM-v2-4B Q8_0（~4GB）并创建 2 个 embedding context（concurrency=2），共 6 个 context：

1. **维度检测 embedder** — `createVectorStore()` Layer 2 路径创建后**未释放**（Layer 3 有 dispose 但 Layer 2 遗漏）
2. **文档 embedder** — `createEmbedder()` 正常创建
3. **查询 embedder** — `createQueryEmbedder()` 新建独立实例

加上 QRRanker + Highlighter 各加载一次 MiniCPM-V-4.6，Mac 统一内存耗尽（16GB 不够 6×F2LLM context + 2×MiniCPM）。

### 根因 2：embedding contextSize 过大

`createEmbeddingContext()` 未传 `contextSize`，库自动分配了 `trainContextSize`（40960）。对于 embedding 场景，每个 context 的 attention 计算 buffer 在 decode 时需几 GB，与 MiniCPM 争抢 VRAM 导致 `llama_decode()` 失败。

### 根因 3（系统性）：大量组件缺少 dispose

全局 grep 发现 7 个组件中有 6 个缺少 `dispose()` 或存在 context 泄漏：

| 组件 | 问题 |
|------|------|
| `LlamaCppSummarizer` | 每次 `summarizeBatch()` 创建 context 不释放 🔴 |
| `LlamaCppLLMReranker` | context 池永久泄漏 |
| `LlamaCppEmbedder` | 无 dispose |
| `SemanticHighlightHighlighter` | 无 dispose |
| `LlamaCppLLMHighlighter` | context 正确释放，model 不释放 |
| `QRRankerHighlighter` | 无 dispose |
| `QRRankerReranker` | 已有完整 dispose ✅ |

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 维度检测 embedder 释放 | `try/finally { dispose }` 补 Layer 2 路径 | Layer 3 已有，Layer 2 遗漏 |
| 查询 embedder 复用 | `createServices()` 中复用文档 embedder | 两者同一模型，分开加载是纯浪费 |
| Embedder 创建顺序 | 先 `createEmbedder()` 再传给 `createVectorStore()` | 取代 建→释放→重建，省一次模型加载 |
| contextSize 保持最大 | 不传显式 contextSize，让库自动分配 | 用户要求保留 late chunking 最大上下文能力 |
| 何时释放 embedder | query 嵌入完成后立即释放 | 比程序退出时释放更有意义，为 rerank/highlight 腾 VRAM |
| Context 池 vs 每次新建 | 池化（summarizer/reranker）| 避免重复分配开销，配合 eraseContext 复用 |
| `dispose?()` 接口 | 加在 `IHighlighter` / `IReranker` 上 | 使调用方能统一释放 |

## 实施计划

- [x] service-factory.ts: `createVectorStore()` Layer 2 补 dispose
- [x] service-factory.ts: `createServices()` 复用 query embedder（llamacpp-llm → 全部本地模型）
- [x] service-factory.ts: 先创建 embedder，传入 `createVectorStore()` 做维度检测
- [x] llamacpp-llm.ts: contextSize 不传（用户保留）
- [x] IHighlighter 接口: 加 `dispose?()`
- [x] IReranker 接口: 加 `dispose?()`
- [x] CodeIndexSearchService: 加 `dispose()` 释放 reranker + highlighter
- [x] CodeIndexManager: `_recreateServices()` 释放旧 searchService
- [x] CodeIndexManager: `_cleanupAsync()` 释放 embedder + searchService
- [x] QRRankerHighlighter: 加 `dispose()`
- [x] LlamaCppLLMReranker: 加 `dispose()` 释放 context 池
- [x] LlamaCppSummarizer: 改为 context 池 + `dispose()`
- [x] LlamaCppEmbedder: 加 `dispose()`
- [x] SemanticHighlightHighlighter: 加 `dispose()`
- [x] LlamaCppLLMHighlighter: 加 `dispose()`
- [x] search-service.ts: query 嵌入完成后立即释放 embedder

## 实施记录

### 2026-05-31
#### 第一轮：修复 InsufficientMemoryError
- 发现 `createVectorStore()` Layer 2 路径中维度检测 embedder 未释放
- 发现 `createServices()` 创建了 3 个 F2LLM 实例
- 修复：Layer 2 加 `try/finally { dispose }`
- 修复：查询 embedder 复用文档 embedder（`llamacpp-llm`）

#### 第二轮：修复 Eval has failed
- 发现 embedding context 的 `contextSize` 被 auto-detect 到 40960
- attention 计算 buffer 过大导致 `llama_decode()` 在 VRAM 不足时失败
- 用户选择保留最大 contextSize 以支持 late chunking
- 改为通过减少实例数（3→1）解决 VRAM 竞争

#### 第三轮：系统性补全 dispose
- 用户质疑新加的 `dispose()` 没有调用者
- 为 `IHighlighter`、`IReranker` 加 `dispose?()` 可选方法
- `CodeIndexSearchService` 加 `dispose()` → cascades to reranker/highlighter
- `CodeIndexManager` 加 `_cleanupAsync()` → cascades to searchService/embedder
- 补全 6 个组件的 `dispose()` 实现
- `LlamaCppSummarizer` 改为 context 池 + 每次 erase 复用，消除每次 summarize 泄漏一个 context 的问题

#### 第四轮：优化释放时机
- 将 embedder 创建提到 `createVectorStore()` 之前，传入复用
- query 嵌入完成后立即释放 embedder（在 `searchIndex()` 中），不等到程序退出
- 释放顺序：embedder（F2LLM）→ reranker/highlighter（MiniCPM）

## 修订记录

（暂无）

## 总结

### 关键收获

1. **实例泄漏是 VRAM 问题的根源** — 3 个 F2LLM 实例同时加载比 context 大小的影响更大
2. **释放时机比释放本身更重要** — query 嵌入完释放比程序退出释放更有意义
3. **接口设计决定调用链** — 没有 `dispose?()` 在接口上，实现再完整也没人调用
4. **`dispose()` 需 idempotent** — 用 `_disposed` 标志或空值检查保证安全重复调用

### 资源变化

| 资源 | 修改前 | 修改后 |
|------|--------|--------|
| F2LLM 实例数 | 3（各 2 context） | 1（2 context） |
| F2LLM VRAM 持有时间 | 整个进程生命周期 | query 嵌入完成后立即释放 |
| 总 context 泄漏 | 每次 summarize 泄漏 1 个 | 0（池化复用） |
| dispose 覆盖组件 | 1/7（QRRankerReranker） | 7/7 |

### 遗留

- `CodeIndexManager.dispose()` 用 `void` fire-and-forget 执行异步清理，如果进程在清理完成前退出，Metal 资源由 OS 回收
- `LlamaCppEmbedder.dispose()` 当前仅在 `llamacpp` provider 下有用，当前配置不使用
