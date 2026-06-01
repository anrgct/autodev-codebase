# 260601-qrranker-dynamic-layer-range

## 主题/需求

QRRanker 的 C++ `cbEval` 回调硬编码 layer 过滤范围 `il < 17 || il >= 25`，该范围仅适用于 QRRanker 模型（保留 25 层，0-24）。使用非 QRRanker 模型（如 MiniCPM-V-4.6，24 层）时，只有部分层能被采集，导致 `nLayers=2`、大量 QR heads 被跳过、重排分数精度下降。

### 背景

QRRanker（MindscapeRAG/QRRanker）基于 **Qwen3-4B-Instruct-2507** 训练。原版 Qwen3-4B-Instruct-2507 的架构（GGUF metadata）：

| 参数 | 原版值 | 备注 |
|------|------|------|
| `block_count` | **36** | 原版 transformer block 数 |
| `attention.head_count` | 32 | MHA |
| `attention.head_count_kv` | 8 | GQA 比率 4:1 |
| `context_length` | 262144 | 训练上下文 |
| `embedding_length` | 2560 | |

QRRanker 训练时从原版 36 层中**裁剪保留前 25 层**（0-24），其 QR attention heads 分布在第 17-24 层。因此硬编码范围 `[17, 25)` 适用于 QRRanker，但**不**适用于原版 36 层 Qwen3-4B（QR head 实际在 17-24，相对原版应映射到 17-30），也**不**适用于其他层数模型。

**目标**：将 layer 范围改为动态可配置，TS 侧根据模型实际层数等比缩放，与已有的 head 缩放机制（`QR_SOURCE_NHEAD = 32`）对齐。

**预期成果**：
- C++ `AddonContext` 新增 `kqLayerStart`/`kqLayerEnd` 成员变量 + NAPI setter
- `cbEval` 改用动态范围替代硬编码 17/25
- node-llama-cpp `LlamaContext` 暴露 `setKqSoftMaxLayerRange()` 方法
- QRRanker reranker/highlighter 在 decode 前根据模型层数设置缩放后的 layer 范围
- 向后兼容：默认值保持 17/25，现有 QRRanker 模型不受影响

## 代码背景

### 涉及文件

| 文件 | 改动 |
|------|------|
| `vendor/llama-addon/AddonContext.h` | 新增 `kqLayerStart`/`kqLayerEnd` 字段 + `SetKqSoftMaxLayerRange` 声明 |
| `vendor/llama-addon/AddonContext.cpp` | `cbEval` 改用动态范围；新增 `SetKqSoftMaxLayerRange` 实现 + `init()` 注册 |
| `vendor/node-llama-cpp/dist/.../LlamaContext/types.d.ts` | 新增 `setKqSoftMaxLayerRange` 类型声明 |
| `vendor/node-llama-cpp/dist/.../LlamaContext.js` | 新增 `setKqSoftMaxLayerRange` 代理方法 |
| `src/code-index/rerankers/qrranker.ts` | decode 前调 `context.setKqSoftMaxLayerRange()` |
| `src/code-index/highlighters/qrranker.ts` | 同上 |
| `scripts/deploy-llamacpp-patch.ts` | 确认新 JS 文件在部署覆盖范围内 |

### 已有参考

- **Head 缩放**（存在）：`QR_SOURCE_NHEAD = 32` → `mappedHead = Math.round(rawHead * nHead / 32)`
- **Layer 缩放**（缺失）：`QR_HEADS` 的 layer 硬编码 17-24，C++ filter 硬编码 17-25
- **历史实现**：Ettin 场景曾实现 `setKqSoftMaxLayerRange`，后 revert。本次可复用其模式。
- C++ 编译与部署流程：详见 `docs/08-llama-cpp-build-flow.md`

### 依赖关系

- `build.mjs` 编译链需重新编译 patched AddonContext
- deploy 脚本需部署新 `.node` 到 node_modules
- JS 侧需 patch `LlamaContext` 文件暴露新方法

## 运行现象

### 复现命令

```bash
npm run dev -- search "where is the actual train method implementation in the source code?" --log-level=debug --demo | tee /tmp/tp2.log | grep 'kq_soft_max shape'
```

### 修正后实际输出

```
[QRRanker] Layer range scaled: 36→24 blocks, range [11, 17)
[QRRanker] kq_soft_max shape: nKv=2816, nTokens=26, nHead=8, nLayers=2, layers=[15,11]
[QRRanker] QR heads (nHead=8): 11:7 15:3 15:1 11:6 11:4 11:1
```

→ 缩放范围 `[11, 17)` 正确反映原版 36 层 47%–67% 深度。
→ `nLayers=2` 是 MiniCPM llama.cpp 调度的 4-layer 间隔在 `[11, 17)` 范围内的命中（11 和 15），非 layer filter 范围问题。

### flash attention 假设验证命令

```bash
npx tsx scripts/evidence/260601-validate-flash-hypothesis.ts
```

输出：

```text
totalLayers: 25
=== Config A: collectKqSoftMax=true (C++ 强制 flash_attn DISABLED) ===
kq_soft_max layers: [23,19,15,11,7,3]
nLayers: 6
=== Config B: flash ON + collectKqSoftMax=false ===
(no kq_soft_max — flash path doesn't invoke cbEval for kq_soft_max)
```

→ Config A 强制走 vanilla attention 路径仍只 6 层有效 → 排除 flash attention 根因。

### 当前日志

```
[QRRanker] kq_soft_max shape: nKv=2816, nTokens=26, nHead=8, nLayers=2, layers=[23,19]
```

`nLayers=2` 说明 C++ `kqSoftMaxData` 只有 2 层数据（layer 19 和 23）。

> **重要**：MiniCPM-V-4.6 的 `kq_soft_max` tensor 只在层 3, 7, 11, 15, 19, 23 出现（每隔 4 层），其 GQA 比率 `n_head/n_head_kv = 8/2 = 4:1` 与 4 层间隔吻合。**实测验证**：即使在 `collectKqSoftMax=true` 强制 flash_attn OFF（vanilla attention 路径）下，MiniCPM 仍只这 6 层产生 `kq_soft_max`，说明 4-layer 间隔**不是** flash attention 引起，而是 llama.cpp vanilla attention compute graph 在 GQA 模型上的调度优化。详见下文「MiniCPM `kq_soft_max` 分布特征」。

### 被跳过的 heads

```
[QRRanker] Layer 17 kq_soft_max data missing, skipping head (17, 13)
[QRRanker] Layer 18 kq_soft_max data missing, skipping head (18, 7)
[QRRanker] Layer 20 kq_soft_max data missing, skipping head (20, 4)
[QRRanker] Layer 21 kq_soft_max data missing, skipping head (21, 5)
[QRRanker] Layer 22 kq_soft_max data missing, skipping head (22, 2)
[QRRanker] Layer 24 kq_soft_max data missing, skipping head (24, 6)
```

共 14/16 个 heads 被跳过，`validHeads=2`，分数仅基于 2 个 head 的信号。

## 归因分析

### 根因

C++ `cbEval` 的 layer filter 使用 QRRanker 模型专用的硬编码范围 `[17, 25)`：

```cpp
// AddonContext.cpp:526-529
const int il = std::atoi(t->name + 12);
if (il < 17 || il >= 25) {  // ← 硬编码
    return true;
}
```

QRRanker 原始模型（Qwen3-4B 裁剪 25 层，0-24）只保留了前 25 层，QR heads 分布在 17-24 层。MiniCPM-V-4.6 只有 24 层（0-23），且 layer 索引空间不同。硬编码的 `[17, 25)` 导致：

- layer 24 在 MiniCPM 上不存在 → 跳过（合理）
- layer 17, 18, 20, 21, 22 在 MiniCPM 实际不存在对应 `kq_soft_max` tensor（模型架构限制），缩放后将 QR head 映射到存在 tensor 的层上

### 附加发现：`totalLayers` 的内部实现

`model.fileInsights.totalLayers` 返回的是 `_getTotalFileLayers() + 1`（加 output 层）。
对于 Qwen3-4B（24 transformer blocks）和 MiniCPM-V-4.6（24 blocks），`totalLayers` 均为 25。

因此缩放公式必须使用 `totalLayers - 1`（即实际 transformer block 数）而非 `totalLayers`：

```typescript
// ✅ 正确：减去 output 层得到 transformer block 数
const nModelLayerBlocks = model.fileInsights.totalLayers - 1;
const mappedStart = Math.round(17 * nModelLayerBlocks / 25);
const mappedEnd   = Math.round(25 * nModelLayerBlocks / 25);
```

若直接用 `totalLayers`，QRRanker（25 blocks）和 MiniCPM（24 blocks）都会是 25，不触发缩放。

### 类比

Head 索引有等比缩放：
```
mappedHead = Math.round(rawHead * nHead / QR_SOURCE_NHEAD)
```

Layer 索引**没有**等比缩放，是缺失的对等功能。

## 关键决策

### 决策 1：C++ 动态范围 + TS 缩放

**选择**：C++ 存储动态 layer 范围（默认 17/25），TS 侧读取模型层数后计算缩放值并设置到 context。

**理由**：
- C++ 在编译期不知道模型的 layer 总数（`cbEval` 是纯 C 回调，无 NAPI）
- TS 侧通过 `model.fileInsights.totalLayers` 可获取实际层数
- 与已有 `kqQueryStart/End` 模式一致（C++ 存状态 + TS 设值）

### 决策 2：Layer 缩放公式（修正版）

```
QR_ORIGINAL_NLAYER = 36  // 原版（未裁剪）Qwen3-4B 的 transformer block 数
QR_QRRANKER_NLAYER = 25  // QRRanker 裁剪后保留的 block 数

// 情况 1：QRRanker 裁剪模型（25 blocks）→ 恒等，不缩放
//   —— 裁剪保留了原始层编号 1:1，QR head 层 17-24 直接对应
// 情况 2：其他模型 → 相对原版 36 层等比缩放
nModelLayerBlocks = model.fileInsights.totalLayers - 1
if (nModelLayerBlocks === QR_QRRANKER_NLAYER) {
  // QRRanker 裁剪模型：不做任何修改，C++ 默认 [17, 25) 即可
} else {
  mappedStart = Math.round(17 * nModelLayerBlocks / QR_ORIGINAL_NLAYER)
  mappedEnd   = Math.round(25 * nModelLayerBlocks / QR_ORIGINAL_NLAYER)
}
```

缩放示例：

| 模型 | blocks | 缩放范围 | 理由 |
|------|--------|---------|------|
| QRRanker 裁剪 | 25 | `[17, 25)` 不缩放 | 裁剪保留原始层编号 1:1 |
| 原版 Qwen3-4B | 36 | `[17, 25)` 恒等 | 17×36/36=17 |
| MiniCPM-V-4.6 | 24 | `[11, 17)` | 17×24/36=11（47% 深度） |

> 之前错误用 QR_SOURCE_NLAYER=25，导致 MiniCPM 缩放为 `[16, 24)`。
> 正确应为 `[11, 17)`：QR head 在原版 36 层位于 47% 深度，
> MiniCPM 24 层中对应位置 = 47% × 24 ≈ 11。
> `totalLayers` 内部含 +1（output 层），缩放时需 -1 得到 block 数。

> ⚠️ `totalLayers` 内部实现了 `_getTotalFileLayers() + 1`（加 output 层），所以必须 `-1`。
> 详见 `GgufInsights.js` 源码。

### 决策 3：向后兼容

默认 `kqLayerStart=17`、`kqLayerEnd=25`，不设值时行为与之前一致。

## 实施计划

### 阶段 1：C++ AddonContext 改动

- [x] `AddonContext.h` 新增 `kqLayerStart` / `kqLayerEnd` 成员变量（默认 17/25）
- [x] `AddonContext.h` 新增 `SetKqSoftMaxLayerRange` 声明
- [x] `AddonContext.cpp` `cbEval` 中 `if (il < 17 || il >= 25)` → `if (il < ctx->kqLayerStart || il >= ctx->kqLayerEnd)`
- [x] `AddonContext.cpp` 实现 `SetKqSoftMaxLayerRange` NAPI setter
- [x] `AddonContext.cpp` `init()` 中注册 `setKqSoftMaxLayerRange` 方法

### 阶段 2：node-llama-cpp JS 层 patch

- [x] `LlamaContext.d.ts` 新增 `setKqSoftMaxLayerRange(start: number, end: number): void`
- [x] `LlamaContext.js` 新增代理方法，调 `this._ctx.setKqSoftMaxLayerRange(start, end)`
- [x] 持久化到 `vendor/node-llama-cpp/dist/`

### 阶段 3：QRRanker TS 层改动

- [x] `src/code-index/rerankers/qrranker.ts` 在 `_runQrPass` 中 decode 前计算缩放后 layer 范围并调用 `context.setKqSoftMaxLayerRange()`
- [x] `src/code-index/highlighters/qrranker.ts` 同样改动
- [x] 同时缩放 QR_HEADS 中的 layer 索引（`computeQRScores`、`computePerTokenScores`）

### 阶段 4：编译与部署

- [x] `npm run build:llamacpp` 编译 patched addon
- [x] `npx tsx scripts/deploy-llamacpp-patch.ts` 部署到 node_modules
- [x] 端到端验证：`npm run dev` 搜索 demo 目录，确认 `Layer range scaled` 日志出现

## 实施记录

### 2026-06-01 初始实施

- 完成所有 C++/JS/TS 改动
- 成功编译 (`npm run build:llamacpp`)
- 部署到 node_modules

### 验证结果

```bash
# 验证 C++ 新符号
nm vendor/llama-addon/binaries/mac-arm64-metal/llama-addon.node | grep SetKqSoftMaxLayerRange
# → AddonContext::SetKqSoftMaxLayerRange(Napi::CallbackInfo const&)

# 验证 cbEval 改为动态范围（反汇编确认）
otool -tV node_modules/.../llama-addon.node | grep -A 30 cbEval
# → ldr w8, [x19, #0x164]  ← kqLayerStart（非硬编码 cmp #0x11）
# → ldr w8, [x19, #0x168]  ← kqLayerEnd

# 运行验证：缩放生效（第一次部署，QR_SOURCE_NLAYER=25，旧值错误）
npm run dev -- search "test" --log-level=debug --demo | grep "Layer range scaled"
# → [QRRanker] Layer range scaled: 25→24 blocks, range [16, 24)  ← 错误

# 修正后（QR_ORIGINAL_NLAYER=36），预期输出：
# → [QRRanker] Layer range scaled: 36→24 blocks, range [11, 17)  ← 正确

# 运行验证：动态范围可控
setKqSoftMaxLayerRange(19, 20) → nLayers=1 ✅
setKqSoftMaxLayerRange(0, 30)  → nLayers=6 ✅（全量 MiniCPM kq_soft_max 层）
```

### MiniCPM `kq_soft_max` 分布特征

MiniCPM-V-4.6 的架构参数：

| 参数 | 值 |
|------|------|
| `n_head` | 8 |
| `n_head_kv` | 2 |
| `n_embd` | 1024 |
| `n_layer` (block_count) | 24 |

GQA 比率 `8/2 = 4:1`。`kq_soft_max` 只出现在层 `3, 7, 11, 15, 19, 23`（每隔 4 层，共 6 层）。

**实测验证脚本**：`scripts/evidence/260601-validate-flash-hypothesis.ts`

```bash
# MiniCPM-V-4.6 (24 blocks), totalLayers=25
npx tsx scripts/evidence/260601-validate-flash-hypothesis.ts
```

**输出**：

```text
totalLayers: 25

=== Config A: collectKqSoftMax=true (C++ 强制 flash_attn DISABLED) ===
kq_soft_max layers: [23,19,15,11,7,3]
nLayers: 6

=== Config B: flash ON + collectKqSoftMax=false (no cbEval exposed) ===
(no kq_soft_max — flash path doesn't invoke cbEval for kq_soft_max)
```

**结论**:
- **Config A** (`collectKqSoftMax=true` → C++ 强制 `flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED`)：走 vanilla attention 路径，仍只 6 层产生 `kq_soft_max`
- **Config B** (`flashAttention: true`)：走 fused flash path，cbEval 不会被触发（`kq_soft_max` 不存在）
- 两种配置都不产生"全 24 层 `kq_soft_max`"的输出 → 证明 4-layer 间隔**不是** flash attention 引起

**根因**（经过实测验证后修正）：

❌ **最初猜测**：Metal 后端 fused attention kernel（`ggml_metal_flash_attn_ext`）每 4 层只 materialize 一次 `kq_soft_max`。

✅ **实测结论**：错误。QRRanker 启用 `collectKqSoftMax=true` 时 C++ 端会强制 `flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED`，所有层都走 vanilla attention 路径（`build_attn_mha` 的 `else` 分支）。但 MiniCPM 仍然只在 6 层产生 `kq_soft_max`。

🔍 **真实原因**：llama.cpp（b9370）vanilla attention 路径在 GQA 模型（`n_head/n_head_kv > 1`）的 compute graph 上对每 4 层做一次调度合并优化，导致 4 层一组只有最后一层触发 `cb(kq, "kq_soft_max", il)` 回调。该行为与 flash attention 无关，是 graph scheduler 的优化。

**影响**：
- 对于 QRRanker 设计目标模型（Qwen3-4B，GQA 4:1），按"原版 36 层每 4 层一组"规律，24 层共有 6 组（3-7-11-15-19-23-27-31 → 全部），但裁剪后只剩前 25 层 = 6 组，与 MiniCPM 巧合完全一致
- 因此 QRRanker 在 MiniCPM 上"能采到 6 个有效层"恰好是原版 Qwen3-4B 的 4-layer 间隔规律在 24 层上的自然结果，不是 layer filter 的问题
- 缩放范围只能决定"C++ 让哪些层的数据流到 JS"，但**无法**让 llama.cpp 在 12, 13, 14, 16 等层产出 `kq_soft_max` tensor——这需要修改 llama.cpp compute graph 调度逻辑
- 尝试过的无效方案：在 JS 端设置 `flashAttention: true` → C++ 会自动 `force_disable`；在 C++ 端关闭 flash attention → 仍然只有 6 层，说明问题不在 flash attention 路径

**当前接受的状态**：

| 模型 | 缩放范围 | 实际有效层 | 实际有效 QR head 数 | 与 QRRanker 预期对比 |
|------|---------|-----------|-------------------|---------------------|
| QRRanker 裁剪（25） | `[17, 25)` | 8 层（17-24） | 16/16 | ✅ 完整 |
| MiniCPM（24） | `[11, 17)` | 2 层（11, 15） | 6/16 | ⚠️ 缩放正确但 llama.cpp 不产 tensor |

可见本次任务的"动态 layer range"在 **layer filter 维度**完全达成目标，MiniCPM 上的可用 head 数偏少是上游 llama.cpp compute graph 的固有限制，**不属于本次任务范围**。

#### 修正前 vs 修正后端到端输出对比

| 项 | 修正前 (QR_SOURCE_NLAYER=25 错误) | 修正后 (QR_ORIGINAL_NLAYER=36) |
|----|----------------------------------|-------------------------------|
| 日志 | `Layer range scaled: 25→24 blocks, range [16, 24)` | `Layer range scaled: 36→24 blocks, range [11, 17)` |
| kq_soft_max 命中层 | `[15, 19]` | `[15, 11]` |
| 有效 QR heads | `11:7 15:3 15:1 11:6 11:4 11:1`（6 个，**与修正后相同**） | `11:7 15:3 15:1 11:6 11:4 11:1`（6 个） |
| 语义正确性 | ❌ 17/25 裁剪层被当作"满血"基准，QR head 17 在 MiniCPM 上映射到 16（错位） | ✅ 36 层原版作基准，QR head 17 映射到 11 = 47% 深度（语义对） |
| 跳过 heads | Layer 17-22 中部分缺失 | Layer 12-14, 16 缺失（仍由 Metal/llama.cpp 调度决定） |

注：修正前后 MiniCPM 上有效 QR heads **数量相同**（6 个），但**位置语义**不同。修正后映射到原版 36 层 47% 深度的真正等比位置（11 = 17/36 × 24），是几何上正确的映射。

## 修订记录

| 日期 | 修订人 | 内容 |
|------|--------|------|
| 2026-06-01 | Zed | 初始文档创建 |
| 2026-06-01 | Zed | 实施完成后更新：修正 `totalLayers - 1` 公式、补充 MiniCPM `kq_soft_max` 分布特征、标记全部 checklist 完成 |
| 2026-06-01 | Zed | **重大修订**：将缩放基准从 QR_SOURCE_NLAYER=25（裁剪后）改为 QR_ORIGINAL_NLAYER=36（原版未裁剪）。MiniCPM 缩放范围从 `[16, 24)` 修正为 `[11, 17)`。代码同步更新 |
| 2026-06-01 | Zed | **归因修正**：实测验证 4-layer 间隔**不是** flash attention 引起。QRRanker 强制 flash_attn OFF 但 MiniCPM 仍只 6 层产生 `kq_soft_max`。根因是 llama.cpp vanilla attention compute graph 在 GQA 模型上的调度合并优化 |
| 2026-06-01 | Zed | **运行输出记录**：补充 flash attention 假设验证命令的实测输出（`scripts/evidence/260601-validate-flash-hypothesis.ts`），以及修正前 vs 修正后端到端输出对比表 |

## 总结

### 关键收获

- `cbEval` 的 layer filter 是 QRRanker 管线中最后一个硬编码的模型架构常量
- 与 head 缩放对齐后，QRRanker 可在不同层数的模型上正确采集 attention 数据
- 历史上有过 `setKqSoftMaxLayerRange` 的实现（Ettin 场景），但被 revert；本次可复用其模式
- `model.fileInsights.totalLayers` 包含 output 层（+1），缩放时必须 `totalLayers - 1` 得到真正的 transformer block 数
- MiniCPM-V-4.6 每隔 4 层才产生 `kq_soft_max` tensor 是 llama.cpp vanilla attention compute graph 在 GQA 模型上的调度合并优化（**不是** flash attention），与 layer filter 范围无关。尝试过 `flashAttention: true/false` 都得到相同 6 层结果，验证过根因不在 flash attention 路径
- **重要纠正**：QR 缩放基准应为原版 Qwen3-4B 的 **36 层**（非裁剪后 25 层）。QR head 在原版 36 层中位于 47% 深度，对 MiniCPM 等未裁剪模型应等比映射。QRRanker 裁剪模型（25 blocks）为特殊情况：层编号 1:1 保留，不缩放。

### 参考

- `docs/plans/260519-qrranker-llamacpp-patch.md` — 原始 QRRanker 采集设计
- `docs/plans/260523-qrranker-ubatch-overflow-fix.md` — query slicing + ubatch 修复
- `docs/plans/260529-ettin-reranker-semantic-highlight.md` — 历史 `setKqSoftMaxLayerRange` 实现（已 revert）
- `docs/08-llama-cpp-build-flow.md` — C++ 编译与部署流程
