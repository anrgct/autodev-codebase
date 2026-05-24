# 260523-llm-embedding-llamacpp

## 主题/需求

实现用通用 LLM（非专用 embedding 模型）获取文本的 embedding 向量，作为"潜在推理检索"方案的第一步。

**目标：** 新增 `llamacpp-llm` embedder provider，用 LLM 的 last-token 隐藏状态作为文本的向量表示，对齐后续"在潜在空间中思考后再检索"的路线。

**预期成果：**
- `LlamaCppLlmEmbedder`：实现 `IEmbedder`，加载 GGUF LLM 模型（如 MiniCPM-V-4.6），提取 last-token hidden state 作为 embedding
- 支持 `embedderProvider: "llamacpp-llm"` 配置
- last-token pooling → L2 normalize → 返回向量

**验证方式：**
- `autodev-config.json` 中设置 `embedderProvider: "llamacpp-llm"` + `embedderGgufLlmPath`
- 启动 demo 验证模型加载和 embedding 生成是否正常
- 对比 `llamacpp`（专用 embedding 模型）和 `llamacpp-llm`（LLM 隐藏状态）的结果差异

## 代码背景

### 关键文件

| 文件 | 用途 |
|------|------|
| `src/code-index/embedders/llamacpp.ts` | 现有 `LlamaCppEmbedder`（专用 embedding 模型，用 `LlamaEmbeddingContext.getEmbeddingFor()`） |
| `src/code-index/embedders/llamacpp-llm.ts` | **新增** `LlamaCppLlmEmbedder`（通用 LLM，用 `getEmbeddingsForTokens()` + last-token pooling） |
| `src/code-index/rerankers/qrranker.ts` | QRRanker 参考——已打通 llama.cpp `cbEval` 回调提取 attention weights |
| `patches/node-llama-cpp+3.18.1.patch` | 已包含 `LlamaEmbeddingContext.getEmbeddingsForTokens()` 方法 |

### 核心 API：`LlamaEmbeddingContext.getEmbeddingsForTokens()`

patch 中已添加的方法，返回 `number[][]`——每个 token 位置的完整 hidden state 向量：

```
LlamaEmbeddingContext.getEmbeddingsForTokens(text)
  → tokenize → evaluate (forward pass) → ctx.getEmbedding(i) per token
  → number[][]
```

关键：该方法通过 `_embeddings: true` 创建 context，`llama.cpp` 会在 forward pass 后将每个 token 位置的 hidden state 存入 `ctx->embd` buffer。

### 池化策略

选择 **last-token pooling**（取最后一个 token 的 embedding），原因：
- 对于 decoder-only LLM（如 MiniCPM-V-4.6 / Qwen 系列），最后一个 token 的 hidden state 包含了整个输入序列的上下文信息
- 比 mean pooling 更符合 LLM 的"预测下一个 token"的设计直觉
- 与后续"潜在推理"路线一致——最终隐藏状态压缩了推理链路

## 关键决策

### 决策 1：复用 `LlamaEmbeddingContext.getEmbeddingsForTokens()` 而非扩展 C++ addon

**选择：** 使用 patch 中已添加的 `getEmbeddingsForTokens()` 方法获取 per-token hidden states。

**理由：**
- `getEmbeddingsForTokens()` 已在 patch 中实现，无需额外的 C++ 修改
- `LlamaEmbeddingContext` 通过 `model.createEmbeddingContext()` 创建，对任意 GGUF 模型都有效（不检查 `pooling_type`）
- 相比扩展 `cbEval` 捕获 hidden state tensor，此方案零新增 C++ 代码

**风险：** 对于通用 LLM（无 `pooling_type` 元数据），`llama.cpp` 可能不将 hidden states 存入 `embd` buffer。需要在实现时验证，若返回零向量则需调整方案。

### 决策 2：last-token pooling（非 mean pooling）

理由见上方"池化策略"部分。后续可根据实验对比调整。

### 决策 3：Provider 命名 `llamacpp-llm`

与现有 `llamacpp-llm` reranker 和 `llamacpp-llm` highlighter 命名一致，表示"使用本地 llama.cpp 加载通用 LLM 模型"。

### 决策 4：Config key 使用 `embedderGgufLlmPath`

与 `rerankerGgufLlmPath`、`highlighterGgufLlmPath` 命名风格一致，表示"GGUF 格式的 LLM 模型路径"。

## 实施计划

- [ ] 步骤 1：创建 `LlamaCppLlmEmbedder`（`src/code-index/embedders/llamacpp-llm.ts`）
- [ ] 步骤 2：在 `service-factory.ts` 中添加 `"llamacpp-llm"` 分支
- [ ] 步骤 3：更新类型系统（`AvailableEmbedders`、`CodeIndexConfig`、`PreviousConfigSnapshot`、`ConfigSnapshot`）
- [ ] 步骤 4：更新配置验证（`config-validator.ts`、`config-manager.ts`）
- [ ] 步骤 5：更新 `NodeConfigProvider`（`getEmbedderConfig`、`isConfigured`、`validateConfig`）
- [ ] 步骤 6：添加 config metadata（`metadata.ts`）
- [ ] 步骤 7：更新 demo 配置（`autodev-config.json`）
- [ ] 步骤 8：端到端验证

## 实施记录

### 2026-05-23

完成 `LlamaCppLlmEmbedder` 的实现及全链路集成：

**新增文件：**
- `src/code-index/embedders/llamacpp-llm.ts`：`LlamaCppLlmEmbedder` 类
  - 使用 `LlamaEmbeddingContext.getEmbeddingsForTokens()` 获取 per-token hidden states
  - last-token pooling + L2 normalize
  - 延迟加载模型、验证配置、完整错误处理

**修改文件：**
- `src/code-index/interfaces/embedder.ts`：`AvailableEmbedders` 新增 `"llamacpp-llm"`
- `src/code-index/interfaces/config.ts`：`EmbedderProvider` 增加 `"llamacpp-llm"`；`CodeIndexConfig`、`PreviousConfigSnapshot`、`ConfigSnapshot` 新增 `embedderGgufLlmPath` 字段
- `src/code-index/interfaces/manager.ts`：`EmbedderProvider` 增加 `"llamacpp-llm"`
- `src/shared/embeddingModels.ts`：`EmbedderProvider` 增加 `"llamacpp-llm"`
- `src/code-index/service-factory.ts`：`createEmbedder()` 新增 `"llamacpp-llm"` 分支；`createVectorStore()` 扩展 GGUF modelId 推导逻辑
- `src/code-index/config-manager.ts`：`isConfigured()`、`doesConfigChangeRequireRestart()`、`currentModelId` 新增 `llamacpp-llm` 支持
- `src/code-index/config-validator.ts`：新增 `llamacpp-llm` 验证规则
- `src/adapters/nodejs/config.ts`：`getEmbedderConfig()`、`isConfigured()`、`validateConfig()` 新增 `llamacpp-llm` 分支
- `src/commands/config/metadata.ts`：新增 `embedderGgufLlmPath` 元数据
- `demo/autodev-config.json`：切换为 `llamacpp-llm` provider + MiniCPM-V-4.6 模型

**验证结果：**
- `tsc --noEmit` 类型检查通过（0 errors）
- `config-manager.spec.ts` 10/10 测试通过
- `service-factory.spec.ts` 14/14 测试通过
- `npx tsx src/cli.ts index --force --demo` 端到端通过：
  - MiniCPM-V-4.6 模型加载成功
  - `getEmbeddingsForTokens()` 返回有效 hidden states
  - last-token pooling + L2 normalize 正常
  - 向量成功写入 Qdrant
- `npx tsx src/cli.ts search "where is the train method" --demo` 搜索验证通过：
  - LLM 隐藏状态作为 query embedding 匹配到 `model.py` 中 6 个相关代码片段
  - 检索质量与专用 embedding 模型（jina-embeddings-v5）可比

