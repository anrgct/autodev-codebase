# 260510-llamacpp-provider-auto-dimension

## 主题/需求

参考 QMD 的纯本地方案，为 codebase 项目增加两个核心能力：

1. **自动维度检测** — 新建向量集合时，通过嵌入一条测试文本自动获取维度，替代硬编码 profile + 手动配置的方式
2. **LlamaCPP Provider** — 基于 `node-llama-cpp` 的纯本地 provider，进程内加载 GGUF 模型，无需外部服务

### 目标

- 用户切换任意嵌入模型时，无需手动配置维度
- 提供完全离线、零外部依赖的本地嵌入、重排序和摘要能力
- `llamacpp` 作为统一 LLM provider，同时服务 `rerankerProvider` 和 `summarizerProvider`

### 预期成果

- `embedderProvider: "llamacpp"` — 纯本地嵌入
- `rerankerProvider: "llamacpp"` — LLM chat 打分重排序（类似 OllamaLLMReranker）
- `summarizerProvider: "llamacpp"` — LLM chat 摘要生成
- 维度自动检测作为 fallback，新建集合时检测，已有集合读取历史维度

### 验证方式

统一在 demo 目录下验证，demo 的配置文件是 `demo/autodev-config.json`：

```bash
npx tsx src/cli.ts index --force --demo
npx tsx src/cli.ts search "where is the actual train method implementation in the source code?" --demo
npx tsx src/cli.ts outline "model.py" --demo --clear-cache --summarize --log-level=debug
```

## 代码背景

### 维度确定链路（现状）

```text-chart
[维度确定链路] (当前: profile → 手动配置 → 报错)
service-factory.createVectorStore:150
  ↓
embeddingModels.getModelDimension:73
  ↓
EMBEDDING_MODEL_PROFILES:19 → 查找预定义维度
  ↓
未找到 → 检查 embedderModelDimension (手动配置)
  ↓
仍未找到 → 抛出错误
```

**关键约束:** `createVectorStore()` 是同步方法，当前不接收 embedder 参数。改为异步后，可在方法内部调用 `this.createEmbedder()` 获取 embedder 用于维度检测，无需外部传参。

**已有基础设施:** `QdrantVectorStore.getCollectionInfo():189` 已能从 Qdrant 获取集合信息（含 vector_size），`initialize():232` 已实现维度比较和集合重建逻辑。阶段1可直接复用。

### LlamaCPP 目标架构

```text-chart
[LlamaCPP Provider 架构] (三种模型，四种角色)
service-factory 内部管理模型生命周期
├── _llamaCppEmbeddingModel (嵌入模型，仅 embedder 使用)
│   ├── 模型路径: embedderLlamaCppModelPath
│   └── model.createEmbeddingContext → context.getEmbeddingFor(text)
├── _llamaCppRerankerModel (专用重排序模型，可选)
│   ├── 模型路径: rerankerLlamaCppRerankerModelPath (用户配置)
│   └── model.createRankingContext → context.rank(query, docs)
└── _llamaCppLlmModel (LLM 生成模型，reranker + summarizer 共享)
    ├── 模型路径: rerankerLlamaCppModelPath / summarizerLlamaCppModelPath
    ├── llm-rerank（2B 模型） → LlamaChatSession + QwenChatWrapper
    │   ├── QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })
    │   └── 禁用 think 标签，顺序执行 batch
    └── summarizer（0.8B 小模型） → LlamaCompletion（raw completion）
        └── 小模型不兼容 chat template，必须用 raw completion
```

**模型共享策略：** service-factory 中使用 `private _llamaCppLlmModel` 懒加载字段，`createReranker()` 和 `createSummarizer()` 共享同一引用。首次调用时加载，进程生命周期内复用。

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/code-index/service-factory.ts` | 服务工厂，创建 embedder/vectorStore/reranker/summarizer (service-factory.CodeIndexServiceFactory:29, createVectorStore:150, createReranker:264, createSummarizer:318) |
| `src/shared/embeddingModels.ts` | 模型维度 profile 和查找函数 (embeddingModels.getModelDimension:73) |
| `src/code-index/interfaces/embedder.ts` | IEmbedder 接口定义 |
| `src/code-index/interfaces/reranker.ts` | IReranker 接口定义 |
| `src/code-index/interfaces/summarizer.ts` | ISummarizer 接口定义（已有 ollama/openai-compatible 实现） |
| `src/code-index/interfaces/config.ts` | 配置接口 CodeIndexConfig |
| `src/code-index/vector-store/qdrant-client.ts` | Qdrant 向量存储，已有 getCollectionInfo():189 和 initialize():232（维度比较 + 集合重建） |
| `src/code-index/config-manager.ts` | 配置管理器，包含 REQUIRES_RESTART_KEYS 和 HOT_RELOADABLE_KEYS 列表 |
| `src/code-index/embedders/ollama.ts` | Ollama embedder 实现（参考模板） |
| `src/code-index/rerankers/ollama.ts` | Ollama LLM reranker 实现 — llm-rerank 模式参考（构建 prompt → LLM 打分） |
| `src/code-index/summarizers/ollama.ts` | Ollama summarizer 实现（参考模板） |

### QMD 参考：维度自动检测

```text-chart
[QMD 维度检测] (参考 qa.md Q6)
首次嵌入
  ↓
session.embed(firstText) → embedding 数组
  ↓
embedding.length → 运行时获取维度 (如 2048)
  ↓
ensureVecTable(dimensions) → 创建对应维度的向量表
```

## 关键决策

### 决策1：维度检测策略 — 新建时检测 + 历史优先

**选择：** profile → 历史维度 → 自动检测（三层 fallback）

**理由：**
- profile 查找零开销，已有模型保持快速启动
- 历史维度从 Qdrant 集合信息获取（复用已有 `getCollectionInfo()`），避免重复检测
- 自动检测作为最终 fallback，保证任意模型都能工作
- 只在创建新集合时检测一次，后续不再调用

**对比方案：**
| 方案 | 优点 | 缺点 |
|------|------|------|
| 仅 profile（现状） | 快速、无 API 调用 | 未知模型直接报错 |
| 完全自动检测 | 兼容所有模型 | 首次启动慢，额外 API 调用 |
| **三层 fallback** | 兼顾速度和兼容性 | 逻辑稍复杂 |

### 决策2：LlamaCPP 集成方式 — 常规 npm 依赖

**选择：** `node-llama-cpp` 作为常规依赖，`npm install` 自动下载预编译二进制

**理由：**
- `node-llama-cpp` 提供主流平台预编译二进制（macOS/Linux/Windows）
- 不需要 optionalDependency 或动态 import
- 用户选择 llamacpp provider 即可使用，和其他 provider 体验一致

### 决策3：模型管理 — 用户自备路径

**选择：** 用户通过配置指定 GGUF 模型文件路径

**理由：**
- 避免自动下载大文件（模型 150MB-2GB）
- 用户可能已有模型文件，不重复下载
- 配置灵活，支持任意 GGUF 模型

### 决策4：LLM 作为统一 provider，Reranker 支持两种模式

**选择：** `llamacpp` 作为独立 provider 类型，可被 `rerankerProvider` 和 `summarizerProvider` 引用

**Reranker 两种模式：**
| 模式 | 原理 | 模型要求 | 精度 |
|------|------|----------|------|
| **rerank** | 专用 ranking context (`createRankingContext`) | 专用 reranker GGUF（如 Qwen3-Reranker） | 高（交叉编码器） |
| **llm-rerank** | LLM chat 打分（构建 prompt → 返回分数） | 通用 LLM GGUF（如 Qwen3.5） | 中（prompt 驱动） |

**理由：**
- 两种模式对应不同使用场景：有专用 reranker 模型时用 rerank 精度更高；只有通用 LLM 时用 llm-rerank 也能工作
- Summarizer 使用 LLM chat 生成摘要
- 嵌入模型、reranker 模型、LLM 模型是独立的 GGUF 文件，分别配置

**配置示例：**
```json
{
  "embedderProvider": "llamacpp",
  "embedderLlamaCppModelPath": "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0.gguf",
  "rerankerProvider": "llamacpp",
  "rerankerLlamaCppModelPath": "/Users/anrgct/llm_models/mradermacher/Qwen3-VL-Reranker-2B-GGUF/Qwen3-VL-Reranker-2B.Q8_0.gguf",
  "summarizerProvider": "llamacpp",
  "summarizerLlamaCppModelPath": "/Users/anrgct/llm_models/unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-UD-Q8_K_XL.gguf"
}
```

### 决策5：维度检测无需修改 IEmbedder 接口

**选择：** 在 `service-factory.createVectorStore()` 内部调用 `this.createEmbedder()` 获取 embedder，直接用 `embedder.createEmbeddings(["test"])` 取 `embeddings[0].length`，不修改 `IEmbedder` 接口。

**理由：**
- `IEmbedder` 有 8 个现有实现，加新方法会波及全部
- TypeScript 接口不支持"默认实现"
- `createVectorStore()` 改为 async 后，内部可直接获取 embedder
- 检测逻辑只有一处调用点（创建向量存储时），不需要抽象到接口层

**`createServices()` 调用顺序调整：**
```typescript
// 改为: createVectorStore 内部创建 embedder 做检测
const vectorStore = await this.createVectorStore()  // async, 内部调用 this.createEmbedder()
const embedder = this.createEmbedder()               // 再创建一次供外部使用
```

对于 HTTP-based provider，创建两次 embedder 开销可忽略（只是 new 一个对象）。对于 LlamaCPP，`LlamaCppEmbedder` 内部使用惰性加载，模型只在首次 `createEmbeddings()` 时加载，重复创建 embedder 实例不会重复加载模型。

### 决策6：LLM 模型共享 — service factory 懒加载字段

**选择：** 在 `CodeIndexServiceFactory` 中增加 `private _llamaCppLlmModel` 懒加载字段，`createReranker()` 和 `createSummarizer()` 共享同一引用。

**理由：**
- 不需要额外的单例类，与现有 factory 模式一致
- 惰性加载：首次使用时才加载模型文件（内存 ~1GB）
- 进程生命周期内复用，不会重复加载

## 实施计划

### 阶段1：自动维度检测

- [ ] 1.1 `service-factory.createVectorStore` 改为 `async`，内部实现三层 fallback
  - 在方法内部调用 `this.createEmbedder()` 获取 embedder（用于自动检测）
  - `createServices()` 调整调用顺序：先 `await createVectorStore()`，再 `createEmbedder()`
- [ ] 1.2 复用 `QdrantVectorStore.getCollectionInfo()` 获取历史维度
  - 该方法已返回 `CollectionInfo`（含 `vector_size`）
  - 只需在 `createVectorStore` 中调用并提取维度
- [ ] 1.3 三层 fallback 实现：profile → 历史维度 → 自动检测
  - 第1层：`getModelDimension(provider, modelId)` 查 profile
  - 第2层：`QdrantVectorStore.getCollectionInfo()` → `config.params.vectors.size`
  - 第3层：`embedder.createEmbeddings(["test"])` → `embeddings[0].length`
- [ ] 1.4 维度冲突检测：历史维度 ≠ 检测维度时抛出明确错误，提示用户 `--force` 重建索引

### 阶段2：LlamaCPP Embedder

- [ ] 2.1 安装 `node-llama-cpp` 依赖
- [ ] 2.2 配置扩展（统一使用 `{组件}LlamaCpp{字段}` 前缀约定）
  - `CodeIndexConfig` 增加：`embedderLlamaCppModelPath`, `embedderLlamaCppGpuLayers`
  - `EmbedderProvider` 类型增加 `"llamacpp"`
  - `AvailableEmbedders` 类型增加 `"llamacpp"`
  - `config-manager.ts` 的 `REQUIRES_RESTART_KEYS` 增加 llamacpp 相关字段
- [ ] 2.3 实现 `LlamaCppEmbedder` — `IEmbedder` 接口
  - 惰性加载模型（首次 `createEmbeddings()` 时初始化）
  - `model.createEmbeddingContext()` → `context.getEmbeddingFor(text)`
  - 支持批量嵌入
  - GPU 自动检测（Metal/Vulkan/CUDA，通过 `node-llama-cpp` 的 `getGpuType()` ）
  - `validateConfiguration()`：检查模型文件存在 + 加载模型 + 测试嵌入提取
- [ ] 2.4 `service-factory.createEmbedder:60` 增加 llamacpp 分支
  - 必填校验：`embedderLlamaCppModelPath` 必须配置
- [ ] 2.5 `embeddingModels.ts` 增加 llamacpp 常用模型 profile（可选，用户自定义模型走自动检测）
  - 如 `jina-embeddings-v5-nano-retrieval` → 1024 维度

### 阶段3：LlamaCPP Reranker（双模式）

- [ ] 3.1 配置扩展
  - `RerankerConfig.provider` 增加 `"llamacpp"` 选项
  - `CodeIndexConfig` 增加：`rerankerLlamaCppModelPath`（LLM 模型路径，llm-rerank 模式使用）
  - `CodeIndexConfig` 增加：`rerankerLlamaCppRerankerModelPath`（专用 reranker 模型路径，rerank 模式使用，可选）
  - `HOT_RELOADABLE_KEYS` 增加对应字段
- [ ] 3.2 `service-factory` 增加 `private _llamaCppLlmModel` 懒加载字段
  - 首次访问时调用 `LlamaModel.load(modelPath)` 加载 LLM 模型
  - `createReranker()` 和 `createSummarizer()` 共享此引用
- [ ] 3.3 实现 `LlamaCppReranker`（rerank 模式）— `IReranker` 接口
  - 使用 `node-llama-cpp` 的 `createRankingContext` + `rank()`
  - 需要专用 reranker GGUF 模型
  - 惰性加载
  - `validateConfiguration()`：检查模型文件存在 + 加载 + 测试 ranking
- [ ] 3.4 实现 `LlamaCppLLMReranker`（llm-rerank 模式）— `IReranker` 接口
  - 复用 `OllamaLLMReranker` 的 prompt 构建模式（构建打分 prompt → LLM 返回分数）
  - 使用共享的 `_llamaCppLlmModel` 创建 `LlamaChatSession`
  - 批量 + 并发 + 重试机制（与 OllamaLLMReranker 一致）
  - `validateConfiguration()`：检查 LLM 模型可用 + 测试文本生成
- [ ] 3.5 `service-factory.createReranker:264` 增加 llamacpp 分支
  - 配置了 `rerankerLlamaCppRerankerModelPath` → 使用 rerank 模式（LlamaCppReranker）
  - 未配置 → 使用 llm-rerank 模式（LlamaCppLLMReranker，共享 LLM 模型）

### 阶段4：LlamaCPP Summarizer

- [ ] 4.1 配置扩展
  - `SummarizerConfig.provider` 增加 `"llamacpp"` 选项
  - `CodeIndexConfig` 增加：`summarizerLlamaCppModelPath`（LLM 模型路径）
  - `HOT_RELOADABLE_KEYS` 增加对应字段
- [ ] 4.2 实现 `LlamaCppSummarizer` — `ISummarizer` 接口
  - 使用共享的 `_llamaCppLlmModel` 创建 `LlamaChatSession.prompt()` 生成摘要
  - 复用 `OllamaSummarizer` 的 prompt 构建模式（`buildPrompt`）
  - 复用 `OllamaSummarizer` 的 JSON 解析容错策略（`extractCompleteJsonObject`）
  - 支持 `summarize()` 和 `summarizeBatch()` 方法
  - `validateConfiguration()`：检查 LLM 模型可用
- [ ] 4.3 `service-factory.createSummarizer:318` 增加 llamacpp 分支
  - llmacpp 不作为 fallback（只有显式配置才使用）

### 阶段5：配置与集成

- [ ] 5.1 CLI `config` 命令支持 llamacpp 配置项
- [ ] 5.2 配置校验：检查模型文件路径存在性（在 `validateConfiguration()` 中实现）
- [ ] 5.3 `EMBEDDING_MODEL_PROFILES` 增加 llamacpp 常用模型（用户自定义模型走自动检测）
- [ ] 5.4 端到端验证：llamacpp provider 的索引和搜索流程（demo 目录）

## 实施记录

### 2025-05-10

- 完成 QMD qa.md 参考分析
- 完成现有代码架构调研
- 确认需求：自动维度检测 + LlamaCPP 全套（embed + rerank + summarize）
- 确认模型管理：用户自备路径
- 确认 LLM provider 模式：reranker 双模式（rerank + llm-rerank），summarizer 用 LLM chat
- 编写实施计划
- 代码评审：发现并修复 6 个架构问题

### 2026-05-10（实施完成）

**阶段1（自动维度检测）：**
- `createVectorStore()` 改为 async，实现三层 fallback（profile → 历史 Qdrant 维度 → embedder 自动检测）
- 新增 `_getExistingVectorSize()` 直接查询 Qdrant 集合 `config.params.vectors.size`
- 新增 `_detectVectorDimension()` 调用 `embedder.createEmbeddings(["test"])` → `embeddings[0].length`
- 维度冲突检测：集合历史维度 ≠ 检测维度时抛出 `vectorDimensionConflict` 错误
- `createServices()` 调整调用顺序：先 `await createVectorStore()`，再 `createEmbedder()`

**阶段2（LlamaCPP Embedder）：**
- 配置扩展：`CodeIndexConfig` 增加 `embedderLlamaCppModelPath`、`embedderLlamaCppGpuLayers`；`EmbedderProvider`/`AvailableEmbedders` 增加 `"llamacpp"`；`REQUIRES_RESTART_KEYS` 增加对应字段
- 新建 `src/code-index/embedders/llamacpp.ts`：惰性加载模型，`model.createEmbeddingContext()` → `context.getEmbeddingFor(text)`，支持 GPU 自动检测（Metal/Vulkan/CUDA），`validateConfiguration()` 检查模型文件 + 测试嵌入
- `service-factory.createEmbedder()` 增加 llamacpp 分支：必填校验 `embedderLlamaCppModelPath`
- `embeddingModels.ts` 增加 4 个 llamacpp 常用模型 profile
- 安装 `node-llama-cpp` 依赖

**阶段3（LlamaCPP Reranker — 双模式）：**
- 配置扩展：`RerankerConfig.provider` 增加 `"llamacpp"`；`CodeIndexConfig` 增加 `rerankerLlamaCppModelPath`、`rerankerLlamaCppRerankerModelPath`；`HOT_RELOADABLE_KEYS` 增加对应字段；`config-manager.rerankerConfig` getter 增加两个字段
- `service-factory` 增加 `private _llamaCppLlmModel` 懒加载字段 + `_getOrCreateLlamaCppLlmModel()` 方法
- 新建 `src/code-index/rerankers/llamacpp-rerank.ts`（rerank 模式）：使用 `createRankingContext` + `rankAll()`，惰性加载，`validateConfiguration()` 检查文件 + 测试 ranking
- 新建 `src/code-index/rerankers/llamacpp-llm-rerank.ts`（llm-rerank 模式）：复用 OllamaLLMReranker 的 prompt 构建模式，使用共享 `_llamaCppLlmModel` 创建 `LlamaChatSession`，批量 + 并发 + 重试 + fallback 分数
- `createReranker()` 改为 async，增加 llamacpp 分支：`llamaCppRerankerModelPath` → `LlamaCppReranker`；`llamaCppModelPath` → `LlamaCppLLMReranker`（共享模型）
- 更新 `manager.ts` 使用 `await this._serviceFactory.createReranker()`
- 修复 llamacpp reranker 类型错误（`rank()` → `rankAll()`，`LlamaChatSession({ context })` → `{ contextSequence }`）

**阶段4（LlamaCPP Summarizer）：**
- 配置扩展：`SummarizerConfig.provider` 增加 `"llamacpp"`；`CodeIndexConfig` 增加 `summarizerLlamaCppModelPath`；`summary-cache.ts` 的 `CacheFingerprint.provider` 增加 `"llamacpp"` + `createFingerprint()` 处理 llamacpp 分支
- 新建 `src/code-index/summarizers/llamacpp.ts`：使用共享 `_llamaCppLlmModel` 创建 `LlamaChatSession.prompt()` 生成摘要，复用 `buildPrompt` + `extractCompleteJsonObject`，支持 `summarize()` 和 `summarizeBatch()`
- `createSummarizer()` 改为 async，增加 llamacpp 分支（只有显式配置才使用，不走 fallback）
- 更新 `outline.ts` 调用链增加 `await`

**阶段5（配置与集成）：**
- CLI `config` 命令 metadata 增加 5 个配置项
- `rerankerProvider`/`summarizerProvider` 枚举增加 `"llamacpp"`
- 类型检查零错误，363 个 code-index 测试全部通过
- **Demo 验证通过：** `npx tsx src/cli.ts index --force --demo` 成功索引 6 个 demo 文件，自动检测维度为 768；`npx tsx src/cli.ts search "where is the actual train method implementation in the source code?" --demo` 正确返回 model.py train 方法作为 Top1 结果
- **修复 3 个缺失的 llamacpp 配置校验分支：** `config-validator.ts`（embedder/reranker/summarizer 三处）、`config-manager.ts`（`isConfigured()` 方法）
- **修复 `node-llama-cpp` 日志噪声：** `LlamaCppEmbedder` 加载模型时设置 `logLevel: "warn"`，消除嵌入初始化时的 info 日志

**修复的问题：**
1. **拆分配置校验分支** — `config-validator.ts` 三处、`config-manager.ts.isConfigured()` 增加 `'llamacpp'` 分支
2. **LlamaChatSession 超时** — summarizer 改用 `LlamaCompletion` 绕过 chat wrapper，消除 Qwen3.5 think token 耗时
3. **摘要缓存陈旧** — 之前失败的 `[Summary failed: ...]` 被缓存，需 `--clear-cache` 强制重新生成
4. **Cross-encoder 分数范围** — `rankAll()` 返回 0~1 分数，需 `* 10` 归一化到 0~10，否则被 `rerankerMinScore` 过滤
5. **`logger` 属性类型错误** — `node-llama-cpp` v3.18.1 的 `LlamaModelOptions` 不支持该属性，且对 C++ 层 "init: embeddings" 消息无效，已移除

**验证记录：**

| 场景 | 配置 | 结果 |
|------|------|------|
| `index --force --demo` | llamacpp embedder (jina-v5-nano) | 索引 6 文件，自动检测维度 768 ✅ |
| `search "train method" --demo` | cross-encoder rerank (Qwen3-Reranker-0.6B) | 8 条结果，rerank 生效 ✅ |
| `outline --summarize --demo --clear-cache` | LLM summarizer (Qwen3.5-0.8B) | 摘要生成正常 ✅ |
| `search "train method" --demo` | Qwen3-VL-Reranker-2B | ❌ `createRankingContext` 不支持此模型 |

**不支持的模型：**
- `Qwen3-VL-Reranker-2B` — GGUF 无 ranking head，`createRankingContext()` 报 "Computing rankings is not supported for this model"，需改用 `qwen3-reranker-0.6b-q8_0.gguf` 或其他支持 ranking 的 GGUF

**新增文件：**
| 文件 | 说明 |
|------|------|
| `src/code-index/embedders/llamacpp.ts` | LlamaCppEmbedder — 惰性加载 + `getEmbeddingFor` 嵌入 |
| `src/code-index/rerankers/llamacpp-rerank.ts` | LlamaCppReranker — 专用 reranker（`rankAll` 交叉编码器） |
| `src/code-index/rerankers/llamacpp-llm-rerank.ts` | LlamaCppLLMReranker — LLM chat 打分重排序 |
| `src/code-index/summarizers/llamacpp.ts` | LlamaCppSummarizer — LLM chat 摘要生成 |

## 修订记录

### 2026-05-10（Demo 验证修复）

**问题与修正：**

1. **`config-validator.ts` 不认识 `"llamacpp"` provider** — embedder 校验的 switch 语句缺少 `case 'llamacpp'` 分支，走到 `default` 报"Unknown provider"。同样，reranker 校验和 summarizer 校验也缺少 `'llamacpp'` 分支。→ 三处增加 llamacpp 分支，embedder 校验 `embedderLlamaCppModelPath` 必填，reranker 和 summarizer 只校验 provider 合法性（模型路径在 service-factory 创建时检查）。

2. **`config-manager.isConfigured()` 不认识 `"llamacpp"` provider** — 方法中的 if-else 链缺少 `embedderProvider === "llamacpp"` 分支，导致对 llamacpp 配置始终返回 `false`，引发 "Code indexing is not properly configured" 错误。→ 增加 llamacpp 分支，要求 `embedderLlamaCppModelPath && qdrantUrl`。

3. **`node-llama-cpp` 嵌入初始化日志噪声** — `createEmbeddingContext()` 时 `node-llama-cpp` 输出大量 `"init: embeddings required but some input tokens were not marked as outputs -> overriding"` 到 stderr，每次嵌入调用都会输出一次。→ `LlamaCppEmbedder.loadModel()` 添加 `logger: { logLevel: "warn" }`，仅显示 warn 及以上级别。

4. **Cross-encoder reranker 分数范围不匹配** — `rankAll()` 返回 0~1 概率分数，但搜索服务用 `rerankerMinScore=7`（0~10 范围）过滤。→ `llamacpp-rerank.ts` 中 `score * 10` 归一化。

5. **`logger` 属性类型错误** — `node-llama-cpp` v3.18.1 的 `LlamaModelOptions` 类型不包含 `logger`，导致类型检查失败。且该属性对 C++ 层 "init: embeddings" 消息无效。→ 移除 embedder 和 reranker 中的 `logger` 设置。

6. **摘要缓存陈旧** — 之前 `outline --summarize` 失败的错误信息被写入缓存，后续运行 100% 命中不再重新生成。→ 需 `--clear-cache` 清除后重建。

7. **Qwen3-VL-Reranker-2B 不支持 ranking API** — `createRankingContext()` 报 "Computing rankings is not supported for this model"。→ 改用 Qwen3-Reranker-0.6B。

### 2025-05-10（评审修订）

**问题与修正：**

1. **`createVectorStore` 无法访问 embedder** → `createVectorStore` 改为 async，内部调用 `this.createEmbedder()` 获取 embedder，无需外部传参。`createServices()` 调整调用顺序。

2. **`IEmbedder.detectDimension()` 波及 8 个实现** → 放弃接口修改，直接在 `createVectorStore` 内部调用 `embedder.createEmbeddings(["test"])` 取长度。

3. **`getCollectionInfo()` 已存在** → 步骤 1.2 改为复用现有方法，不再新增 `getExistingVectorSize()`。

4. **LLM 模型共享架构未融入 factory** → 新增决策6：service-factory 中 `private _llamaCppLlmModel` 懒加载字段，reranker 和 summarizer 共享引用。

5. **配置字段命名不一致** → 统一为 `{组件}LlamaCpp{字段}` 前缀约定（如 `embedderLlamaCppModelPath`、`rerankerLlamaCppModelPath`）。

6. **`createSummarizer` 的 fallback 行为** → llamacpp 作为显式 provider，只在用户配置时使用，不走 unknown provider → Ollama fallback。

### 2026-05-11（llm-rerank + summarizer 对话接口统一）

**llm-rerank 模式全面使用 LlamaChatSession：**
- `llamacpp-llm-rerank.ts`：`LlamaCompletion` → `LlamaChatSession` + `QwenChatWrapper`
- 使用 `QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })` 从源头禁用 `<think>` 标签
- 必须 `temperature: 0` 确保确定性输出
- `contextSize: 32768`，`maxTokens: 4096`

**Summarizer 使用 LlamaChatSession + QwenChatWrapper（实验验证后修正）：**
- 最初认为 0.8B 模型不兼容 `LlamaChatSession`（auto-detection 返回空字符串）
- **实验发现：** `LlamaChatSession (auto)` 失败是因为 0.8B GGUF 的 chat template 元数据导致的 auto-detection 问题，而非模型本身不兼容 chat 格式
- 手动指定 `QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })` 后，0.8B 模型输出正确 JSON，无 think 标签 ✅
- 因此 summarizer 与 llm-rerank 统一使用 `LlamaChatSession` + `QwenChatWrapper`

**Think 标签行为实验结论：**
- `LlamaCompletion`：复杂任务上总会输出 `<think>\n\n</think>` 空标签（不论温度），内容是空的，真正答案在标签外
- `LlamaChatSession (auto)` + 2B：无 think 标签 ✅，auto-detection 正常
- `LlamaChatSession (auto)` + 0.8B：返回空字符串 ❌（chat template auto-detection 失败）
- `LlamaChatSession + QwenChatWrapper(discourage)` + 任意模型：无 think 标签 ✅ — 从 chat template 层面禁用，最可靠
- 结论：**始终使用 `QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })`**，两种模型都能正常工作，且无需 regex 剥离 think 标签

**并发 context 创建限制：**
- `node-llama-cpp` 不支持同一个 `LlamaModel` 上并发 `createContext()` 调用
- llm-rerank：移除 `Promise.all` + `concurrency`，顺序执行 batch（`llamacpp-llm-rerank.ts:39`）
- summarizer batch 调度：`outline.ts` 移除 `Promise.all` + `concurrency`，顺序执行 batch
- 两个地方都用于使用 `concurrency` 参数通过 `Promise.all` 并行处理 batch，对远程 API 没问题，对本地 `node-llama-cpp` 导致第二个 context 创建失败 → 空 response

**验证结果：**

| 测试 | 结果 |
|------|------|
| `search "{query}" --demo` | llm-rerank 两个 batch 全部成功，无 retry、无 fallback、无 think 标签 ✅ |
| `outline "model.py" --demo --clear-cache --summarize` | 7/7 batch 全部成功，无错误 ✅ |

### 2026-05-11（summarizer Prompt 修复）

**问题：** `LlamaChatSession` + `QwenChatWrapper` 对 0.8B 模型，batch 3 持续失败 "Could not extract JSON from batch response"。

**根因分析：**
- Prompt 开头 "Generate semantic descriptions for the following code snippets" 让 chat mode 下的模型理解为"为全部 snippet 生成描述"
- 模型无视 batch 大小，输出全部 32 个 snippet 的摘要，`maxTokens=2048` 不足以完成完整 JSON
- 这和 `LlamaCompletion` 的行为完全不同——chat template 让模型更"helpful"但降低了格式约束遵循能力

**修复：** 一行 Prompt 改动：
```
- "Generate semantic descriptions for the following code snippets:"
+ "You are given ${blocks.length} individual code snippet(s). Generate ONE semantic description for EACH snippet below:"
```
加上 `CRITICAL: You MUST output EXACTLY ${blocks.length} item(s) and nothing else.` 作为双重约束。

**结论：** LlamaChatSession + QwenChatWrapper 对 0.8B 模型可用，但对 Prompt 精确度要求远高于 LlamaCompletion。小模型在 chat mode 下需要极明确的输出数量约束。

### 2026-05-11（context 并发实验 + batch 调度并发化）

**实验：验证 `model.createContext()` 的并发安全性**

创建独立实验脚本，测试 0.8B 模型上的多种并发模式：

| 实验 | 设计 | 结果 |
|------|------|------|
| 1 | 并发 `createContext`（3个同时） | 3/3 成功 ✅ |
| 2 | 顺序 `createContext` | 全部成功 ✅ |
| 3 | 并发 `LlamaCompletion`（不同 context） | 3/3 成功 ✅ |
| 4 | `LlamaCompletion` 进行中并发 `createContext` | 两者都成功 ✅ |
| 5 | `LlamaChatSession` 并发（不同 context） | 3/3 成功 ✅ |
| **6** | **共享 `contextSequence` 并发 `session.prompt`** | **3/3 但不抛错，输出交叉污染 ❌** |
| 7A | 模拟 summarizer 并发 batch（各自 context + `Promise.all`） | 2/2 成功 ✅ |
| 7B | 模拟 summarizer 顺序 batch | 全部成功 ✅ |

**关键发现：**
- `createContext()` **是线程安全的** — 可以并发创建
- **不同 `context` 并发 `prompt()`** 也是安全的
- **共享 `contextSequence` 并发 `session.prompt()` 是危险的** — 不抛异常但底层 C++ 状态被交叉污染，输出乱码/截断/混淆
- 因此每个 batch 独立创建 context + 并发执行是完全安全的

**改动：**
- `outline.ts` — summarizer batch 调度从顺序 `for` 恢复为按 `concurrency` 参数分组 `Promise.all` 并发
- `llamacpp-llm-rerank.ts` — 提取 `processBatchWithRetry` 方法，按 `this.concurrency` 分组并发。每个 batch 独立创建 context，重试/fallback 逻辑保留在方法内部

**验证：** 类型检查通过，reranker 集成测试 7/7 通过

### 2026-05-11（压制 llama.cpp C++ stderr 日志）

**问题：** 搜索和 outline 时 `llama_context: n_ctx_seq...` 和 `init: embeddings required...` 等 C++ 层日志泄漏到 stderr。

**原因：** 这些日志从 llama.cpp C++ 层直接输出，不经过 `node-llama-cpp` 的 JS logger。`getLlama()` 默认 `logLevel: "warn"` 仍允许 `info` 级别消息通过。

**修复：** 两处 `getLlama()` 调用统一设为 `{ logLevel: LlamaLogLevel.error }`：
- `embedders/llamacpp.ts:34` — 嵌入模型
- `service-factory.ts:54` — reranker/summarizer 共享模型

`getLlama()` 是进程单例，首次调用设置全局 logLevel，后续调用复用实例。`LlamaLogLevel.error` 压制所有 `info` 级别 C++ 日志。

**验证：** 搜索和 outline 输出干净，无 C++ 日志泄漏

### 2026-05-12（jina-embeddings-v5-nano-retrieval Query:/Document: 前缀）

**问题：** `jina-embeddings-v5-text-nano-retrieval` 模型需要 Query:/Document: 前缀才能正确生成检索向量。索引时不加前缀的 chunk 和搜索时不加前缀的查询会得到不匹配的向量空间。

**改动文件：**

| 文件 | 改动 |
|------|------|
| `src/shared/embeddingModels.ts` | `getModelQueryPrefix` 新增 llamacpp + jina-embeddings-v5 返回 `"Query: "`；新增 `getModelDocumentPrefix` 同条件返回 `"Document: "` |
| `src/code-index/search-service.ts` | 在 `applyQueryPrefill` 之后、`createEmbeddings` 之前调用 `getModelQueryPrefix` 加 `"Query: "` 前缀 |
| `src/code-index/shared/block-text-generator.ts` | `generateBlockEmbeddingText` 新增可选 `prefix` 参数 |
| `src/code-index/processors/scanner.ts` | `processBatch` 中新增 `_resolveDocumentPrefix()` 私有方法，从 embedder 实例提取模型名并调用 `getModelDocumentPrefix`，结果传给 `generateBlockEmbeddingText` |

**设计决策：**
- 前缀逻辑不在 `LlamaCppEmbedder.createEmbeddings()` 内部处理，因为同一方法被索引和搜索两个场景共用，embedder 无法区分当前是文档还是查询
- 索引侧：`scanner.ts` → `generateBlockEmbeddingText` 加 `Document: `，embedder 不加前缀
- 查询侧：`search-service.ts` → `applyQueryPrefill` → `getModelQueryPrefix` 加 `Query: `，embedder 不加前缀
- `getModelQueryPrefix` / `getModelDocumentPrefix` 只对 `provider === "llamacpp"` 且 `modelId` 包含 `"jina-embeddings-v5"` 时生效，其他 provider 不受影响

**验证：** 新增 19 个单元测试覆盖各种 provider/modelId 组合的前缀返回逻辑，12 个 block-text-generator 测试覆盖 prefix 参数行为

## 总结

本次改动的核心价值：

1. **维度自动检测** — 消除用户手动配置维度的负担，任意模型都能开箱即用
2. **纯本地 LlamaCPP** — 无需 Ollama/OpenAI 等外部服务，一台没有网络的机器也能完成完整索引和搜索
3. **统一 LLM provider** — `llamacpp` 同时服务 embed/rerank/summarize，reranker 支持双模式（专用 ranking + LLM chat 打分）
4. **架构参考 QMD** — 进程内 native addon 方案，延迟低、集成简单、零配置
