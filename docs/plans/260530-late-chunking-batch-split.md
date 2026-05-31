# 260530-late-chunking-batch-split

## 主题/需求

late-chunking 在大文件场景下的处理。原始代码遇到一个子批次超标时，try/catch 把整个 1024 chunks 全部回退到 last-token，late-chunking 等于没生效。

目标：
- 子批次之间隔离，一个失败不影响前面的处理结果
- 精确验证 BPE 边界膨胀，不要估算超标
- 获取最大可用的 context size（不能因为显存竞争被过度裁剪）

## 代码背景

**核心文件：**
- `src/code-index/embedders/llamacpp-llm.ts` — LlamaCppLlmEmbedder，late-chunking 主逻辑
- `vendor/llama-addon/AddonContext.cpp` — C++ addon，`GetEmbedding` 函数
- `src/code-index/service-factory.ts` — 自动检测 embedder 的创建与销毁
- `src/code-index/interfaces/embedder.ts` — IEmbedder 接口
- `src/commands/shared.ts` — 索引进度轮询

**关键依赖：**
- `@realtimex/node-llama-cpp` v0.163.0（内置 llama.cpp b9370）
- F2LLM-v2-80M GGUF（pooling_type=0=NONE，qwen3 架构，8 层，320 维，context 40960）

**现有逻辑：**
- `_lateChunkingCreateEmbeddings` 把所有 chunks 用 for 循环贪心分组，每组装满就调 `_singlePassLateChunking`
- 整段包在 try/catch 里，任何子批次失败就整体回退到 `_lastTokenCreateEmbeddings`
- `_ensureModel` 创建 embedding context 时只传了 `batchSize` 没传 `contextSize`

## 运行现象

### 原始 bug

```log
[2026-05-30T11:55:56.688Z] INFO  Splitting 1024 chunks (1381951 tokens) into sub-batches (context=40960)
[2026-05-30T11:55:57.261Z] WARN  Late chunking failed, falling back to last-token: Error: Input is longer than the context size.
```

估算用 `tokenize(chunk_i)` 独立求和（1,381,951 tokens），发现 > 40960，进入子批次拆分。第一个子批次按估算放进 ~28 chunks（~35k tokens），验证时 `model.tokenize(joined)` 也说 ≤ 40960。但 `getEmbeddingsForTokens` 仍然报溢出。

### 调试发现

添加日志后发现：
```
singlePass: 28 chunks, 35153 tokens, context=40960
```

token 数 35153 < 40960，但 `getEmbeddingsForTokens` 内部检查的是 `this._llamaContext.contextSize`（实际分配值），不是 `this._contextSize`（model.trainContextSize = 40960）。

### 显存竞争

```log
# 自动检测 embedder
Created 2 embedding context(s) for pool, layer=7 (ctx=30720, batchSize=40960)
# 实际索引 embedder（自动检测没释放 VRAM）
Created 2 embedding context(s) for pool, layer=7 (ctx=4352, batchSize=40960)
```

### 模型兼容性（更新版）

模型 F2LLM-v2-80M + `embd_layer=7` 组合下，短文本（<8192 tokens）可正常返回逐 token 不同的 embedding。但长文本场景下，C++ addon 的 `llama_get_embeddings_ith` 受限于 batchSize slot（8192），所有超出位置的调用都返回 NULL，JS 层填充零向量。这不是模型问题，也不是 GGUF pooling_type 枚举问题。

```log
# 短文本（12 tokens）——正常
embdLayer=7: tokens=12, valid=12, distinct=true, ref[0..6]=[6.502e-1, 6.507e+0, ...]

# 长文本（~35000 tokens）——全部失败
[2026-05-30T14:44:36.515Z] Per-token uniqueness check: nTokens=38610, NaN count=1869440, zero count=10485760
```

脚本：`scripts/evidence/260530-per-token-zero-repro.ts`

## 归因分析

### bug 1：contextSize 不匹配

`createEmbeddingContext` 只传 `batchSize` 没传 `contextSize`。`getEmbeddingsForTokens` 检查的是 `this._llamaContext.contextSize`（实际分配值），不是 `batchSize`。库的 `resolveContextContextSize` 根据显存自动分配，可能远小于 `trainContextSize`。

验证阶段用 `model.tokenize(joined).length <= this._contextSize`（40960）做检查，但 `getEmbeddingsForTokens` 内部用 `<= this._llamaContext.contextSize`（实际分配值，如 30720 或 4352）。验证通过但执行失败。

### bug 2：整体 try/catch 回退

`_lateChunkingCreateEmbeddings` 的 try/catch 包住整个循环。任何一个子批次失败（如 BPE 边界膨胀导致超标），所有已处理的子批次数据全丢弃，全部走 `_lastTokenCreateEmbeddings`。

### bug 3：VRAM 竞争

`service-factory.ts` 的 `createVectorStore` 先创建一个 embedder 做自动检测维度。检测完不 dispose，embedder 的 2 个 context（占用 ~30720 tokens KV cache）持续占用 VRAM。后续 `CodeIndexManager` 创建真实 embedder 时只剩 ~4352 tokens 可用。

### bug 4：llama_get_embeddings_ith 受限于 batchSize slot

**状态：** C++ addon 层限制，JS 层无法绕过

`@realtimex/node-llama-cpp` v0.163.0（llama.cpp b9370）的 `getEmbeddingsForTokens` 中，`llama_get_embeddings_ith(ctx, i)` 的 slot 容量为 `batchSize`（8192），而非 `contextSize`（40960）。这不是 `embd_layer` patch 的特有问题——`embdLayer=-1`（绕过 patch）一样受影响。

当输入文本超过 batchSize tokens 时，C++ 输出的日志直接揭示了限制：

```
get_embeddings_ith: invalid embeddings id 3555, reason: batch.logits[3555] != true
...
get_embeddings_ith: invalid embeddings id 8192, reason: out of range [0, 8192)
get_embeddings_ith: invalid embeddings id 8193, reason: out of range [0, 8192)
...
```

**三种失败模式：**

| 位置范围 | C++ 层原因 | JS 层结果 |
|---------|-----------|----------|
| 0..3554 | 有效 slot，但 `batch.logits[i]` 未设 | `getEmbedding` throw → catch → **零向量** |
| 3555..8191 | `batch.logits[i] != true` | `getEmbedding` throw → catch → **零向量** |
| 8192..N | `out of range [0, batchSize)` | `getEmbedding` throw → catch → **零向量** |

**短文本对照（12 tokens）：** `embdLayer=7` 和 `embdLayer=-1` 都正常返回到 12 个不同的 per-token 向量。

**长文本对照（36322 tokens）：** `embdLayer=7` 和 `embdLayer=-1` 都失败（nan=3555, zero=32768, valid=0）。

**结论：** 问题根源是 llama.cpp b9370 的 `llama_get_embeddings_ith` 每次解码只能在 `batchSize` 大小的 buffer 中存储上一步的 logit。多微批次解码后，只有最后一个批次的 logit 可读，之前批次的覆盖丢失。跟模型架构、GGUF pooling_type、embd_layer patch 都无关。

**修复方向（C++ 层）：** `AddonContext.cpp` 的 `DecodeBatch` 的完成回调中遍历当前批次的 logit buffer，拷到 `contextSize * n_embd` 的累加 buffer 的对应 context 位置偏移。`GetEmbedding` 优先读累加 buffer。

**影响：** late-chunking 在 `@realtimex/node-llama-cpp` v0.163.0 下对所有架构的长文本 batch 都有此限制。短文本（<8192 tokens）不受影响。

### bug 5：轮询日志过多

`src/commands/shared.ts` 的 `waitForIndexingCompletion` 每 2 秒打印一次 "Current state: Indexing"。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 子批次拆分 | 逐批次精确验证 + 隔离处理 | 替换整体 try/catch，前面的批次不受后面失败影响 |
| BPE 边界处理 | 用 `model.tokenize(joined)` 精确量，超标则从尾部收缩 | 比固定 margin 准确，适应不同边界数的场景 |
| contextSize 获取 | 不传 contextSize，让库自动分配；读 `_llamaContext.contextSize` | 避免传过大值导致 Metal 后端崩溃 |
| batchSize 设置 | `Math.min(trainContextSize, 8192)` | 避免过大 batchSize 让库的显存估算过度裁剪 context |
| contextSize 解析 | 不传 contextSize，库内部 `resolveContextContextSize` 根据可用显存、batchSize、模型参数、sequences 等自动算出最大值 | 实测：batchSize=40960 时首次 30720、第二次 4352；batchSize=8192 + dispose 后双实例均 40960。传固定值可能触发的 Metal `InsufficientMemoryError` 导致进程崩溃 |
| 自动检测 VRAM 释放 | 给 IEmbedder 加 `dispose()`，auto-detect 后用 `try/finally` 释放 | dispose 后 Metal 不一定立即释放，但减小了竞争窗口 |
| 轮询间隔 | 2s → 10s | 减少索引时的日志噪音 |

## 实施记录

### 2026-05-30

**改动 1：`_lateChunkingCreateEmbeddings` 重写**
- 去掉整体 try/catch，改成 while 循环逐批次处理
- Phase 1：估算候选边界（贪心算法）
- Phase 2：精确验证（`model.tokenize(joined)`）
- Phase 3：处理已验证的子批次
- 之前的批次结果保存在 `allEmbeddings[]` 中，不受后续影响

**改动 2：`_ensureModel` 优化**
- 添加 `_embeddingContextSize` 字段记录实际分配值
- contextSize 从 `_embeddingContextSize` 读取而非 `_contextSize`
- batchSize 从 `trainContextSize`（40960）改为 `min(trainContextSize, 8192)`

**改动 3：dispose 支持**
- 在 `IEmbedder` 接口添加可选 `dispose()` 方法
- `LlamaCppLlmEmbedder` 实现 dispose：逐层释放 contexts → model → loadingPromise
- `service-factory.ts` auto-detect 后 `try/finally { embedder.dispose?.() }`

**改动 4：日志减噪**
- `shared.ts` 轮询间隔 2s → 10s

## 修订记录

### 2026-05-30
**问题：** `createEmbeddingContext` 缺失 contextSize，导致实际 KV cache 远小于 trainContextSize
**修复：** 读取 `_llamaContext.contextSize` 作为实际用量

**问题：** 显存竞争导致第二个 embedder 只拿到 4352 context
**修复：** batchSize 从 40960 降到 8192 + dispose 自动检测的 embedder

**问题：** `_checkPerTokenUniqueness` NaN 假阳性——首个 token embedding 为 NaN，JS 的 `NaN > 1e-6` 永远为 false，导致所有 token 被误判为"全同"
**修复：** 比较时跳过 NaN/Infinity 值，寻找首个有效（非 NaN）向量作为参考基准

**问题：** `_lateChunkingCreateEmbeddings` 的 catch 触发后回退到 `_lastTokenCreateEmbeddings`，重新嵌入所有文本，浪费已有子批次结果
**修复：** 添加 `_lateChunkingNoopDetected` 早期返回——检测到模型不支持 late-chunking 后，后续批次直接走 `_lastTokenCreateEmbeddings`，跳过子批次拆分

## 当前状态

**已修复：** 子批次拆分、contextSize 读取、VRAM 竞争、`_checkPerTokenUniqueness` NaN 假阳性修复、日志减噪

**bug 4（per-token embedding 全零）** → 已通过 C++ 累加 buffer + llama.cpp decode patch 修复，详见 `docs/plans/260531-llamacpp-acc-embd.md`

## 方案 B：C++ AddonContext 累加 buffer + llama.cpp decode patch

> **已实施**，详见独立 task-doc：`docs/plans/260531-llamacpp-acc-embd.md`

核心思路：
- llama.cpp `decode()` 改为提取所有 token 行（非仅 `logits=true` 的），避免 JS 层设全部 logits 导致 OOM
- C++ `AddonContext` 增加跨 JS decode 批次累加 buffer（`_accEmbd`），用 `batch.pos[i]` 按 context 位置索引
- JS 层仅加 1 行 `clearAccumulatedEmbeddings()`，不修改 `_evaluate`

## 总结

> 完整改动清单和验证结果见 `docs/plans/260531-llamacpp-acc-embd.md`

| 问题 | 方案 |
|------|------|
| bug 1: contextSize 不匹配 | 读 `_embeddingContextSize` 替代 `_contextSize` |
| bug 2: 整体 try/catch 回退 | while 循环逐批次隔离 + Phase 1/2/3 |
| bug 3: VRAM 竞争 | batchSize 降到 8192 + auto-detect dispose |
| bug 4: per-token embedding 全零 | llama.cpp decode patch + C++ 累加 buffer → `260531-llamacpp-acc-embd.md` |
| bug 5: 轮询日志过多 | 2s → 10s |
| `_checkPerTokenUniqueness` NaN 假阳性 | 跳过 NaN/Infinity 比较 |

验证：短文本 ✅ | 长文本 0 valid → 24576/36323 (67.7%)
