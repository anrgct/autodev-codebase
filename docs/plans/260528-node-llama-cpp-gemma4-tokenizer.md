# 260528-node-llama-cpp-gemma4-tokenizer

## 主题/需求

调查 `node-llama-cpp` 加载 granite-embedding-311m-multilingual GGUF 模型失败的原因。

**现象：** `embedderProvider: "llamacpp"` 配合 `embedderGgufPath` 指向 `granite-embedding-311M-multilingual-r2-Q8_0.gguf` 时，`node-llama-cpp` 报错 `Failed to load model`，而系统编译的 `llama-embedding` CLI 工具可以正常加载该模型。

## 代码背景

### 相关文件

| 文件 | 作用 |
|------|------|
| `src/code-index/service-factory.ts:150-158` | `llamacpp` provider 的 embedder 创建逻辑，使用 `config.embedderGgufPath` |
| `src/code-index/embedders/llamacpp.ts` | `LlamaCppEmbedder` 实现，通过 `node-llama-cpp` 加载 GGUF 模型 |
| `demo/autodev-config.json` | demo 配置，`embedderProvider: "llamacpp"`，`embedderGgufPath` 指向 granite 模型 |
| `vendor/llama-addon/build.mjs` | 自定义 C++ addon 构建流程（两遍编译，patch `embd_layer`） |
| `vendor/llama-addon/build-trigger.mjs` | 调用 `getLlama({usePrebuiltBinaries: false})` 触发源码编译 |
| `vendor/llama-addon/AddonContext.h/cpp` | 自定义 C++ N-API 绑定层 |

### 依赖关系

- `node-llama-cpp` v3.18.1 内置 llama.cpp `b8390`（来自 `_nlcBuildMetadata.json`）
- 系统编译的 llama.cpp 版本为 `b9352`
- `node-llama-cpp` 的 llama.cpp 版本通过三层机制确定：
  1. 环境变量 `NODE_LLAMA_CPP_REPO_RELEASE`
  2. CLI 参数 `--release`
  3. 预编译包 metadata 中的默认值 `b8390`

## 关键决策

### 决策 1：使用 Jina 模型替代 granite 作为短期修复

- **方案：** 将 `embedderGgufPath` 改回 Jina v5 nano 模型
  - `v5-nano-retrieval-Q8_0-pooling-LAST.gguf`
- **理由：** Jina 模型使用 `jina-v1-en`/`jina-v2-code` 分词器，`b8390` 已支持。维度 768，与现有 Qdrant collection 一致。
- **风险：** 无。之前已使用过该模型，功能正常。

### 决策 2：升级 llama.cpp 版本以支持 `gemma4` 分词器（备选）

- **方案：** 设置 `NODE_LLAMA_CPP_REPO_RELEASE=latest` 后执行 `npm run build:llamacpp`
- **理由：** `gemma4` 分词器支持在 `b8637`（2026-04-02）加入，最新版已支持
- **风险：** 上游 llama.cpp API 可能变更，导致 `build.mjs` 中的内联 patch 匹配失败或 AddonContext 编译失败
- **后续：** 如果 patch 失败，需要手动修复 `build.mjs` 中的文本匹配模式

### 决策 3（最终方案）：替换为 `@realtimex/node-llama-cpp` 预编译包

- **方案：** 将 `node-llama-cpp` v3.18.1 替换为 `@realtimex/node-llama-cpp` v0.163.0
- **理由：**
  - `@realtimex/node-llama-cpp` 预编译了最新 llama.cpp（`release: "latest"`），已包含 `gemma4` 分词器支持
  - 预编译包免去了手动编译的复杂流程
  - API 与原版 `node-llama-cpp` 兼容（fork 来源）
- **风险：**
  - C++ addon 层（`AddonContext`、`embd_layer` patch）需要重新适配
  - 预编译包的内部路径结构可能与原版不同（`@realtimex/node-llama-cpp-<platform>` vs `@node-llama-cpp/<platform>`）
  - vendor 下的 JS/DTS patch 文件需要重新验证兼容性

## 实施计划

- [x] 定位错误根因：`unknown tokenizer: 'gemma4'`
- [x] **替换依赖：** `node-llama-cpp` → `@realtimex/node-llama-cpp` v0.163.0
  - [x] 更新 `package.json` 依赖声明
  - [x] 全局替换 import 路径（12 个源文件）
  - [x] 更新 `vendor/llama-addon/build.mjs` 路径
  - [x] 更新 `vendor/llama-addon/build-trigger.mjs` import
  - [x] 更新 `scripts/deploy-llamacpp-patch.ts` 路径
- [x] **安装验证：** `npm install` 正常拉取预编译包
- [x] **C++ addon 适配：**
  - [x] 修复 `cpu_get_num_math` API 变更（已移除）
  - [x] 新增 pre-pass 阶段，自动修复原版 AddonContext.cpp
  - [x] 修复 vendor AddonContext.cpp 中的 API 引用
  - [x] 两遍编译流程成功
  - [x] llama.cpp b9370 **仍需** 4 处 header patch + 模型 patch 脚本（非原生支持）
- [x] **功能验证：**
  - [x] EmbeddingGemma 模型加载成功
  - [x] Granite embedding 模型加载成功（gemma4 tokenizer ✅）
  - [x] `codebase index --force --demo` 正常运行 ✅
  - [x] `codebase search` 语义搜索正常 ✅

## 实施记录

### 2026-05-28

**问题复现：** 运行 `npm run dev -- index --force --demo` 报错 `Failed to load model`。

**排查过程：**
1. 检查 error stack trace，定位到 `LlamaModel._create` 中 `model._model.init()` 返回 false
2. 用系统 `llama-embedding` CLI 加载同一模型，成功，排除模型文件损坏
3. 用 `node --input-type=module` 直接调 `getLlama` + `loadModel`，看到完整错误：
   ```
   llama_model_load: error loading model: error loading model vocabulary: unknown tokenizer: 'gemma4'
   ```
4. 确认 `_nlcBuildMetadata.json` 中 `release: "b8390"`，而 `gemma4` 分词器在 `b8637` 才加入
5. 验证系统编译的 llama.cpp 版本为 `b9352`，已包含 `gemma4` 支持

**替换方案确认：**
- `@realtimex/node-llama-cpp` v0.163.0 预编译包使用 `release: "latest"`，已包含 `gemma4` 支持
- npm 上可安装，平台二进制包命名格式为 `@realtimex/node-llama-cpp-<platform>`
- 已完成 `package.json` 和 12 个源文件的 import 路径替换

## 修订记录

### 2026-05-28
**创建文档**：记录 gemma4 分词器兼容性问题调查。
### 2026-05-28（更新）
**决策更新**：确定最终方案为替换为 `@realtimex/node-llama-cpp` v0.163.0 预编译包，更新实施计划。

## 总结

### 关键发现

1. `granite-embedding-311m-multilingual-r2-Q8_0.gguf` 模型使用 `gemma4` 分词器类型
2. `node-llama-cpp` v3.18.1 内置的 llama.cpp `b8390` 不支持 `gemma4` 分词器
3. npm 上目前没有比 3.18.1 更新的 `node-llama-cpp` 版本
4. 系统编译的 llama.cpp `b9352` 已支持 `gemma4`，差距约 247 个版本
5. `@realtimex/node-llama-cpp` v0.163.0 预编译了最新 llama.cpp（b9370），已支持 `gemma4`
6. `embd_layer` 未被上游原生支持——4 处 header patch + `add-midlayer-embd.py` 模型 patch 脚本仍然必需

### 已完成变更

- `package.json`：`node-llama-cpp` → `@realtimex/node-llama-cpp` v0.163.0
- 12 个源文件 + 9 个 evidence 脚本：import 路径从 `"node-llama-cpp"` → `"@realtimex/node-llama-cpp"`
- `build.mjs`：路径更新 + pre-pass（修复 `cpu_get_num_math`）+ patchFile 改进（newText 检测）+ 模型 patch 脚本重新启用

### 待完成

- 更新 `vendor/llama-addon/build.mjs` 和 `build-trigger.mjs` 中的路径
- 更新 `scripts/deploy-llamacpp-patch.ts` 中的路径
- 安装验证 + C++ addon 适配 + 功能验证
