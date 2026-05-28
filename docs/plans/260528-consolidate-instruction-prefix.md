# 260528-consolidate-instruction-prefix

## 主题/需求

将 Embedding 模型模板/前缀逻辑从**4个分散文件**合并到**1个统一文件**中解决代码混乱问题。

**现状问题：**
- `query-prefill.ts` — 混合 ollama/qwen3 和 llamacpp-llm 两个不相关的 provider
- `embeddingModels.ts`（`getModelQueryPrefix`/`getModelDocumentPrefix`）— 只对 llamacpp+jina 有效，却被 5 个 embedder 导入为死代码
- `resolve-document-prefix.ts` — 通过 `(embedder as any)` hack 提取 modelId
- `search-service.ts` — 两步串联前缀逻辑（`applyQueryPrefill` + `getModelQueryPrefix`），视觉混乱

**预期成果：**
- 一个文件 `instruction-prefix.ts` 包含所有前缀/模板逻辑
- `resolveQueryPrefix()` — 统一处理所有 provider 的 query 端前缀
- `resolveDocumentPrefix()` — 统一处理所有 provider 的 document 端前缀
- 清理 embedder 内部的死代码（ollama/openai 等中的 `getModelQueryPrefix` 调用）
- 删除 3 个旧文件

## 代码背景

### 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/code-index/search/instruction-prefix.ts` | **新建** | 统一前缀逻辑的目标文件 |
| `src/code-index/search/query-prefill.ts` | **删除** | 逻辑移入 instruction-prefix.ts |
| `src/code-index/shared/resolve-document-prefix.ts` | **删除** | 逻辑移入 instruction-prefix.ts |
| `src/code-index/search/query-prefill.test.ts` | **更新** → `instruction-prefix.test.ts` | 测试新文件 |
| `src/shared/__tests__/embeddingModels.prefix.test.ts` | **删除** | 测试移入 instruction-prefix.test.ts |
| `src/shared/embeddingModels.ts` | **清理** | 移除 `getModelQueryPrefix`/`getModelDocumentPrefix` |
| `src/code-index/search-service.ts` | **简化** | 两步前缀合并为一步 |
| `src/code-index/processors/scanner.ts` | **更新导入** | 从新文件导入 `resolveDocumentPrefix` |
| `src/code-index/processors/file-watcher.ts` | **更新导入** | 从新文件导入 `resolveDocumentPrefix` |
| `src/code-index/embedders/ollama.ts` | **清理** | 移除死代码 `getModelQueryPrefix` |
| `src/code-index/embedders/openai.ts` | **清理** | 同上 |
| `src/code-index/embedders/openai-compatible.ts` | **清理** | 同上 |
| `src/code-index/embedders/openrouter.ts` | **清理** | 同上 |

### 当前数据流混乱

```
查询端 (search-service.ts):
  query → applyQueryPrefill(query-prefill.ts) → 处理 ollama+llamacpp-llm
        → getModelQueryPrefix(embeddingModels.ts) → 处理 llamacpp(专用)
         ↑ 两步处理不同 provider，视觉重复

文档端 (scanner.ts/file-watcher.ts):
  embedder → resolveDocumentPrefix(resolve-document-prefix.ts)
           → getModelDocumentPrefix(embeddingModels.ts) → 返回 "Query: " for jina
           → generateBlockEmbeddingText(block-text-generator.ts)
```

## 关键决策

### 决策 1：函数签名设计

`resolveQueryPrefix(query, provider, modelId, enableLlmPrefix?)` — 纯函数，一次返回完整前缀后 query

`resolveDocumentPrefix(embedder)` — 保留 IEmbedder 参数（因为 callers 只有 embedder 实例，需通过 `(as any)` 提取 modelPath）

### 决策 2：EmbedderProvider 类型统一

`EmbedderProvider` 在多个文件中有重复定义（config.ts, manager.ts, embeddingModels.ts）。新文件从 `"../interfaces"` 导入（已 re-export manager 中的所有类型）。

### 决策 3：jina 前缀逻辑合并

旧代码中 jina-embeddings-v5 的前缀通过两条路径处理：
- `llamacpp`（专用）→ `getModelQueryPrefix` + `getModelDocumentPrefix`
- `llamacpp-llm`（LLM）→ `applyQueryPrefill` 中的特殊分支

新代码中统一在一个函数内按 provider 分支处理。

### 决策 4：移除 embedder 内部的死代码

ollama/openai/openai-compatible/openrouter 等 embedder 在 `createEmbeddings()` 中调用 `getModelQueryPrefix(provider, modelId)`，但该函数对所有非 llamacpp 的 provider 返回 `null`，属于死代码。前缀已由上层（search-service 或 scanner）保证嵌入前已添加。

## 实施计划

- [x] 步骤 1：创建 `instruction-prefix.ts` — 统一所有常量 + `resolveQueryPrefix` + `resolveDocumentPrefix`
- [x] 步骤 2：更新 `search-service.ts` — 两步合并为一步
- [x] 步骤 3：更新 `scanner.ts` + `file-watcher.ts` — 修改导入路径
- [x] 步骤 4：清理 embedder 死代码（ollama/openai/openai-compatible/openrouter）
- [x] 步骤 5：清理 `embeddingModels.ts` — 移除 `getModelQueryPrefix`/`getModelDocumentPrefix`
- [x] 步骤 6：删除旧文件（`query-prefill.ts`, `resolve-document-prefix.ts`, `embeddingModels.prefix.test.ts`）
- [x] 步骤 7：创建/更新测试文件 `instruction-prefix.test.ts`
- [x] 步骤 8：类型检查 + 测试验证

## 实施记录

### 2026-05-28

**创建 Task Doc**，规划重构方案。

### 实施详情

**步骤 1：创建 `instruction-prefix.ts`**
- 统一常量：`QWEN_PREFILL_TEMPLATE`、`LLM_EMBEDDER_PREFILL_TEMPLATE`、`JINA_QUERY_PREFIX`
- `resolveQueryPrefix()` — 按 provider 分支（llamacpp → llamacpp-llm → ollama → others）
- `resolveDocumentPrefix()` — 保留 `IEmbedder` 参数，提取 modelId

**步骤 2：简化 `search-service.ts`**
- 两步（`applyQueryPrefill` + `getModelQueryPrefix`）合并为一步 `resolveQueryPrefix()`
- 删除 `getModelQueryPrefix` 导入

**步骤 3：更新导入路径**
- `scanner.ts` → 从 `"../search/instruction-prefix"` 导入
- `file-watcher.ts` → 同上

**步骤 4：清理 embedder 死代码**
- `ollama.ts`、`openai.ts`、`openai-compatible.ts`、`openrouter.ts` — 移除 `getModelQueryPrefix` 导入和前缀处理逻辑

**步骤 5：清理 `embeddingModels.ts`**
- 移除 `getModelQueryPrefix` 和 `getModelDocumentPrefix` 函数

**步骤 6：删除旧文件**
- `query-prefill.ts`、`resolve-document-prefix.ts`、`embeddingModels.prefix.test.ts`

**步骤 7：创建测试文件**
- `instruction-prefix.test.ts` — 37 个测试覆盖所有 provider/边界场景

**步骤 8：验证**
- `tsc --noEmit` 零新增错误
- 全量测试 1044 passed, 3 skipped（2 个预存 reranker 失败不相关）

### 2026-05-28（补充 Chat Template）

**将 Chat Template 也收拢到 `instruction-prefix.ts`**
- 新增 `wrapInChatTemplate()` 函数，将 `<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n` ChatML 格式集中到统一文件
- `llamacpp-llm.ts`：移除私有 `_wrapInChatTemplate()` 方法，改为导入 `wrapInChatTemplate`
- 新增 4 个测试覆盖 ChatML 包装

## 修订记录

### 2026-05-28

**问题：** Chat Template（`_wrapInChatTemplate`）未纳入统一文件。
**修复：** 新增 `wrapInChatTemplate()` 到 `instruction-prefix.ts`，`llamacpp-llm.ts` 改为导入使用。

**问题：** `instruction-prefix.ts` 中 `resolveDocumentPrefix` 对 ollama/openai 等非 llamacpp provider 错误返回前缀。
**修复：** 添加 provider 白名单检查，只有 `llamacpp` / `llamacpp-llm` 才可能返回前缀。

## 总结

### 核心原则

1. **一个文件**：所有前缀/模板逻辑收敛到 `instruction-prefix.ts`
2. **按 provider 分支**：ollama/qwen3、llamacpp-llm、llamacpp（专用）各自独立分支
3. **统一入口**：query 端 `resolveQueryPrefix()`，document 端 `resolveDocumentPrefix()`
4. **清理死代码**：embedder 内部不再各自维护前缀调用
