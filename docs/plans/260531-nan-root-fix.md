# 260531-nan-root-fix

## 主题/需求

F2LLM-v2-80M（pooling_type=NONE, n_batch=8192）在 token 数超过 24576 时，后半段 per-token embedding 全部为 NaN。需查明根因并修复，以充分利用 context 容量（40960），而非靠 JS 层 `maxBatchTokens = 24576` 只用到 60%。

```log
nTokens=32066, NaN 范围: [24576..32065] (连续 7490 个)
```

## 代码背景

| 文件 | 角色 |
|------|------|
| `llama.cpp/src/llama-context.cpp` `decode()` / `output_reserve()` | embedding 提取逻辑（Patch 6/7） |
| `llama.cpp/src/llama-graph.cpp` `build_inp_out_ids()` | 输出行筛选（Patch 12 探索位置） |
| `llama.cpp/ggml/src/ggml-metal/ggml-metal.metal` | Metal GPU attention/softmax kernel |
| `vendor/llama-addon/AddonContext.cpp` `OnOK` / `GetEmbedding` | embedding 累加 buffer |
| `vendor/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js` | JS 层 `getEmbeddingsForTokens` |
| `src/code-index/embedders/llamacpp-llm.ts` | 应用层 batch 控制 |
| `build.mjs` | C++ patch 编译脚本 |

**关键依赖**：`@realtimex/node-llama-cpp` v0.163.0（内置 llama.cpp b9370，Metal 后端）。

**现有 patch**（已通过 `build.mjs` 合入）：

| # | 文件 | 作用 |
|---|------|------|
| P6 | `llama-context.cpp` `output_reserve()` | NONE pooling 时 `embd.size = n_embd_out * n_batch` |
| P7 | `llama-context.cpp` `decode()` | NONE pooling 时提取全部 token 行（非仅 logits-enabled） |
| P8-10 | `llama-context.cpp/h`, `llama.h` | `llama_get_embeddings_raw()` + `get_embeddings_data()` |

## 运行现象

### 初始现象（260531）

- 短文本（12 tokens）：正常
- 长文本（36322 tokens）：24576/36323 valid（67.7%），8192 zero，3555 NaN
- 半长文本（~27k tokens，第 4 批 ≈ 3k）：正常

### Patch 11 + Patch 12 尝试（未合入）

| 修改 | 27k tokens | 32k tokens |
|------|-----------|-----------|
| 无 patch | NaN at 24576+ | NaN at 24576+ |
| + P11 + P12 | 0 NaN ✅ | NaN at 24576+ ❌ |

P11（bump `n_outputs_max`）和 P12（跳过 `ggml_get_rows`）对 27k 有效但对 32k 无效。

### P12 单独验证（260601）

```
修复前: 24576 valid + 8192 zero + 3555 NaN
+P12后: 24576 valid + 0 zero  + 11747 NaN
```

P12 把 8192 个 zero 变成了 NaN，暴露了 GPU 的真实输出。

### 异步陷阱

在 Patch 7 的 `ggml_backend_tensor_get_async` 后立即检查数据：显示 "clean"。等 `AddonContext::OnOK` 读取时：全部 NaN。

原因：`ggml_backend_tensor_get_async` 是异步的。Metal 命令提交后数据未到达时，读的是清零后的旧 buffer。等 OnOK 回调执行时，GPU 已完成 —— buffer 中全是 NaN。

## 归因分析

### CPU 侧逻辑全部正确

| 环节 | 验证 |
|------|------|
| `output_all` override（`balloc->init()`） | ✅ `embeddings=true` 时全部 `logits[i]` 覆写为 true |
| `n_outputs == n_tokens` per ubatch | ✅ `output_all` 使每个 ubatch 的 `n_outputs = ubatch.n_tokens` |
| `inp_out_ids` identity mapping | ✅ `n_outputs == n_tokens` → `out_ids = [0,1,...,n_tokens-1]` |
| `t_embd` 维度正确 | ✅ `ggml_get_rows` identity 保留所有行 |
| `embd.data` buffer 大小 | ✅ Patch 6 分配 `n_batch * n_embd_out = 8192 * 320` |
| `n_tokens_prev` 每次 decode 重置 | ✅ 第 4 次 decode 时 `n_tokens_prev = 0` |
| `AddonContext::OnOK` position mapping | ✅ 用 `batch.pos[i]` 正确索引 `_accEmbd` |

### 排除的假设

| 假设 | 验证 | 结论 |
|------|------|------|
| `ggml_get_rows` (P12) 导致 NaN | P12 应用后 NaN 不消失，反而 zero→NaN | ❌ 无关 |
| `output_reserve` buffer 不够 (P11) | `output_all` 使 `n_outputs_max` 足够大 | ❌ 不需要 |
| 模型本身数值问题 | CPU-only 测试 33991 tokens 全部正常 | ❌ 无关 |
| `_accEmbd` 累加逻辑错误 | OnOK 读取时 `embd.data` 已含 NaN | ❌ 无关 |

### 根因：Metal GPU attention kernel

**证据**：

| 测试 | 结果 |
|------|------|
| CPU-only (gpuLayers=0), 33991 tokens | ✅ 0 NaN |
| Metal GPU (gpuLayers=99), batchSize=8192 | ❌ batch 4+ 全部 NaN |
| Metal GPU, batchSize=6500 | ❌ 部分 NaN |
| Metal GPU, **batchSize=5500** | **✅ 0 NaN** |
| Metal GPU, batchSize=4500 | ✅ 0 NaN |

触发条件：**batch size ≥ ~7000** 且 **KV cache ≥ 24576 entries** 时，Metal GPU attention kernel 产出 NaN。安全上限在 batch 5500-6500 之间。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 修复方式 | JS 层 `batchSize: 8192 → 5500` | Metal kernel 的 bug 需深入 shader 调试（不可控），降低 batch 是最快、最安全的绕过方式 |
| P11/P12 合入 | 不合入 | `output_all` 机制已使 P11 不必要；P12 不修 NaN，反而暴露问题 |
| C++ 调试日志 | 已清理，不留 | 诊断完成，无需保留 |
| 开销 | batch 数增加 ~5% | 总计算量不变，仅多几次 kernel launch overhead |

## 实施计划

- [x] P12 验证（排除剪枝优化假设）
- [x] GPU→CPU 边界 NaN 检测（确认 NaN 来自 GPU）
- [x] CPU-only 对比测试（排除模型问题）
- [x] 不同 batchSize 边界测试（确定安全值：5500）
- [x] 应用修复：`llamacpp-llm.ts` batchSize → 5500
- [x] C++ 调试日志清理、P12 还原
- [ ] `npm run build:llamacpp` 重新固化 vendor 二进制（可选，当前 localBuilds 已包含最新 patch）

## 实施记录

### 2026-05-31

#### P11/P12 探索

- 应用 P11 (`output_reserve` bump `n_outputs_max`) + P12 (`build_inp_out_ids` skip)
- 结果：27k tokens 修复，32k tokens 仍有 NaN
- 推断是 `output_all` 机制使 P11 冗余，P12 不够

#### 累加 buffer 实现（260531-llamacpp-acc-embd）

- AddonContext 新增 `_accEmbd` / `_accEmbdCount` / `ClearAccumulatedEmbeddings`
- 扩展 Patch 5-10（llama.h、llama-context.cpp/h 的 `llama_get_embeddings_raw` 等）
- 编译卡点：SIGSEGV → dylib 符号缺失（`collectDylibs` 需 parentBinDir 修正）
- 结果：短文本 OK，长文本 24576/36323 valid

### 2026-06-01

#### P12 快速验证（symlink + 增量编译）

- 通过 `vendor/llama-cpp-live` symlink 直接改 `llama-graph.cpp`
- `cmake --build ... -j12` 增量编译（4 targets）
- 结果：zero → NaN，证明 NaN 来自 transformer 而非 `ggml_get_rows`
- **P12 已还原**

#### 精确边界测试

- 阶段 3：按 batch 分析 NaN 分布（target=25000t）
- 发现边界在 batch 4 的 ~7000 tokens 处
- 第 4 批 1055→6995 tokens ✅，7039+ tokens ❌

#### GPU→CPU NaN 检测（关键突破）

- 在 Patch 7 的 `ggml_backend_tensor_get_async` 后加 `fprintf(stderr)` 检测
- **发现 `embd.data` 指针在 batch 4 时重新分配了**（`0x6ce020000` → `0x6bf564200`）
- Patch 7 的 `[PATCH7 OK]` 是因为异步读取了清零后的旧 buffer
- 等 `OnOK` 执行时 GPU 已完成，buffer 中全是 NaN

#### CPU vs GPU 对比

- CPU-only（gpuLayers=0）：33991 tokens，0 NaN
- Metal GPU（gpuLayers=99）：同模型，batch 4+ NaN
- 确认 Metal 特有问题

#### batchSize 安全值测试

- 阶段 4：batchSize=8192/6500/5500/4500
- 5500 及以下完全干净

#### 部署修复

- `llamacpp-llm.ts`：`batchSize: 8192 → 5500`
- C++ 调试日志全部清理

## 修订记录

（暂无）

## 总结

### 关键收获

1. **`ggml_backend_tensor_get_async` 是异步的**——Metal 后端的数据在 kernel 完成后才到达 CPU buffer，不能立即检查
2. **Metal attention kernel 存在大 batch + 大 KV cache 的 NaN bug**——安全上限约 batch 5500
3. **`output_all` 机制正确工作**——P11 不必要，`inp_out_ids` 始终是 identity
4. **`llama_decode()` 每次调用独立**——`n_tokens_prev` reset、`gf_res_prev` reset、graph 重建

### 遗留

- Metal kernel 具体 bug 未定位（需深入 ggml-metal shader 调试，超出当前范围）
- 该限制是否影响其他模型（非 F2LLM）待验证
- `npm run build:llamacpp` 重新固化二进制（当前 localBuilds 已可用）

### 诊断脚本

| 脚本 | 作用 |
|------|------|
| `scripts/evidence/260530-nan-zero-end-to-end.ts` | 端到端诊断（5 阶段串行） |
