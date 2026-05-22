# 260519-qrranker-llamacpp-patch

## 主题/需求

通过 hack `node-llama-cpp`（patch C++ addon 源码 + 预编译二进制分发）将 QRRanker 引入 autodev-codebase，实现基于 attention weights 的 listwise 重排序。

### 背景

QRRanker（MindscapeRAG/QRRanker）基于 Qwen3-4B-Instruct-2507，通过 QR attention heads 计算 query-document 相关性得分。已在 `open_provence_demo` 项目中跑通 PyTorch 版本，并成功转换为 GGUF 格式在 llama.cpp 中通过 `cb_eval` 回调获取 `kq_soft_max` 张量。

### 核心问题

`node-llama-cpp` 不暴露 `cb_eval` 回调——`AddonContext` 构造函数（`llama/addon/AddonContext.cpp#L394-464`）未读取和设置 `llama_context_params.cb_eval` 和 `cb_eval_user_data` 字段。

### 目标

- 修改 node-llama-cpp 的 C++ addon，使其支持在推理时收集 `kq_soft_max` attention 张量
- 编译 patched addon 为预编译二进制（`.node` 文件），提交到 autodev-codebase 仓库
- 用户 `npm install` 时自动部署预编译二进制，无需 cmake/C++ 编译器
- 在 autodev-codebase 中实现 `QRRankerReranker`（实现 `IReranker` 接口）

### 预期成果

- `vendor/llama-addon/` 目录：patched C++ 源码 + 预编译二进制 + 构建脚本
- `scripts/deploy-llamacpp-patch.ts`：postinstall 部署脚本
- `src/code-index/rerankers/qrranker.ts`：QRRanker reranker 实现
- 配置 `rerankerProvider: "qrranker"` + `rerankerQrrankerModelPath`

## 代码背景

### llama-addon.node 构建链路

`llama-addon.node` 是 C++ 源码通过 CMake 编译出来的 **Node.js 原生插件**（类似 `.dylib`/`.so`），是 JS 和 llama.cpp 之间的 C++ bridge。

**正常 `npm install`（不编译 C++）：**

```text-chart
npm install node-llama-cpp
  → node-llama-cpp postinstall
    → 检测平台 (mac-arm64-metal)
    → 下载 @node-llama-cpp/mac-arm64-metal 预编译包
    → 放置 llama-addon.node 到 node_modules/@node-llama-cpp/mac-arm64-metal/bins/
  ⚠️ 使用的 AddonContext.cpp 是原始版本（无 cb_eval）— 预编译包中的二进制
```

**我们的 build.sh（源码编译）：**

```text-chart
vendor/llama-addon/
  ├── AddonContext.cpp  ← patched（+cb_eval + NAPI getter）
  └── AddonContext.h    ← patched（+成员变量 + 方法声明）

build.sh 第一步：cp patched 源文件
  → 覆盖 node_modules/node-llama-cpp/llama/addon/AddonContext.cpp
  → 覆盖 node_modules/node-llama-cpp/llama/addon/AddonContext.h

build.sh 第二步：删除预编译二进制 + cmake 缓存
  → rm node_modules/@node-llama-cpp/mac-arm64-metal/bins/.../llama-addon.node
  → rm -rf node_modules/node-llama-cpp/llama/build/
  → rm -rf node_modules/node-llama-cpp/llama/localBuilds/

build.sh 第三步：触发源码编译
  → getLlama({usePrebuiltBinaries: false})
    → clone llama.cpp 源码（如未缓存）
    → cmake 配置（Metal backend、Accelerate BLAS、ARM dotprod/i8mm）
    → make -j 编译 ~229 个 translation unit（约 5 分钟）
    → 产出 llama-addon.node

build.sh 第四步：提取产物
  → 从 node_modules/.../llama/localBuilds/mac-arm64-metal/Release/llama-addon.node
  → 复制到 vendor/llama-addon/binaries/mac-arm64-metal/llama-addon.node
  → git commit（668KB，用户安装时无需编译）
```

**用户 `npm install`（运行时）：**

```text-chart
npm install
  → node-llama-cpp postinstall
    → 下载 @node-llama-cpp/mac-arm64-metal 预编译包（原始版本）
  → patch-package
    → 应用 JS 补丁（LlamaContext.getKqSoftMax 等）
  → scripts/deploy-llamacpp-patch.ts
    → 检测平台 mac-arm64-metal
    → cp vendor/llama-addon/binaries/mac-arm64-metal/llama-addon.node
      → node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node
    → 覆盖预编译包中的原始二进制为 patched 版本 ✅
  ⚠️ 用户不需要 cmake，不需要 C++ 编译器
```

**关键区别：**

| | 正常 `npm install` | 我们的 `build.sh` | 用户 `npm install` |
|------|:--:|:--:|:--:|
| 使用的二进制 | 预编译（原始） | 源码编译（patched） | 预编译（覆盖为 patched） |
| AddonContext.cpp | 无 `cbEval` | **有 `cbEval`** | **有 `cbEval`** |
| 需要 cmake？ | 否 | 是 | 否 |
| 耗时 | 0 秒 | ~5 分钟 | 0 秒 |

### node-llama-cpp 调用链

```
TypeScript                                    C++ Addon                          llama.cpp
──────────────────────────────────────────────────────────────────────────────────────────
LlamaContext._create() (LlamaContext.ts:885)
  └─ new AddonContext(model, options)        AddonContext::AddonContext (C++:394)
       contextSize, batchSize,                  └─ llama_context_default_params()
       flashAttention, threads,                 └─ 逐字段赋值
       embeddings, ranking, ...                 ⚠️ cb_eval 未设置 → nullptr

LlamaContext.dispatchPendingBatch()
  └─ this._ctx.decodeBatch()                 AddonContext::DecodeBatch (C++:676)
                                                └─ AddonContextDecodeBatchWorker
                                                   └─ Execute(): llama_decode(ctx, batch)
                                                      ⚠️ cb_eval=nullptr → 回调被跳过
```

### QRRanker 需要的 llama.cpp 能力

| 需求 | 机制 | 可行性 |
|------|------|:--:|
| 拦截 `kq_soft_max` 张量 | `llama_context_params.cb_eval` | ✅ 已是公开 API |
| 按层号过滤（layers 17-24） | `t->name` = `"kq_soft_max-{layer}"` | ✅ 张量命名约定 |
| GPU→CPU 数据拷贝 | `ggml_backend_tensor_get()` | ✅ 跨后端兼容 |
| 关闭 flash attention | `flash_attn_type = DISABLED` | ✅ 融合 op 不暴露中间张量 |

### 关键文件

| 文件 | 位置 | 改动 |
|------|------|:--:|
| `AddonContext.h` | `node-llama-cpp/llama/addon/` | 新增成员变量和方法声明 |
| `AddonContext.cpp` | `node-llama-cpp/llama/addon/` | 构造函数 + cbEval + NAPI getter |
| `AddonTypes.ts` | `node-llama-cpp/src/bindings/` | TS 类型定义 |
| `LlamaContext.ts` | `node-llama-cpp/src/evaluator/LlamaContext/` | 新增公开方法 |
| `types.ts` | `node-llama-cpp/src/evaluator/LlamaContext/` | LlamaContextOptions 新增选项 |

### QRRanker 推理流程（参考）

```
输入：[chunks + query] 拼接为一个序列
  → llama_decode(ctx, batch)
    → cbEval 被每个 kq_soft_max-{17..24} 张量触发
      → ask=true  → 记录形状
      → ask=false → ggml_backend_tensor_get() 拷贝到 CPU
  → 收集完毕：8 层 × [n_kv, n_tokens, n_head] float32 数组
  → JS 侧 computeQRScores():
      for each QR head (layer, head):
        attention_weights = kqSoftMaxData[layer][head, :, :]
        query_attn = mean(attention_weights[query_start:query_end, :])
        for each chunk:
          chunk_score += sum(query_attn[chunk_start:chunk_end])
  → 按 chunk_score 排序 → 返回 RerankerResult[]
```

## 关键决策

### 决策 1：分发方式 — vendor 预编译二进制 + postinstall 部署

**选择**：将编译好的 `llama-addon.node` 提交到 autodev-codebase 的 `vendor/llama-addon/binaries/`，postinstall 复制到 `node_modules/@node-llama-cpp/<platform>/bins/<platform>/`。

**理由**：
- 保留 `node-llama-cpp` 免编译的优势——用户不需要 cmake/C++ 编译器
- `.node` 文件约 200KB，适合 git 管理
- 不依赖 npm 发布或 GitHub Release

**方案对比**：

| 方案 | 用户安装成本 | 维护成本 |
|------|:--:|:--:|
| Fork + npm 发布预编译包 | 零 | 高（需 CI 多平台构建 + npm 发布） |
| Fork + git 依赖 + 本地编译 | 需 cmake + 5-10min | 低 |
| **vendor 预编译二进制** | 零 | 中（开发者需手动编译各平台） |

### 决策 2：C++ 改动策略 — 新增方法 + 纯 C 回调

**选择**：在 `AddonContext` 中新增：
- `static bool cbEval(ggml_tensor*, bool, void*)`：纯 C 回调，无 NAPI 依赖
- `GetKqSoftMax(layer)`：NAPI getter，返回单层数据
- `GetKqSoftMaxShape()`：NAPI getter，返回形状元信息
- `SetCollectKqSoftMax(bool)`：运行时开关

不修改 `AddonContextDecodeBatchWorker`，不改变解码流程。

**理由**：
- `cb_eval` 在 `AsyncWorker::Execute()` 内部被同步调用，不能访问 NAPI
- 纯 C 回调收集数据到 C++ 容器，解码结束后通过 NAPI getter 拉取
- 避免 JS↔C++ 跨边界回调的性能开销

### 决策 3：JS 侧集成方式 — 直接操作 AddonContext

**选择**：在 `LlamaContext` 上暴露 `getKqSoftMax()` / `getKqSoftMaxShape()` 方法，`QRRankerReranker` 直接调用。

不通过 `node-llama-cpp` 的标准高层 API（如 `LlamaChatSession`），因为 QRRanker 不需要自回归生成，只需要一次 `llama_decode`。

**理由**：
- `LlamaChatSession` 封装了 chat template 和自回归采样，QRRanker 不需要
- 直接使用 `LlamaContext` + `LlamaContextSequence.evaluateWithoutGeneratingNewTokens()` 更简单
- QR 后处理逻辑（chunk 范围计算、attention 聚合）放在 TypeScript 中更易维护

### 决策 4：QR score 计算在 TypeScript 侧

**选择**：C++ 只负责收集 `kq_soft_max` 原始数据，QR score 计算（attention 聚合、chunk 范围求和、QR head 筛选）在 TypeScript 中实现。

**理由**：
- QR head 配置（16 个 (layer, head) 对）可能在模型版本间变化，TS 侧更灵活
- 数据量小（8 层 × ~26MB = ~200MB），TypedArray 操作高效
- 方便调试和单元测试

### 决策 5：目录结构

```
autodev-codebase/
├── vendor/
│   └── llama-addon/
│       ├── AddonContext.h              ← patched 头文件（完整文件）
│       ├── AddonContext.cpp            ← patched 实现（完整文件）
│       ├── build.sh                    ← 一键编译脚本
│       └── binaries/
│           ├── mac-arm64-metal/
│           │   └── llama-addon.node
│           └── linux-x64/
│               └── llama-addon.node
├── scripts/
│   └── deploy-llamacpp-patch.ts        ← postinstall 调用
└── src/code-index/
    └── rerankers/
        └── qrranker.ts                 ← IReranker 实现
```

**理由**：
- `vendor/` 存放完整 patched 文件而非 diff，便于修改和维护
- 预编译二进制按平台分目录，`deploy-llamacpp-patch.ts` 根据 `process.platform + arch` 选择
- 构建脚本 `build.sh` 独立可运行，不依赖 CI

## 实施计划

### 阶段 1：C++ addon 修改与编译

- [x] 步骤 1：创建 `vendor/llama-addon/` 目录结构
- [x] 步骤 2：基于 node-llama-cpp 3.18.1 的 `AddonContext.h/.cpp`，编写 patched 版本
- [x] 步骤 3：编写 `vendor/llama-addon/build.sh` —— 复制源文件到 node_modules + 触发 cmake 编译 + 提取 .node
- [x] 步骤 4：执行 `build.sh`，生成 `mac-arm64-metal/llama-addon.node`（668KB），提交到 git

### 阶段 2：TypeScript 类型与 API 暴露

- [x] 步骤 5：patch `node_modules/node-llama-cpp/dist/` 中的 `.js` / `.d.ts` 文件（`AddonTypes.ts`、`LlamaContext/types.ts`、`LlamaContext.ts`）
- [x] 步骤 6：使用 `patch-package` 生成 `.patch` 文件，追加到 `patches/node-llama-cpp+3.18.1.patch`

### 阶段 3：部署脚本

- [x] 步骤 7：编写 `scripts/deploy-llamacpp-patch.ts`
  - 检测当前平台
  - 复制 `vendor/llama-addon/binaries/<platform>/llama-addon.node` → `node_modules/@node-llama-cpp/<platform>/bins/<platform>/`
- [x] 步骤 8：修改 `package.json` 的 `postinstall`：`patch-package && npx tsx scripts/deploy-llamacpp-patch.ts`

### 阶段 4：QRRanker IReranker 实现

- [x] 步骤 9：实现 `QRRankerReranker`（`src/code-index/rerankers/qrranker.ts`）
  - 加载 GGUF 模型
  - 构造输入 prompt（query + documents 拼接）
  - 创建启用 `collectKqSoftMax` 的 context
  - 调用 `evaluateWithoutGeneratingNewTokens()`
  - 从 context 拉取 `kq_soft_max` 数据
  - 计算 QR scores + 排序
- [x] 步骤 10：在 `service-factory.ts` 的 `createReranker()` 中增加 `"qrranker"` provider 分支
- [x] 步骤 11：在配置接口中增加 `rerankerProvider: 'qrranker'` 类型
- [x] 步骤 12：端到端验证 —— 用 demo 数据对比 PyTorch 输出

### 阶段 5：多平台支持（后续）

- [ ] 步骤 13：linux-x64 平台编译与验证
- [ ] 步骤 14：win-x64 平台编译与验证（可选，需交叉编译环境）

## 实施记录

_待实施_

## 修订记录

### 2026-05-22（Head 等比映射 + 跨模型安全）

QR_HEADS 硬编码 16 个 `(layer, head)` 对，head 索引最高 31，基于 32-head Qwen3-4B 训练。非 QRRanker 模型（16-head/8-head）上 head 越界读取 Float32Array 返回 `undefined` → 全部分数 NaN。

**Head 等比映射：** `computeQRScores` / `computePerTokenScores` 中 `mappedHead = Math.min(Math.round(rawHead × nHead / 32), nHead - 1)`。32-head 走 identity（零开销）。映射后 16 head 全部存活，normalizer 按 `validHeads` 计数。

**Layer 缺失降级：** `warn → debug` — 非 QR 模型上层不匹配是预期行为。

**Detokenize 前置：** reranker 在 `_rerankBatch` 中对 code 区域 token 逐个 `model.detokenize([id])`，payload 传 `_qrrankerTokenTexts: string[]` 替代 `_qrrankerCodeTokenIds`。highlighter 不需要加载模型/碰词表，消除跨模型 `std::out_of_range` crash。

**一行 debug 打印选中 heads：** `QR heads (nHead=16): 17:2 22:2 21:4 ...`

### 2026-05-19（ubatch 覆盖 bug）

**问题描述**：当 `batchSize = 2048` 且输入 token 数（如 5510）超过该值时，QRRanker 所有 chunk 得分全为 0。

**根因**（三层）：

1. **llama.cpp 内部 micro-batching**：`context_params.n_ubatch = n_batch = 2048`。`llama_decode` 发现输入 5510 > 2048，自动切成 3 个 micro-batch，每个独立执行完整的前向计算。

2. **`cbEval` 每 micro-batch 触发一次且覆盖写入**：C++ `cbEval` 回调将数据按 layer 索引存入 `std::unordered_map<int, std::vector<float>>`(`AddonContext.cpp:506-508`)：
   ```cpp
   auto &buf = ctx->kqSoftMaxData[il];
   buf.resize(nbytes / sizeof(float));
   ggml_backend_tensor_get(t, buf.data(), 0, nbytes);  // ← 覆盖
   ```
   第 2、3 个 micro-batch 依次覆盖第 1 个的数据，最终只剩最后一个 micro-batch（1414 tokens）的 attention 矩阵。

3. **JS 侧用完整 token 范围索引**：`computeQRScores()` 中的 `queryStart`、`queryEnd`、`chunkRanges` 基于全部 5510 token 计算，去索引只有 1414 行/列的 attention 数据 → 索引越界/全零。

**执行流程**：
```
batchSize=2048, tokens=5510:
  micro-batch 1: [0, 2048)  → kq_soft_max [2048, 2048, 32] → kqSoftMaxData[layer] = data1 ✅
  micro-batch 2: [2048, 4096) → kq_soft_max [4096, 2048, 32] → kqSoftMaxData[layer] = data2 ❌ 覆盖
  micro-batch 3: [4096, 5510) → kq_soft_max [5510, 1414, 32] → kqSoftMaxData[layer] = data3 ❌ 覆盖
  → computeQRScores() 用全部 5510 个 token 的范围去取 nTokens=1414 的数据 → chunk 得分全 0
```

**修复**：
- `batchSize = Math.min(tokens.length, 8192)`（`qrranker.ts:258`），让所有 token 落在一个 micro-batch 内，`cbEval` 只触发一次，拿到完整 attention 矩阵
- 超过 8192 时 warn，建议减少候选数或截断内容

**未来方向**：如需支持超长输入（>8192 tokens），需修改 C++ `cbEval` 在 `ask==true` 阶段按 micro-batch 偏移量分段累积，而非整体覆盖。但当前场景（20 候选 × ~400 token）不涉及。

### 2026-05-19（分片批处理）

**问题**：单 batch 处理全部 20 个候选（5510 tokens）耗时 7334ms，attention 计算 O(n²) 导致随候选数增长越来越慢。

**修复**：参照 `LlamaCppLLMReranker` 的分片模式，在 `QRRankerReranker` 中增加分片 + 并发逻辑：

- 新增构造参数 `batchSize`（默认 10）、`concurrency`（默认 2）、`maxRetries`、`retryDelayMs`
- `rerank()` 中将 candidates 按 `batchSize` 切片，每组独立运行 `_rerankBatch()`（`qrranker.ts:221-237`）
- 并发控制：`Promise.all()` 每组 `concurrency` 个 batch（`qrranker.ts:232-234`）
- 失败重试：`_rerankBatchWithRetry()` 指数退避，最终 fallback 为 score=0（`qrranker.ts:294-316`）
- 结果日志抽取为 `_logResults()`，在所有 batch 完成后一次性输出（`qrranker.ts:318-331`）
- `service-factory.ts` 从 config 传递 `batchSize`/`concurrency` 参数
- demo 配置改为 `rerankerBatchSize: 10`, `rerankerConcurrency: 2`

**性能预估**：20 candidates × ~275 tokens batchSize=10 → 2 groups → ~2 × 3000ms ≈ 6000ms（vs 单 batch 29577ms）

**注意**：跨 batch 分数不可直接比较（每 batch 的 attention 分布因输入不同而不同），但组内排序准确。

### 2026-05-19（部署策略修正）

**问题 1：patch-package 无法解析手动追加的 patch**

之前 QRRanker 的 JS 层修改是手动拼接到 `patches/node-llama-cpp+3.18.1.patch` 末尾的，
`patch-package` 8.0.1 解析时报 `Unexpected file mode string: 160000`。

**修复**：标准流程重生成——
1. `npm install node-llama-cpp@3.18.1`（干净安装）
2. 手动 patch 原始 3 个文件 + 新增 4 个 QRRanker 修改
3. `npx patch-package node-llama-cpp` 重新生成完整 patch

同时将 `patch-package` 和 `tsx` 从 `devDependencies` 移到 `dependencies`，
确保用户 `npm install` 时 postinstall 不失败。

**问题 2：vendor 中 .dylib 文件的取舍**

源码编译产出的 `.node` 链接 `.dylib` 格式的动态库，但 `@node-llama-cpp`
官方预编译包中这些库是 `.so` 后缀的 **Mach-O bundle**，不能被 dylib `dlopen`。

分析官方预编译包后确定：
- 原始预编译包已有的 (`.dylib`)：`libggml-base.dylib`、`libggml.metal.*.dylib`、
  `libllama.metal.*.dylib` — **不存 vendor**，直接复用
- 原始预编译包是 `.so` bundle 的：`libggml-cpu`、`libggml-blas`、
  `libggml-metal` — **源码编译产出的 `.dylib` 存入 vendor**

vendor 最终仅有 4 个二进制文件：`llama-addon.node` + 3 个 `.dylib`。

**问题 3：localBuilds 缓存覆盖补丁二进制**

`getLlama()` 的加载优先级是 **localBuilds > 预编译包**（见 `getLlama.js#L350-430`）。
当预编译二进制加载失败时，`node-llama-cpp` 会自动回退源码编译，在
`node_modules/node-llama-cpp/llama/localBuilds/` 下产出 **未打补丁** 的 `.node`。
下一次 `getLlama()` 调用时优先加载它，覆盖了 `@node-llama-cpp/.../bins/` 中
的 patched 版本，导致 `getKqSoftMaxShape is not a function`。

**修复**：`deploy-llamacpp-patch.ts` 在部署前 `rm -rf localBuilds/`。

**根本方案**：`build.sh` 用 `usePrebuiltBinaries: false` 触发源码编译，
产物直接写入 `localBuilds/`（`compileLLamaCpp.js#L43`），然后 `build.sh` 提取
`.node` + `.dylib` 到 vendor。用户侧 `deploy-llamacpp-patch.ts` 清除 localBuilds
并部署到预编译目录，`getLlama()` 走优先级 2 加载 patched 版本。

## 总结

### 关键收获

1. **`cb_eval` 是公开 API，无需修改 llama.cpp 本体**：`llama_context_params` 已包含 `cb_eval` 和 `cb_eval_user_data`，只是 node-llama-cpp 的 addon 未传递它们。

2. **C++ 侧收集 + JS 侧拉取是最优模式**：避免了 C++→JS 同步回调的 NAPI 限制和性能问题。

3. **vendor 预编译二进制 > npm 发布**：对于单项目使用的 patch，vendor 方式最简单——免构建、免 CI、免 npm 发布流程。`.node` 文件仅 200KB，git 友好。

4. **`patch-package` 对 C++ 无效**：因为 node-llama-cpp 使用预编译二进制，patch C++ 源码不会触发重编译，需要手动编译 + 部署预编译二进制。

### 参考

- QRRanker GGUF 转换：`open_provence_demo/docs/plans/260519-qrranker-gguf-convert.md`
- QRRanker PyTorch 集成：`open_provence_demo/docs/plans/260519-qrranker-integration.md`
- QRRanker GGUF 可行性：`open_provence_demo/docs/plans/260519-qrranker-gguf-feasibility.md`
- autodev-codebase llama.cpp provider：`autodev-codebase/docs/plans/260510-llamacpp-provider-auto-dimension.md`
- node-llama-cpp 现有 patch：`autodev-codebase/patches/node-llama-cpp+3.18.1.patch`
