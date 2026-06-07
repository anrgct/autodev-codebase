# 260607-qrranker-multi-microbatch-nkv-fix

## 主题/需求

Gemma 3 270M 模型（32K context）作为 QRRanker 进行语义搜索时，`batchSize=4096` 导致 `RangeError: Invalid typed array length: -1192` 崩溃。

触发条件：prompt token 数（~17681）远超 `batchSize`（4096），llama.cpp 自动拆分 multi-micro-batch，C++ `cbEval` 回调无法正确累积跨 batch 的 kq_soft_max 数据。

复现命令：

```bash
npx tsx src/cli.ts search "黄一是谁？" --log-level=info --path=~/workspace/novel
```

## 代码背景

| 文件 | 角色 |
|------|------|
| `vendor/llama-addon/AddonContext.cpp` | C++ addon，`cbEval` 回调收集 kq_soft_max attention 数据 |
| `vendor/llama-addon/AddonContext.h` | C++ 头文件，`kqSoftMaxData`、`kqN_Kv` 等元数据 |
| `src/code-index/rerankers/qrranker.ts` | TS QRRanker 实现，tokenization、chunk ranges、score computation |
| `src/code-index/highlighters/qrranker.ts` | TS QRRanker 高亮器（相同 `batchSize: 4096` 模式） |

历史上下文：
- `docs/plans/260519-qrranker-llamacpp-patch.md`：原始 C++ addon patch（引入 `cbEval` + `getKqSoftMax`）
- `docs/plans/260523-qrranker-ubatch-overflow-fix.md`：Metal NaN 问题的发现和 `batchSize=4096` 保守规避
- `docs/plans/260529-qrranker-vram-context-pool.md`：context 池化、VRAM 管理、`contextSize` 上限

原始 `batchSize=4096` 的来源：在 QRRanker 专用模型（0.6B Q8）上，Metal backend 在 `batchSize=8192` 时 13/16 attention heads 返回 NaN，降到 4096 后正常。这是保守规避，不是根治。

## 运行现象

```text
[QRRanker] Processing 17681 tokens with batchSize=4096
[QRRanker] kq_soft_max shape: nKv=4864 (expected ~17681)
[CodeIndexSearchService] Error during search: RangeError: Invalid typed array length: -1192
    at new Float32Array (<anonymous>)
    at QRRankerReranker.computeChunkScores (qrranker.ts:327)
...
GGML_ASSERT([rsets->data count] == 0) failed  ← Metal cleanup crash (secondary)
```

## 归因分析

两个问题叠加：

### Bug 1（JS 侧）：BPE Tokenizer 跨边界合并

**位置**：`tokenizeWithChunkRanges()` —— `qrranker.ts:178-219`

`chunkRanges` 通过对每个 chunk **独立 tokenize** 再累加长度，但 `tokens` 是对完整 prompt **一次性 tokenize**。BPE 分词器在跨 chunk 边界时会合并子词（如 `"apple" + "tree" → "appletree"` 成一个 token），导致 `sum(独立tokenize) > tokenize(完整prompt)`，`chunkRanges[ci].start` 越界。

**修复**：改用增量前缀 tokenization（incremental prefix approach），每次对 `prefix + chunk0 + ... + chunkN` 做完整 tokenize，确保 chunk 范围与 tokens 数组精确对齐。

### Bug 2（C++ 侧）：buf stride 跨 micro-batch 不匹配

**位置**：`cbEval()` —— `AddonContext.cpp:533-601`

`ask=true` 阶段每个 micro-batch 更新 `kqN_Kv = t->ne[0]`（不断增长：4096 → 8192 → ... → 17681）。

`ask=false` 阶段：
```cpp
// Line 564-565: 首次 micro-batch 时用当前 n_kv (=4096) 分配 buf
if (buf.empty()) {
    buf.resize(n_head * n_query_full * n_kv, 0.0f);  // stride = 4096
}

// Line 582-583: 后续 micro-batch 的索引用当前 n_kv (=8192, 17681...)
const size_t dst_offset = ((size_t)h * n_query_full + ...) * n_kv;  // stride ≠ 4096
```

→ **buf 只有 4096-stride，但索引按 17681-stride 偏移 → 越界溢出 → Float32Array 负数长度崩溃**。

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| C++ 修复策略 | 用 `context_params.n_ctx` 做统一 stride | 总 context 大小固定不变，跨所有 micro-batch 一致 |
| `ask=true` 的 `kqN_Kv` | 设为 `context_params.n_ctx`（如 32768）而非 `t->ne[0]` | JS 侧拿到稳定的 nKv，覆盖所有 chunk positions |
| `ask=false` 拷贝方式 | 逐行（row-by-row）拷贝，处理 stride 差异 | Tensor 的 `n_kv` 每 batch 不同（4096→8192→17681），buf stride 固定 32768 |
| `batchSize` 策略 | 恢复统一 `batchSize=4096` | C++ 修复后不再需要单 micro-batch，保持 Metal NaN 防御 |
| JS 侧防御 | `computeChunkScores` 加入 `chunkLen <= 0` guard | 防止意外越界，异常 chunk 给零分 |

## 实施计划

- [x] 步骤 1：修复 JS `tokenizeWithChunkRanges` 增量前缀 tokenization
- [x] 步骤 2：C++ `cbEval` 统一 stride 修复（`ask=true` + `ask=false`）
- [x] 步骤 3：`npm run build:llamacpp` 重编译 C++ addon + 部署
- [x] 步骤 4：JS 侧 `computeChunkScores` 防御性 guard
- [x] 步骤 5：恢复 `batchSize=4096`，端到端验证 Gemma 3 和 QRRanker 模型

## 实施记录

### 2026-06-07

1. **JS `tokenizeWithChunkRanges` 修复**：将独立 chunk tokenize → 增量前缀 tokenize，保证 chunkRanges 与 tokens 精确对齐。

2. **C++ `cbEval` 修复**：
   - `ask=true`（line 533-541）：`kqN_Kv = ctx->context_params.n_ctx` 替代 `(int)t->ne[0]`
   - `ask=false`（line 560-593）：引入 `buf_n_kv = ctx->kqN_Kv`，逐行拷贝处理 tensor `n_kv` 与 buf stride 差异：

   ```cpp
   for (int q = 0; q < n_query_in_mb; q++) {
       const size_t dst_row = ((size_t)h * n_query_full + ...) * buf_n_kv;
       const size_t src_row = (size_t)q * n_kv;
       for (int kv = 0; kv < n_kv; kv++) {
           buf[dst_row + kv] += tmp_head[src_row + kv];
       }
   }
   ```

3. **`npm run build:llamacpp`**：编译 250 translation units → 产 `llama-addon.node` (477KB) → 部署到 `node_modules` 和 `vendor`

4. **端到端验证**：Gemma 3 270M + batchSize=4096 + 17681 tokens，无崩溃，无 nKv mismatch warning，输出 7 个搜索结果。

### 2026-06-07（模板补丁）

发现 Gemma 3 使用 ChatML 模板输出乱码（`<|im_end|><|im_start|>...`）。根因：`buildPrompt` 硬编码了 Qwen 的 ChatML turn delimiters（`<|im_start|>`/`<|im_end|>`），Gemma 3 不认识这些 token。

5. **新增 `_getPromptTemplate()` 方法**：通过 tokenizer 自动检测模型类型（`model.tokenize("<start_of_turn>")[0] > 0`），返回对应模板配置：

| 组件 | ChatML（Qwen） | Gemma 3 |
|------|---------------|---------|
| user turn | `<\|im_start\|>user\n` | `<start_of_turn>user\n` |
| user end | `<\|im_end\|>\n` | `<end_of_turn>\n` |
| assistant turn | `<\|im_start\|>assistant\n` | `<start_of_turn>model\n` |
| 引导前缀 | `<think>\n\n</think>\n\n` | `根据检索到的内容，` |

6. **`buildPrompt` 和 `tokenizeWithChunkRanges` 更新**：使用模板对象的 turn delimiters 替换硬编码 ChatML 字符串。

**效果**：Gemma 3 输出从乱码变为 `陈黄一的身份是"黄二"。`

### 修改文件清单

| 文件 | 改动类型 |
|------|---------|
| `vendor/llama-addon/AddonContext.cpp` | C++ 根治：`ask=true` kqN_Kv 统一为 context_params.n_ctx；`ask=false` 统一 stride + 逐行拷贝 |
| `src/code-index/rerankers/qrranker.ts` | JS：增量 prefix tokenize；computeChunkScores guard；回退 batchSize 到 4096；新增 `_getPromptTemplate()` 自动检测模型架构切换聊天模板 |

## 总结

**根因本质**：C++ `cbEval` 在两个点使用了不同来源的 `n_kv`（`buf.resize` 用首次 batch 的 4096，索引用当前 batch 的 17681），跨 micro-batch 后 stride 不匹配导致 buffer overflow。

**修复后效果**：`batchSize=4096` 下任意长度输入都可正确处理，Gemma 3 270M 和 QRRanker 小模型都兼容，Metal NaN 防御保持不变。通过 tokenizer 自动检测模型架构，自动切换 ChatML/Gemma 聊天模板。

## Highlighter 同步分析

### Bug 1（BPE 跨边界合并）：不需要移植

高亮器的 `tokenizeWithRanges()` 使用**子序列搜索**（`_findSubsequence`）定位 code/query 边界，其流程为：

```
tokenize(full prompt) → 在 token 数组中搜索 code 前 3 个 token 的子序列 → 找到就用 / 找不到 fallback 字符偏移估算
```

与 reranker 旧方案（独立 tokenize 每个 chunk 再累加 → `sum > tokenize(full)` → 越界崩溃）的关键区别：

| 维度 | Reranker（旧方案） | Highlighter（子序列搜索） |
|------|-------------------|--------------------------|
| 场景 | 多 chunk 批量处理 | 单 chunk + 单 query |
| Bug 严重性 | **崩溃级**：`Float32Array(-1192)` | **精度级**：搜索失败 → fallback 字符偏移，不会崩溃 |
| 原理 | 独立 tokenize 求和 ≠ 完整 tokenize | 直接在完整 token 序列上定位，不存在求和超量问题 |

子序列搜索也可能因 BPE 跨边界合并而匹配失败（概率低），此时退化为字符偏移估算——对高亮器来说"不够精确但可用"。

**结论**：高亮器也可以用增量前缀（只需 3 次 tokenize：`prefix` → `prefix+code` → 完整 prompt），但当前方案对单 chunk 场景**足够安全且更简洁**，不需要移植。

### Bug 2（C++ cbEval stride）：已共享修复

C++ addon 已重编译部署，reranker 和高亮器共用同一个 `llama-addon.node`，C++ 层修复对两者同时生效。

### 缺少 `_getPromptTemplate()`：需要同步

高亮器的 `buildPrompt()` 仍硬编码 ChatML turn delimiters（`<|im_start|>` / `<|im_end|>`），使用 Gemma 3 模型时会产生与 reranker 修复前相同的乱码输出。需要按 reranker 的方案移植 `_getPromptTemplate()`，并更新 `buildPrompt()` 和 `tokenizeWithRanges()` 使用模板对象。

### 汇总

| 修改项 | Reranker | Highlighter | 状态 |
|--------|----------|-------------|------|
| Bug 1：增量前缀 tokenize | ✅ 已修复 | ❌ 不需要 | 场景不同，无需移植 |
| Bug 2：C++ stride | ✅ 已修复 | ✅ 自动受益 | 共用 `llama-addon.node` |
| `_getPromptTemplate()` | ✅ 已添加 | ❌ 待添加 | **需要移植** |
| `computeChunkScores` guard | ✅ 已添加 | N/A | Highlighter 无此函数 |

**后续优化**：高亮器 `src/code-index/highlighters/qrranker.ts` 有相同 `batchSize: 4096` 模式（line 868+），但高亮器每次创建临时 context，不涉及 context 池化，当前不受此 bug 影响。如未来改为池化模式，需同步应用此修复。
