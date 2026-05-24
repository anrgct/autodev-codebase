# 260524-midlayer-perf-investigation

## 主题/需求

提取中间层（`embd_layer`）改造后，`npm run dev -- index --force --demo` 索引耗时 28s，感觉比改造前慢。需要找出性能回退原因并验证。

**核心问题：** 中间层改造（llama.cpp C++ 层 `embd_layer` 支持 + node-llama-cpp/autodev JS 层集成）是否导致了索引性能回退？

**预期成果：**
- 确定性能回退的根因
- 对照实验验证中间层特性本身的性能影响
- 如果根因不在中间层，定位真正的变量

## 代码背景

### 改造涉及的层次

```
autodev-codebase/src/code-index/embedders/llamacpp-llm.ts  ← JS 层：_resolveLayer, embdLayer 参数传递
autodev-codebase/src/code-index/service-factory.ts         ← 配置传递
autodev-codebase/demo/autodev-config.json                  ← demo 配置：mean pooling, layer=-2
node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js      ← vendor JS：embdLayer → _embdLayer
node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js  ← vendor JS：_embdLayer → AddonContext
vendor/llama-addon/AddonContext.cpp                         ← C++ 绑定：options["embdLayer"] → context_params.embd_layer
vendor/llama-addon/build.mjs                                ← 两遍编译：Pass1 下载+编译, Pass2 patch+重编
llama.cpp/src/models/*.cpp                                  ← 107 个模型架构文件：if(il==embd_layer) 截断
```

### 关键 commit 时序

```
94a31cb  QR-attention pooling（有 mean 模式，默认 late-chunking）
32d8ce2  merge master
42aa578  build 重构 bash→JS（首次引入 build.mjs + embd_layer patch 逻辑）
b48bcd9  中间层改造（JS 层集成 embdLayer，默认 pooling 改为 mean）
d57740e  HEAD: fix 层解析边界条件
```

### 三种池化模式

| 模式 | 前向传播 | 适用场景 |
|------|:--:|------|
| `late-chunking` | 1次/文件（全文件 chunk 拼接） | 最快 |
| `mean` | 1次/chunk | 质量最优（L22-mean MRR=0.55） |
| `last-token` / `qr-weighted` | 1次/chunk | 实验性质 |

## 关键决策

### 决策 1：对照实验设计——在 JS 层添加 DISABLE_MIDLAYER 开关

**选择：** 添加 `_embdLayerParam()` 方法，通过 `DISABLE_MIDLAYER=1` 环境变量控制是否传递 `embdLayer` 参数。

**理由：**
- 只需改一个文件（`llamacpp-llm.ts`），5 处调用点统一控制
- 不修改二进制，只改变 JS → C++ 的参数流
- 可以快速 A/B 对比（`npm run dev` vs `DISABLE_MIDLAYER=1 npm run dev`）

### 决策 2：改造前二进制对照——checkout 42aa578 + 跳过 Pass 2 构建

**选择：** checkout `42aa578`（build 重构后、JS 层改造前），修改 `build.mjs` 跳过 Pass 2（patch 步骤），构建无 `embd_layer` 的清洁二进制，结合改造前 JS 代码形成完整的"改造前"对照环境。

**理由：**
- `42aa578` 的 JS 代码不含 `_resolveLayer`、`embdLayer` 参数——天然就是改造前
- 二进制跳过 Pass 2 后无任何 middle-layer patch——天然就是改造前
- 构建系统相同（同一套 `build.mjs`），排除构建差异干扰

## 实施计划

- [x] 添加 `DISABLE_MIDLAYER` 环境变量开关到 `llamacpp-llm.ts`
- [x] A/B 实验：有中间层 vs 关闭中间层（同二进制，纯 JS 层对比）
- [x] 备份当前二进制到 `/tmp/backup-binaries/`
- [x] Checkout `42aa578`，修改 `build.mjs` 跳过 Pass 2
- [x] 构建无 patch 清洁二进制 + 部署
- [x] 改造前对照实验：无 patch 二进制 + 改造前 JS + mean 模式
- [x] 恢复 HEAD + 原始二进制
- [x] 清理实验代码

## 实施记录

### 2026-05-24: 实验一——JS 层 A/B（DISABLE_MIDLAYER 开关）

在 `llamacpp-llm.ts` 添加 `_embdLayerParam()` 方法和 `DISABLE_MIDLAYER` 环境变量控制逻辑。5 处 `createEmbeddingContext({ embdLayer: ... })` 调用统一改为 `createEmbeddingContext(this._embdLayerParam(model))`。

```bash
# A 组：有中间层（embdLayer 正常传递）
time npm run dev -- index --force --demo
# real    0m27.472s

# B 组：关闭中间层（createEmbeddingContext 不传 embdLayer）
time DISABLE_MIDLAYER=1 npm run dev -- index --force --demo
# real    0m27.912s
```

**结果：** 差距 0.44s，在运行误差范围内。**JS 层 `embdLayer` 参数传递对性能无影响。**

### 2026-05-24: 实验二——改造前二进制对照

1. 备份 HEAD 二进制到 `/tmp/backup-binaries/`
2. `git checkout 42aa578`（build 重构后、中间层 JS 集成前）
3. 修改 `build.mjs` L284：注释 `pass2_patchAndRebuild(tag)`，跳过所有 llama.cpp patch
4. `npm run build:llamacpp`——229 个 object 全新编译，CMAKE_BUILD_TYPE=Release
5. 部署二进制 + 运行 `deploy-llamacpp-patch.ts` 拷贝 vendor JS 文件
6. 验证：JS 源码（`42aa578`）无 `_resolveLayer`，vendor JS 无 `embdLayer`

```bash
# 改造前：无 patch 二进制 + 改造前 JS + mean pooling + layer=-2
time npx tsx src/cli.ts index --force --path demo
# real    0m27.695s
```

**结果：** 改造前 27.7s vs 改造后 27.5s，差距 0.2s。**二进制层 patch 对性能无影响。**

### 2026-05-24: 恢复

```bash
git checkout d57740e
cp /tmp/backup-binaries/* → node_modules/@node-llama-cpp/mac-arm64-metal/bins/
npx tsx scripts/deploy-llamacpp-patch.ts  # 恢复 vendor JS
git checkout -- vendor/llama-addon/build.mjs  # 恢复 build.mjs
```

## 修订记录

（无）

## 总结

### 三组实验数据

```
                                         二进制     JS 层        pooling     耗时
──────────────────────────────────────────────────────────────────────────────────
实验一 A 组：HEAD                          有patch   有embdLayer   mean       27.5s
实验一 B 组：HEAD + DISABLE_MIDLAYER=1     有patch   无embdLayer   mean       27.9s
实验二：    42aa578 无patch二进制           无patch   无embdLayer   mean       27.7s
──────────────────────────────────────────────────────────────────────────────────
参考：      HEAD + late-chunking           有patch   有embdLayer   late-chk    9.8s
```

### 根因

**中间层改造（`embd_layer` 特性）对索引性能无任何影响。** JS 层参数传递、C++ 二进制 patch 均不改变前向传播耗时。

28s 索引时间的真正来源是 **`mean` 池化模式的固有开销**——每 chunk 独立前向传播。Demo 项目约 40-50 个 chunk，每个 chunk 一次完整 24 层 transformer 前向传播，累积耗时约 20s（减去模型加载 ~8s）。

### 改造中引入的实际变化

改造 commit `b48bcd9` 将 `_poolingMode` 默认值从 `"late-chunking"` 改为 `"mean"`：

```diff
- this._poolingMode = poolingMode ?? "late-chunking"
+ this._poolingMode = poolingMode ?? "mean"
```

虽然 demo 配置显式设置了 `"mean"`，但默认值变更会影响所有未显式指定池化模式的用户——这些用户会从 10s 级（late-chunking）变为 28s 级（mean）。

### 建议

- 如果追求速度：使用 `late-chunking`（~10s）
- 如果追求质量：继续用 `mean`（28s 是合理的代价，MRR 从 0.28 提升到 0.55）
- 默认值建议改回 `"late-chunking"`，让用户按需选择 `"mean"`
