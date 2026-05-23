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

*(待填写)*

## 修订记录

*(待填写)*

## 总结

### 改动规模估算

| 层次 | 文件数 | 预估行数 | 难度 |
|------|:---:|:---:|:---:|
| llama.cpp API 层 | 3 | ~20 | 低 |
| llama.cpp Graph | 2 | ~30 | 中 |
| llama.cpp 模型架构 | ~30 | ~150 | 中（机械重复） |
| node-llama-cpp | 3 | ~30 | 低 |
| autodev-codebase | 4 | ~30 | 低 |
| **合计** | **~42** | **~260** | |

### 风险点

1. **架构差异**：BERT 等 encoder-only 模型的 embedding 提取路径不同，可能需要单独处理
2. **DeepStack 架构**：Qwen3 的 DeepStack 有交错层结构，`embd_layer` 的语义可能需要澄清（索引的是 transformer 层还是包括 DeepStack 层？）
3. **output_norm 缺失**：部分模型没有独立的 `output_norm`（如 BERT 用 `result_embd`），需要分类处理
4. **性能影响**：中间层截断不会减少计算量（后续层仍需构建），但可以减少 GPU→CPU 的数据拷贝量（`embd` 数组只有到目标层的 token 数 × n_embd 大小）

### 后续工作

- 中间层实验：在 MiniCPM-V-4.6 上用 `embedderPoolingLayer: 15, 20, 25, 30`（共 48 层）跑 eval 对比
- 多层平均实验：如果单层效果不显著，测试"最后 N 层平均"的效果
- 如果实验证实中间层有效，考虑在 llama.cpp 层面做"多层加权平均"的优化（单次 forward pass 内完成）
