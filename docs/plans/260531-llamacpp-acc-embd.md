# 260531-llamacpp-acc-embd

## 主题/需求

`llama_get_embeddings_ith` 在长文本（>8192 tokens）场景下只能返回最后一个微批次的 per-token embedding，导致 late-chunking 在大文件上全部退化到 last-token。需要在 C++ addon 层增加跨批次累加 buffer，使 `GetEmbedding` 能返回 context 范围内任意位置的 embedding。

## 代码背景

**核心文件：**
- `vendor/llama-addon/AddonContext.h` / `.cpp` — C++ addon，`GetEmbedding` + `DecodeBatch::OnOK`
- `vendor/llama-addon/build.mjs` — 两遍编译脚本，含内联 `patchFile()` 函数
- `vendor/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js` — JS 层 `getEmbeddingsForTokens`
- `llama.cpp/src/llama-context.cpp` `decode()` / `output_reserve()` — 被打 patch 的上游代码

**关键依赖：**
- `@realtimex/node-llama-cpp` v0.163.0（内置 llama.cpp b9370）
- F2LLM-v2-80M GGUF（pooling_type=NONE，320 维，context 40960）

**现有逻辑：**

JS `getEmbeddingsForTokens` → `evaluate(resolvedInput, { _noSampling: true })` → `_evaluate` 只设 `logitsArray[evalTokens.length - 1] = true` → `llama_decode` 只计算最后一个 token 的 embedding → JS 循环 `getEmbedding(i)` 其余全部 catch 后填零向量。

## 运行现象

```log
# 短文本（12 tokens）——正常
embdLayer=7: tokens=12, valid=12, distinct=true

# 长文本（36322 tokens）——全部零向量
tokens=36323, nan=3555, zero=32768, valid=0
```

复现脚本：`scripts/evidence/260530-nan-zero-end-to-end.ts`（阶段 1）

## 归因分析

对 llama.cpp `decode()` 源码的追踪推翻了原假设（"`embd.data` 只保留最后一个微批次"）。实际发现：

| 问题 | 根因 | 层 |
|------|------|-----|
| `logits` 只在最后 token 为 true | `_evaluate` 中 `logitsArray[evalTokens.length - 1] = true` | JS |
| `embd.data` 只分配 `n_outputs` 行 | `output_reserve` 按 `n_outputs_max`（=1）分配 | llama.cpp |
| embedding 提取只复制 `n_outputs` 行 | `decode()` 使用 `n_outputs_prev/n_outputs` 偏移 | llama.cpp |
| `output_ids` 跨 JS decode 批次被覆盖 | `output_ids.resize(n_batch)` 固定大小 + 每批次重置 | C++ |
| `llama_get_embeddings_ith` 检查 `output_ids` | `output_resolve_row(i)` 要求 `output_ids[i] >= 0` | llama.cpp |

**为什么不在 JS 层修复（设全部 `logits=true`）？**

`output_reserve` 的 logits 分配 = `n_vocab * n_outputs_max * 4`。对大词表模型（Qwen3 ~152k vocab），35000 tokens 的 logits buffer ≈ 21 GB，直接 OOM。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| embedding 提取层级 | 在 llama.cpp `decode()` 中改为提取所有 token 行 | 避免 logits 内存爆炸；`embd.data` 扩到 `n_batch * n_embd` 仅 ~10 MB |
| 累加 buffer 索引方式 | 用 `batch.pos[i]`（context 位置）索引 `_accEmbd` | 多序列 interleaved batch 中正确映射 |
| 读取方式 | `llama_get_embeddings_raw()` → `get_embeddings_data()` → `embd.data`（无 `output_reorder`） | 避免 `output_reorder` 打乱 token 顺序 |
| 清空时机 | JS `clearAccumulatedEmbeddings()` 在 `eraseContextTokenRanges` 之后、`evaluate` 之前调用 | 显式控制，不侵入 evaluate 流程 |
| JS 层修改 | 仅加 1 行 `clearAccumulatedEmbeddings()` | 不改 `_evaluate`，无 logits 膨胀风险 |

## 实施计划

- [x] `AddonContext.h`：新增 `_accEmbd` / `_accEmbdCount` / `_accEmbdDim` + `ClearAccumulatedEmbeddings`
- [x] `AddonContext.cpp` `DecodeBatch::OnOK`：遍历 `batch.n_tokens`，用 `batch.pos[i]` 做偏移，`llama_get_embeddings_raw` 读 `embd.data`，`memcpy` 到 `_accEmbd`
- [x] `AddonContext.cpp` `GetEmbedding`：优先查 `_accEmbd`，命中直接返回；否则走原逻辑
- [x] `AddonContext.cpp` `ClearAccumulatedEmbeddings` + `init()` 注册
- [x] `LlamaEmbeddingContext.js`：`evaluate` 前调 `_ctx.clearAccumulatedEmbeddings()`
- [x] `build.mjs` Patch 5：`llama.h` 新增 `llama_get_embeddings_raw()` 声明
- [x] `build.mjs` Patch 6：`output_reserve` 对 NONE pooling 强制 `embd.size = n_embd_out * n_batch`
- [x] `build.mjs` Patch 7：`decode()` NONE pooling 时用 `n_tokens_prev / ubatch.n_tokens` 提取所有 token 行
- [x] `build.mjs` Patch 8：`llama_get_embeddings_raw()` 实现（调 `get_embeddings_data()`）
- [x] `build.mjs` Patch 9：`llama-context.h` 新增 `get_embeddings_data()` 声明
- [x] `build.mjs` Patch 10：`get_embeddings_data()` 实现
- [x] `build.mjs` `collectDylibs`：增加 `parentBinDir` 搜索（`Release/` → `bin/`）
- [x] 编译 → 部署 → 验证

## 实施记录

### 2026-05-31

#### AddonContext 改动

**`AddonContext.h`** — 新增字段和方法声明：

```cpp
// 累加 buffer，按 context position 索引
std::vector<float> _accEmbd;
int32_t _accEmbdCount = 0;
int32_t _accEmbdDim = 0;

Napi::Value ClearAccumulatedEmbeddings(const Napi::CallbackInfo& info);
```

**`AddonContext.cpp` `DecodeBatch::OnOK`** — 每次 decode 后累加：

```cpp
void OnOK() {
    if (ctx->ctx != nullptr && ctx->model != nullptr
        && ctx->has_batch && ctx->batch.n_tokens > 0) {
        const auto pooling_type = llama_pooling_type(ctx->ctx);
        if (pooling_type == LLAMA_POOLING_TYPE_NONE) {
            const int n_embd = llama_model_n_embd(ctx->model->model);
            if (ctx->_accEmbdDim == 0) {
                ctx->_accEmbdDim = n_embd;
                ctx->_accEmbd.resize(llama_n_ctx(ctx->ctx) * n_embd, 0.0f);
            }
            const float * embd_raw = llama_get_embeddings_raw(ctx->ctx);
            if (embd_raw != nullptr) {
                for (int32_t i = 0; i < ctx->batch.n_tokens; i++) {
                    const int32_t pos = ctx->batch.pos[i];
                    if (pos < 0 || pos >= llama_n_ctx(ctx->ctx)) continue;
                    memcpy(ctx->_accEmbd.data() + pos * n_embd,
                           embd_raw + i * n_embd, n_embd * sizeof(float));
                    if (pos + 1 > ctx->_accEmbdCount)
                        ctx->_accEmbdCount = pos + 1;
                }
            }
        }
    }
    deferred.Resolve(Env().Undefined());
}
```

**`AddonContext.cpp` `GetEmbedding`** — 优先读累加 buffer：

```cpp
// 累加 buffer 优先
if (!_accEmbd.empty() && inputTokensLength - 1 < _accEmbdCount) {
    const float * emb = _accEmbd.data() + (inputTokensLength - 1) * _accEmbdDim;
    // ... 返回 Float64Array ...
}
// 回退原逻辑（短文本或 pooling_type != NONE）
```

#### llama.cpp patch

共 6 个新 patch（Patch 5-10）通过 `build.mjs` 的 `patchFile()` 内联替换：

| # | 文件 | old → new |
|---|------|-----------|
| 5 | `llama.h` | `llama_get_embeddings_ith` 声明后追加 `llama_get_embeddings_raw` |
| 6 | `llama-context.cpp` `output_reserve` | `embd.size = has_embd ? n_embd_out*n_outputs_max : 0` → NONE pooling 时 `n_embd_out*n_batch` |
| 7 | `llama-context.cpp` `decode()` | `n_outputs_prev/n_outputs` → `n_tokens_prev/ubatch.n_tokens`，提取所有 token 行 |
| 8 | `llama-context.cpp` | `llama_get_embeddings_raw` 实现（调 `get_embeddings_data()`） |
| 9 | `llama-context.h` | `get_embeddings_data()` 声明 |
| 10 | `llama-context.cpp` | `get_embeddings_data()` 实现（return `embd.data`） |

#### 构建卡点

**1. SIGSEGV (exit 139)**：编译通过后运行 `getEmbeddingFor("test")` 崩溃。

排查过程：
- npm 原始源编译（无 patch）→ ✅ 正常
- 仅 embd_layer patch → crash
- embd_layer + decode + accum → crash

*根因*：`collectDylibs()` 从 `vendor/llama-addon/binaries/` 复制 dylib，该目录存的是 Pass 1 编译的旧 dylib（不含 `llama_get_embeddings_raw` 符号）。`.node` 引用该符号但 dylib 不导出 → 运行时 `U _llama_get_embeddings_raw` 符号未解析 → SIGSEGV。

*修复*：
- 手动从 `localBuilds/<variant>/bin/` 收集 Pass 2 编译的新 dylib
- 修改 `collectDylibs()` 增加 `parentBinDir` 搜索路径（`Release/` → `../bin/`）

**2. npm AddonContext 被 deploy 覆盖**：`deploy-llamacpp-patch.ts` 把 vendor 的 patched AddonContext 部署到 `node_modules`，导致 `build.mjs` Pass 1（使用 npm 原始 AddonContext）编译失败。

*修复*：`npm uninstall` + `npm install --save-exact @realtimex/node-llama-cpp@0.163.0` + `npm run build:llamacpp`。已录入 `docs/08-llama-cpp-build-flow.md` 的 FAQ。

## 修订记录

（暂无）

## 总结

### 验证结果

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 短文本 embdLayer=7 | ✅ | ✅ 12/12 valid |
| 短文本 embdLayer=-1 | ✅ | ✅ 12/12 valid |
| 长文本 embdLayer=7 | ❌ 0 valid | ✅ 24576/36323 (67.7%) |
| 长文本 embdLayer=-1 | ❌ 0 valid | ✅ 24576/36323 (67.7%) |

### 已知限制

- **8192 zero tokens**：`output_ids` 固定 `n_batch`=8192 的硬限制，跨 JS decode 批次时最后批次可能覆盖。不阻塞索引使用。
- **3555 NaN tokens**：模型深层数值问题（embdLayer=7/-1 一致），非 patch 引入。

### 改动文件

| 文件 | 改动 |
|------|------|
| `vendor/llama-addon/AddonContext.h` | `_accEmbd` / `_accEmbdCount` / `_accEmbdDim` + `ClearAccumulatedEmbeddings` |
| `vendor/llama-addon/AddonContext.cpp` | `OnOK` 累加、`GetEmbedding` 优先读 buffer、`ClearAccumulatedEmbeddings` + `init()` 注册 |
| `vendor/llama-addon/build.mjs` | Patch 5-10 + `collectDylibs` parentBinDir 修正 |
| `vendor/node-llama-cpp/.../LlamaEmbeddingContext.js` | evaluate 前 `clearAccumulatedEmbeddings()` |
| `docs/08-llama-cpp-build-flow.md` | 新增 npm 重置流程 FAQ |
