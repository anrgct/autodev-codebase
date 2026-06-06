# 260606-ggml-cbeval-decode-speed-fix

## 主题/需求

`collectKqSoftMax=true`（QRRanker 所需）下 token 生成速度比正常模式慢 **22 倍**（3.8 tps vs 84 tps），需要定位根因并在 llama.cpp 中修复。

### 背景

QRRanker 通过 `llama_context_params.cb_eval` 回调收集推理过程中的 `kq_soft_max` attention 矩阵。在 `@realtimex/node-llama-cpp` 的 C++ addon 中，设置 `collectKqSoftMax: true` 会：

1. `cb_eval = AddonContext::cbEval`
2. `flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED`

### 预期成果

- 修复 llama.cpp/ggml 调度器，使 `cb_eval` 模式下的 decode 速度恢复到正常水平（差异 < 5%）
- 将修复固化为 `build.mjs` 的自动 patch（Patch 11）
- 提供 A/B 速度测试脚本用于回归验证

## 代码背景

### 涉及文件

| 文件 | 位置 | 角色 |
|------|------|------|
| `ggml/src/ggml-backend.cpp:1677-1714` | llama.cpp 上游 | 调度器 `cb_eval` 分支（**根因所在**） |
| `vendor/llama-addon/AddonContext.cpp:512-601` | autodev-codebase | `cbEval` 回调实现 |
| `vendor/llama-addon/build.mjs` | autodev-codebase | 编译流程，包含 10 个已有 patch |

### 已有 patch 体系

`build.mjs` 的 Pass 2 使用 `patchFile()` 对克隆后的 llama.cpp 源码做字符串替换。已有 10 个 patch（涉及 `embd_layer`、`llama_get_embeddings_raw` 等）。本次新增 Patch 11。

### ggml 调度器 callback_eval 路径（修复前）

```cpp
// ggml/src/ggml-backend.cpp:1677-1714
if (!sched->callback_eval) {
    // 正常模式：整图一次 compute_async → Metal graph reuse 生效 → 84 tps
    ggml_backend_graph_compute_async(split_backend, &split->graph);
} else {
    // cbEval 模式：逐个 node 分组
    for (int j0 = 0; j0 < split->graph.n_nodes; j0++) {
        bool need = sched->callback_eval(t, true, ...);  // ask
        // while (!need) 向前扫描找下一个 need=true 的 node
        // 创建 subgraph [j0, j1]
        ggml_backend_graph_compute_async(split_backend, &gv);  // subgraph!
        ggml_backend_synchronize(split_backend);               // ← 无条件 sync
        if (need) callback_eval(t, false, ...);               // copy
    }
}
```

## 运行现象

### 复现命令

```bash
npx tsx scripts/evidence/260606-speed-50token-mode-vs-direct.ts
```

### 修复前

```
A 组 (collectKqSoftMax=true + kq 调用):  3.86 tps, per-token 259ms
B 组 (collectKqSoftMax=false):          84.45 tps, per-token  12ms
比率 A/B: 0.046x (A 慢 22 倍)
```

prefill 无差异（~4.5s），慢的全部集中在 decode 阶段。

### 控制变量实验

| 实验 | collectKqSoftMax | kq 调用 | 结果 |
|------|:--:|:--:|------|
| ① | true | **无** | 仍然 3.7 tps — flag 本身拖慢 |
| ② | false | — | 84 tps — 基线 |

→ 问题不在 C++/JS 端的 `getKqSoftMax` 调用，而在**设 flag 后 ggml 调度器换了条路**。

## 归因分析

### Fix 1 失败（条件 sync）

**假设**：`ggml_backend_synchronize` 在每个 subgraph 后被无条件调用，去掉非 `need` 节点的 sync 即可。

**修改**（1 行）：
```cpp
// 改前: ggml_backend_synchronize(split_backend);
// 改后: if (need) { ggml_backend_synchronize(split_backend); }
```

**结果**：仍然 3.8 tps，几乎无改进。

**原因**：去掉 sync 只是减少了 GPU fence 开销（~2-3ms/次），但 `ggml_backend_graph_compute_async` 仍然被多次调用，每次传入不同的 subgraph。

### Fix 2 成功（整图计算 + 后置拷贝）

**根因**：Metal 后端的 decode 性能（84 tps）严重依赖 **graph reuse** 优化——连续 `compute_async` 调用传入**相同的 graph** 时，Metal 后端复用上一轮的 compute pipeline state（shader 绑定、buffer 映射），只更新变化的 tensor 数据。

`cb_eval` 路径把图切成 subgraph：
```
split->graph (300 nodes)
  → subgraph[0..k1]  ← compute_async + sync
  → subgraph[k1+1..k2] ← compute_async + sync (不同 graph → reuse 失效!)
  → subgraph[k2+1..k3] ← compute_async + sync
  ...
```

每次 `compute_async(subgraph)` 传入的 graph 尺寸不同 → Metal 后端无法匹配缓存的 pipeline → **每次都从零 setup GPU 状态**。这是 22x 的真正来源（GPU pipeline setup cost vs 1-token decode 的极小计算量）。

**修复思路**：整张 split graph 一次 `compute_async`（Metal 走 graph reuse 快速路径），sync 一次后遍历 nodes 拷贝数据。

```cpp
// 修复后: 整图 compute → sync 一次 → walk nodes copy
} else {
    ggml_backend_graph_compute_async(split_backend, &split->graph);  // 整图！
    ggml_backend_synchronize(split_backend);                         // 一次 sync

    for (int j = 0; j < split->graph.n_nodes; j++) {
        if (callback_eval(t, true, ...)) {       // ask
            callback_eval(t, false, ...);        // copy
        }
    }
}
```

**权衡**：所有 kq_soft_max 数据在 sync 后批量从 GPU 读到 CPU，内存峰值略高（~200 MB vs 逐组 ~30 MB），但对 10051 token prompt 完全可接受。

## 关键决策

### 决策 1：Fix 2 而非 Fix 1

| | Fix 1 (条件 sync) | Fix 2 (整图+后置拷贝) |
|------|:--:|:--:|
| 改动量 | 1 行 | ~30 行 → 15 行 |
| graph reuse | ❌ 仍然被破坏 | ✅ 保留 |
| 性能 | 3.8 tps (无效) | 84 tps (恢复) |

Fix 1 思路正确（减少不必要的 sync），但未能解决 graph split 导致 reuse 失效的核心问题。

### 决策 2：用 `patchFile()` 而非修改上游源码

选择通过 `build.mjs` 的 `patchFile()` 在 clone 后 apply patch，而非 fork llama.cpp。理由：
- 与现有 10 个 patch 保持一致
- 跟随上游更新（旧 patch 不匹配时 `patchFile` 会 warn 而非崩溃）
- 无需维护独立的 llama.cpp fork

### 决策 3：固化到 build.mjs 的 Pass 2

Patch 11 插入在 Pass 2 的 `pass2_patchAndRebuild` 函数中（Patch 10 之后），与其他 header/model 文件 patch 并列。Pass 1 用原始代码编译完成后，Pass 2 替换 ggml-backend.cpp 并增量 rebuild。

## 实施计划

- [x] 定位根因：`ggml_backend_synchronize` 无条件调用 + subgraph 破坏 graph reuse
- [x] Fix 1 尝试（条件 sync）→ 无效，回退
- [x] Fix 2 尝试（整图+后置拷贝）→ 成功
- [x] 在 build.mjs 中新增 Patch 11
- [x] `npm uninstall` + `npm install` + `npm run build:llamacpp` 全链路验证
- [x] 速度回归测试确认 0.99x

## 实施记录

### 2026-06-06：定位

1. 编写 `260606-speed-50token-mode-vs-direct.ts` A/B 对比脚本
2. 第一次测试：A 3.86 tps vs B 84.45 tps → 22x 差距
3. 控制变量实验：去掉所有 `getKqSoftMax` 调用 → 仍然 3.7 tps → 问题在 `collectKqSoftMax` flag 本身
4. 定位到 `ggml-backend.cpp:1677-1714` 的 `else` 分支

### 2026-06-06：Fix 1（失败）

修改 `ggml-backend.cpp:1706`：`ggml_backend_synchronize` → `if (need) { synchronize }`。编译部署后测试仍 3.8 tps。确认 sync 频率不是主因。

### 2026-06-06：Fix 2（成功）

替换整个 `else` 分支：整图 `compute_async` + 一次 sync + 遍历拷贝。编译部署后 A 恢复到 84 tps。

### 2026-06-06：固化

1. 将 Fix 2 写入 `vendor/llama-addon/build.mjs` 作为 Patch 11
2. 还原到 `npm uninstall` + `npm install` 干净状态
3. `npm run build:llamacpp` 全量编译（clone → cmake → patch → rebuild → deploy）
4. 验证：A 86.52 tps vs B 84.57 tps → 1.02x（噪声级）

## 修订记录

| 日期 | 内容 |
|------|------|
| 2026-06-06 | 初始实施：Fix 1（条件 sync）→ 无效 |
| 2026-06-06 | Fix 2（整图+后置拷贝）→ 成功，固化到 build.mjs Patch 11 |

## 总结

### 关键收获

1. **Metal graph reuse 是 decode 速度的核心依赖**。任何将 compute graph 切成 subgraph 的操作都会破坏此优化，导致 20x+ 的性能回归。
2. **`ggml_backend_synchronize` 不是罪魁**（Fix 1 证明），真正的杀手是 **graph 分片**。
3. **批量 GPU→CPU 拷贝是安全的**：sync 后逐个 `ggml_backend_tensor_get` 拷贝 ~200 MB 数据的开销远小于多次 GPU pipeline drain。
4. **`patchFile()` 模式对上游源码的 patch 管理有效**：`JSON.stringify` 处理多行字符串的转义，确保 oldText 精确匹配 upstream。

### 参考

- 测试脚本：`scripts/evidence/260606-speed-50token-mode-vs-direct.ts`
- 编译流程：`docs/08-llama-cpp-build-flow.md`
- 原始 QRRanker 采集设计：`docs/plans/260519-qrranker-llamacpp-patch.md`
- QRRanker 动态 layer range：`docs/plans/260601-qrranker-dynamic-layer-range.md`
