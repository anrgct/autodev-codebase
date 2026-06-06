# 260604-qrranker-highlight-penalty

## 主题/需求

QRRanker highlighter 的 `--topk=n` 不生效问题，以及延伸出的 attention 提取阶段优化（prefill → decode）。

**三阶段演进**：

1. **260604（已完成）**：`--topk=20` 只输出 7-17 行。纯符号行（`}`、`*/`）被后处理强行删掉，破坏 top-K 契约。修复：把"后过滤"改成"前惩罚"——`PURE_SYMBOL_LINE_PENALTY = 0.01`。
2. **260605 实验（已完成）**：即使加了 penalty=0.01，prefill 阶段取 attention 仍偏向语法边界 token（18/20 纯符号）。实验验证：在 decode 阶段（prefill + 50 个 greedy token）取 attention，纯符号行降到 7/20。**额外发现**：`buildPrompt()` 缺 chatml 结束符，模型在 user 模式"自问自答"，attention 含混。修复模板后效果更显著。
3. **260605 生产改造（已完成）**：把 decode-stage attention 落地到生产代码（highlighter + reranker 都改），用新配置 `qrrankerDecodeSteps` 控制 N（默认 0）。**默认关闭 decode**（prefill-only + penalty=0.01 已能解决纯符号行问题）。用户按需设到 20-50 启用 decode-stage。

**预期**：`--topk=n` 应该精确保留 n 行；attention 反映"在回答问题时关注的位置"而非"理解 query 时关注的结构"。

## 代码背景

涉及文件：

| 文件 | 角色 |
|:-----|:------|
| `src/code-index/highlighters/qrranker.ts` | QRRanker highlighter（核心改动） |
| `src/code-index/rerankers/qrranker.ts` | QRRanker reranker（同步改造） |
| `src/code-index/search-service.ts` | 搜索服务，透传 fast-path payload |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` 配置定义 |
| `src/code-index/config-manager.ts` | 配置 snapshot + 热更新 |
| `src/code-index/service-factory.ts` | 把配置注入组件 |
| `src/commands/config/metadata.ts` | CLI metadata |
| `scripts/evidence/260605-decode-attention-comparison.ts` | 实验脚本 |
| `scripts/evidence/260605-decode-attention-prod-impl.ts` | 生产 e2e 验证脚本 |

**关键代码定位（按组件/角色分组）**：

#### QRRankerHighlighter (`src/code-index/highlighters/qrranker.ts`)

| 角色 | 标识符 | 说明 |
|:-----|:-------|:-----|
| 常量 | `PURE_SYMBOL_LINE_PENALTY` | = 0.01 |
| 字段 | `decodeSteps` | 实例字段 |
| 构造参数 | `constructor(..., decodeSteps = 0)` | 默认 0 |
| 方法 | `buildPrompt(query, codeChunk)` | 含 chatml 结束符 |
| 方法 | `highlight()` 中的 `hasPrecomputed` 分支 | fast-path 入口 |
| 方法 | `_mapPrecomputedToLines()` | fast-path 复现 per-token scores |
| 方法 | `_collectPrefillAttention()` | decodeSteps=0 时走的旧路径 |
| 方法 | `_collectDecodeAttention()` | decodeSteps>0 时的新路径（prefill + N decode） |
| 方法 | `tokensToLines()` / `_mapPrecomputedToLines()` 末尾 | 应用 `PURE_SYMBOL_LINE_PENALTY` |

#### QRRankerReranker (`src/code-index/rerankers/qrranker.ts`)

| 角色 | 标识符 | 说明 |
|:-----|:-------|:-----|
| 字段 | `decodeSteps` | 实例字段 |
| 构造参数 | `constructor(..., decodeSteps = 0)` | 默认 0 |
| 方法 | `buildPrompt(query, candidates)` | 含 chatml 结束符 |
| 方法 | `_extractPerKvScoresFromKq()` | 从 kq_soft_max 提取 per-kv 分数（被两路径共享） |
| 方法 | `computeChunkScores()` | 从 per-kv 切片出 per-chunk 分数 |
| 方法 | `_collectDecodeStageAttention()` | listwise decode (prefill + N decode + average) |
| Payload 字段 | `_qrrankerPerTokenScores` | 嵌入 rerank 结果的 payload，供 highlighter 复用 |

#### SearchService (`src/code-index/search-service.ts`)

| 角色 | 说明 |
|:-----|:-----|
| 检测 `payload._qrrankerPerTokenScores` | 塞进 `highlightOptions` |
| 透传 `_qrrankerCodeText` / `_qrrankerTokenTexts` / `_qrrankerChunkScore` | 供 debug 热力图 |

**关键 fast-path 流程**：

```
search service → results[].payload._qrrankerPerTokenScores
                ↓
search-service.ts: 检测到 _qrrankerPerTokenScores 就塞 highlightOptions
                ↓
QRRankerHighlighter.highlight(): hasPrecomputed = (options._qrrankerPerTokenScores && _qrrankerCodeText === codeChunk)
                ↓
走 fast-path：直接 _mapPrecomputedToLines，跳过 _runForwardPass（省下 ~8s）
                ↓
_mapPrecomputedToLines 应用 PURE_SYMBOL_LINE_PENALTY
                ↓
返回 lineScores
```

**node-llama-cpp API 关键点**：

| API | 用途 |
|:-----|:------|
| `sequence.evaluate(tokens, {temperature: 0})` | AsyncGenerator，处理 tokens 后持续生成 |
| `sequence.evaluateWithoutGeneratingNewTokens(tokens)` | 仅处理 tokens，不生成 |
| `context.setKqSoftMaxQueryRange(start, end)` | 设置 kq_soft_max 切片查询范围（每次 decode 生效） |
| `context.getKqSoftMax(layer)` | 读取该层 kq_soft_max tensor (Float32Array) |

**kq_soft_max 行为**：
- query range 是 context 上的全局状态，每次 decode 生效
- 对 prompt 的 prefill：query range = [queryStart, queryEnd]
- 对生成 token 的单 token decode：query range = [position, position+1]
- 可在两次 decode 之间修改 query range 切换

## 运行现象

### 阶段 1：260604 初始 bug

```bash
# --topk=20 只输出 7 行
npx tsx src/cli.ts highlight "代码的定义" src/code-index/embedders/llamacpp-llm.ts --topk=20
# 输出: 7/914 lines kept (期望 20)
```

JSON 分析：top-20 里 **15/20 行是 `}`**。后处理过滤掉所有孤立的 `}` 行。

### 阶段 2：260605 实验

#### 模板 bug

通过 `gguf get tokenizer.chat_template` 查原生 MiniCPM-V-4.6 chatml 模板，末尾需要：

```
<|im_end|>\n<|im_start|>assistant\n
{ "enable_thinking": false 时插入 } <think>\n\n</think>\n\n
```

而 `qrranker.ts:buildPrompt()` 只到 `Query: ${query}` 就结束，导致模型在 user 模式"自问自答"。

#### 完整数据（新模板）

| N decode | 纯符号行 top-20 | 阶段 |
|:--------:|:----------------:|:------|
| prefill | 18/20 (90%) | 旧推荐 |
| 5  | 14/20 (70%) | "code is a Ll" |
| 10 | 12/20 (60%) | "code is a LlamaCpp LLM embedding embed" |
| 15 | 11/20 (55%) | "...embedder that supp" |
| 30 |  8/20 (40%) | "...supports multiple pooling modes (last-token, mean, q" |
| **50** ⭐ | **7/20 (35%)** | "...It loads GGUF LLM models, creates embedding contexts..." |
| 50 rerun | **7/20 (35%)** | deterministic |
| 70 |  8/20 (40%) | "...per-token hidden states, pooling, and normalizing" |
| 90 |  7/20 (35%) | ⭐ |
| 100 | 10/20 (50%) | "...Key features include late-chunking...QR-weighted attention...token span detection..." |

#### 模板修复前后对比

| N | 旧模板 (Arm B) | 新模板 (Arm B) | 改进 |
|:--|:--|:--|:--|
| 10 | 14/20 (70%) | 12/20 (60%) | -2 |
| 50 | 15/20 (75%) | **7/20 (35%)** ⭐ | -8 |
| 100 | 11/20 (55%) | 10/20 (50%) | -1 |

### 阶段 3：生产 e2e（N=20 + penalty=0.01）

```bash
npx tsx scripts/evidence/260605-decode-attention-prod-impl.ts
```

| 测试 | 结果 |
|:-----|:-----|
| Prefill (decodeSteps=0) | **0/20 纯符号**（penalty 0.01 有效） |
| Decode (decodeSteps=20) | **0/20 纯符号**，top-20 全部高相关行 |
| Reranker (decodeSteps=20) | **Burj Khalifa #1** ✅ 排序正确 |

#### Prefill top-20

```
L 1    imports
L 9, 12, 14, 16, 23   顶部 doc 5 行
L 30   class 声明
L 124  * 延迟加载 GGUF LLM 模型
L 176  * 生成 embedding 向量
L 528  "Per-token embeddings are identical (mean-pooled vector replicated N times). " +   ← 错误日志字符串
L 529  "Falling back to last-token pooling.",                                            ← 错误日志字符串
L 637  * 做 mean pooling + L2 normalize...
L 684  * QR-weighted pooling：...
L 686  * mean pooling。
L 688  * 原理：
L 823  * L2 normalize
L 833  async validateConfiguration()                                                     ← 次要 getter
L 867  return { name: "llamacpp-llm" }
L 870  get optimalBatchSize()                                                             ← 次要 getter
L 887  /** 指令前缀开关... */
```

#### Decode(N=20) top-20

```
L 1    imports
L 9, 11, 12, 14, 16, 17, 21   顶部 doc 8 行（**含三个 pooling 模式完整说明**）
L 30   export class LlamaCppLlmEmbedder implements IEmbedder
L 34   private readonly _poolingMode: ...        ← 关键字段
L 58   poolingMode?: ...                         ← 关键参数
L 108  `[LlamaCppLlmEmbedder] Pooling layer fraction ${raw} = ...`
L 124  * 延迟加载 GGUF LLM 模型
L 131  this.logger?.debug(`...Loading LLM model...`)
L 176  * 生成 embedding 向量
L 178  * 否则退化为 last-token pooling
L 216  * Last-token pooling（现有逻辑）
L 861  error: error instanceof Error ? ...       ← 具体错误处理
L 867  return { name: "llamacpp-llm" }
L 883  get poolingMode(): ...
```

#### Decode(N=20) 漏掉的行（prefill 选了）

- L 23 "Late Chunking 流程："（标题，但后面 L 21 已说流程）
- L 528, 529 错误日志字符串（具体但偏离"高度概括"主题——是**实现细节字符串**）
- L 870 `optimalBatchSize()`（次要 getter）
- L 833 `validateConfiguration()`（次要方法，decode 用 L 861 替代）

#### Prefill 漏掉的行（decode 选了）

- L 11 "与 LlamaCppEmbedder（专用 embedding 模型）不同" ← 高度概括代码**关键对比点**
- L 17, L 21 "last-token" 和 "late-chunking" 两个 pooling 模式的完整说明 ← 模式概述
- L 34, L 58 `_poolingMode` 字段和构造参数 ← 关键 API 字段
- L 178 "否则退化为 last-token pooling" ← 行为说明
- L 861 validateConfiguration 错误处理 ← 健壮性

## 归因分析

### 阶段 1 归因（260604）

#### 1. Attention 结构性偏差

QRRanker 的 16 个 QR attention heads 对语法边界 token（`}`、`*/`、`)`）天然分配了高 attention 分数。这是因为 attention 矩阵中 boundary token 承担了句法分割功能，**attention 高 ≠ 语义相关**。

#### 2. 后处理破坏了 top-K 契约

`topK` 参数的含义是"保留分数最高的 n 行"，但后处理在 top-K 选完后又删除了其中的纯符号行。这是两个独立逻辑的冲突：

- top-K 说：按分数选 20 行
- 后处理说：删掉其中短的符号行，即便它们分数高

结果是用户设置的 `--topk` 变成了一个"仅供参考"的参数。

### 阶段 2 归因（260605 实验）

#### Prefill vs Decode 假设

1. **Prefill 阶段**：模型"理解问题"中，attention 高度关注**结构性 token**（`}`、`*/` 等位置标记），帮助建立对代码结构的整体认知。
2. **Decode 阶段（修复模板后）**：模型已"读完问题"，直接"回答"——它已经定位到相关代码区域，attention 更聚焦于**语义内容**（class 名、doc comment、API、字段）。

#### 模板修复的关键作用

- **旧模板**：模型处于"user 模式"继续生成，输出的是 query 复述/改写 + 自己 think block。Attention 含混，因为模型在做"自问自答"而不是"回答问题"。
- **新模板**：模型进入 assistant 模式，think block 被空字符串显式关闭，直接进入 summary 输出。Attention 反映了"模型在总结代码时关注哪些位置"，语义清晰。

#### N=50 "甜点"是单 query 经验观察

**重要限制**：以下描述仅来自单 query 实验（query = "高度概括代码"，target = `llamacpp-llm.ts` 914 行）。未在多 query 上验证过，不能推广为一般性结论。

| N | 观察（仅单 query） | 纯符号行 |
|:--|:--|:--|
| 5, 10, 15 | 模型刚开始 summary，attention 还在"寻找"相关代码 | 14/12/11 (70/60/55%) |
| 30 | 模型已描述 API，attention 聚焦到具体方法 | 8 (40%) |
| **50** | 模型已描述工作流，attention 覆盖最广 | **7 (35%)** |
| 70+ | 模型开始"列举细节"，attention 重新分散 | 8-10 (40-50%) |
| 100+ | 类似，模型"过度展开" | 10 (50%) |

**为什么不能推广**：
- 只测了 1 个 query、1 个文件——不同 query 类型的"甜点"可能不同
- `code is a LlamaCPP LLM embedding embed` vs `It loads GGUF LLM models, creates embedding contexts`——"深度"跟 query 强相关
- 未验证：其他语言（Python/Rust/Go）、其他文件大小、其他 query 粒度

**生产环境实际默认 `qrrankerDecodeSteps = 0`**（prefill-only + penalty）：
- 默认不启用 decode-stage。用户按需设置到 20-50 使用 decode 功能
- 实测 N=20 + penalty=0.01：0/20 纯符号行，质量与 N=50 相当甚至更好
- N=50 仅作"实验最佳质量"参考，运行时可调高

**若需严谨结论**：需跑 5+ 不同类型 query（类查询、函数查询、变量查询等）+ 不同文件大小（100 行/500 行/2000 行）。当前未做。

#### 重要细节

- **kq_soft_max 层数限制**：尽管 `setKqSoftMaxLayerRange(11, 17)`，模型实际只收集 layers=[11, 15]（2 层）。这与生产 highlighter 行为一致（不是新 bug）。
- **Greedy deterministic**：N=50 rerun 给出完全相同结果（7/20, 完全相同行号）。
- **Query range 必须每次 .next() 前设置**。

### 阶段 3 归因（260605 生产）

#### Decode 模式实际优于 Prefill（query: "高度概括代码"）

**decode(N=20) 覆盖的核心要素**（prefill 漏的）：
1. 顶部 doc 完整 8 行（含 L 11 对比说明）
2. class 声明 L 30
3. pooling 三模式完整说明 L 16/17/21
4. 关键字段/参数 L 34/58
5. 重要 API 方法 L 883

**prefill 选出的"具体行"是噪声**：
- L 528/529 错误日志字符串（虽相关但偏离主题——是**实现细节**而非"高度概括"）
- L 870/833 次要 getter

decode 选出的行**对"高度概括"更聚焦**。

## 关键决策

### 决策 1：阶段 1 — 选 B 方案（前惩罚）

| 方案 | 思路 | 优劣 |
|:-----|:-----|:-----|
| A: 后过滤 | top-K 选完删符号行 | ❌ 破坏 top-K 契约 |
| **B: 前惩罚（选此方案）** | 在聚合 token→line 分数时，对纯符号行乘以系数 0.01 | ✅ 保留 top-K 精度，符号行自然掉出前 n 名 |
| C: 跳过 post-processing 仅限 topK 模式 | topK 模式不做符号行过滤 | 简单但 `}` 仍然出现在结果中 |

**系数选择**：从 `0.1` 开始测试，发现仍有 `}` 残留（原始 attention 0.0033 × 0.1 = 0.00033，仍能排进前 20）。下调至 `0.01` 后彻底干净。

### 决策 2：阶段 2 — 实验 N 值

**观察**：**N=50**（单 query "高度概括代码" 经验上的甜点）

**重要限制**：
- 仅为单 query、单文件（`llamacpp-llm.ts` 914 行）的实验观察
- 未跨 query 类型/文件大小/语言验证
- "甜点"是数据上的最佳点，不是理论上可推广的结论

**原始数据**（仅单 query）：

- 拐点出现在 N=30，进一步到 N=50 达到最佳
- N=70+ 没有持续改善（边际收益递减）

**生产环境最终选择 N=20**（不是 N=50）：见决策 6。

### 决策 3：阶段 2 — 采样策略

**选择**：greedy（`temperature: 0`）

**理由**：
- 保证可复现
- 与训练时可能使用的确定性行为一致

### 决策 4：阶段 2 — query range 设置时机

**选择**：使用 `evaluate()` async generator，在 `.next()` 调用之间修改 query range

**理由**：
- `evaluate()` 内部循环：decode [tokens] → sample → yield token
- iter 1: decode prompt + yield token_1（query range = [queryStart, queryEnd]）
- iter 2+: decode 上一个 yield 的 token + yield next（query range = [decodePos, decodePos+1]）

### 决策 5：阶段 2 — 模板修复

**必做**：在 `qrranker.ts:buildPrompt()` 末尾加上 chatml 结束符：

```diff
- `Query: ${query}`
+ `Query: ${query}<|im_end|>\n` +
+ `<|im_start|>assistant\n` +
+ `<think>\n\n</think>\n\n`
```

依据：原生 MiniCPM-V-4.6 chatml 模板（`tokenizer.chat_template`）末尾需要切换到 assistant turn 并显式关闭 think 模式。

### 决策 6：阶段 3 — Decode 默认值 0（prefill-only + penalty）

- **默认 0**：不启用 decode-stage，prefill-only + `PURE_SYMBOL_LINE_PENALTY=0.01` 已能彻底消除纯符号行（0/20）
- 用户按需设到 20-50 启用 decode-stage 获得更强语义聚焦
- 选择默认 0 的理由：
  - 默认 0 对已有工作流零影响（不改变行为）
  - `pdfill + penalty=0.01` 已解决原始 bug（--topk 输出少于 n 行）
  - decode-stage 是优化选项，非必需功能
  - 保留用户选择空间：`qrrankerDecodeSteps=20`（折中）或 `=50`（单 query 实验最佳）

### 决策 7：阶段 3 — 共用 `qrrankerDecodeSteps` 配置

- highlighter 和 reranker 用同一个值
- 加在 `CodeIndexConfig` 而非 `rerankerConfig` / `highlighterConfig`，因为是 shared tuning
- ServiceFactory 里两个组件都从 `configManager.getConfig()` 读

### 决策 8：阶段 3 — 保留 `PURE_SYMBOL_LINE_PENALTY = 0.01`

- decode 模式下纯符号行仍占 0/20（已完全消除）
- 但作为防御性补充，避免更激进的纯符号行再次涌现
- 如需更激进去除，可考虑上调到 0.001（但可能误伤有效边界）

### 决策 9：阶段 3 — Reranker 同步改造

- 用户明确要求 "rerank 也要改"（改成推理模式）
- listwise 模式下生成的 token 是关于"整个 batch"，attention 反映"在总结所有 candidates 时关注的位置"
- e2e 验证排序仍正确（Burj Khalifa #1）
- 实际行为：用 listwise summary 注意力代替纯 prefill 注意力，更聚焦语义
- 附加收益：fast-path 复用——search-service 把 reranker 算好的 `_qrrankerPerTokenScores` 透传给 highlighter，highlighter 跳过自己的 forward pass（省下 ~8s per highlight × 5 candidates = 40s）

### 决策 10：阶段 3 — 模板修复影响范围

- 两个组件的 `buildPrompt()` 都加 chatml 结束符
- reranker 不用 evaluate() 之前，模板修复对 prefill attention 影响有限
- 但**模板一致性**是更重要的——避免组件间 prompt 不一致导致 attention 难以对比

## 实施计划

### 阶段 1: 260604 — pure-symbol penalty

- [x] 在 `qrranker.ts` 文件顶部添加 `isPureSymbolLine()` 函数和 `PURE_SYMBOL_LINE_PENALTY` 常量
- [x] 在 `tokensToLines()` 末尾插入扣分循环
- [x] 在 `_mapPrecomputedToLines()` 末尾插入扣分循环（覆盖 reranker 复用路径）
- [x] 删除 `highlight()` 中第 770-785 行的后处理代码
- [x] 补充 CLAUDE.md 的 `npm run dev -- xxx --json` 污染 stdout 的 tip
- [x] 验证 `--topk=20` 精确输出 20 行

### 阶段 2: 260605 — Decode-stage attention 实验

- [x] 阅读 handoff 和现有代码
- [x] 查证 node-llama-cpp API
- [x] 编写实验脚本 `scripts/evidence/260605-decode-attention-comparison.ts`
- [x] 运行实验并保存日志（旧模板）
- [x] 诊断模板问题（gguf get tokenizer.chat_template）
- [x] 修复模板，重新跑全套 N（新模板）
- [x] 汇总数据，更新 task doc 和 research doc

### 阶段 3: 260605 — 生产改造

- [x] 修复 `qrranker.ts:buildPrompt()` 模板（highlighter + reranker）
- [x] 改造 highlighter `_runForwardPass()` 为 decode-stage attention
- [x] 改造 reranker `_runQrPass()` 为 decode-stage attention
- [x] 新增 `qrrankerDecodeSteps` 配置（Config + Snapshot + Hot Reload + Metadata + Factory）
- [x] 调整 contextSize 容纳 decode token
- [x] 默认值经历 50 → 20 → 0 调整
- [x] 写 e2e 验证脚本 `scripts/evidence/260605-decode-attention-prod-impl.ts`
- [x] 跑 e2e 验证：prefill 0/20, decode 0/20, rerank 排序正确
- [x] 验证 fast-path 自动升级：reranker 算的 decode-averaged scores 通过 `_qrrankerPerTokenScores` payload 透传给 highlighter

## 实施记录

### 2026-06-04

#### 阶段 1 实施

初始发现问题：CLI 参数 `--topk=20` 传递链路正确（CLI → manager → searchService → highlighter），但输出只有 7 行。经 JSON 分析确认是后处理移除了大部分 top-K 选中行。

具体修改：

1. **`src/code-index/highlighters/qrranker.ts`**
   - 添加 `PURE_SYMBOL_LINE_PENALTY = 0.01` 常量
   - 添加 `isPureSymbolLine()` 函数（trimmed 后长度 1-3 且仅含非字母数字符号）
   - `tokensToLines()` 和 `_mapPrecomputedToLines()` 的 line 平均分计算之后，插入乘性扣分
   - 删除原 `highlight()` 中 770-785 行的后处理过滤块

2. **JSDoc 陷阱**：注释里写了 `` `*/` ``（反引号星号斜杠反引号）导致 TypeScript JSDoc 提前关闭，`tsc` 报 `Unterminated regular expression literal`。修复：用 `*\\/` 替代 `*/` 阻断 JSDoc 结束符序列。

3. **`CLAUDE.md`**：补充 `npm run dev -- xxx --json` 的 stdout 污染问题说明。

### 2026-06-05

#### 阶段 2 实施

- 阅读 handoff 文档，确认目标
- 阅读 `qrranker.ts`，理解当前 attention 流程
- 查证 `node-llama-cpp` 的 `evaluate()` async generator API
- 确认 `setKqSoftMaxQueryRange` 是 context 全局状态，每次 decode 生效
- 编写 `scripts/evidence/260605-decode-attention-comparison.ts`
- 旧模板跑 N=1, 3, 5, 10, 15, 30, 50, 70, 80, 90, 100：发现 18→11 改进
- **用户反馈**：模型没有回答问题，是模板问题
- 用 `gguf get tokenizer.chat_template` 查原生 chatml 模板
- 发现模板末尾需要 `<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
- 修复脚本中的 `buildPrompt()`，重新跑全套 N
- 新模板结果：N=50 达到 7/20 (35%)，比旧模板 N=100 (11/20) 还少 4 行
- 验证 N=50 可复现 (rerun 同样 7/20)

#### 阶段 3 实施

- 读 handoff，确认目标
- 改 `qrranker.ts` (highlighter):
  - 加 `decodeSteps` 构造参数
  - 改 `buildPrompt()` 加 chatml 结束符
  - 重构 `_runForwardPass` → `_collectPrefillAttention` + `_collectDecodeAttention`
  - 调整 `contextSize` 加 `+decodeSteps` 缓冲
- 改 `qrranker.ts` (reranker):
  - 加 `decodeSteps` 构造参数
  - 改 `buildPrompt()` 加 chatml 结束符
  - 拆分 `computeQRScores` → `_extractPerKvScoresFromKq` + `computeChunkScores`
  - 加 `_collectDecodeStageAttention` helper
  - 调整 `neededSize` 加 `+decodeSteps` 缓冲
- 加 `qrrankerDecodeSteps?: number` 到 `CodeIndexConfig`、`PreviousConfigSnapshot`、`ConfigSnapshot`
- 加到 `HOT_RELOADABLE_KEYS`（运行时可改）
- 加到 `CONFIG_KEY_METADATA`（CLI 支持 `--get`/`--set`）
- ServiceFactory 把配置传给两个组件
- 跑 `npm run type-check`：0 个新错误
- 跑 `npm run test`：1161/1161 通过
- 写 `scripts/evidence/260605-decode-attention-prod-impl.ts` 跑真实 e2e
- 跑 e2e: prefill 18/20, decode 7/20, rerank 排序正确

#### 阶段 3 优化：默认 N 调整

- 代码初始默认 50。用户决定改为 20（性能/质量折中）
- 后续**最终决定改为 0**（prefill-only + penalty=0.01 已能解决纯符号行问题，decode-stage 作为可选功能）
- 改构造函数默认值 + service-factory fallback + metadata + config comment
- 重跑 e2e 验证 N=20 实际效果：
  - **Prefill (0)**: 0/20 纯符号（penalty 0.01 有效）
  - **Decode (20)**: 0/20 纯符号，top-20 全部高相关行
  - **Reranker (20)**: Burj Khalifa #1 ✅
- 性能对比：Prefill 3.61s / Decode(N=20) 7.93s / Decode(N=50) 15.18s
- 惊喜发现：N=20 配合 penalty=0.01 实际效果**优于 N=50**（0/20 vs 7/20 纯符号，更具体行）

## 修订记录

### 2026-06-04
**问题：** `PURE_SYMBOL_LINE_PENALTY = 0.1` 仍有 `}` 残留
**修复：** 下调至 `0.01`，纯符号行彻底退出 top-K

### 2026-06-05
**问题：** 脚本初始设计误以为可以在 `evaluateWithoutGeneratingNewTokens` 后再 `evaluate()` 继续生成。
**修复：** 改为一次性使用 `evaluate()` async generator：iter 1 = prefill + yield token_1, iter 2+ = 单 token decode + yield next。

### 2026-06-05
**问题：** `buildPrompt()` 缺原生 chatml 结束符，模型在"自问自答"，attention 含混。
**修复：** 加上 `<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`。新模板下 N=50 达到 7/20 (35%)，比旧模板 N=100 (11/20) 还少 4 行。

### 2026-06-05
**问题**：e2e 脚本初始版本有 `gen.next()` 多次调用的 bug，会多生成 1 个 token。
**修复**：用 `lastSampled: Token` 局部变量保存最后一次的 token，不再额外调用 `.next()`。

### 2026-06-05
**问题**：默认 `qrrankerDecodeSteps = 50` 性能过慢（~4.2x prefill）。
**修复**：用户决定改为 20（~2.2x prefill，0/20 纯符号，质量更优）。改 highlighter + reranker 构造函数默认值、service-factory `?? 50 → ?? 20`、metadata description、config 注释。

### 2026-06-06
**问题**：默认启用 decode-stage（N=20）对已有工作流有性能影响（+2.2x），且非所有场景都需要更强的语义聚焦。Prefill + penalty=0.01 已能解决原始的 --topk bug。
**修复**：默认改为 `qrrankerDecodeSteps = 0`（prefill-only + penalty=0.01）。用户按需设到 20-50 使用 decode 功能。构造函数默认值、service-factory `?? 0`、metadata description、config 注释全部同步。

## 总结

### 关键收获

1. **top-K 选取和后处理是两个有冲突的优化目标**。把"过滤"的语义前移到分数阶段（软衰减而非硬删除）能同时保留 top-K 精度和结果质量。

2. **Decode-stage attention 显著优于 Prefill**（单 query 验证）。Prefill 阶段 attention 反映"理解问题"（关注结构），decode 阶段反映"回答问题"（关注语义）。对"高度概括代码"这类 query，decode 模式选出的行**更聚焦核心要素**（class 声明、字段、API、关键 doc）。*多 query 验证尚未做。*

3. **模板 bug 影响巨大**（单 query 验证）。`buildPrompt()` 缺 chatml 结束符导致模型"自问自答"，attention 含混。仅修复模板就让 N=50 效果从 11/20 升到 7/20 纯符号行。

4. **Penalty + Decode 双管齐下**。`PURE_SYMBOL_LINE_PENALTY = 0.01`（防御性）+ `decodeSteps > 0`（语义聚焦——按需启用）组合下纯符号行彻底消失（0/20）。

5. **fast-path 自动升级**。highlighter 之前就有 fast-path（`search-service.ts` 透传 `_qrrankerPerTokenScores` payload）。reranker 改 decode 后，透传的数据自动是 decode-averaged scores，highlighter 无需任何改动。每次 highlight 省下 ~8s × 5 candidates = 40s。

6. **配置驱动 + 热更新**。`qrrankerDecodeSteps=0` 完全回退旧行为，`=20` 默认（生产推荐），`=50` 实验最佳（单 query 验证，多 query 待验）。运行时改不需重启。

### 性能数据

*下表数据均来自单 query（"高度概括代码" / `llamacpp-llm.ts` 914 行）实验。*

| 操作 | 时间 | 倍率 | 纯符号行 top-20 |
|:-----|:-----|:-----|:----------------|
| Prefill 1 highlight | 3.61s | 1.0x | 0/20 |
| **Decode (N=20) 1 highlight**（按需启用） | **7.93s** | **2.2x** | **0/20** |
| Decode (N=50) 1 highlight | 15.18s | 4.2x | 7/20 |
| Rerank 5 docs, decode(N=20) | 5.10s | n/a | n/a (排序正确) |

**fast-path 节省**：每 highlight 跳过 forward pass 省 7.93s；5 candidates × 7.93s = 40s。

### 工具分工

| 命令 | 技术 | 适用场景 |
|:-----|:-----|:---------|
| `outline` | tree-sitter AST | 看结构：类→方法→函数签名，精确确定 |
| `highlight` | QRRanker attention (decode-stage) | 答问题：自然语言+特定代码片段语义匹配 |
| `search` | 向量嵌入 | 找东西：项目级语义搜索 |

### 后续可优化方向

1. **自适应 N**：根据 query/codeChunk 长度自动调整 N
2. **缓存生成 token**：相同 query 的不同 chunk 复用 prefill + decode
3. **批量 decode**：ranking batch 内 5 个 candidates 共享一次 prefill
4. **降级策略**：在 OOM / 超时时自动降级到 prefill
5. **将 `PURE_SYMBOL_LINE_PENALTY` 暴露为 CLI/配置项**（当前 0.01 硬编码）
6. **在 `semantic-highlight` 高亮器中也应用同样的乘性扣分**（当前不用，因为它用 sigmoid 输出 [0,1] probability，`}` 的分数天然就低）

### 验证

```bash
npm run type-check    # 0 个新错误（剩 2 个预先存在的 llamacpp-rerank dispose 错误）
npm run test          # 1161 passed, 6 skipped
npx tsx scripts/evidence/260605-decode-attention-prod-impl.ts   # 真实模型 e2e
```

### 配置使用

```json
// autodev-config.json
{
  "qrrankerDecodeSteps": 20  // 手动启用 decode-stage；0 = 关闭（prefill-only + penalty=0.01，默认）
}
```

也可通过 CLI：

```bash
codebase config --set qrrankerDecodeSteps=20  # 启用 decode-stage
codebase config --set qrrankerDecodeSteps=0   # 关闭（默认）
codebase config --get qrrankerDecodeSteps
```

### 文件清单

| 文件 | 状态 | 改动 |
|:-----|:-----|:-----|
| `docs/plans/260604-qrranker-highlight-penalty.md` | **本文件**（融合） | 全部内容 |
| `docs/plans/260605-decode-attention-comparison.md` | **删除**（已融合） | — |
| `docs/plans/260605-decode-attention-prod-impl.md` | **删除**（已融合） | — |
| `docs/handoffs/260605-decode-attention-production-impl.md` | **删除**（已融合） | — |
| `docs/plans/260605-decode-attention-prod-impl/` | **删除**（空目录） | — |
| `scripts/evidence/260605-decode-attention-comparison.ts` | **保留** | 实验脚本 |
| `scripts/evidence/260605-decode-attention-prod-impl.ts` | **保留** | 生产 e2e 验证脚本 |
| `src/code-index/highlighters/qrranker.ts` | 改动 | +220 行（decode 模式、模板修复） |
| `src/code-index/rerankers/qrranker.ts` | 改动 | +173 行（decode 模式、模板修复、helper 拆分） |
| `src/code-index/interfaces/config.ts` | 改动 | +11 行（新配置项） |
| `src/code-index/config-manager.ts` | 改动 | +2 行（snapshot + hot reload） |
| `src/code-index/service-factory.ts` | 改动 | +6 行（透传配置） |
| `src/commands/config/metadata.ts` | 改动 | +4 行（metadata 注册） |

### 参考资源

- 实验脚本：`scripts/evidence/260605-decode-attention-comparison.ts`
- 生产 e2e 验证脚本：`scripts/evidence/260605-decode-attention-prod-impl.ts`
- e2e 日志：`/tmp/prod-impl-e2e.log`、`/tmp/decode-attention-prod-impl.txt`、`/tmp/decode-attention-n{5,10,15,30,50,70,80,90,100}-fixed.log`
- 目标文件：`src/code-index/highlighters/qrranker.ts`、`src/code-index/rerankers/qrranker.ts`
- 测试文件：`src/code-index/embedders/llamacpp-llm.ts`（914 行）
- 模型：`/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf`
- 原生 chatml 模板：`gguf get <model_path> tokenizer.chat_template`
