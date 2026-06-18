# 260617-llm2vec-embedder-provider

## 主题/需求

给 `embedderProvider` 增加 `"llm2vec"` 选项，接入 LLM2Vec-Gen-Qwen3-0.6B 的 Q8_0 GGUF 作为新 embedder provider，跑通 demo 目录的语义搜索。

**目标**：
- 新增 `embedderProvider: "llm2vec"` 配置选项
- 新增 `embedderGgufLlm2vecPath` 配置字段指向 GGUF 文件
- embedding 管道与 Python 版 `demo_llamacpp.py` 的 `encode()` 语义对齐
- 不需要修改 node-llama-cpp 或 llama.cpp

## 代码背景

### 涉及文件

| 文件 | 角色 |
|------|------|
| `src/code-index/interfaces/config.ts` | EmbedderProvider 类型、Llm2VecEmbedderConfig、config 字段 |
| `src/code-index/interfaces/embedder.ts` | AvailableEmbedders 类型 |
| `src/code-index/interfaces/manager.ts` | manager 层的 EmbedderProvider 类型 |
| `src/shared/embeddingModels.ts` | 模型配置文件和 getDefaultModelId |
| `src/code-index/embedders/llamacpp-llm2vec.ts` | **新建** LlamaCppLlm2VecEmbedder 类 |
| `src/code-index/service-factory.ts` | createEmbedder/createVectorStore/localProviders |
| `src/code-index/constants/index.ts` | EMBEDDER_BATCH_SIZES |
| `src/code-index/search/instruction-prefix.ts` | resolveQueryPrefix/resolveDocumentPrefix |
| `src/code-index/config-manager.ts` | isConfigured/currentModelId |
| `src/commands/config/metadata.ts` | CONFIG_KEY_METADATA |
| `demo/autodev-config.json` | demo 配置切换 |
| `llm2vec-gen/gguf/qwen3-06b-llm2vec-unified-q8_0-mlp.gguf` | 模型文件（775 MB，Q8_0） |

### 模型架构

LLM2Vec-Gen 使用 Qwen3-0.6B 基座，在前 10 个 `<questionN>` token（id 151669-151678）上加 PEFT delta。embedding 管道（两个 MLP **串联**，见 `llm2vec_gen_flow.md` §1/§2.1 对 `modeling_encoder_decoder.py:547-556` 的逐行分析）：

```
text + <question1..10> → tokenize(special=true) → encoder
→ 取最后 10 token hidden states
→ reconstruction_mlp(x@rW.T+rb)        # = recon
→ alignment_mlp(x@aW.T+ab)             # = align(recon)
→ mean(10) → L2 normalize → 1024-dim vector
```

- `reconstruction_mlp`：1024×1024 线性，把 last10 hidden 投影成 `recon`（索引路径的中间产物；同时可作 decoder 软提示用于 debug 解释）
- `alignment_mlp`：1024×1024 线性，输入是 `recon`（不是原始 hidden），产出最终可检索向量

两个 MLP **串联**而非平行分叉：`alignment_mlp` 的输入是 `reconstruction_mlp` 的输出。源码 `encode()` L547-556：

```python
decoder_input_hidden_states = self.reconstruction_mlp(decoder_input_hidden_states)  # recon
encoder_hidden_states = decoder_input_hidden_states                                # = recon
if self.alignment_mlp is not None:
    encoder_hidden_states = self.alignment_mlp(encoder_hidden_states)              # align(recon)
```

```
索引/检索：last10 hidden → reconstruction_mlp → alignment_mlp → mean(10) → L2 normalize → 1024-dim vector
debug 解释：last10 hidden → reconstruction_mlp → recon（连续软提示）→ decoder 解码
```

两个 MLP 权重嵌入在 GGUF metadata 中（`llm2vec_gen.{alignment,reconstruction}_mlp.*`）。

## 关键决策

### 决策 1：LLM2Vec 作为独立 provider（而非复用 llamacpp-llm）

**理由**：
- LLM2Vec 的 embedding 管道需要特殊 tokenize（`special=true`）+ alignment_mlp 后处理
- 与 llamacpp-llm 的 `getEmbeddingsForTokens` + pooling 模式差异较大
- 独立 provider 便于后续扩展（如 demo 的 recon 通道）

### 决策 2：MLP 在 JS 侧用数组运算完成

**理由**：llama.cpp 无法表达「encoder 后接独立线性头」的拓扑。alignment_mlp 是标准 `nn.Linear`，numpy `x @ W.T + b` 与 JS 数组运算数学完全一致。GGUF 只负责产出 raw per-token hidden states。

### 决策 3：索引走 recon→align 串联，reconstruction_mlp 是索引路径必需环节

**理由**（基于 `llm2vec_gen_flow.md` §1/§2.1/§3.1 对 `modeling_encoder_decoder.py:547-556` 的逐行源码分析，推翻此前「align-only」的假设）：

1. **源码字面**：`encode()` L547-556 中 `alignment_mlp` 的输入是 `reconstruction_mlp` 的输出（recon），两者串联，不是平行分叉：
   ```python
   decoder_input_hidden_states = self.reconstruction_mlp(decoder_input_hidden_states)  # recon
   encoder_hidden_states = decoder_input_hidden_states                                # = recon
   if self.alignment_mlp is not None:
       encoder_hidden_states = self.alignment_mlp(encoder_hidden_states)              # align(recon)
   ```

2. **alignment loss 公式**（论文 §3 + `losses.py`）：`ê_i = Pool(alignment_mlp(reconstruction_mlp(h)))` —— 串联写在损失计算里。

3. **两份 demo 一致**：torch `demo_quickstart.py` 的 `model.encode()` 和 llama.cpp 版 `demo_llamacpp.py` 的 `Llama2VecEncoder.encode()` 都是 `last10 → rW → aW → mean → L2`，互相印证。

4. **此前「两个 MLP 是设计上独立的头、索引只用 align-only」的说法缺乏源码支撑**，是对「torch encode() 不可靠」声明的过度推广。源码逐行分析证明 encode() 的串联逻辑是确定且一致的。

5. reconstruction_mlp 的输出（recon）同时是 debug 解释路径的 decoder 软提示来源（一物两用）。

**probe 实测**（torch 原版权重，短 documents 检索 cos 矩阵）：

| 路径 | 对角（相关） | 非对角（不相关） | 区分度 |
|------|------|------|------|
| recon→align（=原版 `model.encode()`） | 0.879 / 0.914 | 0.152 / 0.099 | 好 |
| align-only | 0.902 / 0.898 | 0.311 / 0.318 | 非对角偏高 |
| recon-only | 0.856 / 0.863 | 0.077 / 0.029 | 区分度最高 |

recon→align 的 0.8789 恰好等于原版 `model.encode()` 输出，可验证串联逻辑无误。

### 决策 4：teacher-forcing oracle 作为 debug 解释方式

**理由**：`[recon_token] + [query_text] → decoder 续写` 产生可读的自然语言解释，比 free-running（坍塌）或纯 nearest-token 更有信息量。

## 实施计划

- [x] 在 3 个类型定义文件中添加 `"llm2vec"`
- [x] 添加 `embedderGgufLlm2vecPath` 配置字段（CodeIndexConfig / PreviousConfigSnapshot / ConfigSnapshot）
- [x] 创建 `LlamaCppLlm2VecEmbedder` 类
- [x] 接入 service-factory、config-manager、constants、instruction-prefix、metadata
- [x] 更新 demo/autodev-config.json
- [x] 验证：索引 + 搜索 + debug 解释

## 实施记录

### 2026-06-17

1. **添加类型定义**：3 个文件（config.ts/embedder.ts/manager.ts）+ embeddingModels.ts 共 4 处添加 `"llm2vec"`
2. **创建 embedder 类**：`src/code-index/embedders/llamacpp-llm2vec.ts`
   - `_ensureModel()`：readGgufFileInfo 读取 alignment_mlp + reconstruction_mlp 权重（均必需）→ 加载 llama.cpp 模型 → createEmbeddingContext(embdLayer=-1)
   - `_encode()`：tokenize(special=true) → getEmbeddingsForTokens → 取 last10 → reconstruction_mlp → alignment_mlp → mean → L2 norm（recon→align 串联，2026-06-18 修订）
   - `_ensureTokenEmbs()`：lazy 加载 Q8_0 token embeddings 子集（前 32K），用于 debug 最近 token 查找
   - `_ensureGenContext()`：lazy 创建 LlamaContext + LlamaCompletion，用于 debug decoder 生成
   - `_interpretHiddenStates()`（仅 debug）：reconstruction_mlp 投影 → 最近 token → teacher-forcing → decoder 续写
3. **接入各模块**：
   - `service-factory.ts`：导入新类，添加 `"llm2vec"` 分支到 createEmbedder/createVectorStore/localProviders
   - `config-manager.ts`：isConfigured/currentModelId 支持 llm2vec
   - `instruction-prefix.ts`：resolveQueryPrefix/resolveDocumentPrefix 支持 llm2vec（与 llamacpp-llm 一致）
   - `constants/index.ts`：添加 batch size=1
   - `commands/config/metadata.ts`：添加 metadata 条目
4. **测试**：
   - 索引：72/72 blocks，dimension=1024 自动检测 ✓
   - 搜索 `"batch processing"`：top=0.833 (README.md) ✓
   - 搜索 `"error handling"`：top=0.571 (model.py) ✓
   - 搜索 `"用户认证"`：中文语义搜索 ✓
   - debug 解释：teacher-forcing 产生可读自然语言输出 ✓

## 修订记录

### 2026-06-17（第二轮修正）

**问题 1：reconstruction_mlp 被误塞进索引管道。**
首轮实现 `_encode()` 是 `last10 → alignment_mlp → mean`（正确），但一度误改为
`last10 → reconstruction_mlp → alignment_mlp → mean`，理由是 torch 源码 `encode()`
里 align 接在 recon 输出后。后澄清：torch 源码 `encode()` 是 AI 生成的实现细节，
两个 MLP 在设计上是独立的头——**alignment_mlp 产可检索向量，reconstruction_mlp 产
decoder 软提示（仅解释用）**。索引只用 alignment_mlp。

**修复**：
1. `_encode()` 改回只走 alignment_mlp：`last10 → alignment_mlp → mean → L2 normalize`。
2. `reconstruction_mlp` 在 `_ensureModel()` 改回**可选**（缺失不报错），仅 debug 解释用。
3. `createEmbeddings()` guard 去掉 `_rW/_rb` 必需检查。
4. 类注释、字段注释同步说明两条独立流水线。

> ⚠️ **此结论已推翻**（2026-06-18，见上方《决策 3：索引走 recon→align 串联》）。
> 逐行源码分析（`llm2vec_gen_flow.md` §1/§2.1）证明两个 MLP 是串联而非独立头，
> `_encode()` 已改回 `recon→align` 串联，`reconstruction_mlp` 改回必需。本段保留作历史记录。

**问题 2：查询/文档端前缀抄错了源。**
早期实现把 `llm2vec` 当成 `llamacpp-llm` 复用通用前缀（`resolveDocumentPrefix` 对
非 jina 模型返回 undefined → 文档端完全无前缀）。中间一度抄了 `demo_llamacpp.py` 第二版的
`"Instruct: Given a web search query...\nQuery:"/Document:` —— 这是错的源。
正确的对齐基准是**原版 `demo_quickstart.py` + README Quick Start**：生成式口吻的非对称指令。

**修复**（对齐原版 demo_retrieval）：
1. `LLM2VEC_QUERY_PREFIX = "Generate a passage that best answers this question: "`
2. `LLM2VEC_DOCUMENT_PREFIX = "Summarize the following passage: "`
3. `resolveQueryPrefix()` / `resolveDocumentPrefix()` 给 `llm2vec` 单独分支，**始终**应用前缀（不受 `enableLlmPrefix` 控制，因模型按指令训练）。
4. 新增 7 个单测锁定行为（query 4 + document 3）。

### 2026-06-17（首轮实现）

**问题：** 初步实现遗漏了 reconstruction_mlp（误解为 embedding 管道必需），后澄清仅用于 debug 解释。

**修复：** alignment_mlp 作为唯一 embedding 管道 MLP；reconstruction_mlp 仅在 debug 模式下加载，用于 teacher-forcing oracle 解释。

**问题：** Q8_0 token embeddings 反量化时 scale 读错（用了 32-bit float 读 16-bit value），导致 NaN。

**修复：** 实现 `fp16ToF32()` 手动解 IEEE 754 half-precision。

**问题：** 最近 token 查找未做 L2 归一化，低 ID token（标点）因 embedding 模长大排在最前。

**修复：** `_findNearestTokens` 对 token embeddings 做 L2 归一化后计算 cosine similarity。

**问题：** decoder free-running greedy（T=0）坍塌，输出无限循环。

**修复：** 改为 teacher-forcing oracle：`[recon_token] + [query_text] → decoder 续写`，T=0.6，maxTokens=24。

**问题：** 生成文本含换行导致多行输出。

**修复：** `replace(/\n/g, " ")` 合并为单行。

### 2026-06-18（索引路径改为 recon→align 串联）

基于 `llm2vec_gen_flow.md` §1/§2.1 对 `modeling_encoder_decoder.py:547-556` 的逐行源码分析，
确认两个 MLP 为串联而非独立头。`_encode()` 从 align-only 改为 recon→align 串联。

**改动**（`src/code-index/embedders/llamacpp-llm2vec.ts`）：
1. `_encode()`：`last10 → reconstruction_mlp → alignment_mlp → mean → L2 normalize`
2. `_ensureModel()`：reconstruction_mlp 权重从**可选**改回**必需**（缺失抛错）
3. `createEmbeddings()` guard 加回 `_rW/_rb` 必需检查
4. shape 校验去掉空值保护
5. 类注释、字段注释从「两条独立流水线」改为「recon→align 串联」

**验证**：
- type-check 通过
- `--force --demo` 重建索引：72/72 blocks 成功，模型正常加载，reconstruction_mlp 权重必需加载未报错
- 搜索 `"batch processing"`：top 0.625 命中 README.md，0.500 命中 `utils.py` 的 `process_batch`，语义正确
- 搜索 `"用户认证"`：命中 `hello.js` 的 `UserManager` / `config.json` 的 `user_management`，语义正确

### 2026-06-18（pool-first 优化：先 mean pool 再 MLP）

**问题**：JS 侧逐 token MLP 计算是索引的主瓶颈。`_encode()` 对 10 个 token 各做 2 次 `_applyLinear`（1024×1024），共 20 次矩阵向量乘，纯 JS 循环 ~38ms/文档，占总时间 67%（medium 文档）。

**实测数据**（合成文本 benchmark，每文档）：

| 文档长度 | 总耗时 | JS MLP | MLP 占比 |
|---------|-------|--------|--------|
| short (~20 tok) | 36ms | ~38ms | ~100% |
| medium (~150 tok) | 57ms | ~38ms | 67% |
| long (~400 tok) | 114ms | ~38ms | 33% |

**实测数据**（Musique 语料全量，9838 文档）：

| | 优化前（逐 token MLP） | 优化后（pool-first） |
|---|---|---|
| 每文档耗时 | ~82ms | ~42.7ms |
| 索引总时间 | ~13.4 分钟 | ~7 分钟 |
| MLP 部分 | 38ms | ~4ms |

> 注：全量实测加速 ~1.9×，低于合成 benchmark 的理论 2.5×——因真实 Musique 文档较长，
> LLM 前向传播 + SQLite I/O 占比更大，MLP 降幅（38→4ms）被整体拉平。

**修复**：利用两个 MLP 均为 `nn.Linear`（无激活函数）的线性性，将 mean pool 移到 MLP 之前：

```
mean(align(recon(h_i)))  ==  align(recon(mean(h_i)))
```

先对 10 个 raw hidden state 取平均（O(10×1024)），再做 2 次 `_applyLinear`，从 20 次减为 2 次。

**改动**（`_encode()` 第 372-378 行）：
1. 删除 `for (i of last10) { recon = applyLinear(h_i); align = applyLinear(recon) }` 逐 token 循环
2. 改为 `pool(last10) → recon = applyLinear(pooled) → align = applyLinear(recon)`
3. 保持返回 `{ embedding, hiddenStates }` 结构不变（hiddenStates 仍是 raw last10，供 debug）

**验证**：
- 数值等价：pool-first 与逐 token 的余弦相似度 **1.000000000000**，最大元素差 2.22e-16（float64 机器精度）
- MLP 部分加速：**5.9×**（合成 benchmark 23ms → 3.9ms）
- 全量实测加速：**~1.9×**（Musique 9838 文档 13.4min → 7min，每文档 82ms → 42.7ms）
- 搜索质量不受影响（数值完全等价）
- type-check 通过

## 总结

### 关键收获

1. **LLM2Vec embedding 管道**：text + 10 question tokens → encoder → last10 hidden → **reconstruction_mlp** → recon → **alignment_mlp** → mean → L2 norm（两 MLP 串联，见 `llm2vec_gen_flow.md` §1）。recon 同时是 debug 解释路径的 decoder 软提示来源。
2. **非对称前缀**：查询端 `"Generate a passage that best answers this question: "`、文档端 `"Summarize the following passage: "`（原版 demo_quickstart.py + README 生成式口吻指令），始终应用。
3. **不需要修改 node-llama-cpp 或 llama.cpp**：MLP 线性变换在 JS 侧完成，GGUF 只负责产出 per-token hidden states。
4. **Q8_0 反量化**：block 格式为 f16 scale(2B) + int8 values(32B)，scale 需用 fp16→f32 转换。
5. **Teacher-forcing oracle** 比 free-running 更适合解释隐藏状态：`[recon_token] + [query] → decoder` 产生可读的自然语言输出。
6. **pool-first 优化**：两个 MLP 均为 `nn.Linear`（无激活），mean 是线性算子，故 `mean(align(recon(h_i))) == align(recon(mean(h_i)))`。先 mean pool 再做 MLP 可从 20 次减为 2 次 matmul，MLP 部分 5.9× 加速，数值完全等价。

### Musique 评测结果

**配置**：llm2vec (Qwen3-0.6B / Q8_0) + 混合搜索，对比 jina-embeddings-v5-nano + 混合搜索。

| Recall@K | 🆕 **llm2vec** | **jina v5 nano**（基线） | 差距 |
|:---------|:--------------|:----------------------|:----|
| 1 | **20.16%** | 26.95% | -6.8% |
| 2 | **29.37%** | 38.97% | -9.6% |
| 5 | **41.14%** | 54.12% | -13.0% |
| 10 | **50.32%** | 63.81% | -13.5% |
| 20 | **59.68%** | 73.38% | -13.7% |
| 50 | **70.31%** | 83.64% | -13.3% |
| 100+ | **70.31%**（停滞）| 83.64% | -13.3% |

**分析**：
- Qwen3-0.6B 作为 generative LLM 改的 embedder，检索质量弱于同量级专用 embedding 模型（jina v5 nano）
- ~30% 的 gold 文档始终不在 top-200 内（jina ~16%），混合搜索的 BM25 部分未能补回
- 结果合理——LLM2Vec-Gen 的设计目标是生成式检索（GEAR）场景而非标准稠密检索

**实测索引性能**（9838 文档，Musique 语料）：

| | 优化前（逐 token MLP） | 优化后（pool-first） |
|---|---|---|
| 每文档耗时 | ~82ms | ~42.7ms |
| 索引总时间 | ~13.4 min | ~7 min |
| 搜索 1000 query | — | ~54s |

### 已迁移的 LLM2Vec-Gen 组件

| 组件 | 状态 | 说明 |
|------|------|------|
| Encoder (Qwen3-0.6B) | ✅ | `node-llama-cpp` 加载 GGUF |
| alignment_mlp | ✅ | JS 侧 `x@W.T+b` |
| reconstruction_mlp | ✅ | 索引路径的必需环节（recon = last10 → reconstruction_mlp），其输出同时作 decoder 软提示用于 debug 解释 |
| Decoder 生成 | ✅ (debug only) | LlamaContext + LlamaCompletion |
| Question token (special=True) | ✅ | `model.tokenize(text, true)` |

### 后续优化

- [x] **pool-first MLP 优化**：先 mean pool 再 MLP，利用线性等价，MLP 部分 5.9× 加速（2026-06-18 已完成）
- [ ] **Float64Array 替代 number[]**：`_applyLinear` 改用 typed array，可进一步加速 ~2-3×
- [ ] 支持 `embedderGgufLlm2vecPath` 的 `codebase config --set` 交互配置
- [ ] reconstruction_mlp + token_embd 的完整 NN lookup（当前仅前 32K token）
- [ ] 考虑将 teacher-forcing oracle 的计算独立到单独的 debug 命令中

## 已知问题：TS debug recon 路径与 demo 的注入方式不一致

> 此问题**只影响 debug 解释路径**（`_interpretHiddenStates`），不影响索引/检索
> （那块走 recon→align 串联）。记录在此作为后续单独任务。

### 现状

TS 的 `_interpretHiddenStates`（`src/code-index/embedders/llamacpp-llm2vec.ts:400`）
对 reconstruction_mlp 输出的处理，和 demo（`demo_llamacpp.py` 的 `ReconGenerator`
+ `demo_quickstart.py` 的 `generate(recon_hidden_states=...)`）**根本不是一回事**。

**demo 的正确用法**（`demo_llamacpp.py:479` `generate_free_running`，`demo_quickstart.py:184`）：

```python
recon = last10 @ rW.T + rb          # [10, 1024] 连续软提示向量
# 把这 10 个向量直接写进底层 batch.embd，作 inputs_embeds 注入 decoder
batch.embd[i] = recon[i]            # 连续向量，不是 token id
decoder free-running 续写 → 答案文本
```

即 reconstruction_mlp 输出的 **10 个连续向量作为软提示 embedding 注入 decoder**
（等价 torch 的 `decoder(inputs_embeds=recon)`），decoder 自己续写出答案。recon 编码的
是「潜在答案」的连续表示，decoder 直接消费这个连续向量。

**TS 现状**（`llamacpp-llm2vec.ts:410-444`）：

```ts
// 1. 对每个 recon 向量找最近 token id（最近邻查找）→ 离散化
const reconIds = reconVecs.map(v => this._findNearestTokens(v, 1)[0]?.id ?? 0)
// 2. 拼接 [10个离散token id] + [原始query token id]
const teacherForcingInput = [...reconIds, ...queryTokens.map(t => Number(t))]
// 3. 当普通 token 序列喂 LlamaCompletion.generateCompletion(tokenIds)
```

### 两者的本质差异

| 维度 | demo（正确） | TS 现状（错误） |
|------|--------------|-----------------|
| decoder 输入形态 | 连续向量（`batch.embd` / `inputs_embeds`） | 离散 token id 序列 |
| recon 信息保留 | 10 个连续软提示向量原样注入 | 每个向量离散化为 1 个 token id，连续语义丢失 |
| 拼接内容 | [10 个 recon embd 向量] | [10 个离散 token id] + [原始 query token id] |
| 生成方式 | free-running greedy 续写（recon 驱动） | teacher-forcing 文本续写（query 文本驱动） |
| 数学等价性 | = torch `decoder(inputs_embeds=recon)` | 与 torch recon 通道毫无关系 |

核心问题：**recon 在第 1 步「最近 token 查找」就被离散化，连续软提示语义丢失**。之后
拼接的 query token 反客为主，decoder 实际是被 query 文本驱动续写，recon 形同虚设。
这与 demo 用 `inputs_embeds` 连续注入、decoder 由 recon 驱动 free-running，在数学上毫无关系。

### 为什么现在没改

要复刻 demo 的连续向量注入，需要绕过 node-llama-cpp 的高层 API（`LlamaCompletion` 只吃
token id，不暴露 `batch.embd` 注入）。得走到底层 `LlamaContextSequence` / addon 层手动
写 embd，类似 `demo_llamacpp.py` 直接操作 `llama_batch.embd` 的做法。这是一个独立的
工作量，且只服务 debug 解释功能，不影响检索质量，故暂记于此待后续处理。

### 修复方向（后续任务）

1. 在 node-llama-cpp 的 `LlamaContextSequence` / 底层 addon 上找或加一个
   `evaluateEmbeddings(vectors: number[][])` 接口，等价 `llama_batch.embd` 注入。
2. `_interpretHiddenStates` 改为：`recon`（10 个连续向量）→ `evaluateEmbeddings`
   → free-running greedy 续写（参考 `demo_llamacpp.py:479` `generate_free_running`）。
3. 去掉 `_findNearestTokens` 离散化、`_generateFromTokens` 文本拼接路径。
4. 用 demo 的「recon → decoder」输出做对比验证（0.6B 上会坍塌为通用模板，见
   `260616-recon_root_cause_report.md` §4.4，但坍塌文本本身应与 demo 一致）。


