# 260524-jina-v5-late-chunking-noop

## 主题/需求

用户在 jina-v5 模型上使用 `embedderPoolingMode: "late-chunking"`，但切换到其他 pooling 模式后效果完全相同（10/12 命中，MRR ~0.58-0.60），怀疑 late-chunking 没有真正生效。

**目标：** 排查 late-chunking 在 jina-v5 上静默失效的根因，给出修复方案。

## 代码背景

### 关键文件

| 文件 | 用途 |
|------|------|
| `src/code-index/embedders/llamacpp-llm.ts` | `LlamaCppLlmEmbedder`：late-chunking 核心算法，调用 `getEmbeddingsForTokens()` |
| `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js` | `getEmbeddingsForTokens()` 实现：逐个 token 调用 `llama_get_embeddings_ith()` |
| `node_modules/node-llama-cpp/llama/llama.cpp/include/llama.h` | `llama_get_embeddings_ith()` API 定义：pooling_type != NONE 时行为不同 |
| `demo/autodev-config.json` | 用户配置：`embedderProvider: "llamacpp-llm"`，GGUF 路径指向 jina-v5 |
| `scripts/evidence/260525-evidence-jina-v5-pooling.ts` | 证据脚本（v1）：5 项测试验证 per-token embedding 全部相同 |
| `scripts/evidence/260525-evidence-jina-v5-none-vs-last.ts` | 证据脚本（v2）：NONE vs LAST 三变体余弦对比 + inter-chunk 判别力 |
| `scripts/evidence/260525-evidence-embedding-failure.ts` | 证据脚本（v3）：全链路 embedding 差异分析（⚠️ 该脚本有 CLS off-by-one bug——multi-chunk 的 span 起始位置未跳过 CLS，
结论中的"上下文导致 embedding 差异"被夸大） |
| `scripts/evidence/260525-evidence-reproduce-bug.sh` | 全链路复现：两遍 eval（LAST gguf → index → eval \| NONE gguf → index → eval） |
| `scripts/evidence/260525-verify-late-chunking.ts` | 验证脚本：BPE span 修复后，对比 single-chunk vs late-chunking embedding |
| `scripts/evidence/260525-debug-token-count.ts` | 调试脚本：验证 token 拼接一致性 + batchSize 有效性 |

### 数据流

```
config.embedderProvider === "llamacpp-llm"
  → LlamaCppLlmEmbedder (llamacpp-llm.ts)
    → _lateChunkingCreateEmbeddings()
      → embedContext.getEmbeddingsForTokens(concatText)
        → node-llama-cpp: LlamaEmbeddingContext.getEmbeddingsForTokens()
          → for i in 1..nTokens:
              llama_get_embeddings_ith(ctx, i)    ← 关键调用！
```

### llama.cpp 的逐 token embedding 行为

```c
// llama.h:994-999
// llama_get_embeddings_ith() 返回逐 token hidden states 的条件：
//   1. pooling_type == LLAMA_POOLING_TYPE_NONE，或
//   2. 模型是因果生成模型（generative model）
//
// 否则对所有 i 返回相同的池化向量（mean/cls）
```

### jina-v5 的 GGUF 元数据

| 属性 | 值 |
|------|-----|
| `general.architecture` | `eurobert`（BERT 风格双向编码器） |
| `eurobert.pooling_type` | `3` (`LLAMA_POOLING_TYPE_LAST`) — 取最后一个 token 做池化 |
| `totalLayers` | 13（含 1 个 output 层） |
| Embedding 维度 | 768 |

**llama.cpp 枚举定义（`llama.h:169-178`）：**

```c
enum llama_pooling_type {
    LLAMA_POOLING_TYPE_UNSPECIFIED = -1,
    LLAMA_POOLING_TYPE_NONE = 0,   // 只有这个是逐 token！
    LLAMA_POOLING_TYPE_MEAN = 1,
    LLAMA_POOLING_TYPE_CLS  = 2,
    LLAMA_POOLING_TYPE_LAST = 3,   // jina-v5 实际值
    LLAMA_POOLING_TYPE_RANK = 4,
};
```

**`llama-graph.cpp:2742-2763` — `build_pooling()` 计算图构建：**

```cpp
switch (pooling_type) {
    case LLAMA_POOLING_TYPE_NONE:
        cur = inp;   // 直接透传 [n_tokens, n_embd]，保持逐 token hidden states
        break;
    case LLAMA_POOLING_TYPE_LAST:   // jina-v5 走这个分支
        ggml_tensor * inp_cls = build_inp_cls();  // 选出最后 token 位置
        cur = ggml_get_rows(ctx0, inp, inp_cls);   // 只取最后一行！输出 [n_embd, 1]
        break;
    // MEAN / CLS 同理——都压缩成一个向量
}
```

**`llama-context.cpp:1757-1794` — `decode()` 提取逻辑：**

```cpp
case LLAMA_POOLING_TYPE_NONE:
    // 提取 token embeddings: n_outputs * n_embd_out 个 float（每个 token 独立）
    break;
case LLAMA_POOLING_TYPE_LAST:  // jina-v5
    // 提取序列 embeddings: 只有 n_embd_out 个 float（所有 token 共享）
    break;
```

## 关键决策

### 决策 1：根因 — pooling_type ≠ NONE 导致 per-token embedding 全部相同

**验证实验（证据脚本 `scripts/evidence/260525-evidence-jina-v5-pooling.ts`）：**

```bash
npx tsx scripts/evidence/260525-evidence-jina-v5-pooling.ts
```

5 项测试结果：

| 测试 | 内容 | 结果 |
|:---:|------|------|
| 1 | `getEmbeddingFor` 标准池化 | 768 维向量 |
| 2 | `getEmbeddingsForTokens` 逐 token | 21 个 token **全部相同** |
| 3 | token 向量 vs 池化向量 | **完全相同**（逐元素差 < 1e-6） |
| 4 | 模拟 late-chunking per-chunk last-token | 3 个 chunk 两两 **cos=1.000000** |
| 5 | 对照：独立 last-token vs late-chunked | cos ∈ [0.58, 0.77]（池化文本范围不同） |

**测试 5 的微妙发现：** late-chunking 和独立 last-token 对 jina-v5 **会产生不同向量**（因为池化的文本范围不同：全拼接 vs 单 chunk），但 late-chunking **内部所有 chunk 共享同一个全拼接池化向量**——与"每个 chunk 从跨 chunk 上下文中获得独特语义"的设计目标完全背离。这解释了为什么 eval 指标相近（跨文件检索仍有效），但 chunk 级别区分度为零。

**结论：** `getEmbeddingsForTokens()` 对 jina-v5 返回的是 last-token 池化向量复制 N 次，不是真正的逐 token hidden states。这导致 late-chunking 中按 chunk 边界取任何 token 位置都得到同一个 embedding，与 `last-token` / `mean` / `qr-weighted` 模式效果完全一致。

**ASCII 图解：**

```
拼接: "chunk1\n\nchunk2\n\nchunk3"
        ↓ tokenize
[t1, t2, t3, SEP, t4, t5, SEP, t6, t7]
        ↓ getEmbeddingsForTokens (jina-v5, pooling_type=LAST)
[e,  e,  e,  e,   e,  e,  e,   e,  e]     ← 全部相同!（last-token 池化向量）
        ↓ per-chunk last-token
chunk1 → e, chunk2 → e, chunk3 → e           ← 三个 chunk embedding 一模一样
        ↓ L2 normalize
cos(chunk1, chunk2) ≈ 1.0                    ← 完全无法区分


对比因果 LLM (pooling_type=NONE):
[e1, e2, e3, e4,  e5, e6, e7,  e8, e9]     ← 每个 token 不同
        ↓ per-chunk last-token
chunk1 → e3, chunk2 → e6, chunk3 → e9        ← 三个 chunk embedding 各不相同
```

### 坑 2：BPE 边界效应 — `_computeTokenSpans` 假设加法性

**症状：** 即使 CLS 偏移修复后，late-chunking 索引静默完成，但非首个 chunk 的 embedding 取到错误位置，搜索效果 0/12。

**根因：** `_computeTokenSpans` 假设 `tokenize(A) + tokenize(sep) + tokenize(B) = tokenize(A+sep+B)`。但 BPE 预分词器在 chunk 边界处会合并相邻 token：

```
单独 tokenize: [token_RANK] + [token_","] + [token_\n] + [token_\n]
拼接后 tokenize: [token_RANK] + [token_",\n"] + [token_\n]
                                        ^^^^^^ 少1个token！
```

每个 chunk 边界累积 -1 偏移。model.py 的 38 个 chunks → 累积偏移 ~-41 tokens。
`Math.min(end-1, perTokenEmbs.length-1)` 静默钳制越界，但返回的 embedding
是错误位置的（非最后一个 chunk 的 last-token）。

**修复：** 改用**逐步前缀 tokenize** 计算 span。每次 tokenize 完整的渐进前缀
（包含 BPE 边界合并），相减得 span：

```typescript
// 旧：计数加法（假设加法性 → 累积偏移）
const spans = this._computeTokenSpans(prefixLen, sepLen, chunkTokenSeqs)

// 新：逐步前缀（每个前缀包含 BPE 边界效应 → 相减消除偏移）
const spans: { start: number; end: number }[] = []
let prevEnd = prefixLen
for (let i = 0; i < texts.length; i++) {
  const prefix = texts.slice(0, i + 1).join(separator)
  const currEnd = model.tokenize(prefix).length
  spans.push({ start: prevEnd, end: currEnd })
  prevEnd = currEnd
}
```

### 坑 3：`createEmbeddingContext` 默认 batchSize 太小 → 95% token embedding 为零向量

**症状：** 所有 3 个修复后，late-chunking 产生有效 embedding，但搜索效果 2/12。

**根因：** `getEmbeddingsForTokens()` 内部调用 `llama_get_embeddings_ith(i)`，
该函数要求 `batch.logits[i] === true`。**默认 batchSize 只有 512**，超过
~112 个 token 后 `batch.logits[i]` 未设置，`getEmbeddingsForTokens` 的
catch 块静默填充**零向量**。

```
默认 {}:                              batchSize=8192:
  embeddings: 2161                      embeddings: 2161
  零向量: 2048/2161 （95%！）           零向量: 0/2161 ✅
  最后有效位置: 112                       最后有效位置: 2160
```

对于 BERT 模型的 NONE pooling，必须显式传递 `batchSize`，否则后排 token
全为零向量。

**修复：** 所有 5 处 `createEmbeddingContext` 调用加入 `batchSize:`

```typescript
const embedContext = await model.createEmbeddingContext({
  embdLayer: this._resolveLayer(model),
  batchSize: LlamaCppLlmEmbedder._EMBEDDING_BATCH_SIZE, // =8192
} as any)
```

### 坑 4（改善）：Mean pool 缓解上下文不匹配

将 `_singlePassLateChunking` 的 pooling 从 `last-token` 改为 `mean` 后，
检索效果显著提升——因为每个 token 的邻居噪声被平均掉，后续 chunk 的
注意力拉力也被分散。

```
同 chunk single vs late-chunking:
          last-token pool    mean pool
chunk1:     0.34              0.44
chunk2:     0.21              0.39
chunk3:     0.94              0.44
```

Mean pool 让所有 chunk 更一致（~0.44），last-token 的极端值被平均掉。

**原因：** last-token 模式下，chunk 的最后一个 token 被后续 chunk 的
注意力"收割"最严重（因为它紧邻后续内容）。Mean pool 平摊了这种影响。

**当前效果：** late-chunking + mean pool + NONE GGUF → **7/12 recall, MRR 0.19**
仍然低于 `last-token` 模式（10/12, MRR 0.60），但已经具备实用性。

## 实施计划

### 步骤 1：运行时检测 + 自动降级 ✅

在 `LlamaCppLlmEmbedder` 添加逐 token embedding 有效性检测：

- 首次调用 `getEmbeddingsForTokens` 时，检查前两个 token 的 embedding 是否相同
- 若相同，打印明确警告并抛出 Error，触发 `_lateChunkingCreateEmbeddings` 的 catch 块自动降级到 `last-token` 模式
- 检测逻辑实现为 `_checkPerTokenUniqueness()` 方法
- 用 `_lateChunkingNoopDetected` 标志缓存检测结果

```
╔══════════════════════════════════════════════════════════════════╗
║  ⚠️  Late-chunking 检测到所有 token hidden state 完全相同       ║
╠══════════════════════════════════════════════════════════════════╣
║  根因: GGUF 模型的 pooling_type 不是 NONE                      ║
║  getEmbeddingsForTokens 返回的是池化向量而非逐 token           ║
║  hidden states (BERT 嵌入模型的默认行为)。                     ║
║                                                               ║
║  Late-chunking 将自动退化为 last-token 池化模式。              ║
║  要启用真正的 late-chunking，请将 GGUF 切换为 NONE 版本:      ║
║                                                               ║
║    v5-nano-retrieval-Q8_0-pooling-NONE.gguf                    ║
║                                                               ║
║  注意: NONE 模式下 getEmbeddingFor() 返回逐 token outputs，   ║
║        应用层需自行 pool（例如取 last-token 或 mean pool）。   ║
╚══════════════════════════════════════════════════════════════════╝
```

### 步骤 2：创建双 GGUF 文件（LAST + NONE）✅

**不再修改同一个文件来回切换。** 最终方案是创建两个独立的 GGUF 文件：

| 文件 | pooling_type | 用途 |
|------|:---:|------|
| `v5-nano-retrieval-Q8_0-pooling-LAST.gguf` | LAST (3) | 默认生产环境：last-token / mean / qr-weighted |
| `v5-nano-retrieval-Q8_0-pooling-NONE.gguf` | NONE (0) | late-chunking 模式：逐 token hidden states |

**做法：** 从原始 Q8_0 GGUF 出发，用 Python 二进制修改 `eurobert.pooling_type` 的值，保存为两个独立文件。无需重新转换整个模型（省去数小时量化）。

```
LAST → eurobert.pooling_type = 3  (GGUF 原始)
NONE → eurobert.pooling_type = 0  (二进制修改)
```

**NONE + last-token 与 LAST 完全等价（cos=1.0）：** 由 `260525-evidence-jina-v5-none-vs-last.ts` 证明。`getEmbeddingsForTokens()` 返回多行后取最后一行，与最后一行本身是同一个值。

### 步骤 3：全链路对比脚本 ✅

创建 `260525-evidence-reproduce-bug.sh`，自动化两遍 eval：

```bash
# Pass 1: LAST gguf → index → eval
# Pass 2: NONE gguf → index → eval
bash scripts/evidence/260525-evidence-reproduce-bug.sh
```

### 步骤 4：切换为 mean pooling ✅

2026-05-25 验证：将 `_singlePassLateChunking` 从 last-token pool 改为 mean pool 后，
检索效果从 2/12 → **7/12**（MRR 0.01 → 0.19）。

**改动：** `src/code-index/embedders/llamacpp-llm.ts` Step 5 的 span→embedding 映射：

```typescript
// 旧：last-token pool（后续 chunk 拉力大）
return l2Norm(perTokenEmbs[end - 1])

// 新：mean pool（每个 token 平等投票）
const pooled = mean(perTokenEmbs.slice(start, end))
return l2Norm(pooled)
```

## 实施记录

### 2026-05-24：根因排查

**排查步骤：**

1. 阅读 `getEmbeddingsForTokens` 源码（`LlamaEmbeddingContext.js:63`），发现注释："Requires a model with pooling_type=none in GGUF metadata"
2. 检查 jina-v5 GGUF 元数据：`general.architecture = eurobert`，`eurobert.pooling_type = 3` (LAST)
3. 阅读 llama.cpp 头文件（`llama.h:994-1007`）：确认 `llama_get_embeddings_ith()` 在 `pooling_type != NONE` 时返回池化向量
4. 编写验证脚本直接测试：确认 `getEmbeddingsForTokens("hello world")` 对 jina-v5 返回 3 个完全相同的向量

**关键发现：**

| 属性 | 因果 LLM (MiniCPM) | BERT 嵌入模型 (jina-v5) |
|------|:---:|:---:|
| GGUF pooling_type | NONE（无 pooling 层） | LAST (3) |
| `getEmbeddingsForTokens` | 真正的逐 token hidden states | 池化向量复制 N 次 |
| Late-chunking 是否有效 | ✅ 是 | ❌ 否（no-op） |
| 四种 pooling 模式效果 | 不同 | 完全相同 |

**为什么文档中的 Berlin 测试成功而用户测试失败：**

文档中的 late-chunking Berlin 测试用的是 **MiniCPM-V-4.6**（因果 LLM，pooling_type=NONE），compare 脚本绕过 BatchProcessor 直接调用 `createEmbeddings`。用户用的是 **jina-v5**（BERT 嵌入模型，pooling_type=LAST=3），虽然也走了 `llamacpp-llm` 路径，但底层 `getEmbeddingsForTokens` 返回的是复制向量。

### 2026-05-25 上午：步骤 2 第一次尝试 → 失败分析

**尝试：** 将 jina-v5 的 GGUF `pooling_type` 从 `LAST` (3) 改为 `NONE` (0)，发现 last-token 检索效果崩溃。

**调试过程：**

1. 尝试取"倒数第二个 token" → MRR 0.038 → 0.012，更差
2. 通过 `260525-evidence-embedding-failure.ts` 证实：`getEmbeddingsForTokens()` 多出的 1 个 embedding 在开头（CLS）不在末尾，`token[-1]` 已经是最后一个 content token
3. 通过 `260525-evidence-jina-v5-none-vs-last.ts` 证实：NONE + last-token == LAST (cos=1.0)

**结论：** NONE + last-token 与 LAST 完全等价。单 GGUF 文件方案的问题不在 embedding 质量，而在于无法同时支持两种场景。解决方向不是回滚，而是创建两个独立 GGUF 文件。

### 2026-05-25 下午：最终修复

1. **创建两个独立 GGUF 文件：**
   - `v5-nano-retrieval-Q8_0-pooling-LAST.gguf`（pooling_type=3）
   - `v5-nano-retrieval-Q8_0-pooling-NONE.gguf`（pooling_type=0）
   - 均从原始 GGUF 出发，二进制修改 `eurobert.pooling_type` 值

2. **代码层面：** 在 `llamacpp-llm.ts` 中添加 `_checkPerTokenUniqueness()` 运行时检测 + 自动降级
   - 新增 `_lateChunkingNoopDetected` 实例标志（第 41 行）
   - 新增 `_checkPerTokenUniqueness()` 方法（第 359-407 行）
   - 在 `_singlePassLateChunking` 中调用检测（第 317-319 行）

3. **全链路对比脚本：** 创建 `260525-evidence-reproduce-bug.sh`，支持一键跑完两遍 eval

## 关键发现总结

### NONE 与 LAST 的等价性

| 变体 | 方法 | 与 LAST-gguf 的 cos |
|------|------|:---:|
| A | NONE: `token[0]` (CLS) | 0.48–0.50 ❌ 不可用 |
| B | NONE: `token[1..]` mean pool | 0.66–0.99（判别力更优） |
| C | NONE: `token[0..]` mean pool | ≈B（CLS 仅 1/7 权重） |
| D | NONE: `token[-1]` (last) | **1.0000** ≡ LAST |

**NONE + mean pool（B）的判別力优势：**

| chunk 对 | LAST-gguf | B (NONE mean) |
|------|:---:|:---:|
| save_model vs train_model | 0.54 | 0.54 |
| save_model vs Utility | 0.29 | 0.22 |
| class Model vs predict | 0.07 | **-0.04** |

### NONE 下 multi-chunk 上下文的陷阱

**⚠️ 重要勘误：** `260525-evidence-embedding-failure.ts` 的 multi-chunk 对比部分有 **CLS off-by-one bug**。
该脚本计算 multi-chunk span 时未考虑 CLS token 偏移（直接 `start: 0` 但 `getEmbeddingsForTokens` 返回
的数组以 CLS 开头），导致 multi-chunk 的 last-token 索引错了 1 个位置。因此其结论
"同一 chunk 在 single vs multi 下 cos<0.5" 部分来自索引错误。

**实际影响（在 BPE span + batchSize 修复后验证）：** 同一段代码在 single-chunk 和 multi-chunk
拼接下的 last-token embedding 余弦相似度因相邻 chunk 内容而定，通常在 0.7-0.95 之间。
上下文确实会改变 embedding，但没有之前夸张。

**检索效果对比（NONE GGUF, demo/model.py, 12 queries）：**

| 配置 | Recall | MRR | 说明 |
|------|:------:|:---:|------|
| `last-token` | **10/12** | 0.60 | 最佳选择，索引与查询 embedding 空间一致 |
| `late-chunking`（fix 前） | 0/12 | 0.00 | 零向量问题 + span 错位导致 |
| `late-chunking`（last-token pool） | 2/12 | 0.01 | 后续 chunk 注意力拉力太大 |
| `late-chunking`（**mean pool**） | **7/12** | **0.19** | 🚀 mean pool 缓解上下文不匹配 |

**结论：** Late-chunking + mean pool 已具备实用性（7/12），
但仍不如 `last-token` 模式（10/12, MRR 0.60）。选择取决于是否
需要跨 chunk 上下文感知。

## 有效配置组合

| poolingMode | GGUF 文件 | 效果 | 原理 |
|:---|:---|:---:|------|
| `last-token` | `-pooling-LAST.gguf` | 10/12 (基线) | llama.cpp 直接 LAST pooling，输出 1 个向量 |
| `last-token` | `-pooling-NONE.gguf` | 10/12 (等价) | NONE + last-token ≡ LAST (cos=1.0)，可共用 NONE GGUF |
| `mean` | `-pooling-LAST.gguf` | 待测 | 同上，mean pool 全 token |
| `qr-weighted` | `-pooling-LAST.gguf` | 待测 | 同上 |
| `late-chunking` | `-pooling-NONE.gguf` | **7/12** (mean) | mean pool 缓解上下文不匹配 |

**注意：** `last-token` + NONE GGUF 与 LAST GGUF 完全等价（已验证 cos=1.0），
所以不需要同时维护两个 GGUF 文件。统一用 NONE GGUF 即可。

## 修订记录

- 2026-05-24：初始记录，确认根因
- 2026-05-24：创建证据脚本 `260525-evidence-jina-v5-pooling.ts`
- 2026-05-24：实施步骤 1 — `_checkPerTokenUniqueness()` 运行时检测
- 2026-05-24：实施步骤 2（初版）— 二进制修改 GGUF pooling_type
- 2026-05-25：步骤 2 失败分析，发现 NONE+last-token ≡ LAST
- 2026-05-25：创建 `260525-evidence-jina-v5-none-vs-last.ts` 和 `260525-evidence-embedding-failure.ts`
- 2026-05-25：修正方案为创建两个独立 GGUF 文件（LAST + NONE）
- 2026-05-25：创建 `260525-evidence-reproduce-bug.sh` 全链路对比
- 2026-05-25：文档重写，移除过时的"回滚"结论
- 2026-05-25：**发现三大隐形 Bug**：
  - 🐛 ① CLS off-by-one：`getEmbeddingsForTokens` prepend CLS 与 `model.tokenize` 不匹配
  - 🐛 ② BPE 边界累积偏移：`_computeTokenSpans` 假设加法性，每个边界 -1 token
  - 🐛 ③ batchSize 默认太小：`createEmbeddingContext({})` 只返回前 ~112 个有效 embedding
  - 修复后 late-chunking 检索效果 2/12（last-token pool）
  - 2026-05-25：**Mean pool 大幅改善**：改为 mean pool 后 recall 2/12 → **7/12** (**+250%**)
