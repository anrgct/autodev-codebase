# @realtimex/node-llama-cpp Patch 构建与部署流程

autodev-codebase 对 @realtimex/node-llama-cpp 有两层修改，对应两套部署机制。

> **包替换说明：** 原使用 `node-llama-cpp` v3.18.1（内置 llama.cpp b8390），
> 2026-05-28 替换为 `@realtimex/node-llama-cpp` v0.163.0（内置 llama.cpp b9370）。
> 理由是 `@realtimex/node-llama-cpp` 预编译了最新 llama.cpp，支持 `gemma4` 分词器。
> 迁移变更：`docs/plans/260528-node-llama-cpp-gemma4-tokenizer.md`

---

## 两层架构

| 层 | 位置 | 修改内容 | 部署方式 |
|------|------|------|------|
| **JS/DTS** | `vendor/node-llama-cpp/dist/*.js` / `*.d.ts` | 新增参数、方法、类型声明 | 文件覆盖（`deploy` 脚本） |
| **C++** | `vendor/llama-addon/` + llama.cpp 源码 | 修改 AddonContext、llama.h、模型文件 | `build.mjs` 编译 + `deploy-llamacpp-patch.ts` 部署 |

两层修改的完整文件均保存在 `vendor/` 下，架构统一：JS/DTS 在 `vendor/node-llama-cpp/dist/`，C++ 在 `vendor/llama-addon/`。`deploy` 脚本负责将所有 vendor 文件部署到 `node_modules` 运行位置。

---

## 流程 1：JS/DTS 层（`npm install` 自动完成）

```bash
npm install
# → postinstall 自动执行：
#   npx tsx scripts/deploy-llamacpp-patch.ts
#     ├── JS/DTS 层：扫描 vendor/node-llama-cpp/dist/ →
#     │   逐文件覆盖到 node_modules/@realtimex/node-llama-cpp/dist/
#     │   （替换了旧方案 patch-package）
#     └── C++ 层：复制 .node + dylib 到 @realtimex/node-llama-cpp-<platform>/bins/
```

### 部署策略：完整文件覆盖（替代 patch-package）

原来使用 `patch-package` 生成 `.patch` 差异文件，apply 时依赖上下文匹配，存在以下问题：
- 不可审计——diff 格式不直观，改了什么需要反向还原
- 脆弱——上游小版本更新可能导致上下文匹配失败
- 架构不统一——JS 层用 diff，C++ 层用完整源码

新方案将 patched 文件的**完整副本**保存在 `vendor/node-llama-cpp/dist/`，部署时直接覆盖。附带版本检查：`deploy` 脚本比对 installed 版本与 `vendor/node-llama-cpp/.version` 中的基线，不匹配时告警。

### 涉及文件

| 文件 | 说明 |
|------|------|
| `vendor/node-llama-cpp/dist/` | 修改过的 JS/DTS 文件完整副本（7 个文件） |
| `vendor/node-llama-cpp/.version` | 基线版本（如 `0.163.0`），deploy 时做版本比对 |
| `scripts/deploy-llamacpp-patch.ts` | 部署脚本：JS 覆盖 + C++ 二进制复制 + 版本检查 |
| `vendor/llama-addon/binaries/<platform>/llama-addon.node` | 预编译 C++ addon |
| `vendor/llama-addon/binaries/<platform>/*.dylib` | 全部 dylib（含 `libllama-common.dylib`、`libggml-base.dylib`） |

### 修改 JS 层的工作流

```bash
# 1. 直接改 node_modules 中的文件（开发调试）
vim node_modules/@realtimex/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js

# 2. 验证通过后，复制回 vendor（持久化）
cp node_modules/@realtimex/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js    vendor/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js

# 3. 如果新增了文件，同样复制并在 deploy 脚本中确认覆盖逻辑
```

### 版本升级时的处理

```bash
# 当 package.json 中 @realtimex/node-llama-cpp 版本号变更后：
npm install              # 安装新版本
# deploy 脚本会输出版本不匹配告警：
#   ⚠️  installed: 0.164.0  vendor baseline: 0.163.0
# 此时需要：
# 1. review 新版本改动，确认 vendor 中的 patch 是否仍需调整
# 2. 更新 vendor/node-llama-cpp/dist/ 中的文件
# 3. 更新 vendor/node-llama-cpp/.version
# 4. 重新运行 npm install 验证

---

## 流程 2：C++ addon 源码编译（`npm run build:llamacpp`）

当需要修改 C++ 层（`AddonContext.cpp`、`llama.h`、模型文件等）时触发。`build.mjs` 内建**两遍编译**，一次命令完成全部流程。

### 一键编译

```bash
npm run build:llamacpp
# → node vendor/llama-addon/build.mjs
```

### 完整流程图

```text-chart
[vendor/llama-addon/ 源码]
  AddonContext.h / AddonContext.cpp  ← 开发者手动编辑
         │
         ↓
[build.mjs: 准备阶段]
  1. 检测平台 tag（mac-arm64-metal / linux-x64 / ...）
  2. 删除可能冲突的预编译 binary
  3. 清理 build 和 localBuilds 缓存
         │
         ↓
[build.mjs: Pass 1 — getLlama 下载 + 编译]
  4. 运行 build-trigger.mjs
         │  ↑ 使用 npm install 自带的原始 AddonContext（不含 embd_layer 引用）
         ↓
[getLlama 内部]
  5. clone llama.cpp 官方源码到 node_modules/.../llama.cpp/
  6. cmake-js configure（自动设置平台/variant/Metal 等参数）
  7. cmake-js build → 产出原始 AddonContext + 上游未 patch 的 llama.cpp
         │  此时 cmake build 目录就绪，cache 保留全部平台参数
         ↓
[build.mjs: Pass 2 — 逐个检查并 patch header + 模型文件]
  8. 对 4 个 header 文件逐一执行 patchFile()：
     - 检查 newText 是否已存在（原生支持或已 patch 过）→ 跳过
     - 否 → 替换 oldText → 应用 patch
     - 4 个 target：llama.h / llama-cparams.h / llama-context.cpp ×2
         │
         ↓
  9. 检查模型文件是否需要 patch（检查 gemma.cpp 是否已含 embd_layer）
         │
         ├─ 已含 → 跳过
         │
         └─ 缺失 → 运行 add-midlayer-embd.py patch 所有模型文件
              （脚本依赖上游代码模式，可能因更新而失败，但不影响编译）
         │
         ↓
[build.mjs: 复制 patched AddonContext + 增量重编]
  9. 复制 AddonContext.h/cpp → node_modules/.../llama/addon/
 10. cmake --build <localBuilds/<variant>/> --config Release
     ↑ header 已 patch，AddonContext 编译通过
         │
         ↓
[build.mjs: 收集产物]
 11. 多路径 fallback 查找 llama-addon.node
     a) @node-llama-cpp/<platform>/bins/
     b) localBuilds/<variant>/
     c) find 整个 node_modules/node-llama-cpp
 12. 复制 .node → vendor/llama-addon/binaries/<platform>/
 13. 复制全部 `.dylib`（包括 `libllama-common.dylib`、`libggml-base.dylib` 等）→ 同上
```

### 步骤详解

#### 步骤 1：编辑 AddonContext（每次改 C++ 绑定必做）

```bash
vim vendor/llama-addon/AddonContext.cpp
vim vendor/llama-addon/AddonContext.h
```

#### 步骤 2：llama.cpp 源码 patch（自动处理）

**不需要手动操作。** `build.mjs` 在 Pass 2 中逐文件检查和 patch：

1. **内联 patch 4 个 header 文件**（`patchFile()` 函数）：
   - 检测策略：每处 patch 检查其 `newText` 是否已存在文件内容中
     - 若存在 → 跳过（已原生支持或已 patch 过）
     - 若不存在 → 查找 `oldText` 并替换
   - 4 个 target：
     - `include/llama.h` — 给 `llama_context_params` 添加 `int32_t embd_layer`
     - `src/llama-cparams.h` — 给 `llama_cparams` 添加 `int32_t embd_layer = -1`
     - `src/llama-context.cpp` — 构造函数中拷贝 `cparams.embd_layer = params.embd_layer`
     - `src/llama-context.cpp` — 默认参数中设 `embd_layer = -1`
   - ⚠️ 上游 llama.cpp **并未**原生支持 `embd_layer`，所有 patch 都是项目自有的
2. **运行模型 patch 脚本**：
   - 先检测 `src/models/gemma.cpp` 是否已含 `embd_layer`
   - 若已含 → 跳过（避免重复 patch 导致脚本失败）
   - 若缺失 → 运行 `add-midlayer-embd.py` patch 全部模型文件
   - ⚠️ 模型脚本依赖上游代码模式，可能因上游更新而失败。header patch 是编译必需的（保证 AddonContext 通过），模型脚本失败仅影响运行时中间层 embedding 功能，不影响编译。

> **为什么 AddonContext 在 Pass 2 才复制？** patched AddonContext 引用了 `embd_layer`，该字段仅在 patch 后的 `llama.h` 中存在。Pass 1 使用 npm 自带的原始 AddonContext 让 `getLlama` 先编译通过，Pass 2 patched header 后再复制 patched AddonContext 并重编。

#### 步骤 3：编译

```bash
npm run build:llamacpp
```

#### 步骤 4：部署到 node_modules 加载路径

```bash
npx tsx scripts/deploy-llamacpp-patch.ts
```

该脚本从 `vendor/llama-addon/binaries/<tag>/` 复制到两个路径（`getPrebuiltBinaryPath` 查找顺序）：
1. `dist/bins/<tag>/` — `getLlama` 内部第一优先 prebuilt 路径
2. 平台包 `<platform-pkg>/bins/<tag>/` — 第二优先（npm 官方 prebuilt 位置）

每次复制包含：
- `llama-addon.node` + `_nlcBuildMetadata.json`（构建元数据，`getPrebuiltBinaryBuildMetadata` 需要）
- 全部 `.dylib`（`llama-addon.node` 的 `@rpath` 依赖 `libllama-common.dylib` 等，缺一不可）

> 不再清理 `localBuilds`。`getLlama` 先查 prebuilt，加载失败才回退到 localBuild。保留 localBuilds 作为安全 fallback，且避免首次运行时触发从源码重新编译（耗时约 5 分钟）。

### 设计要点

**为什么是两遍编译（实为三阶段）？**

Pass 1 用原始 AddonContext 编译（`embd_layer` 字段尚不存在于上游 header），Pass 2 patched header + 复制 patched AddonContext，最后 `cmake --build` 增量重编。

| 问题 | 原因 |
|------|------|
| 能不能在 Pass 1 中直接 patch？ | ❌ `getLlama()` 内 `compileLlamaCpp()` 把 clone + cmake 编译包在同一个 `withLockfile` 中，中间没有 hook。 |
| 能不能只跑一遍？ | ❌ patched AddonContext 引用 `embd_layer`，该字段仅在 patch 后的 header 中存在。Pass 1 必须先让原始 AddonContext 编译通过。 |
| 模型 patch 脚本失败了怎么办？ | ⚠️ 模型脚本依赖上游代码模式，可能因 llama.cpp 更新而失败。内联 header patch 是编译必需的（保证 AddonContext 通过），模型脚本失败仅影响运行时 `embd_layer` 功能在模型层的支持，不影响编译。`build.mjs` 会自动检测模型文件是否已 patch 过（检查 `gemma.cpp` 是否含 `embd_layer`），避免重复执行导致误报失败。 |
| 为什么用 `cmake --build` 而不是再跑 `cmake-js`？ | ✅ Pass 1 的 `cmake-js configure` 已经正确设置了平台、Metal、variant、架构等全部参数，增量编译只需 `cmake --build`，不需要重新 configure，也不需要手写 cmake-js 参数（避免平台硬编码）。 |

**为什么需要 hash 版 dylib？**

官方预编译包中的 `.so` 文件是 Mach-O bundle 格式，不能作为 shared library 被 `dlopen`。源码编译产生的 `.dylib` 文件名包含 cmake-options hash（如 `libllama.metal.b8390.2da1n284.dylib`），`llama-addon.node` 在链接时依赖这些精确的文件名。详见 `docs/plans/260523-qrranker-ubatch-overflow-fix.md`。

**为什么不再清理 `localBuilds`？**

因为 `getLlama` 的 `loadExistingLlamaBinary` 函数先查 **prebuilt 路径**，再查 **localBuilds**。只要 `dist/bins/<tag>/` 有完整的 `.node` + metadata + dylib，就会走 prebuilt 路径。localBuilds 仅作为 `prebuilt` 加载失败时的回退。

保留 localBuilds 的好处：
1. 首次运行时立即使用，无需重新编译（省 5 分钟）
2. 如果 `build:llamacpp` 后忘记 deploy，localBuilds 仍能兜底

---

## 核心文件

| 文件 | 作用 |
|------|------|
| `vendor/llama-addon/build.mjs` | 主编译入口：复制 AddonContext → Pass 1 (getLlama) → Pass 2 (patch + rebuild) → 收集产物 |
| `vendor/llama-addon/build-trigger.mjs` | 调用 `getLlama({usePrebuiltBinaries: false})` 触发下载 + 编译 |
| `vendor/llama-addon/AddonContext.h` / `.cpp` | C++ addon 源码（N-API 绑定层），累积多个功能的改动 |
| `scripts/deploy-llamacpp-patch.ts` | 将 vendor 下的二进制部署到 node_modules 加载路径 |
| `vendor/node-llama-cpp/dist/` | 修改过的 JS/DTS 文件完整副本（7 个文件） |
| `scripts/add-midlayer-embd.py` | 模型文件 patch 脚本（对 97 个模型文件添加中间层 embedding 支持） |

### build-trigger.mjs

```js
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

const llama = await getLlama({
    logLevel: LlamaLogLevel.warn,
    gpu: "metal",
    usePrebuiltBinaries: false,
    cmakeOptions: {
        GGML_NATIVE: "OFF",          // 避免 ARM try_run 卡住
        GGML_CPU_ARM_ARCH: "armv8.6-a+dotprod+i8mm",
    },
    progressLogs: true,
});
```

> `GGML_NATIVE=OFF`：macOS ARM 下 CMake `try_run` 会交叉编译并尝试执行，可能卡住。设 `OFF` + 显式指定 `GGML_CPU_ARM_ARCH` 规避。源自 QRRanker 采集需求，详见 `docs/plans/260523-qrranker-ubatch-overflow-fix.md`。

---

## 常见问题

### Q: 如何查看改动了哪些 JS/DTS 文件？

```bash
diff -rq vendor/node-llama-cpp/dist/ node_modules/@realtimex/node-llama-cpp/dist/
# 或查看 vendor 目录直接看完整源码：
ls -R vendor/node-llama-cpp/dist/
```

### Q: 改了 AddonContext.cpp 后必须重编 addon 吗？

是的。`.node` 是编译后的二进制，修改 C++ 源码必须重新编译。

### Q: 改了 llama.h（如新增字段）后必须重编吗？

是的。AddonContext.cpp `#include "llama.h"`，头文件变更需重新编译 addon 和 libllama.dylib。

### Q: build.mjs 报 `addVariantSuffix` 错误？

cmake 变量（`NLC_VARIANT`、`NLC_CURRENT_PLATFORM`）未正确传入。`build-trigger.mjs` 通过 `getLlama` 自动设置这些变量，直接调用 `cmake-js` 时需手动传 `--CD` flags。

### Q: 如何验证 C++ addon 是否包含我的改动？

```bash
# 检查 .node 链接的 dylib
otool -L vendor/llama-addon/binaries/mac-arm64-metal/llama-addon.node

# 检查导出的符号
nm vendor/llama-addon/binaries/mac-arm64-metal/llama-addon.node | grep -i embd
```

---

## C++ 层当前修改范围

`vendor/llama-addon/` 累积了以下功能的 C++ 改动，编译后的二进制包含全部：

| 功能 | 涉及文件 | 关联文档 |
|------|------|------|
| 中层 embedding 提取 (`embd_layer`) | `AddonContext.h/cpp`、`llama.h`、107 个模型文件 | `docs/plans/260524-llamacpp-midlayer-embd.md` |
| QRRanker `kq_soft_max` 采集 | `AddonContext.h/cpp`（`collectKqSoftMax`、`kqQueryStart/End`、`cbEval` 等） | `docs/plans/260523-qrranker-ubatch-overflow-fix.md` |

---

## 相关文档

- `docs/plans/260524-llamacpp-midlayer-embd.md` — 中层 embedding 提取的完整设计、实施与验证
- `docs/plans/260523-qrranker-ubatch-overflow-fix.md` — QRRanker 采集、CMake try_run 修复、hash dylib 部署
- `vendor/llama-addon/build.mjs` — 编译脚本（唯一入口，270 行 JS，可直接阅读全部逻辑）
- `vendor/node-llama-cpp/dist/` — JS/DTS patched 文件（7 个文件，可直接阅读差异）
- `scripts/deploy-llamacpp-patch.ts` — 部署脚本（JS 覆盖 + C++ 复制 + 版本检查）
