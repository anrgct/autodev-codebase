# 260524-llamacpp-midlayer-embd

## 主题/需求

在 llama.cpp 中增加支持从 Transformer **中间层**（而非仅最后一层）提取 per-token hidden states 的能力，使上层（autodev-codebase / node-llama-cpp）可以配置 `embd_layer` 参数来选择 pooling 的层深度。

**动机：** 因果语言模型（如 MiniCPM-V-4.6）的最后一层 hidden state 偏向 next-token prediction 目标，用于语义相似度任务时区分度不足。从中间层（约 50-75% 深度）提取 hidden states 做 pooling，在学术研究中已被验证能获得更好的语义表示（LLM2Vec、Echo Embeddings 等）。

**前置实验结论**（见 `260523-late-chunking.md`）：QR-attention temperature sweep (0.25~4.0) 作为"层深度"的间接代理，表明 temp=1.0（最后层 + 标准 softmax）已是 Pareto 最优。但 temperature 只改变了 pooling 注意力的锐度，**没有改变 hidden states 本身的语义层来源**——真正测试中间层效果必须从 C++ 层支持层选择。

**预期成果：**
- llama.cpp `llama_context_params` 新增 `int32_t embd_layer` 字段（-1 = 最后一层，保持兼容）
- 所有支持 embedding 模式的模型架构（~30 个）在 graph building 时按 `embd_layer` 在目标层截断
- node-llama-cpp `LlamaEmbeddingContextOptions` 新增 `embdLayer` 选项
- autodev-codebase `embedderPoolingLayer` 配置项，类型 `"last" | number`

## 代码背景

### 关键文件

| 文件 | 用途 | 改动范围 |
|------|------|:---:|
| `llama.cpp/include/llama.h` | C API 头文件：`llama_context_params` 结构体定义 | +1 字段 |
| `llama.cpp/src/llama-cparams.h` | 内部参数结构体 `llama_cparams` | +1 字段 |
| `llama.cpp/src/llama-context.cpp` | Context 创建：参数拷贝、`encode()`/`decode()` embedding 提取 | ~10 行 |
| `llama.cpp/src/llama-graph.cpp` | Graph building 基础设施：`llm_graph_result`、`llm_graph_context` | ~20 行 |
| `llama.cpp/src/llama-graph.h` | Graph 相关结构体声明 | ~5 行 |
| `llama.cpp/src/models/*.cpp` | ~30 个模型架构文件：各架构的 graph 构造函数 | 每文件 ~5 行 |
| `node-llama-cpp/src/evaluator/LlamaEmbeddingContext.ts` | TS binding：context 创建 options | +1 字段 |
| `node-llama-cpp/src/evaluator/LlamaEmbedding.ts` | TS binding：batch eval 时传递参数 | ~5 行 |
| `node-llama-cpp/src/gguf/types/*.ts` | 类型定义 | ~3 行 |
| `autodev-codebase/src/code-index/embedders/llamacpp-llm.ts` | LLM embedder：使用 `embdLayer` 参数 | ~10 行 |
| `autodev-codebase/src/code-index/interfaces/config.ts` | 配置类型：新增 `embedderPoolingLayer` | ~5 行 |
| `autodev-codebase/src/code-index/shared/service-factory.ts` | Service factory：传递新参数 | ~3 行 |
| `autodev-codebase/src/code-index/shared/config-manager.ts` | 配置管理：新字段注册 | ~3 行 |

### 现有架构：Embedding 提取的完整链路

```text-chart
[Embedding 提取链路] (从 TS 到 C++ 的完整调用链)
autodev-codebase
  LlamaCppLlmEmbedder._qrAttentionCreateEmbeddings
    ↓
  embedContext.getEmbeddingsForTokens(text)
    ↓
node-llama-cpp
  LlamaEmbeddingContext.getEmbeddingsForTokens:63
    ↓
  this._sequence.evaluate(resolvedInput)
    ↓
  this._llamaContext._ctx.getEmbedding(i)
    ↓
llama.cpp C API
  llama_get_embeddings_ith(ctx, i)
    ↓
  ctx->get_embeddings_ith(i)
    ↓
  embd.data[j * n_embd_out]  ← t_embd 在 graph 中被设为最后一层输出
```

### 关键锚点：`t_embd` 在 graph building 中的设置

以 llama 架构为例（`llama.cpp/src/models/llama.cpp`）：

```text-chart
[Llama 架构 graph building] (embedding 模式下 t_embd 的设置位置)
build_inp_embd → inpL
  ↓
for il = 0 .. n_layer-1:
  ├── build_norm(attn_norm)
  ├── build_qkv → rope → build_attn
  ├── ggml_add(cur, inpSA)  → ffn_inp
  ├── build_norm(ffn_norm) → build_ffn (or build_moe_ffn)
  ├── ggml_add(cur, ffn_inp)
  ├── build_cvec(cur, il)
  └── inpL = cur
  ↓
cur = inpL
  ↓
cur = build_norm(output_norm)
  ↓
res->t_embd = cur  ← ⭐ 此处始终设为全部层后的输出
  ↓
(if !embed) lm_head → res->t_logits
```

**核心问题**：`res->t_embd = cur` 无条件执行在所有层循环之后。无论 embedding 模式还是生成模式，extracted hidden states 始终来自最后一层。

## 关键决策

### 决策 1：参数命名 `embd_layer`，语义为"目标层索引"

**选择：** `int32_t embd_layer`，其中 `-1` = 最后一层（默认），`0 ~ n_layer-1` = 指定层索引（从 transformer 第一层算起，不含 embedding 层）。

**理由：**
- 与现有 llama.cpp 命名风格一致（`embeddings` bool、`n_embd`、`embd` 数组）
- `-1` 作为默认值向后兼容，所有现有调用方无需修改
- 层索引从 0 开始，与模型内部的 `il` 变量一致（`for il = 0; il < n_layer; ++il`）

**替代方案：**
- `embd_layer_offset`：从最后一层往回数（如 -1=最后一层, -2=倒数第二层）。更直观但对不同层数的模型语义不一致
- `embd_layer_ratio`：按比例（0.5=中间层）。语义最直观但依赖模型层数，需运行时解析

### 决策 2：在 graph building 中截断而非在 encode/decode 中后处理

**选择：** 在 graph building 阶段（各模型架构的 graph 构造函数），在指定层 `il == embd_layer` 时设 `res->t_embd = cur`，后续层仍然构建但输出图只包含到目标层。

**理由：**
- 后续层仍然需要构建（因果 attention 的 KV cache 依赖前面的层），但 output tensor 只需标记到目标层
- 这样 `ggml_backend_tensor_get_async` 只拷贝到目标层的 hidden states
- 如果后处理截断（在 encode/decode 中），所有层的数据已经被拷贝到 `embd` 数组，无法撤销

**替代方案：**
- **截断计算图**（后续层不构建）：更高效（省计算），但需要处理 KV cache 依赖，复杂度高
- **后处理取子集**：最简单但内存和计算都没有节省

### 决策 3：每层使用该层的 ffn_norm 输出（而非 raw residual）

**选择：** 在目标层 `il`，取 `build_norm(ffn_inp, layer[il].ffn_norm, ...)` + FFN + residual add 后的 `cur`。即取该 transformer 层的完整输出（含 attention + FFN + residual）。

**理由：**
- 这是标准做法——每层输出 = 经过 attention block + FFN block 后的 hidden state
- 与最后一层的 `output_norm` 行为类似（只是用 layer-specific norm 而非 global output_norm）
- 不需要额外引入新的 norm 计算

**注意：** 不同模型架构的层结构不同（如 MoE 用 `build_moe_ffn`，某些架构有 parallel attention/FFN），需在每个架构中适配。

### 决策 4：保留 `output_norm` 的应用

**选择：** 在目标层 `il` 的 `cur` 上额外应用 `model.output_norm`（如果模型有独立的 output_norm），使中间层的 hidden state 分布与最后一层更接近。

**理由：**
- 最后一层总是经过 `output_norm` 后才设为 `t_embd`
- 不应用 output_norm 会引入分布偏移，使查询 embedding（始终用最后一层）与文档 embedding（中间层）之间的语义空间不对齐
- output_norm 权重在所有层间共享（或全局唯一），应用成本为零

**反方观点：** 如果目标是对比不同"原始"层的语义质量，不应加 output_norm。此处选择加 norm 是为了与查询 embedding 对齐——如果后续实验表明不需要，可以增加 `embd_layer_skip_norm` flag。

### 决策 5：llama.cpp API 仅支持单一层，上层可自行组合多层

**选择：** C API `embd_layer` 只接受单个层索引。如需要"最后 N 层加权平均"，由上层（node-llama-cpp / autodev）做多次 forward pass 并在 TS 层做加权平均。

**理由：**
- 保持 C API 简洁
- 多层平均的实验性质较强，不应在底层固化
- 如果实验验证多层平均显著优于单层，可后续在 C 层做优化（单次 forward pass 内完成）

### 决策 6：配置项命名 `embedderPoolingLayer`，类型 `"last" | number`

与现有 `embedderPoolingMode`、`highlighterMode` 命名风格一致。默认 `"last"`（等价于 `embd_layer = -1`）。

## 实施计划

整个改动跨越 3 个代码库，按自底向上的依赖顺序分为 3 层：

```text-chart
[实施分层] (自底向上的依赖顺序)
┌─────────────────────────────────────────────────────┐
│ Layer 3: autodev-codebase                           │
│   ├── config.ts: embedderPoolingLayer                │
│   ├── llamacpp-llm.ts: 传递 embdLayer               │
│   └── service-factory.ts / config-manager.ts        │
├─────────────────────────────────────────────────────┤
│ Layer 2: node-llama-cpp (TypeScript binding)        │
│   ├── LlamaEmbeddingContext.ts: options + 传递       │
│   ├── LlamaEmbedding.ts: batch eval 链路            │
│   └── types: GgufMetadataTypes                      │
├─────────────────────────────────────────────────────┤
│ Layer 1: llama.cpp (C/C++ 核心)                     │
│   ├── llama.h: llama_context_params + embd_layer    │
│   ├── llama-cparams.h: llama_cparams + embd_layer   │
│   ├── llama-context.cpp: 参数传递                   │
│   ├── llama-graph.cpp/h: graph 基础设施             │
│   └── models/*.cpp: ~30 个架构 graph 构造函数       │
└─────────────────────────────────────────────────────┘
```

### 步骤 1：llama.cpp API & 参数层

**文件：** `include/llama.h`、`src/llama-cparams.h`、`src/llama-context.cpp`

- [ ] `llama_context_params` 末尾（bool 区之前）新增 `int32_t embd_layer`
- [ ] `llama_context_default_params()` 中初始化为 `-1`
- [ ] `llama_cparams` 新增 `int32_t embd_layer;`
- [ ] `llama_context::llama_context()` 中 `cparams.embd_layer = params.embd_layer;`

```text-chart
[步骤 1：参数传递链路]
llama_context_params.embd_layer (API)
  ↓
llama_context::llama_context() → cparams.embd_layer
  ↓
llama_model::build_graph(params) → llm_graph_params
  ↓
模型架构 graph 构造函数中读取
```

### 步骤 2：llama.cpp Graph 基础设施

**文件：** `src/llama-graph.h`、`src/llama-graph.cpp`

- [ ] `llm_graph_params` 中确认 `cparams` 已可访问（`const llama_cparams & cparams`）
- [ ] 在 `llm_graph_result` 或 `llm_graph_context` 中添加 `embd_layer` 字段
- [ ] 确保 graph building 代码可通过 `hparams.n_layer` 进行层数校验

### 步骤 3：llama.cpp 模型架构适配（核心工作量）

**文件：** `src/models/*.cpp`（~30 个架构文件）

每个架构文件遵循统一的改动模式。以 `llama.cpp` 为例：

**改动前（`models/llama.cpp` embedding 模板）：**
```cpp
for (int il = 0; il < n_layer; ++il) {
    // attention block ...
    // FFN block ...
    inpL = cur;
}
cur = inpL;
cur = build_norm(cur, model.output_norm, NULL, LLM_NORM_RMS, -1);
cb(cur, "result_norm", -1);
res->t_embd = cur;  // ← 始终在最后一层
```

**改动后：**
```cpp
const int embd_layer = cparams.embeddings
    ? (cparams.embd_layer >= 0 ? cparams.embd_layer : n_layer - 1)
    : n_layer - 1;

for (int il = 0; il < n_layer; ++il) {
    // attention block ...
    // FFN block ...
    
    if (il == embd_layer) {
        // 在目标层截断：应用 output_norm（如模型有）后设为 t_embd
        cur = build_norm(cur, model.output_norm,
            model.output_norm_b, LLM_NORM_RMS, -1);
        cb(cur, "result_norm", -1);
        res->t_embd = cur;
        // 后续层仍构建（KV cache 依赖），但不再更新 t_embd
    }
    
    inpL = cur;
}
// 只有 embd_layer == n_layer-1 时才在此处设（向后兼容）
if (embd_layer == n_layer - 1) {
    cur = inpL;
    cur = build_norm(cur, model.output_norm, NULL, LLM_NORM_RMS, -1);
    cb(cur, "result_norm", -1);
    res->t_embd = cur;
}
```

需适配的架构列表（基于 `src/models/` 目录）：

| 架构 | 文件 | 是否有 output_norm | 注意事项 |
|------|------|:---:|------|
| llama | `llama.cpp` | ✅ RMS | MoE 分支（`build_moe_ffn`）需单独处理 |
| qwen2 | `qwen2.cpp` | ✅ RMS | 与 llama 几乎相同 |
| qwen3 | `qwen3.cpp` | ✅ RMS | DeepStack 架构，层结构不同 |
| gemma | `gemma.cpp` | ✅ RMS | GeGLU FFN |
| gemma2 | `gemma2.cpp` | ✅ RMS | 交替 local/global attention |
| gemma3 | `gemma3.cpp` | ✅ RMS | per-layer embedding |
| mistral | `mistral.cpp` | ✅ RMS | 滑动窗口 attention |
| mixtral | `mixtral.cpp` | ✅ RMS | MoE |
| phi | `phi*.cpp` | ✅ | 多个变体 |
| stablelm | `stablelm.cpp` | ✅ | LayerNorm（非 RMS） |
| falcon | `falcon.cpp` | ✅ | Parallel attention/FFN |
| bert | `bert.cpp` | ❌ 无 output_norm | Encoder-only，`result_embd` 直接设置 |
| minicpm | `minicpm.cpp` | ✅ | 可能有特殊结构 |
| deepseek | `deepseek*.cpp` | ✅ | MoE |
| ... | ... | ... | 共 ~30 个架构 |

**简化策略：** 对大部分架构，只需在层循环内的 FFN 完成后、`inpL = cur` 之前加 3 行条件判断。可以写一个 Python 脚本批量处理。

### 步骤 4：node-llama-cpp TypeScript 层

**文件：** `node-llama-cpp/src/evaluator/LlamaEmbeddingContext.ts`、`node-llama-cpp/src/evaluator/LlamaEmbedding.ts`

- [ ] `LlamaEmbeddingContextOptions` 新增 `embdLayer?: number`（-1 = 最后一层）
- [ ] `LlamaEmbeddingContext._create()` 中将 `embdLayer` 传给 `model.createContext()`
- [ ] `LlamaContextOptions` 新增 `embdLayer` 字段
- [ ] 底层 native binding 将 `embdLayer` 写入 `llama_context_params.embd_layer`

### 步骤 5：autodev-codebase 集成

**文件：** `autodev-codebase/src/code-index/embedders/llamacpp-llm.ts`、`autodev-codebase/src/code-index/interfaces/config.ts`、`autodev-codebase/src/code-index/shared/service-factory.ts`

- [ ] `CodeIndexConfig` / `ConfigSnapshot` 新增 `embedderPoolingLayer: "last" | number`
- [ ] 配置校验：`"last"` → `embdLayer = -1`；`number` → 直接传入
- [ ] `LlamaCppLlmEmbedder` 构造函数接受 `poolingLayer` 参数
- [ ] `createEmbeddingContext` 时传入 `embdLayer`
- [ ] `config-manager.ts` 注册新字段
- [ ] `demo/autodev-config.json` 示例配置

### 步骤 6：验证

- [ ] `llama.cpp` 编译通过（`cmake --build build`）
- [ ] `llama-embedding` 示例工具增加 `--embd-layer` flag 并验证输出维度正确
- [ ] node-llama-cpp TypeScript 编译通过 + binding 测试
- [ ] autodev-codebase `tsc --noEmit` 通过
- [ ] E2E：用 MiniCPM-V-4.6 对 demo 项目做不同层的 embedding 对比

## 实施记录

### 2026-05-24：llama.cpp C++ 层完成

**改动范围**：111 文件，+1672 / -5 行。

**API 层（4 文件）**
- `include/llama.h`：`llama_context_params` 新增 `int32_t embd_layer` 字段（默认 -1）
- `src/llama-cparams.h`：`llama_cparams` 新增 `int32_t embd_layer` 字段
- `src/llama-context.cpp`：构造函数中拷贝 `embd_layer`，`llama_context_default_params()` 初始化为 -1
- `src/llama-graph.h`：`llm_graph_params::allow_reuse()` 加入 `embd_layer` 比较

**模型架构层（107 文件）**
- 通过 Python 脚本 `scripts/add-midlayer-embd.py` 批量处理 97 个标准架构文件
- 手动处理 10 个特殊架构（jais2、lfm2、t5、wavtokenizer-dec、bailingmoe2、deepseek2、exaone-moe、glm4、glm4-moe、mimo2）
- llama.cpp 作为参考实现手动修改

**改动模式（每个模型文件）：**
1. for 循环前：计算 `embd_layer`（默认 -1 → 最后一层）
2. for 循环内（`inpL = cur` 前）：检查 `il == embd_layer`，应用 output_norm 并设置 `res->t_embd`
3. for 循环后：`res->t_embd = cur` 包装在 `if (embd_layer == n_layer - 1)` 中

**特殊处理：**
- BERT 类模型（bert、eurobert、neo-bert、modern-bert、wavtokenizer-dec、pangu-embed）：无 output_norm，直接设置 `res->t_embd = cur`
- T5：encoder 和 decoder 两个 graph 构造函数分别处理
- 使用 `n_transformer_layers` / `effective_n_layers` 替代 `n_layer` 的模型：调整最后层判断
- jais2：循环变量不叫 `inpL = cur`，改为在 `cb(inpL, "l_out", il)` 后插入
- lfm2：无 `inpL` 变量，直接在 `cb(cur, "l_out", il)` 后插入
- wavtokenizer-dec：posnet + convnext 两层循环，全局层索引跨循环计算

**编译验证：** `cmake --build build` 零错误通过。

### 2026-05-24：node-llama-cpp TypeScript 层 + autodev-codebase 集成完成

**node-llama-cpp（5 文件）：**
- `src/bindings/AddonTypes.ts`：`AddonContext` params 新增 `embdLayer?: number`
- `src/evaluator/LlamaContext/types.ts`：`LlamaContextOptions` 新增 `_embdLayer?: number`
- `src/evaluator/LlamaContext/LlamaContext.ts`：构造函数 + AddonContext 传递
- `src/evaluator/LlamaEmbeddingContext.ts`：`LlamaEmbeddingContextOptions` 新增 `embdLayer?: number`，传递给 context 创建
- `llama/addon/AddonContext.cpp`：C++ 绑定读取 `embdLayer` 选项并写入 `llama_context_params.embd_layer`

**autodev-codebase（7 文件）：**
- `src/code-index/interfaces/config.ts`：`CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 新增 `embedderPoolingLayer?: "last" | number`
- `src/code-index/constants/index.ts`：`DEFAULT_CONFIG` 新增 `embedderPoolingLayer: "last"`
- `src/code-index/config-validator.ts`：校验 `embedderPoolingLayer` 类型（"last" 或非负整数）
- `src/code-index/config-manager.ts`：`REQUIRES_RESTART_KEYS` + `_createConfigSnapshot` + `doesConfigChangeRequireRestart` 加入新字段
- `src/code-index/service-factory.ts`：`LlamaCppLlmEmbedder` 构造时传入 `embedderPoolingLayer`
- `src/code-index/embedders/llamacpp-llm.ts`：接受 `poolingLayer` 参数，转换为 `embdLayer`（"last" → -1，数字 → 直接传入），传递给所有 `createEmbeddingContext()` 调用
- `src/commands/config/metadata.ts` + `parser.ts`：支持 `union` 类型配置值解析

**类型编译：** `tsc --noEmit` 零新增错误通过。

### 2026-05-24：llama.cpp 工具链 & API 验证

**common 框架（3 文件）：**
- `common/common.h`：`common_params` 新增 `int32_t embd_layer = -1`
- `common/arg.cpp`：新增 `--embd-layer N` 参数解析（LLAMA_EXAMPLE_EMBEDDING / LLAMA_EXAMPLE_DEBUG）
- `common/common.cpp`：`common_context_params_to_llama()` 传递 `embd_layer`

**API 测试：** `tests/test-embd-layer.cpp` 验证：
- `llama_context_default_params().embd_layer == -1` ✅
- 可设为任意非负整数（0, 15 等）✅
- `llama-embedding --embd-layer 5` 参数解析正常 ✅

**运行时验证（MiniCPM-V-4.6-Q8_0, 24 layers）：**

不同层 embedding 余弦相似度矩阵（prompt: "The capital of France is Paris"）：

| | L23(last) | L18(75%) | L12(50%) | L6(25%) | L0(0%) |
|---|:---:|:---:|:---:|:---:|:---:|
| **L23(last)** | 1.00 | 0.46 | 0.17 | 0.13 | 0.12 |
| **L18(75%)** | 0.46 | 1.00 | 0.47 | 0.38 | 0.20 |
| **L12(50%)** | 0.17 | 0.47 | 1.00 | 0.75 | 0.38 |
| **L6(25%)** | 0.13 | 0.38 | 0.75 | 1.00 | 0.44 |
| **L0(0%)** | 0.12 | 0.20 | 0.38 | 0.44 | 1.00 |

**关键发现：**
- 最后一层与中间层相似度极低（0.12-0.46），验证了"最后一层偏向 next-token prediction"的核心假设
- 相邻层相似度符合预期：L6→L12=0.75，L12→L18=0.47——语义逐层漂移
- L6-L12 形成语义簇（cos=0.75），是 embedding 提取的候选目标区间
- 中间层嵌入提取功能端到端验证通过 ✅

### 2026-05-24：node-llama-cpp 原生 addon 编译 ✅ 已完成

**卡点回顾与解决：**

原卡点：下载的 llama.cpp 版本（ggml 0.9.7）与 workspace llama.cpp（ggml 0.11.1）API 不兼容，5 个特殊模型文件编译失败。

解决方式：`build.mjs` 重构为两遍编译流程——Pass 1 用原始 AddonContext 编译 llama.cpp，Pass 2 内联 patch header + 运行模型脚本 + 复制 patched AddonContext + cmake --build 增量重编。详见 `docs/plans/260524-llamacpp-node-build-flow.md`。

**编译结果：**
- ✅ `llama-addon.node` + `libllama.metal.*.dylib` 编译成功
- ✅ 部署到 `node_modules/@node-llama-cpp/mac-arm64-metal/bins/`
- ✅ `deploy-llamacpp-patch.ts` 实现 vendor → node_modules 完整文件覆盖部署

### 2026-05-24：node-llama-cpp JS 层参数传递修复

**问题：** vendor JS 文件中 `LlamaEmbeddingContextOptions.embdLayer` 仅在 `.d.ts` 中声明了类型，`LlamaEmbeddingContext.js` 的 `_create()` 方法没有把 `embdLayer` 传递到 `createContext()` → `LlamaContext` → `AddonContext`。C++ 二进制已正确编译，但 JS 层参数链路中断。

**修复（4 个 vendor 文件）：**

| 文件 | 改动 |
|------|------|
| `vendor/.../LlamaEmbeddingContext.js` | `_create()` 解构 `embdLayer`，传 `_embdLayer` 给 `createContext()` |
| `vendor/.../LlamaContext/LlamaContext.js` | 构造函数解构 `_embdLayer`，传 `embdLayer` 给 `AddonContext` |
| `vendor/.../LlamaContext/types.d.ts` | 新增 `_embdLayer?: number` |
| `vendor/.../bindings/AddonTypes.d.ts` | `AddonContext` params 新增 `embdLayer?: number` |

**完整调用链（打通后）：**
```text
createEmbeddingContext({embdLayer: 12})
  → LlamaEmbeddingContext._create(_, {embdLayer: 12})
    → createContext({_embdLayer: 12, _embeddings: true})
      → LlamaContext._create(options)
        → new LlamaContext({...options})  // _embdLayer=12
          → new AddonContext(model, {embdLayer: 12, ...})
            → context_params.embd_layer = 12
              → graph building: il==12 时 t_embd=cur
```

### 2026-05-24：llama.cpp 模型文件 patch 修复（llama 架构遗漏）

**问题：** `scripts/add-midlayer-embd.py` 中 `ALREADY_MODIFIED = {"llama.cpp"}` 导致 `llama` 架构被跳过——该脚本为 workspace llama.cpp 设计（llama.cpp 已手动 patch），但 build.mjs 对下载版 llama.cpp 运行时，llama.cpp 未被 patch。llama 架构被 MiniCPM、Qwen2、Mistral 等大量模型使用。

**修复：**
- `scripts/add-midlayer-embd.py`：`ALREADY_MODIFIED` 改为空 `set()`
- 重新运行脚本 patch 下载版 llama.cpp → 97 个模型文件全部含 `embd_layer`
- `cmake --build` 增量重编 → dylib 重新部署

**验证：**
```bash
grep -c "embd_layer" node_modules/.../src/models/llama.cpp
# → 4  (修复前: 0)
grep -l "embd_layer" node_modules/.../src/models/*.cpp | wc -l
# → 97 (修复前: 96)
```

### 2026-05-24：全层扫描验证（24 层 × 5 prompts）

使用 `scripts/test-midlayer-embd.ts` 对 MiniCPM-V-4.6（24 层）逐层提取 embedding，
5 个 prompt mean-pool 后 L2 normalize，计算每层与最后一层 (L23) 的 cosine similarity：

```text
L0   █████                                            0.09
L1   ███████                                          0.11
L2   ████████                                         0.13
L3   ███████                                          0.12
L4   █████████                                        0.15
L5   █████████                                        0.15
L6   ████████                                         0.14  ← 浅层 avg=0.13
L7   ███████████                                      0.18
L8   ██████████                                       0.17
L9   ███████████                                      0.19
L10  ████████████                                     0.21
L11  █████████████                                    0.22
L12  ██████████████                                   0.23
L13  ███████████████                                  0.25
L14  ██████████████                                   0.24
L15  ████████████████                                 0.27
L16  ██████████████████                               0.30
L17  ███████████████████                              0.32
L18  ███████████████████                              0.31  ← 中层 avg=0.24
L19  █████████████████████                            0.35
L20  █████████████████████                            0.35
L21  ███████████████████████                          0.38
L22  █████████████████████████                        0.41
L23  ████████████████████████████████████████████████ 1.00  ◀ last
```

**三个语义区：**

| 区域 | 层范围 | 平均 cos | 特征 |
|------|------|:--:|------|
| 浅层 | L0-L6 | 0.13 | 与最后层几乎正交——语法/表面特征 |
| 中层 | L7-L18 | 0.24 | 语义逐步发育，过渡区 |
| 深层 | L19-L23 | 0.50 | 趋近最后层，但 L22 仍只有 0.41 |

**关键发现：**
- **"最后一层悬崖"**：L22→L23 的 Δcos = 0.59，是相邻层平均变化（0.87→1.00 的差距）的 14 倍，说明最后一层经历了质变（next-token prediction head 对齐）
- **相邻层平滑**：相邻层平均 cos = 0.87，表示逐层微调
- **Embedding sweet spot**：L15-L18（62-75% 深度）语义丰富且未受 last-layer 偏置
- 端到端验证通过 ✅

### 2026-05-24：Layer Sweep 检索质量评估（9 层 × 12 查询）

使用 `src/examples/layer-sweep.sh` 对 9 个关键层（L23-L8）分别重建索引 + 运行 `eval_search.py`，测量检索质量随层深度的变化。

**结果汇总：**

| Layer | 命中 | MRR | R@1 | R@10 | R@20 | 中位数排名 | 平均分数 |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **L23 (last)** | **11/12** | 0.2820 | 8.3% | 66.7% | 66.7% | 5 | 0.2552 |
| **L22** ★ | 9/12 | **0.5000** | **33.3%** | 75.0% | 75.0% | **2** | 0.1632 |
| L20 | 9/12 | 0.4355 | 25.0% | 75.0% | 75.0% | 2 | 0.1514 |
| L18 | 10/12 | 0.4097 | 16.7% | 75.0% | 83.3% | 3 | 0.1578 |
| L16 | 10/12 | 0.3463 | 16.7% | 75.0% | 83.3% | 5 | 0.1774 |
| L15 | 10/12 | 0.2301 | 0% | 58.3% | 75.0% | 8 | 0.1623 |
| L12 | 9/12 | 0.3071 | 16.7% | 58.3% | 75.0% | 4 | 0.1639 |
| L10 | 9/12 | 0.2528 | 16.7% | 50.0% | 75.0% | 9 | 0.1383 |
| L8 | 9/12 | 0.3677 | 25.0% | 58.3% | 75.0% | 2 | 0.1360 |

**★ L22 是最佳层：MRR 提升 77%（0.28→0.50），R@1 提升 4×（8%→33%）**

**丢失查询分析：**

| Layer | 丢失查询 | 说明 |
|:---:|------|------|
| L23 | #1 (is_hub_model) | 仅丢 1 个，覆盖最广 |
| L22/L20 | #1, #3 (predict_cli), #11 (track) | 丢 3 个，rank 质量最高 |
| L18/L16 | #1, #4 (train best/last weight) | 丢 2 个，平衡之选 |

**关键发现：**

1. **"最后一层悬崖"被检索实验证实**：L22→L23 的 MRR 从 0.50 暴跌到 0.28（-44%），与全层扫描中 cos=0.41↗1.00 的跳跃一致。最后一层的 next-token prediction 对齐不仅改变了 hidden states 的几何方向，还显著损害了语义检索的排序质量。

2. **Coverage vs Precision 的表示层权衡**：
   - 最后一层：覆盖最广（11/12），但排序最差（MRR 0.28，中位数 #5）
   - L22：覆盖降低（9/12），但排序大幅提升（MRR 0.50，中位数 #2）
   - 这说明最后一层的 hidden states 被"稀释"了——能微弱匹配更多查询，但区分度不足

3. **最佳提取区间为 L18-L22（75-92% 深度）**：
   - MRR 0.41-0.50，显著优于最后一层的 0.28
   - L22 的 R@1=33.3% vs L23 的 8.3%，说明 top-1 质量有质的提升
   - L18 命中 10/12，是最接近 L23 命中数（11）的非最后层

4. **浅层（≤L15）不适合检索**：MRR 和 Recall 均显著低于 L18-L22 区间

5. **丢失查询 #1（is_hub_model）在所有层均未命中**：这可能是 MiniCPM-V-4.6 hidden states 对该代码模式的固有盲区，与层深度无关

## 总结

### 改动规模估算

| 层次 | 文件数 | 实际行数 | 难度 |
|------|:---:|:---:|:---:|
| llama.cpp API 层 | 4 | +25 | 低 |
| llama.cpp Graph | 1 | +5 | 低 |
| llama.cpp 模型架构 | 107 | +1642 | 中（97 脚本 + 10 手动） |
| llama.cpp 工具链 & 测试 | 4 | +80 | 低 |
| node-llama-cpp TS 源码 | 5 | +40 | 低 |
| node-llama-cpp vendor JS/DTS | 4 | +15 | 低（编译后文件直接修改） |
| node-llama-cpp C++ addon 编译 | 3 | +200 | 高（两遍编译流程） |
| autodev-codebase | 7 | +55 | 低 |
| **合计** | **135** | **~2062** | |

### 风险点

1. **架构差异**：BERT 等 encoder-only 模型的 embedding 提取路径不同，可能需要单独处理
2. **DeepStack 架构**：Qwen3 的 DeepStack 有交错层结构，`embd_layer` 的语义可能需要澄清（索引的是 transformer 层还是包括 DeepStack 层？）
3. **output_norm 缺失**：部分模型没有独立的 `output_norm`（如 BERT 用 `result_embd`），需要分类处理
4. **性能影响**：中间层截断不会减少计算量（后续层仍需构建），但可以减少 GPU→CPU 的数据拷贝量（`embd` 数组只有到目标层的 token 数 × n_embd 大小）

### 后续工作

- ✅ 全层扫描完成：24 层 embedding 余弦相似度分析，确认 L15-L18 为语义 sweet spot
- ✅ Layer Sweep 检索评估完成：L22 为最佳提取层（MRR 提升 77%），L18-L22 为最佳区间

### 2026-05-24：层 × 池化 交叉实验（MiniCPM-V-4.6, 3 pooling × 7 layers）

测试 `last-token`、`mean`、`qr-attention` 三种池化方式在 L23-L8 七个层深度上的检索质量。

**完整矩阵：**

```
                     ──────────── 池化方式 ────────────
层    cos vs L23     last-token         mean              qr-attention
──────────────────────────────────────────────────────────────────────────
L23   1.00           8/12 MRR=0.04      11/12 MRR=0.27    11/12 MRR=0.28
L22   0.41           6/12 MRR=0.12      9/12 MRR=0.55 ★   9/12 MRR=0.50
L20   0.35           2/12 ❌            9/12 MRR=0.43     9/12 MRR=0.44
L18   0.31           2/12 ❌            10/12 MRR=0.41    10/12 MRR=0.41
L15   0.27           1/12 ❌            10/12 MRR=0.33    10/12 MRR=0.23
L12   0.23           0/12 ☠             9/12 MRR=0.31     9/12 MRR=0.31
L8    0.14           0/12 ☠             9/12 MRR=0.36     9/12 MRR=0.37
```

**★ L22-mean 是新王者：MRR=0.5486，中位数排名 #1**

**关键发现：**

1. **last-token 极度依赖层深度**：它只看最后一个 token 的 hidden state。离 lm_head 越远，这个 token 的语义方向越偏，L20 以下命中从 8 骤降到 2→0。

2. **mean 出奇地强且对层不敏感**：L22-mean 的 MRR=0.55 是全场最高，且即使在 L8 仍然有 9/12 命中。mean pooling 的分布式特性（所有 token 平均）使其对单个 token 的层变换扭曲有天然容错。

3. **qr-attention 只在最后层优于 mean**：qr-attention 依赖"最后 token 对前文的 cosine 相似度"作为注意力权重。这个信号只在接近 lm_head 对齐层时有意义——L23 时 qr (0.28) > mean (0.27)，L22 时就被 mean 反超 (0.55 > 0.50)。

4. **qr-attention 在浅层的退化**：L8 时所有 token 的 hidden states 高度相似（都在编码表面特征），cosine 全部挤在 0.8 附近，softmax 拉不开差距，权重退化到 1/n → 等价于 mean pooling（L8: qr 0.37 ≈ mean 0.36）。

**直觉模型：**

| 池化 | 机制 | 层敏感度 | 最佳层 |
|------|------|:--:|:--:|
| last-token | 取一个点 | 极高 | L23 only |
| qr-attention | 最后 token 加权 | 中 | L23 |
| mean | 等权平均 | 低 | L22 |

**结论：最佳组合 = 干净层 (L22) × 干净池化 (mean)**——两个维度都没有引入噪声。

### 2026-05-24：多模型全层扫描对比（5 因果 LM + 1 嵌入模型）

对 6 个不同大小和训练目标的模型运行完整的全层 cosine 扫描。

**⚠️ 注意：早期扫描因层数检测 bug（`totalLayers - 1` 而非 `totalLayers - 2`）导致对大模型只扫了前 24 层，得出了"悬崖随模型大小衰减"的错误结论。以下为修正后数据。**

**完整对比表：**

| 模型 | 参数量 | 层数 | 训练目标 | L0 | L(N-2) | L(N-1) | Δ(悬崖) |
|------|:--:|:--:|------|:--:|:--:|:--:|:--:|
| MiniCPM-V-4.6 | 0.5B | 24 | 通用 VLM | 0.09 | 0.41 | 0.41 | **0.59** |
| Qwen3.5-4B | 4B | 32 | 通用 LLM | 0.08 | 0.43 | 0.47 | **0.53** |
| Qwen3.5-9B | 9B | 32 | 通用 LLM | 0.17 | 0.41 | 0.60 | **0.40** |
| Qwen3.6-27B | 27B | 64 | 通用 LLM | 0.09 | 0.56 | 0.56 | **0.44** |
| Qwen3.6-35B-A3B | 35B | 40 | MoE LLM | 0.17 | 0.38 | 0.38 | **0.62** |
| Qwen3-Embedding | 0.6B | 28 | 对比学习 | 0.03 | 0.70 | 0.70 | **0.30** |

**修正后的规律：**

**1. 悬崖是因果 LM 的固有属性，与模型大小无关**

```
Δ(L(N-1)→L(N))：
0.5B (24层)  ████████████████████████████████  0.59
4B   (32层)  █████████████████████████████     0.53
9B   (32层)  ████████████████████████           0.40
27B  (64层)  ██████████████████████████         0.44
35B  (40层)  ███████████████████████████████    0.62
Emb  (28层)  ████████████████                   0.30  ← 嵌入模型悬崖小但仍存在
```

所有因果 LM 的悬崖在 0.40-0.62 之间，**与参数量无明显相关性**。0.5B 和 35B 的悬崖几乎一样大。悬崖来自 next-token prediction 训练目标，而非容量限制。

**2. 嵌入模型也有悬崖，但更小**

Qwen3-Embedding (0.6B, 对比学习) 的悬崖为 0.30，约是因果 LM 的一半。L26=0.70（vs MiniCPM 的 L22=0.41），说明嵌入模型的倒数第二层已经与最后层高度一致，悬崖更平缓。

**3. L0 在 5 个因果 LM 中高度一致：0.08-0.17**

与 MiniCPM L0=0.09 几乎相同——所有因果 LM 的浅层都与最终语义表示接近正交。只有 Qwen3-Embedding 的 L0=0.03 更低（嵌入模型不需要在浅层保留任何 next-token 结构）。

**4. L(N-2) 的规律**

| 模型类型 | L(N-2)→last cos | 含义 |
|------|:--:|------|
| 因果 LM <10B | 0.41-0.43 | 倒数第二层已远离最后层，必须跨过 |
| 因果 LM >10B | 0.38-0.56 | 同样有显著差距 |
| 嵌入模型 | 0.70 | 更接近，但仍有 0.30 悬崖 |

**对中层提取的修正指导：**

| 模型条件 | 是否需要中层提取 | 建议 |
|------|:--:|------|
| 因果 LM（任何大小） | 🔴 需要 | 至少 L(N-2)，悬崖大小不随模型增大而消失 |
| 嵌入模型（任何大小） | 🟡 可选 | L(N-1) 足够，悬崖较小 |




- `embedderPoolingLayer` 默认值建议从 `"last"` 改为具体层索引（如 22），或自动检测模型层数后取 92% 深度
- 多层平均实验：测试"最后 N 层加权平均"（如 L20-L23 平均）是否能同时保持覆盖率和排序质量
- 不同模型验证：在 Qwen3-Embedding / jina-v5 上重复 layer sweep 对比
- `scripts/test-midlayer-embd.ts` 和 `src/examples/layer-sweep.sh` 可作为持续验证工具
