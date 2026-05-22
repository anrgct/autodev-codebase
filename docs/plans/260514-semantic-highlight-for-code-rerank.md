# 260514-semantic-highlight-for-code-rerank

## 主题/需求

将 [zilliz/semantic-highlight-bilingual-v1](https://huggingface.co/zilliz/semantic-highlight-bilingual-v1) 模型接入 codebase 搜索管线，在 Rerank 之后对每个代码块做行级语义高亮，实现 **"保留相关行、剪掉噪音行、保留原始行号、不连续块用 `---` 分隔"** 的展示效果。

### 目标

- 搜索结果的每个代码块返回行级相关性标注（kept / removed + 分数）
- 输出格式：保留原始行号，连续行成组，不连续块用 `---` 分隔
- 基于现有 `node-llama-cpp` 基础设施，不引入 Python 依赖
- 使用已量化的 GGUF 模型 + 外置 Pruning Head（软最大化分类头）

### 预期成果

- 新增 `IHighlighter` 接口和 `SemanticHighlightHighlighter` 实现
- 在 `CodeIndexSearchService.searchIndex()` 管线中插入 Highlighter 步骤
- `patch-package` 方式给 `node-llama-cpp` 打补丁，增加 `getEmbeddingsForTokens()` token 级 embedding API
- 输出格式：`{lineNumber}  {text}` + `---` 分隔符

### 验证方式

编辑 `demo/autodev-config.json`，新增 highlighter 配置：

```json
// --- Semantic Highlight (行级过滤) ---
"highlighterEnabled": true,
"highlighterGgufModelPath": "/Users/anrgct/workspace/open_provence_demo/output/gguf/semantic-highlight-bilingual-v1-Q8_0.gguf",
"highlighterTopK": 20
```

通过 CLI 搜索验证：

```bash
# 索引（如已索引可跳过）
npx tsx src/cli.ts index --force --demo

# 搜索并检查 highlightedText 输出
npx tsx src/cli.ts search "where is the actual train method" --demo --json | jq '.[0].payload.highlightedText'

# 期望输出格式：
#  234  function train():
#  235    model.fit(x, y)
#  ---
#  456    return result
```

单元测试：

```bash
npm run test -- src/code-index/highlighters/__tests__/llamacpp.test.ts --silent=false
```

## 代码背景

### 现有搜索管线

```text-chart
searchIndex(query, filter)  (search-service.CodeIndexSearchService.searchIndex:28)
  │
  ├─ 1. Embedding → Vector Search (Qdrant)
  │      → VectorStoreSearchResult[]  (每条含 payload.codeChunk, payload.startLine)
  │
  ├─ 2. [可选] IReranker.rerank()
  │     └─ ollama / openai-compatible / llamacpp
  │
  └─ 3. 返回结果（目前无行级过滤）
```

(search-service.CodeIndexSearchService:12)

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/code-index/search-service.ts` | 搜索服务，管线编排 |
| `src/code-index/interfaces/reranker.ts` | IReranker 接口（参考模式） |
| `src/code-index/rerankers/llamacpp-llm-rerank.ts` | LLM prompt 打分重排（prompt 构建参考） |
| `src/code-index/rerankers/llamacpp-rerank.ts` | 专用 reranker 模型，`createRankingContext` + `rank()` |
| `src/code-index/embedders/llamacpp.ts` | LlamaCPP embedder，`createEmbeddingContext` + `getEmbeddingFor` |
| `src/code-index/service-factory.ts` | 服务工厂，`createReranker()` / `createEmbedder()` / `createVectorStore()` |
| `src/code-index/interfaces/config.ts` | CodeIndexConfig 配置接口 |
| `src/code-index/config-manager.ts` | 配置管理器 |
| `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js` | **需 patch** — 新增 `getEmbeddingsForTokens()` |

### GGUF 模型 & 外置 Pruning Head

模型通过 `open_provence_demo/output/gguf/disguise.py` 伪装成标准 BGE-M3 (`XLMRobertaForSequenceClassification`) 后由 `convert_hf_to_gguf.py` 转换：

- **GGUF 模型**：`open_provence_demo/output/gguf/semantic-highlight-bilingual-v1-Q8_0.gguf`
  - 包含完整 XLM-RoBERTa backbone（24 层，1024-dim hidden）
  - `pooling_type=none`（GGUF metadata 中设定）
- **外置 Pruning Head**：`open_provence_demo/output/gguf/pruning_head_weight.npy` [2, 1024] + `pruning_head_bias.npy` [2]
  - 从原版模型提取后被 `disguise.py` 跳过，不在 GGUF 中
  - 公式：`logits = hidden @ W.T + b → softmax → probs[:, 1]` = token keep 概率

已验证 GGUF 输出与原版 HF 模型一致性（见 `validate_gguf.py` 和 `validation_comparison.json`）。

### node-llama-cpp 当前能力边界

`node-llama-cpp` v3.18.1 的 `LlamaEmbeddingContext.getEmbeddingFor()` 只返回 **pooled** embedding（单个向量）。当 GGUF 模型 `pooling_type=none` 时，底层 C++ 的 `getEmbedding(n)` 返回第 `n-1` 个 token 的 embedding。但 JS API 只调用一次，不暴露全部 token。

**需通过 patch 新增 `getEmbeddingsForTokens()`**，循环调用 `getEmbedding(i+1)` 获取全部 token embedding。

**⚠️ 已知限制：**
- C++ addon 强行设置 `n_ubatch = n_batch`（消除内部 ubatch 拆分），导致 JS 层多次 `llama_decode()` 会覆盖前一次的 embedding。
- **修复**：在 `createEmbeddingContext` 时传 `batchSize` = 模型 training context size（8192），确保一次 `llama_decode` 处理全部 token。见 § 修复方案-B。

## 关键决策

### 决策1：Highlighter 独立于 Reranker — 新增 `IHighlighter` 接口

**选择：** 新建 `IHighlighter` 接口，不塞进 `IReranker`

**理由：**
- Reranker 回答"多个候选代码块哪个最相关"（文档级），Highlighter 回答"单个代码块里哪几行最相关"（行级）
- 输入输出语义不同：Reranker 输入 `Candidate[]` 输出 `RerankerResult[]`，Highlighter 输入单个 `(query, codeChunk, startLine)` 输出 `HighlightResult`
- 可独立开关：用户可能想要 rerank 但不需要行级裁剪，反之亦然

### 决策2：使用 `patch-package` 给 `node-llama-cpp` 打补丁

**选择：** 修改 `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.{js,d.ts}`，用 `patch-package` 生成 `.patch` 文件

**理由：**
- C++ addon 已编译，`getEmbedding(n)` 原生支持按索引取 token embedding
- 纯 JS 层循环调用 `getEmbedding(i+1)` 即可获取全部 token embedding，无需重编译原生模块
- `patch-package` 方式保证 `npm install` 后自动应用补丁，对协作者透明
- 与现有 `patches/node-llama-cpp+3.18.1.patch` 模式一致

**对比方案：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **patch-package** | 不改 C++，自动应用 | 依赖 patch 文件维护 |
| 改 C++ + 本地 fork | 最高性能 | 需重编译，分发给协作者麻烦 |
| subprocess `llama-embedding` | 不改任何代码 | 进程开销 + JSON 序列化，已验证可用作 fallback |

### 决策3：默认 Top-K 模式（threshold=0）

**选择：** `threshold=0, topK=20`，不做硬阈值过滤

**理由：**
- 代码行间有控制流/数据流依赖，硬阈值剪掉 import、变量定义会让代码断裂
- Top-K 保证永远返回确定行数，对 query 变化不敏感
- 与 `260514-semantic-highlight-for-code-rerank.md` 分析文档结论一致

### 决策4：输出保留原始行号 + `---` 分隔符

**选择：** 保留行按行号排序，连续行成组，组间用 `---` 分隔

**格式：**
```
 234  function sortItems(items):
 235    if items is None:
 236      return []
 ---
 456    filtered.sort(key=lambda x: x.name)
 ---
 567    return result
```

**理由：**
- 用户明确要求此格式
- 保留原始行号方便定位原文件
- `---` 分隔符清晰表示代码被裁剪的位置

### 决策5：Pruning Head 权重硬编码为 TypeScript 常量

**选择：** 将 `pruning_head_weight.npy` [2, 1024] 和 `pruning_head_bias.npy` [2] 导出为 TypeScript 常量，嵌入 `SemanticHighlightHighlighter`

**理由：**
- 权重极小（2048 + 2 = 2050 个 float32，约 8KB），编译后增量可忽略
- 无需额外文件依赖，部署简单
- 与模型 GGUF 版本绑定，模型更新时同步更新常量

### 决策6：Token → Line 映射采用字符偏移近似

**选择：** 按 character offset 比例分配 tokens 到代码行

**理由：**
- llama.cpp 的 SentencePiece tokenizer 不直接暴露 offset mapping
- 对于代码场景（每行通常 20-80 字符），比例映射精度足够
- 实现简单，无需额外依赖

## 实施计划

- [x] **阶段1：node-llama-cpp patch** — 修改 `LlamaEmbeddingContext.js` 和 `.d.ts`，新增 `getEmbeddingsForTokens()`，生成 patch 文件
- [x] **阶段2：接口定义** — 新建 `src/code-index/interfaces/highlighter.ts`，定义 `IHighlighter`、`HighlightLine`、`HighlightResult`、`HighlighterConfig`
- [x] **阶段3：SemanticHighlightHighlighter 实现** — 新建 `src/code-index/highlighters/semantic-highlight.ts`
  - 加载 GGUF 模型 + 创建 embedding context
  - 调用 `getEmbeddingsForTokens()` 获取 token 级 hidden states
  - 应用外置 Pruning Head（softmax → keep probs）
  - Token → Line 映射（字符偏移）
  - Top-K 选取 + `formattedText` 格式化
- [x] **阶段4：配置层** — `CodeIndexConfig` 新增 `highlighterEnabled`、`highlighterGgufModelPath`、`highlighterTopK` 字段
- [x] **阶段5：管线集成** — `search-service.ts` 注入 `IHighlighter`，在 Rerank 之后对每个结果的 `codeChunk` 调用 `highlight()`
- [x] **阶段6：service-factory 集成** — 新增 `createHighlighter()` 方法
- [x] **阶段7：manager 初始化** — 初始化时创建 highlighter 实例
- [x] **阶段8：测试** — 纯逻辑单元测试（`src/code-index/highlighters/__tests__/llamacpp.test.ts`），17 个用例覆盖 `_findCodeOffset`、`_applyPruningHead`、`_formatOutput`、`_fallbackAllLines`、`highlighterInfo`

## 实施记录

### 2026-05-15

- ✅ **阶段1-7 完成** — 全部 7 个代码阶段已实施并通过类型检查
- 新增文件：
  - `src/code-index/interfaces/highlighter.ts` — IHighlighter 接口定义
  - `src/code-index/highlighters/semantic-highlight.ts` — SemanticHighlightHighlighter 实现
  - `src/code-index/highlighters/constants/pruning-head-weights.ts` — Base64 编码的 Pruning Head 权重
- 修改文件：
  - `interfaces/config.ts` — CodeIndexConfig / PreviousConfigSnapshot / ConfigSnapshot 新增 highlighter 字段
  - `interfaces/index.ts` — 导出 highlighter
  - `config-manager.ts` — 新增 highlighterConfig getter
  - `commands/config/metadata.ts` — highlighter 配置键元数据
  - `search-service.ts` — 注入 IHighlighter，Rerank 后行级高亮
  - `service-factory.ts` — 新增 createHighlighter() / validateHighlighter()
  - `manager.ts` — 创建 highlighter 实例并传入 search service
  - `commands/search.ts` — JSON/文本格式化输出 `highlightedText` 字段
- node-llama-cpp 补丁：`patches/node-llama-cpp+3.18.1.patch` 新增 `getEmbeddingsForTokens()`
- `npx tsc --noEmit` 通过，`npm run build` 成功
- ✅ 验证通过：搜索输出含 `highlightedText`，格式正确（保留行号，`---` 分隔不连续块）

#### 补丁迭代

1. **v1** — 逐 token 调用 `getEmbedding(i)`：token 49 处报错 `Failed to get embeddings`
2. **v2** — 改为一次 `getEmbedding(n_tokens)` 获取拼接结果按 hidden_dim 分割：token 585 处报错（长代码块超出有效范围）
3. **v3（当时采用）** — 回归逐 token 调用 + try/catch 兜底，`getEmbedding(i)` 对 i>416 的 token 返回零向量。**这是治标方案**，根因是 batchSize 太小导致 embedding 被覆盖（见 § 根因分析）。
4. **v4（当前）** — 不再依赖 try/catch 兜底。`_ensureModel()` 中设置 `batchSize = model.trainContextSize`（8192），确保单次 `llama_decode` 覆盖全部 token，`getEmbedding(1..N)` 全部可用。

#### 已知限制 → 根因分析（2026-05-15 深入调研）

**现象：** 向 context 喂入 4000 token 后，`getEmbedding(1)` ~ `getEmbedding(416)` 可正常返回，`getEmbedding(417)` 起全部失败。416 = 4000 - 7 × 512，恰好是最后一个 batch 的 token 数。

**根因：node-llama-cpp 的 JS 层 batching 与 llama.cpp 内部的 ubatch 循环冲突。**

llama.cpp 原生设计了两层 batching：
- `n_batch`：逻辑 batch 大小上限
- `n_ubatch`：物理 micro-batch 大小（`n_ubatch` < `n_batch`）
- 单次 `llama_decode()` 内部通过 `do-while` 循环将 `n_batch` 拆成多个 `n_ubatch`，embedding **跨 ubatch 累积**

```text-chart
llama.cpp 原生行为（n_batch=4000, n_ubatch=512）：
llama_decode(4000 tokens)
  ├─ ubatch 1: tokens 0..511    → embd.data[0..511*embd]      累积 ✓
  ├─ ubatch 2: tokens 512..1023 → embd.data[512..1023*embd]  累积 ✓
  ├─ ...
  └─ ubatch 8: tokens 3584..3999 → embd.data[3584..3999*embd] 累积 ✓
  n_outputs = 4000, output_ids[0..3999] 全部有效
  ✅ getEmbedding(1..4000) 全部可用
```

但 node-llama-cpp C++ addon 中**强行让 `n_ubatch = n_batch`**：

```cpp
// node-llama-cpp/llama/addon/AddonContext.cpp#L414-415
context_params.n_ubatch = context_params.n_batch;  // ← 消除了内部 ubatch 拆分
```

因此 node-llama-cpp 的 JS 层 `dispatchPendingBatch` 只能**多次独立调用** `llama_decode()`，每次调用都会**覆盖**前一次的 embedding 缓冲区：

```text-chart
node-llama-cpp 实际行为（batchSize=512）：
dispatchPendingBatch #1: llama_decode(512) → embd.data 有 512 个
                         ~promise 尚未 resolve（token 未处理完）~
dispatchPendingBatch #2: llama_decode(512) → embd.data 被覆盖！只剩这 512 个
                         ...
dispatchPendingBatch #8: llama_decode(416) → embd.data 只剩 416 个
                         ~此时 promise resolve，evaluate() 返回~
  n_outputs = 416（最后一次 decode 的）, output_ids 仅 0..415 有效
  ❌ getEmbedding(1..416)   可用（对应最后 batch 的 token）
  ❌ getEmbedding(417..4000) 全部失败（output_ids 未初始化 / 越界）
```

**关键代码路径：**
1. `LlamaEmbeddingContext.getEmbeddingFor()` → `sequence.evaluate()` → `_decodeTokens()` → `dispatchPendingBatch()`
2. `dispatchPendingBatch` 按 `_batchSize`（默认 512）拆分 token，每个 batch 一次 `decodeBatch()` → `llama_decode()`
3. `llama_decode()` 退出时，`n_outputs` = 本 batch 的 token 数，`output_ids` 只映射本 batch
4. 下一次 `llama_decode()` 调用 `output_reserve()` 重新初始化 `output_ids`，前一次的映射全部丢失

#### 修复方案

**方案 B（已采用 ✅）：增大 embedding context 的 batchSize**

在 `SemanticHighlightHighlighter._ensureModel()` 中将 `createEmbeddingContext` 的 `batchSize` 设为模型的 training context size（如 8192）：

```typescript
const embedContextSize = this._model.trainContextSize
this._embeddingContext = await this._model.createEmbeddingContext({
    batchSize: embedContextSize,  // 默认是 min(contextSize, 512)
})
```

效果：JS 层 `_batchSize` 变为 8192，`dispatchPendingBatch` 一次处理全部 token，单次 `llama_decode()` 内部 1 个 ubatch（因为 n_ubatch == n_batch == 8192），所有 embedding 在一个 buffer 里。

- ✅ 一行改动，无需重编译原生模块
- ✅ 对于非因果注意力（bidirectional）的 embedding 模型完全安全
- ⚠️ 内存：8192 tokens × 1024 dim × 4 bytes ≈ 33MB embedding buffer，完全可以接受

**方案 A（备选，更彻底）：修改 C++ addon，解耦 n_ubatch 和 n_batch**

```cpp
// AddonContext.cpp：不再强行让 n_ubatch = n_batch
if (options.Has("ubatchSize")) {
    context_params.n_ubatch = options.Get("ubatchSize").As<Napi::Number>().Uint32Value();
}
// 不再有: context_params.n_ubatch = context_params.n_batch;
```

然后在 JS 层传 `batchSize: 8192, ubatchSize: 512`，恢复 llama.cpp 原生行为。

- ✅ 最符合 llama.cpp 设计意图，后续所有 embedding 场景都受益
- ❌ 需要重新编译原生 addon

**方案 C（备选，最保守）：JS 层分 chunk 评估，逐 chunk 提取 embedding**

```js
// getEmbeddingsForTokens 改为逐 chunk 评估
for (let offset = 0; offset < resolvedInput.length; offset += chunkSize) {
    const chunk = resolvedInput.slice(offset, offset + chunkSize);
    await this._sequence.eraseContextTokenRanges([...]);
    const it = this._sequence.evaluate(chunk, { _noSampling: true });
    for await (const t of it) { break; }
    for (let i = 1; i <= chunk.length; i++) {
        allEmbeddings.push(Array.from(this._llamaContext._ctx.getEmbedding(i)));
    }
}
```

- ✅ 完全不需要动原生代码
- ❌ 4000 token 需 8 次 evaluate，每次都重建计算图，显著变慢

#### 历史记录

- 不是模型架构限制（BGE-M3 max position = 8192）
- 之前误判根因为"pooling_type=none 时 evaluate 只保留约前 416 个 token 的 embedding"，现更正为 JS 层多次 `llama_decode()` 导致的 embedding 覆盖问题

#### 双模式支持

- 新增 `highlighterMode` 配置：`"topk"`（默认，固定保留 K 行）/ `"threshold"`（保留 score ≥ 阈值的所有行）
- 新增 `highlighterThreshold` 配置（threshold 模式阈值，默认 0.5）
- `IHighlighter.highlight()` 新增 `options?: HighlightOptions` 参数支持运行时覆盖

### 2026-05-21（--debug-highlight 支持 + 后处理过滤 + 回退移除）

- ✅ **`--debug-highlight` 支持 `semantic-highlight` provider** — `SemanticHighlightHighlighter` 新增 `_buildDebugTokenView()` 方法
- **逐词着色** — 以 `/(\s+|[^\s]+)/g` 切分词语，取词中点字符位置反向比例映射到 embedding token 分数，词内颜色统一不割裂
- **后处理过滤** — 排除不连续纯符号行（`"""`, `)`, `}`, `---` 等 1-3 字符无 `[\p{L}\p{N}_]` 且前后无保留行的行），与 qrranker 一致
- **移除阈值回退** — threshold 模式下无行达标时不再回退到最优行，直接返回空
- **过滤空行** — `_formatOutput` 跳过纯空白行
- CLI `--debug-highlight` 描述、接口注释均已更新，不再限定 "qrranker only"

```bash
# 验证：逐词着色 + 后处理过滤
npx tsx src/cli.ts search "train method" --demo --debug-highlight
# 结果数从 16 → 14（过滤了 predict、clear_callback 等无关片段）
```

### 2026-05-16

- ✅ **batchSize 修复** — `_ensureModel()` 中 `createEmbeddingContext({ batchSize: model.trainContextSize })`，解决 embedding 只能覆盖 ~416 token 的问题
- ✅ **根因分析** — 确认问题出在 node-llama-cpp 的 JS 层多次 `llama_decode()` 与 C++ addon `n_ubatch = n_batch` 的冲突（见文档 § 根因分析）
- ✅ **单元测试** — 新增 `src/code-index/highlighters/__tests__/llamacpp.test.ts`，17 个纯逻辑测试，覆盖 `_findCodeOffset` / `_applyPruningHead` / `_formatOutput` / `_fallbackAllLines`（无需加载模型）
- 📄 文档更新 — 补全根因分析、三种修复方案（A/B/C）、修订记录

### 2026-05-14

- 完成架构设计和文档（本文档）
- 确认 GGUF 模型可用（`semantic-highlight-bilingual-v1-Q8_0.gguf`，已验证与原版 HF 一致）
- 确认 node-llama-cpp 补丁方案可行（`getEmbedding(i+1)` 循环获取 token 级 embedding）
- 提取 Pruning Head 权重（`pruning_head_weight.npy` [2, 1024]、`pruning_head_bias.npy` [2]）

## 修订记录

- 2026-05-21：`--debug-highlight` 支持 semantic-highlight + 后处理过滤 + 移除回退 + 过滤空行 + Unicode 字符检测
- 2026-05-16：根因分析 → batchSize 修复 → 单元测试
- 2026-05-15：阶段 1-7 实施，补丁迭代 v1→v3，双模式支持
- 2026-05-14：架构设计，文档初始化

## 总结

**核心思路：** GGUF Backbone（token 级 hidden states）+ 外置 Pruning Head（softmax 分类）→ token keep 概率 → 按行聚合 → Top-K → 格式化输出。

**关键技术点：**
1. `node-llama-cpp` 的 `getEmbedding(n)` 在 `pooling_type=none` 时返回第 `n-1` 个 token 的 embedding。需配合 `batchSize = trainContextSize` 确保单次 `llama_decode` 覆盖全部 token（否则 embedding 会被多次 decode 覆盖，详见 § 根因分析）
2. Pruning Head 是标准线性分类器（[1024] → [2] → softmax），推理开销极低
3. 纯 JS patch 方式避免 C++ 重编译，便于分发和协作

**预设模型路径：** `open_provence_demo/output/gguf/semantic-highlight-bilingual-v1-Q8_0.gguf`

**验证方式：** 修改 `demo/autodev-config.json`，加 `highlighterEnabled`/`highlighterGgufModelPath`/`highlighterTopK`，执行 `npx tsx src/cli.ts search xx --demo --json` 检查 `payload.highlightedText`
