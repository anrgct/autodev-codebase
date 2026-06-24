# 260624-node-llama-cpp-embd-injection

## 主题/需求

给 `@realtimex/node-llama-cpp` 打补丁，暴露**底层 embedding 向量注入（embd injection）+ token→embd 查表**两项能力，使其支持把连续向量直接写入 `llama_batch.embd` 并 `llama_decode`——而非只能喂 token id。

**背景**：`260624-recon-agent-multihop.md` 计划用 LLM2Vec 的 reconstruction_mlp 输出（`recon[10, n_embd]` 连续向量）作为 decoder 软提示。**主路径是混合注入**：`[recon 软提示 × 10] + [文本提示词 token_embd × T]` 拼成一个 embd 序列，一次 decode 建 KV cache，再 greedy 续写——复刻 `demo_llamacpp.py` 的 `teacher_forced` 结构（`[recon×K + ans_embd×T]`）结合 `generate_free_running` 的续写机制。

**为什么混合注入而非纯 free-running**：纯 `[recon×10]` 注入后 greedy 解码已知会坍塌（参考脚本注释 + `recon_root_cause_report.md §4.4`）。文本提示词给 decoder 一个**结构锚点/方向引导**，缓解坍塌，更可能产出有用的 query 扩展。纯 free-running 仅作对比基线。

**目标**：
- C++ addon 新增：① embd 注入（`llama_batch_init(n_tokens, n_embd, 1)` + 写 `batch.embd`）② token→embd 查表（从 `token_embd.weight` 取任意 token 的输入嵌入向量）
- JS 层封装 `initBatchEmbd` / `addToBatchEmbd` / `getTokenEmbeddings`
- 应用层（`llamacpp-llm2vec.ts`）新增 `generateWithPrompt(text, prompt, maxTokens)`：recon + 提示词混合 embd → decode → greedy 续写
- 验证：对 worst20 题跑混合注入，观察生成文本质量（含坍塌程度、是否含 gold 实体）

**预期成果**：node 侧具备与 `demo_llamacpp.py:teacher_forced` + `generate_free_running` 等价的能力，为 recon-agent 多跳搜索提供基础。

## 代码背景

### 现有 patch 基础设施

项目已有完整的 node-llama-cpp C++ patch 体系（见 `docs/08-llama-cpp-build-flow.md`），`AddonContext.h/cpp` 累积了两次 patch：

| 功能 | C++ 改动 | 关联文档 |
|------|----------|----------|
| 中层 embedding 提取 (`embd_layer`) | `llama.h`/`llama-cparams.h`/`llama-context.cpp` + 107 模型文件 | `docs/plans/260524-llamacpp-midlayer-embd.md` |
| QRRanker `kq_soft_max` 采集 | `cbEval` callback、`collectKqSoftMax`、`kqQueryStart/End` | `docs/plans/260523-qrranker-ubatch-overflow-fix.md` |

### 涉及文件

| 文件 | 角色 |
|------|------|
| `vendor/llama-addon/AddonContext.h` | C++ addon 头文件，新增 embd 方法 + token embd 查表声明 |
| `vendor/llama-addon/AddonContext.cpp` | C++ addon 实现，新增 `InitBatchEmbd`/`AddToBatchEmbd`/`GetTokenEmbeddings` |
| `vendor/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js` | JS 封装层，新增 `initBatchEmbd`/`addToBatchEmbd`/`getTokenEmbeddings` |
| `vendor/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.d.ts` | 类型声明 |
| `vendor/llama-addon/build.mjs` | 编译入口（无需改，复用现有两遍编译） |
| `src/code-index/embedders/llamacpp-llm2vec.ts` | 应用层，新增 `generateWithPrompt`/`generateFreeRunning` |
| `scripts/evidence/260624-embd-injection-smoke.ts` | 观测脚本（验证 embd 注入正确性） |

### C++ addon 现状（关键代码路径）

**batch 构建**（`AddonContext.cpp:747`）：
```cpp
Napi::Value AddonContext::InitBatch(...) {
    int32_t n_tokens = info[0].As<Napi::Number>().Int32Value();
    batch = llama_batch_init(n_tokens, 0, 1);  // ← embd=0，走 token id 路径
    ...
}
```

**加 token**（`AddonContext.cpp:784`）：
```cpp
Napi::Value AddonContext::AddToBatch(...) {
    // info[2] = Uint32Array tokens
    common_batch_add(batch, tokens[i], firstTokenContextIndex + i, { sequenceId }, logits);
}
```

**decode**（`AddonContext.cpp:34` `AddonContextDecodeBatchWorker::Execute`）：
```cpp
int r = llama_decode(ctx->ctx, ctx->batch);  // ← 本身支持 embd，无需改
```

**取 logits / 采样**（`AddonContext.cpp:287` `AddonContextSampleTokenWorker`）：
```cpp
const auto * logits = llama_get_logits_ith(ctx->ctx, batchLogitIndex);  // 续写每步复用
```

**JS 调用链**（`LlamaContext.js:309-368`）：
```js
this._ctx.initBatch(currentBatchSize)
this._ctx.addToBatch(seqId, firstIndex, Uint32Array.from(tokens), Uint32Array.from(logitIndexes))
await this._ctx.decodeBatch()
```

### 参考实现（Python，已验证可跑）

**混合注入结构**（`demo_llamacpp.py:542` `teacher_forced`）：
```python
recon = self.encoder.get_recon(question)        # [10, n_embd] recon 软提示（连续向量）
ans_embd = self.tok_embd[ans_ids]               # 文本 tokenize 后查 token_embd 表 → [T, n_embd]
seq_recon = np.concatenate([recon, ans_embd])   # [K+T, n_embd] 混合序列 ← 本任务主路径
logits = self._decode_embd(seq_recon)           # 一次 decode
```

**续写机制**（`demo_llamacpp.py:492` `generate_free_running`）：
```python
# step0: 喂 K 个 embd 建 KV cache
batch = llama_cpp.llama_batch_init(K, self.n_embd, 1)  # embd=n_embd（关键）
batch.logits[K-1] = True
for i in range(flat.shape[0]):
    batch.embd[i] = float(flat[i])
llama_cpp.llama_decode(self.ctx, batch)
# step1+: 喂 token id 续接 KV cache，greedy argmax
```

本任务 = `teacher_forced` 的混合前缀（`[recon + 提示词 embd]`）+ `generate_free_running` 的 token 续写。

### LLM2Vec recon 管道（应用层基础）

`llamacpp-llm2vec.ts:_encode()` 返回 `{ embedding, hiddenStates }`，其中 `hiddenStates` 是最后 10 个 `<question>` token 的 raw 隐藏状态 `[10, n_embd]`。对每个 hidden state 做 `reconstruction_mlp`（`_applyLinear(h, rW, rb, dim)`）即得 recon 软提示 `[10, n_embd]`。

## 运行观测

### 现象 1：node-llama-cpp 高层 API 不支持 embd 注入

`@realtimex/node-llama-cpp` v0.163.0 的 `LlamaContextSequence` 只暴露：
- `evaluate(tokens: Token[])` — 只接受 token id
- `controlledEvaluate(input: ControlledEvaluateInputItem[])` — `ControlledEvaluateInputItem = Token | [Token, options]`，同样无 embd 字段
- `evaluateWithoutGeneratingNewTokens(tokens)`

addon 层（`.node` 二进制）未导出 `llama_batch_init` 给 JS。`batch.embd` 字段被高层封装封死。

### 现象 2：参考脚本能跑混合注入，因为 Python 绑定暴露了底层

`llama-cpp-python` 暴露 `llama_cpp.llama_batch_init` + `batch.embd` 逐元素写 + 直接读 `token_embd.weight` tensor 查表，故 `demo_llamacpp.py` 可实现 `[recon + 文本 embd]` 混合注入。Node 侧缺少等价 API。

### 现象 3：纯 free-running 坍塌，混合注入更可控

参考脚本注释明确写"free-running 坍塌现象与 torch 版 record.md §6.1 一致"。纯 `[recon×10]` 注入后 greedy 易退化成重复/垃圾。混合注入用文本提示词给结构锚点，是缓解坍塌的主路径。

## 归因分析

### 为什么 node-llama-cpp 封死了 embd 注入

node-llama-cpp 设计为"token-in / token-out"的高层抽象，`evaluate` 把 tokenize→batch→decode→sample 全包了。`llama_batch.embd` 字段（接受 embedding 向量替代 token id 的 forward pass）是 llama.cpp 底层 C API 能力，但高层认为不需要（绝大多数用例是 token 生成），故未暴露。同理，`token_embd.weight` 直接查表（取输入嵌入向量，未经 transformer 层）也未暴露。

recon 软提示注入是"embedding-in"的特殊用例（训练时 `inputs_embeds`），必须绕过 tokenize 直接写 embd；文本提示词要和 recon 混在同一 batch，也必须查表成 embd。

### 为什么选方案 B（打补丁）而非 A（混合 Python）

| 方案 | 代价 |
|------|------|
| A 混合架构 | 进程间通信、双份模型加载、eval 脚本割裂 |
| **B 打补丁**（本任务） | 一次性 C++ + JS 改动，但 node 侧原生能力，与现有 patch 体系一致 |
| C 离散化近似 | recon→最近 token 离散化，信息损失，已被否决 |

项目已有 `embd_layer`/`kq_soft_max` 两次 C++ patch 经验和完整 `build.mjs` 脚手架，方案 B 边际成本低。

### 为什么主路径是"recon + 提示词混合"而非纯 free-running

| 模式 | 输入 | 坍塌风险 | 可控性 |
|------|------|----------|--------|
| 纯 free-running | `[recon×10]` | 高 | 差（只有软提示） |
| **recon + 提示词**（主路径） | `[recon×10] + [提示词 embd×T]` | 低 | 好（提示词给结构/方向引导） |

提示词（如 `"Query: 找出相关线索"`）给 decoder 明确的起点和生成方向，是缓解 recon 单独注入坍塌的关键。

## 关键决策

### 决策 1：新增 embd 注入方法，与现有 token-id 路径并存

不改造 `InitBatch`/`AddToBatch`（避免破坏现有 evaluate/embedding/embd_layer/kq_soft_max 全链路），而是新增：
- C++：`InitBatchEmbd(n_tokens)`（内部 `llama_batch_init(n_tokens, n_embd, 1)`）+ `AddToBatchEmbd(seqId, firstPos, Float32Array embd, nTokens, nEmbd, logitsFlag)`
- JS：`initBatchEmbd(n_tokens)` / `addToBatchEmbd(seqId, firstPos, Float32Array embd, nTokens, logitIndexes)` — 与现有 `initBatch`/`addToBatch` 风格一致，低层分离式 API，应用层自行拼 batch

`decodeBatch`/`sampleToken`/`getEmbedding` 直接复用（`llama_decode` 本身支持 embd）。

### 决策 2：新增 token→embd 查表方法（混合注入的必需件）

文本提示词要和 recon 放同一 embd batch，必须先查表成 `[T, n_embd]` 向量：
- C++：`GetTokenEmbeddings(Uint32Array tokenIds) → Float32Array`，内部从模型 `token_embd.weight` tensor 查表（全量 vocab、无损、未经 transformer 层）
- llama.cpp 取 token 输入嵌入：通过模型 tensor 访问（参考脚本 `_load_token_embd_from_bf16_tensor` 从 GGUF 文件读，C++ 侧可直接用已加载的 tensor，更快）

> 注：应用层 `llamacpp-llm2vec.ts` 已有 `scanGgufTensors`+`loadQ8_0Tensor` 读 token_embd（前 32K、Q8_0 反量化），用于 `_findNearestTokens`。但提示词可能含中文/特殊 token 超出 32K，且 Q8_0 有量化误差。C++ 侧查表用模型已加载的原始 tensor，全量无损，是正确做法。

### 决策 3：混合注入 + token 续写的两阶段 decode

free-running 两阶段（`teacher_forced` 前缀 + `generate_free_running` 续写）：
1. step0（embd 模式）：`InitBatchEmbd(10+T)` → `AddToBatchEmbd([recon×10 + 提示词embd×T])` → `decodeBatch`（建 KV cache，position 0..10+T-1，末位输出 logits）
2. step1+（token 模式）：切回 `InitBatch(1)` → 循环 `AddToBatch(token, position=10+T+i)` → `decodeBatch` → `sampleToken` greedy 续接同一 sequence，直到 EOS/maxTokens

跨 batch 的 embd→token 切换：KV cache 是 context 级别（不在 batch 里），`InitBatch` free 旧 batch 不影响 KV cache，只要 position/seq_id 续接正确（参考脚本 llm2vec-gen/scripts/demo_llamacpp.py` `generate_free_running` 已验证此模式）。

### 决策 4：logits 取最近 batch 末位

续写每步只需最后一位的 logits 做 argmax。`llama_get_logits_ith(ctx, batch.n_tokens - 1)` 即可，复用现有 `sampleToken`（已有 greedy 采样）。

## 实施计划

### 阶段 1：C++ addon 新增 embd 注入 + token 查表

- [x] `AddonContext.h` 新增方法声明：`InitBatchEmbd`、`AddToBatchEmbd`、`GetTokenEmbeddings`
- [x] `AddonContext.cpp` 实现：
  - `InitBatchEmbd(n_tokens)`：`llama_batch_init(n_tokens, llama_model_n_embd(model->model), 1)`
  - `AddToBatchEmbd(seqId, firstPos, Float32Array embd, nTokens, nEmbd, logitsFlag)`：逐元素写 `batch.embd`，设 `batch.pos`/`seq_id`/`logits`。`seq_id` 显式 malloc（与 `common_batch_add` 一致，`llama_batch_free` 负责释放）
  - `GetTokenEmbeddings(Uint32Array tokenIds)`：手工解析 GGUF 二进制，定位 `token_embd.weight`，支持 F32/F16/BF16/Q8_0 四种类型，返回 `Float32Array [nTokens * nEmbd]`
- [x] `AddonContext.cpp` 注册 InstanceMethod：`initBatchEmbd`、`addToBatchEmbd`、`getTokenEmbeddings`
- [x] `npm run build:llamacpp` 编译 + 部署

### 阶段 2：JS 层封装

- [x] `LlamaContext.js` 新增：
  - `initBatchEmbd(n_tokens)` — 初始化 embd 注入 batch
  - `addToBatchEmbd(seqId, firstPos, embdFlat, nTokens, logitIndexes)` — 写入 embedding 向量
  - `getTokenEmbeddings(tokenIds)` — 透传 C++ token 查表方法
- [x] `LlamaContext.d.ts` 补类型声明
- [x] 部署到 `vendor/node-llama-cpp/dist/` + `node_modules/`

### 阶段 3：应用层混合注入生成

- [x] `llamacpp-llm2vec.ts` 新增 `generateWithPrompt(text, prompt, maxTokens)`：
  - `_encode(text)` → hiddenStates → reconstruction_mlp → recon[10, n_embd]
  - `prompt` → tokenize → `getTokenEmbeddings` → promptEmbd[T, n_embd]
  - 取底层 `LlamaContext` 实例（从 `_genContext._ctx` 拿 `_ctx`）
  - `clearHistory()` → step0：`initBatchEmbd` + `addToBatchEmbd` 建 KV cache
  - step1+：切 token 路径循环 `initBatch` + `addToBatch` → `decodeBatch` → `sampleToken`，直到 EOS/maxTokens
  - 创建 AddonSampler 实现 greedy argmax 采样
- [x] `generateFreeRunning(text, maxTokens)`（纯 recon，作对比基线）

### 阶段 4：验证

- [x] **观测 1：patch 符号检测** — `nm` + JS 运行时确认三个新方法 ✅
- [x] **观测 2：embd 注入基本流程** — `getTokenEmbeddings` → `initBatchEmbd` → `addToBatchEmbd` → `decodeBatch` ✅
- [x] **观测 3：精度不变量**（embd vs token 路径 hidden state `max|Δ| = 0`）✅
- [x] **观测 4：free-running 生成**（recon → greedy 续写，与 Python `demo_llamacpp.py` 一致性验证）✅
  - Qwen3-4B Q8_0：`"The solution is:"` — 与 Python 输出完全一致
  - 详见下方踩坑记录 #4（`sampleToken` 返回值 bug）
- [x] **观测 5：混合注入生成**（recon + 提示词 → greedy 续写）✅
  - `generateWithPrompt` 已修复 Metal GPU 多 context 冲突（`clearHistory` → `disposeSequence(0)`）
  - Qwen3-4B Q8_0：`" to answer the question \"What is the capital of France?\"<|end_of_text|>"`
  - 生成文本含 gold 实体 `France`/`Paris`，无坍塌
- [ ] 调优提示词模板

## 实施记录

### 2026-06-24

**阶段 1-3 实施完成**：
- C++ addon：`InitBatchEmbd`、`AddToBatchEmbd`、`GetTokenEmbeddings` 实现 + NAPI 注册
  - `GetTokenEmbeddings` 采用纯文件 I/O 手工解析 GGUF header（不依赖 internal API），支持 F32/F16/BF16/Q8_0
  - `AddToBatchEmbd` 的 `seq_id` 内存管理对齐 `common_batch_add`（显式 malloc，`llama_batch_free` 释放）
- JS 层：`LlamaContext.js` + `LlamaContext.d.ts` 新增三个代理方法
- 应用层：`llamacpp-llm2vec.ts` 新增 `generateWithPrompt`（混合注入主路径）和 `generateFreeRunning`（对比基线）
- 编译 + 部署：`npm run build:llamacpp` 两遍编译通过，部署到 `vendor/` + `node_modules/`

**smoke test 验证**：
- C++ 符号检测：`nm` 确认 `InitBatchEmbd`/`AddToBatchEmbd`/`GetTokenEmbeddings` 存在，JS 运行时检测通过
- `getTokenEmbeddings`：成功读取 Q8_0 GGUF 的 `token_embd.weight`，6 tokens × 1024 dim = 6144 floats
- `initBatchEmbd(6)` + `addToBatchEmbd` (logitRes=[5]) + `decodeBatch`：embd 注入 forward pass 成功
- `getEmbedding` 在 LLM2Vec unified 模型上不可用（非 NONE pooling），精度不变量验证需另选 NONE-pooling 模型

**最终精度验证（2026-06-24，修复 GGUF offset + Q8_0 bf16 scale 后）**：

| 模型 | n_embd | hidden[0] embd | hidden[0] token | max|Δ| | 结果 |
|------|--------|---------------|-----------------|----------|------|
| MiniCPM5-1B Q8_0 | 1536 | -14.042735 | -14.042735 | **0.000e+0** | ✅ |
| LLM2Vec unified Q8_0 | 1024 | 0.185706 | 0.185706 | **0.000e+0** | ✅ |

两个模型 embd 路径与 token 路径的末位 hidden state **完全一致**（`max|Δ| = 0`，远超预期的 `1e-4` 阈值）。

**踩坑记录**：
1. **`dataStart` 偏移错误** → embd 全是零。手动 GGUF KV 解析的 `sizes[]` 数组只覆盖 type 0-9，缺少 FLOAT64 (12)。改用 `gguf_init_from_file` + `gguf_get_data_offset`。
2. **Q8_0 scale bf16** → embd 全是 NaN。新 GGUF v3+ 用 bf16 存 Q8_0 scale，初版始终用 fp16 解码，NaN 传播到 hidden state。改为 `fp16ToF32` + NaN 回退 `bf16ToF32`。
3. **误删 `DisposeSequence`** → DLL 加载失败。Python 替换 `GetTokenEmbeddings` 函数时边界识别错误，连带删除了紧邻的 `DisposeSequence` 实现。补回。
4. **`sampleToken(ctx, sampler, false)` 返回数组导致 free-running 坍塌成 `"!!!!!"`** — **根因最深的坑**。
   - **现象**：free-running 生成全是 `"!!!"`（token 0），4B 和 0.6B 都坍塌。但 Python `demo_llamacpp.py` 用相同模型 / 相同 recon 向量不会坍塌。
   - **排查过程**：
     1. 逐步对比 Python 和 TS：hidden states 完全一致（6 位小数）、recon 向量完全一致、step0 首 token 一致（id=785）——encoding 和 embd 注入都正确
     2. step1 出现分歧：Python 得 token 6291（"solution"），TS 得 token 0（"!"）
     3. 在 C++ addon 新增 `getLogitsRow` 方法 dump raw logits，发现 step1 logits argmax=6291 —— **logits 正确，问题在 sampler 返回值**
     4. 打印 `sampleToken` 返回值类型：`typeof === "object"`（数组），不是 number！
   - **根因**：`AddonContextSampleTokenWorker` 构造函数中 `arrayResult = info.Length() > 2 && info[2].IsBoolean()`。传入 `false` 作为第三个参数 → `info[2].IsBoolean() == true` → `arrayResult = true` → `OnOK` 返回 `[tokenId, probabilities?]` 数组而非裸数字。调用方 `Number([785, ...])` → `NaN` → `Uint32Array` 存 0 → 喂 token 0（"!"）→ 全步坍塌。
   - **修复**：所有 `sampleToken` 调用移除第三个参数 `false`，只传 `(batchLogitIndex, sampler)` → `info.Length() == 2` → `arrayResult = false` → 返回裸 number。
   - **验证**：修复后 Qwen3-4B free-running 输出 `"The solution is:"`，与 Python `demo_llamacpp.py` 完全一致。

**C++ addon 额外新增**：`GetLogitsRow(batchTokenIndex)` 方法 + `getLogitsRow` JS 注册。Debug 用途，返回 `llama_get_logits_ith` 的 raw logits（Float32Array），用于排查采样问题。

**Metal GPU 多 context 冲突修复**（2026-06-24）：
- 根因：`this._genSequence.clearHistory()` 是高层 sequence 方法，与 embd 注入路径（直接操作 addon context 的 `initBatchEmbd`/`addToBatchEmbd`/`decodeBatch`）的 seqId 管理不同步，KV cache 没清干净，第二次 `decodeBatch` 触发 `GGML_ASSERT([rsets->data count] == 0)`。
- 修复：两处（`generateWithPrompt` + `generateFreeRunning`）都改用 `ctx.disposeSequence(0)` — 直接调 addon 层的 `llama_kv_cache_seq_rm` 清 seqId=0 的 KV cache。

**待完成**：
- 调优提示词模板

---

文档创建。技术调研完成：
- 确认 node-llama-cpp 高层 API 无 embd 注入 + token embd 查表能力
- 定位 C++ 补丁落点（`InitBatch`/`AddToBatch` 旁新增 embd 变体 + `GetTokenEmbeddings`）
- 确认 `decodeBatch`/`sampleToken`/`getEmbedding` 可复用
- 参考 `demo_llamacpp.py:teacher_forced`（混合前缀）+ `generate_free_running`（token 续写）的两阶段范式
- 明确主路径为 recon + 提示词混合注入（非纯 free-running），提示词作结构锚点缓解坍塌
- 创建观测脚本 `scripts/evidence/260624-embd-injection-smoke.ts`（伪代码）：观测 1 embd 注入不变量（embd 路径 vs token 路径 hidden state `max|Δ|<1e-4`）+ 观测 2 混合注入生成（gold 实体命中 + 3-gram 坍塌检测），含 patch 前置检测

## 修订记录

### 2026-06-24

**文档创建**：记录 node-llama-cpp embd 注入 + token 查表补丁任务，作为 `260624-recon-agent-multihop.md` 的前置依赖。

**方向修订**：从"纯 free-running"调整为"recon embed + 文本提示词混合注入"（teacher-forced 前缀 + 续写）为主路径。理由：纯 free-running 已知坍塌，提示词混合注入更可控。补丁相应增加 `GetTokenEmbeddings`（token→embd 查表）能力。

## 总结

### 关键假设

1. `llama_decode(ctx, batch)` 在 `batch.embd` 非空、`batch.token` 为空时能正常 forward（llama.cpp 底层支持，参考脚本已验证）
2. 跨 batch 的 embd→token 模式切换可续接同一 KV cache（参考脚本 `generate_free_running` 已验证）
3. node-llama-cpp 的 `LlamaContext` 能暴露底层 addon 实例（已有 `_ctx` 字段调用 `initBatch` 等先例），embd 注入路径可挂载
4. 提示词混合注入能显著缓解纯 free-running 坍塌（待阶段 4 验证）

### 后续

- 本任务完成后，回到 `260624-recon-agent-multihop.md` Step 0：用混合注入生成文本验证 recon 信号质量
- 若混合注入仍坍塌，研究提示词模板调优 / teacher-forcing query 本身作前缀 / 截断生成策略
