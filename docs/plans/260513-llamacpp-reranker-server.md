# 260513-llamacpp-reranker-server

## 主题/需求

为 `LlamaCppReranker` 增加 Server 模式：通过配置 `rerankerLlamaCppServer` 切换排序方式。默认使用 `node-llama-cpp` 的 `createRankingContext`（Direct 模式），开启后自动启动 `llama-server` 进程并通过其 `/v1/rerank` HTTP 端点完成排序，结束后自动清理子进程。

## 代码背景

### 相关文件

| 文件 | 说明 |
|------|------|
| `src/code-index/rerankers/llamacpp-rerank.ts` | 核心实现，需增加 server 模式逻辑 |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig`/`PreviousConfigSnapshot`/`ConfigSnapshot` 新增配置字段 |
| `src/code-index/interfaces/reranker.ts` | `RerankerConfig` 新增字段 |
| `src/code-index/config-manager.ts` | `rerankerConfig` getter 和 snapshot 传递新字段 |
| `src/code-index/service-factory.ts` | 创建 `LlamaCppReranker` 时传入 server 标志和 bin 路径 |
| `src/code-index/constants/index.ts` | `DEFAULT_CONFIG` 添加默认值 |
| `src/commands/config/metadata.ts` | CLI 元数据注册新配置键 |
| `demo/autodev-config.json` | 示例配置，启用 server 模式 |

### 现有 reranker 体系

- `IReranker` 接口定义：`rerank()`、`validateConfiguration()`、`rerankerInfo`
- 已有实现：`OllamaLLMReranker`、`OpenAICompatibleReranker`、`LlamaCppReranker`（Direct）、`LlamaCppLLMReranker`
- service-factory 中按 `rerankerProvider` + 路径选择策略：
  1. `llamacpp` + `llamaCppRerankerModelPath` → `LlamaCppReranker`（交叉编码器）
  2. `llamacpp` + `llamaCppModelPath` → `LlamaCppLLMReranker`（LLM chat 打分）

### llama.cpp server 关键约束

- 需要 `--reranking` 参数启用 `/v1/rerank` 端点
- 需要 `--ubatch-size N` 调整物理批次大小（默认 512，不足会报 500）
- 端点遵循 Cohere API 格式：`POST /v1/rerank`，返回 `{ results: [{ index, relevance_score }] }`
- raw score 是 logit 值（可负），需 sigmoid 归一化

## 关键决策

### 1. 配置最小化

只暴露 `rerankerLlamaCppServer`（boolean）和 `rerankerLlamaCppServerBinPath`（string）两个配置项。

### 2. server 二进制路径

当前硬编码 `/Users/anrgct/workspace/llama.cpp/build/bin/llama-server` 为 fallback，同时支持通过配置项 `rerankerLlamaCppServerBinPath` 指定。`node-llama-cpp` 不捆绑 `llama-server` 二进制，因此无法从中自动发现。

### 3. 子进程生命周期管理

- 自动分配空闲端口（`net.createServer().listen(0)`）
- 轮询 `/health` 等待 server 就绪（2 分钟超时）
- `child.unref()` + stdio 流的 `unref()` → 主进程退出时不阻塞
- `dispose()` 方法提供显式 SIGTERM 清理

### 4. 分数归一化：sigmoid(if raw) × 10

不同 reranker 模型返回的 `relevance_score` 尺度完全不同：

| 模型 | 原始范围 | 含义 |
|------|---------|------|
| **bge-reranker-v2-m3** | `-2.1 ~ -9.8` | 原始 logit，需 sigmoid |
| **Qwen3-Reranker-4B** | `0.467 ~ 0.0002` | 已归一化 [0,1] |
| **Qwen3-Reranker-0.6B** | `0.025 ~ 0.0002` | 已归一化 [0,1] |

**两步归一化**：

```
raw logit → sigmoid(if outside [0,1]) → ×10 → final[0~1.07]
```

1. **范围检测**：全部在 [0,1] 内 → 跳过 sigmoid；有负值或 >1 → 应用 sigmoid
2. **缩放**：`× 10` 到 [0~10]，但由于 sigmoid 实际输出在 0~1，最终有效范围约 `0~1.07`

**不做 min-max**：避免人为制造 10 分（赢者通吃效应），保留原始模型的相对置信度。`rerankerMinScore` 为绝对阈值，需按模型调整（bge 约 0.02~0.05，Qwen3-0.6B 约 0.01~0.03）。

## 实施计划

- [x] 配置接口：在 config.ts、reranker.ts 中添加新字段
- [x] 配置传递：config-manager.ts、service-factory.ts 添加透传
- [x] 核心实现：llamacpp-rerank.ts 增加 server 模式（启停、HTTP rerank、sigmoid）
- [x] 边缘处理：子进程 unref 避免卡住、ubatch-size 解决输入超长
- [x] 默认值与元数据：constants/index.ts、metadata.ts
- [x] 示例配置：demo/autodev-config.json
- [x] 测试验证：92 个现有测试全部通过，搜索命令端到端验证通过

## 实施记录

### 2026-05-13

1. 配置接口层（6个文件） → `rerankerLlamaCppServer` 贯穿所有类型
2. 核心实现 v1 → 用 `getLlama().llamaCppDirectory` 找 `llama-server`，失败（该属性不可访问）
3. 改用硬编码路径 `/Users/anrgct/workspace/llama.cpp/build/bin/llama-server`，但缺 `--reranking` 参数导致 501
4. 添加 `--reranking` 后端点正常，但 `--batch-size` 错误（实际需要 `--ubatch-size`）
5. `ubatch-size 2048` 后 rerank 成功，但分数全负 → 所有结果被 `rerankerMinScore: 5` 过滤掉
6. 添加 sigmoid 归一化，结果正常输出
7. 子进程未 `unref` → 搜索完成后进程卡住，无法退出
8. 添加 `child.unref()` + stdio 流的 `unref()`，进程正常退出
9. 用户要求将 bin 路径放入配置，改为 `rerankerLlamaCppServerBinPath`
10. 测试三种模型发现分数尺度完全不同：bge（logit）、Qwen3-4B（[0,1]）、Qwen3-0.6B（[0,1]）
11. `sigmoid × 1000` 对 bge 最高只有 107 分，`rerankerMinScore: 5` 几乎不过滤
12. 改为 `sigmoid → min-max → ×10` 三步归一化，分数统一到 [0,10]，`* 10` 而非 `* 1000` 以匹配 `RerankerResult` 接口声明的 0-10 范围

## 修订记录

### 2026-05-13
**问题：** `getLlama().llamaCppDirectory` 在运行时不可访问（private/internal prop）
**修复：** 移除 node-llama-cpp 路径发现，改用配置项 + 硬编码 fallback

**问题：** `POST /v1/rerank` 返回 501
**修复：** 添加 `--reranking` 启动参数

**问题：** `input (562 tokens) is too large to process. current batch size: 512`
**修复：** `--batch-size` 无效，需用 `--ubatch-size 2048`

**问题：** 分数全负导致结果被 `rerankerMinScore` 过滤
**修复：** 对 raw score 应用 sigmoid 归一化 → 但 `sigmoid × 1000` 对 bge 最高才 107 分，`rerankerMinScore: 5` 几乎无过滤效果

**问题：** 后续发现不同模型分数尺度完全不同（bge logit vs Qwen3 [0,1]），需统一归一化策略
**修复：** 最终改为 `sigmoid(if raw) → ×10`（去掉 min-max），避免赢者通吃效应；同时将 Direct 模式也从 `×1000` 统一为 `×10` 以匹配 `RerankerResult` 接口声明的 0-10 范围。最终实际有效分数范围约 0~1.07，`rerankerMinScore` 需按模型调整

**问题：** 搜索完成后进程不退出
**修复：** `child.unref()` + 各 stdio 流的 `unref()`

## 总结

### 关键收获

1. `llama-server` 的 `/v1/rerank` 端点需要 `--reranking` 参数显式启用
2. 物理批次大小由 `--ubatch-size` 控制（非 `--batch-size`），默认 512
3. **不同 reranker 模型的分数尺度不统一**：bge 返回 logit(-inf,+inf)，Qwen3 返回 sigmoid 后 [0,1]。不能硬编码一种归一化策略
4. **最终方案**：`sigmoid(if outside [0,1]) → ×10`，不做 min-max。分数保留原始相对置信度，实际有效范围约 0~1.07
5. `rerankerMinScore` 是**绝对阈值**，需按模型调整（bge ~0.02~0.05，Qwen3-0.6B ~0.01~0.03）
6. Node.js 子进程 + pipe 会保持事件循环活跃，必须 `unref()`
7. `node-llama-cpp` 不捆绑 `llama-server` 二进制，路径需用户配置

### 后续优化

- 可考虑跳过 node-llama-cpp 依赖，当 `rerankerLlamaCppServer=true` 时完全由 HTTP 通信
- server 启动参数可进一步优化（GPU layers、parallel 等）
