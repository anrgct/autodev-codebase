# 260608-kv-unified

## 主题/需求

在 `@realtimex/node-llama-cpp` 中暴露 `kv_unified` 参数，使上层的 `LlamaCppSummarizer` 能通过 `kvUnified: true` 让多个 sequence 共享 KV cache，而非按 `contextSize / sequences` 预分配。

**动机：** 当前 `sequences = concurrency * 2` 的默认策略用多开槽位来吸收并发竞态窗口，但每槽 KV cache = `contextSize / sequences`。如果未来 prompt 长度增长（如大文档摘要），槽位越多单槽可用的 KV cache 越少，容易溢出。`kvUnified=true` 可以让所有 sequence 共享完整的 `contextSize`，解耦「并发安全」和「每槽 KV cache 大小」两个问题。

## 代码背景

### 涉及包

- `@realtimex/node-llama-cpp`（`/Users/anrgct/workspace/node-llama-cpp-therealtimex`）
- `autodev-codebase` 对它有自定义 patch 机制（JS/DTS + C++ 两层）

### 相关文件

| 文件 | 层 | 当前状态 |
|------|------|------|
| `src/evaluator/LlamaContext/types.ts` | JS 类型 | `LlamaContextOptions` 无 `kvUnified` 字段 |
| `src/evaluator/LlamaContext/LlamaContext.ts` | JS 逻辑 | 第 888 行 `const kvUnified = false` **硬编码** |
| `llama/addon/AddonContext.cpp` | C++ 绑定 | 构造函数不读 `kvUnified` 选项，`kv_unified` 保持 `default_params()` 的 `false` |
| `vendor/node-llama-cpp/dist/` | 项目 patch 持久化 | JS/DTS 修改后复制到此 |
| `vendor/llama-addon/AddonContext.cpp` | 项目 C++ 持久化 | AddonContext 源码 |
| `vendor/llama-addon/build.mjs` | C++ 编译入口 | 两遍编译 + patch + 部署 |
| `scripts/deploy-llamacpp-patch.ts` | 部署脚本 | JS 覆盖 + C++ 二进制复制 |

### 现有 patch 机制

见 `docs/08-llama-cpp-build-flow.md`。简要回顾：

- **JS 层**：修改 `node_modules/` 中的文件 → 验证后复制到 `vendor/node-llama-cpp/dist/` → `deploy` 脚本在 `postinstall` 时覆盖回 `node_modules`
- **C++ 层**：修改 `vendor/llama-addon/AddonContext.cpp` → `npm run build:llamacpp` 两遍编译 → 收集产物到 `vendor/llama-addon/binaries/` → `deploy` 脚本复制到加载路径

## 运行现象

（尚未运行，这是待实施任务）

## 归因分析

（尚未实施）

## 关键决策

### 1. 三层改动的范围

| 层 | 改动 | 备注 |
|------|------|------|
| `types.ts` | `LlamaContextOptions` 加 `kvUnified?: boolean` | 新增类型声明 |
| `LlamaContext.ts` | `kvUnified = options.kvUnified ?? false` | 暴露选项，默认仍为 false 保持兼容 |
| `AddonContext.cpp` | 读取 `kvUnified` 选项并设 `context_params.kv_unified` | C++ 绑定层 |

### 2. 不修改 llama.cpp 源码

`kv_unified` 在 `llama_context_params` 中已经存在（默认 `false`），`AddonContext.cpp` 只需要从 JS 读取并赋值，无需 `patchFile()` 或模型脚本。

### 3. JS 调试走 symlink 模式

按 `docs/08-llama-cpp-build-flow.md` 的 symlink 工作流：

```bash
ln -sf ../node_modules/@realtimex/node-llama-cpp vendor/llama-cpp-live
```

这样可以直接用 `vendor/llama-cpp-live/dist/...` 路径来 `read_file` / `edit_file`。

## 实施计划

- [x] 阶段 1：JS 层 — 类型 + 逻辑
  - [x] 创建 `vendor/llama-cpp-live` symlink
  - [x] 在 `types.d.ts` / `types.ts` 的 `LlamaContextOptions` 添加 `kvUnified?: boolean`
  - [x] 在 `LlamaContext.js` / `.ts` 将硬编码 `false` 改为 `options.kvUnified ?? false`
  - [x] `paddedContextSize` 已内建 `kvUnified` 分支（乘 `sequences` 后分配）

- [x] 阶段 2：C++ 层 — AddonContext
  - [x] 修改 `vendor/llama-addon/AddonContext.cpp`，添加读取 `kvUnified` 选项的代码

- [x] 阶段 3：验证
  - [x] 运行 experiment 脚本确认 kv_unified 生效（n_ctx_seq = n_ctx 当 kvUnified=true）
  - [x] 确认现有功能不受影响（实验脚本行为不变）

- [x] 阶段 4：持久化到 vendor
  - [x] JS 文件复制到 `vendor/node-llama-cpp/dist/`
  - [x] `npm run build:llamacpp` 编译 C++ addon
  - [x] `scripts/deploy-llamacpp-patch.ts` 部署到加载路径

## 实施记录

### 2026-06-08

完成三层修改：

**JS/DTS 类型层：**
- `types.d.ts`（dist）和 `types.ts`（source）的 `LlamaContextOptions` 添加 `kvUnified?: boolean`

**JS 逻辑层：**
- `LlamaContext.js`（dist）和 `LlamaContext.ts`（source）：`kvUnified = false` → `options.kvUnified ?? false`
- `paddedContextSize` 在 `kvUnified=true` 时总 KV cache = `contextSize × sequences`

**C++ 绑定层：**
- `vendor/llama-addon/AddonContext.cpp`：新增读取 `kvUnified` 选项并设 `context_params.kv_unified`

待完成：
- C++ 编译 `npm run build:llamacpp`
- 验证 experiment 脚本
- JS 文件复制到 `vendor/node-llama-cpp/dist/`

### 2026-06-08 (第二回合)

**修复构造函数解构问题：**
- `LlamaContext` 构造函数解构 options 时漏了 `kvUnified`，导致传到 C++ 侧被丢弃
- 添加 `kvUnified` 到解构列表和 `removeNullFields` 调用

**验证结果：**
- `kvUnified=false`：`n_ctx_seq = 262144`（= n_ctx / 4），分区 ✓
- `kvUnified=true`：`n_ctx_seq = 1048576`（= n_ctx），共享 ✓
- 原始 experiment 脚本行为不变 ✅

## 修订记录

（暂无）

## 总结

（待补充）
