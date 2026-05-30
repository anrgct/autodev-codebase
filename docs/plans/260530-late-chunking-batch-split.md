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

**已知限制（C++ 层，JS 无法绕过）：**
- `llama_get_embeddings_ith` 的 slot 容量 = batchSize（8192），非 contextSize（40960）
- 输入 >8192 tokens 时，超出位置的 embedding 全部返回 NULL，JS 层填充零向量
- 这不是模型架构问题（短文本在 embdLayer=7 和 -1 下均正常），是对所有架构通用的 C++ addon 限制
- late-chunking 自动回退到 last-token 逐块嵌入（正确行为）

**修复方向：** 在 `AddonContext` 中增加跨微批次累加 buffer，使 `GetEmbedding` 能返回所有位置的 embedding。

### 目标

让 `llama_get_embeddings_ith` 能返回 context 范围内任意位置的 per-token embedding，而非仅限上一个 decode 的 batchSize 个 slot。

### 方案 B：C++ AddonContext 累加 buffer

#### 改动文件

| 文件 | 改动 |
|------|------|
| `vendor/llama-addon/AddonContext.h` | 新增 `std::vector<float> _accEmbd` 字段、`int32_t _accEmbdCount` |
| `vendor/llama-addon/AddonContext.cpp` | `DecodeBatch` 回调中积累 embedding；`GetEmbedding` 优先读 `_accEmbd` |

#### 实现步骤

##### Step 1: AddonContext.h — 新增字段

```cpp
std::vector<float> _accEmbd;     // 累加的 per-token embeddings
int32_t _accEmbdCount = 0;        // 已积累的 token 数量
int32_t _accEmbdDim = 0;          // embedding 维度
```

##### Step 2: DecodeBatch OnOK — 每次 decode 后拷贝 embedding

`AddonContextDecodeBatchWorker::OnOK()` 中，在 `deferred.Resolve(Env().Undefined())` 之前，遍历 `ctx->batch` 中所有 `logits=true` 的 token，调 `llama_get_embeddings_ith(ctx->ctx, i)` 获取 embedding，拷贝到 `ctx->_accEmbd` 的对应位置。

```cpp
void OnOK() {
    // 积累当前批次的 embeddings
    const auto &batch = ctx->batch;
    const int n_embd = llama_model_n_embd(ctx->model->model);
    
    if (ctx->_accEmbd.empty()) {
        // 首次：分配完整 buffer（contextSize * n_embd）
        ctx->_accEmbd.resize(ctx->_accEmbdDim * ctx->_accEmbdCount_max);
    }
    
    for (int32_t i = 0; i < batch.n_tokens; i++) {
        if (!batch.logits[i]) continue;
        const float *emb = llama_get_embeddings_ith(ctx->ctx, i);
        if (emb == nullptr) continue;
        const int32_t pos = i;  // 需要映射到实际 context 位置
        memcpy(ctx->_accEmbd.data() + pos * n_embd, emb, n_embd * sizeof(float));
    }
    ctx->_accEmbdCount = max(ctx->_accEmbdCount, ???);
    
    deferred.Resolve(Env().Undefined());
}
```

##### Step 3: GetEmbedding — 优先读累加 buffer

```cpp
if (!_accEmbd.empty() && inputTokensLength <= _accEmbdCount) {
    const float *emb = _accEmbd.data() + (inputTokensLength - 1) * _accEmbdDim;
    // 拷贝到 Float64Array...
    return result;
}
// 回退到原来的逻辑
```

#### 关键细节

1. **位置映射：** `batch.n_tokens` 对应 `firstTokenContextIndex` + tokens 数组。`AddToBatch` 接收 `firstTokenContextIndex` 参数，DecodeBatch 内需要记录这个偏移量来做位置映射。
2. **多次 DecodeBatch：** `getEmbeddingsForTokens` 中每次 `evaluate` 调用都会触发多次 `AddToBatch + DecodeBatch`（微批次）。每次 DecodeBatch 都要积累。
3. **清空时机：** 每次 `evaluate` 开始前（`eraseContextTokenRanges` 后）清空 `_accEmbd`。
4. **批次大小：** `_accEmbd` 分配 `contextSize * n_embd * sizeof(float)` bytes。对于 40960 × 320 × 4 = ~52 MB，在可接受范围内。

#### 边界情况

- **pooling_type != NONE：** 当模型做了 mean/cls pooling，`llama_get_embeddings_ith` 返回串行化向量（所有位置相同）。累加 buffer 同样会存相同值——不影响 `_checkPerTokenUniqueness` 的判断。
- **短文本（<8192 tokens）：** 单次 DecodeBatch 即可完成，`_accEmbd` 只包含一次积累，行为与现有一致。
- **并发（concurrency=2）：** 每个 context 有独立的 `_accEmbd`，互不干扰。

#### 工作量估算

| 步骤 | 预估 |
|------|------|
| 理解 logit 位置映射 | 1-2 小时 |
| AddonContext.h/cpp 实现 | 2-3 小时 |
| 构建 native binary（`npm run build:llamacpp`） | 10 分钟 |
| 验证 + 调试 | 2 小时 |
| **合计** | **~6 小时** |

## 总结

- late-chunking 子批次拆分现已正确工作，context 可以跑到 40960
- `@realtimex/node-llama-cpp` v0.163.0 的 `embd_layer` 特性中，`llama_get_embeddings_ith` 的 slot 容量 = batchSize，无法覆盖整个 context 窗口
- late-chunking 检测到不可用后自动回退到 last-token（正确行为，索引结果不受影响）
- 短文本（<8192 tokens）场景下所有嵌入模式均正常工作
- 复现脚本：`scripts/evidence/260530-per-token-zero-repro.ts`
