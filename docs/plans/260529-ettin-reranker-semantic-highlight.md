# 260529-ettin-reranker-semantic-highlight

## 主题/需求

探索 Ettin-Reranker-V1 系列模型能否替代原 semantic-highlight 模型（XLM-RoBERTa）做 **rerank** 和 **token-level highlight**。

### 背景

原 pipeline 使用 `zilliz/semantic-highlight-bilingual-v1` 模型（XLM-RoBERTa backbone），存在两个痛点：
1. **SentencePiece tokenizer 丢失 `\n`** — Normalizer 层在 tokenization 之前就将换行符转换为空格，导致 `detokenize` + `indexOf` 的文本对齐方式有 41.5% 的 token 匹配失败，最终被迫用"逐字符着色"兜底（见 `260522-semantic-highlight-heatmap-alignment-v2.md`）
2. **硬编码 `open_provence.*` metadata keys** — 代码死板绑定特定模型的自定义 metadata 格式

Ettin-Reranker-V1 基于 ModernBERT，使用 **BPE tokenizer**（无 `\n` 丢失问题），`attention.causal=false`（非因果编码器），理论上可作为替代候选。

### 探索目标

- Ettin-Reranker-V1 的 `getEmbeddingsForTokens()` 返回 per-token 还是 pooled embedding？
- 能否用 cosine similarity / dot product 做 token-level highlight 评分？
- 能否读取 GGUF 中的 classifier head 权重，做 trained scoring？

### 验证结论

| 验证项目 | 结论 |
|:---|:---:|
| per-token hidden states 可用 | ✅ `pooling_type=NONE` 返回 [N, 1792] |
| cosine similarity 评分 | ❌ 1792 维空间区分度低，token 身份主导 |
| dot product 评分 | ❌ 同上，`self`、`"""` 等高频 token 的 norm 大，掩盖 query 信号 |
| 读取 classifier head 权重 | ❌ GGUF 中不存在 `cls.weight`/`cls.output.weight` |
| `convert_hf_to_gguf.py` 支持 | ❌ 官方脚本没有 ModernBERT handler |

### 运行现象

配置 `rerankerProvider=semantic-highlight` + `rerankerGgufPath=ettin-reranker-1b-v1-Q8_0.gguf` 时：

```
[SemanticHighlightReranker] Reading head weights from GGUF: ...ettin-reranker-1b-v1-Q8_0.gguf
Reranker validation failed: RerankHead weights not found in GGUF metadata
```

**发生链：**

```text-chart
SemanticHighlightReranker._loadHeadWeights()
  └─ meta["open_provence"]?.["rerank_head"] → undefined        ← Ettin 没有这个 key
       └─ throw Error("RerankHead weights not found...")
            └─ manager._recreateServices() 捕获
                 ├─ console.warn("Reranker validation failed:")
                 └─ reranker = undefined                        ← 静默降级，不阻止搜索
```

**结果：**
- Reranker 被静默关闭，搜索结果按原始 vector score 排序
- 不影响搜索和 highlight（highlighter 独立配置，用的是原 XLM-RoBERTa）
- 用户看到的搜索输出中不包括 reranking

同理，如果 highlighter 也配置为 Ettin，`SemanticHighlightHighlighter._loadHeadWeights()` 会抛出 "Pruning Head weights not found in GGUF metadata"，highlighter 也会静默关闭。

---

## 代码背景

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/code-index/rerankers/semantic-highlight.ts` | Reranker 实现，从 `open_provence.rerank_head` metadata 读取 RerankHead 权重 |
| `src/code-index/highlighters/semantic-highlight.ts` | Highlighter 实现，从 `open_provence.pruning_head` metadata 读取 PruningHead 权重，硬编码 `dim=1024` |
| `src/code-index/interfaces/reranker.ts` | RerankerProvider 类型定义，含 `"semantic-highlight"` |
| `src/code-index/service-factory.ts` | `createReranker("semantic-highlight")` / `createHighlighter()` |
| `src/code-index/manager.ts` | `_recreateServices()` — reranker 验证失败时 `reranker = undefined` 静默降级 |

### 涉及的模型文件

| 模型 | 路径 | embedding_dim | 状态 |
|:---|:---|:---:|:---|
| Ettin-Reranker-17m-v1 | `.../ettin-reranker-17m-v1-Q8_0.gguf` | 256 | ❌ 无 classifier head |
| Ettin-Reranker-400m-v1 | `.../ettin-reranker-400m-v1-Q8_0.gguf` | **1024** | ❌ 无 classifier head |
| Ettin-Reranker-1b-v1 | `.../ettin-reranker-1b-v1-Q8_0.gguf` | 1792 | ❌ 无 classifier head |
| XLM-RoBERTa (原) | `.../semantic-highlight-bilingual-v1-Q8_0-unified.gguf` | 1024 | ✅ 有 PruningHead + RerankHead |

---

## 实施计划

### 阶段 1：GGUF 转换脚本（已完成）

编写 gguf-py 转换脚本，将 HF safetensors → GGUF，包含 backbone tensors + classifier head tensors + metadata。

### 阶段 2：验证原生 RANK 模式（已完成，有剩余问题）

llama.cpp `pooling_type=RANK` 对 ModernBERT 做 MeanPool → Dense(GELU) → LayerNorm → OutProj，理论上 Ettin 的分类头可以原生工作。NaN 问题已定位修复，但当前输出 sigmoid 饱和（全 1.0），需进一步排查。

### 阶段 3：JS 端 Reranker 适配

- 更新 `SemanticHighlightReranker` 支持 Ettin 的 dim=256 分类头格式
- 支持 GELU 激活 + LayerNorm 的 forward path
- 评估 highlight 是否也要适配

---

## 实施记录

### 2026-05-29 (上午) — 原始验证

**验证 1：`getEmbeddingsForTokens()` 返回 per-token embedding**

创建 `createEmbeddingContext()`，调用 `getEmbeddingsForTokens(input)`，返回 134 个 1792-dim 向量，各不相同。确认模型使用 `pooling_type=NONE`。

**验证 2：cosine/dot scoring 效果不佳**

- Query-aware cosine: `def train(` 仅 0.20，但 `self,` 和 `"""` 高达 0.65
- Contrastive 归一化后：`def train(` 低至 -0.83，仍被无关 token 压制
- 根因：1792 维空间中隐藏状态主要编码 token 身份而非 query 相关性

**验证 3：GGUF 无 classifier head tensor**

```
Non-block tensors:
  output_norm.weight    [1792]
  token_embd.weight     [1792,50368]
  token_embd_norm.weight [1792]
  ← 没有 cls.* 或 cls.output.*
```

三个 Ettin 模型（17m/400m/1b）均无 classifier head。

**验证 4：`convert_hf_to_gguf.py` 无 ModernBERT handler**

```
$ grep "MODERN_BERT\|ModernBert" convert_hf_to_gguf.py
# 空
```

官方转换脚本不支持 ModernBERT。gguf-py 库的 `constants.py` 和 `tensor_mapping.py` 有 ModernBERT 定义（`MODEL_ARCH.MODERN_BERT` 包含 `CLS`/`CLS_OUT`/`CLS_NORM`），但 `convert_hf_to_gguf.py` 未集成。

### 2026-05-29 (下午) — HF → GGUF 转换成功

**发现：Ettin 是 sentence-transformers CrossEncoder 格式**

模型由 HuggingFace 下载后，目录结构为：

```
snapshots/{hash}/
├── model.safetensors              # ModernBERT backbone
├── config.json                    # ModernBERT 配置（hidden_size=256, layers=7）
├── tokenizer.json                 # BPE tokenizer
├── 1_Pooling/                     # CLS pooling
├── 2_Dense/                       # Linear(256→256, GELU), no bias
│   ├── config.json
│   └── model.safetensors → linear.weight [256, 256]
├── 3_LayerNorm/                   # LayerNorm(256)
│   ├── config.json
│   └── model.safetensors → norm.weight [256], norm.bias [256]
└── 4_Dense/                       # Linear(256→1, identity), with bias
    ├── config.json
    └── model.safetensors → linear.weight [1, 256], linear.bias [1]
```

**编写转换脚本 `scripts/convert_ettin_to_gguf.py`**

关键实现：

1. **Backbone 转换** — 直接用 PyTorch tensor shape 传入 `add_tensor`（GGUF 的 shape 反转恰好匹配 C++ `ne[]` 顺序，不手动转置）
2. **分类头 → GGUF tensors** — 用于 llama.cpp 原生 RANK 模式：
   - `cls.weight` ← 2_Dense `linear.weight` (F32, 256×256)
   - `cls.norm.weight` ← 3_LayerNorm `norm.weight` (F32, 256)
   - `cls.output.weight` ← 4_Dense `linear.weight` (F32, 1×256)
   - `cls.output.bias` ← 4_Dense `linear.bias` (F32, 1)
3. **分类头 → GGUF metadata** — 供 JS 端 fallback：`open_provence.rerank_head.*`
4. **Tokenzier** — 从 `tokenizer.json` 提取完整词汇表，设置 BERT 模型类型、特殊 token ID
5. **架构参数** — `pooling_type=RANK`, `attention.causal=false`, `feed_forward_length=384`, `classifier.output_labels=["LABEL_0"]`

**转换文件：** `open_provence_demo/output/ettin_reranker_gguf/ettin-reranker-17m-v1-F16.gguf` (33.47 MB)

**验证结果：**

| 项目 | 状态 |
|:---|---:|
| 48 tensors (44 backbone + 4 CLS head) | ✅ |
| 30 KV metadata (含 open_provence.*) | ✅ |
| `getEmbeddingsForTokens` 推理 | ✅ 7 tokens, dim=256, 值正常 |
| `createRankingContext` 加载 | ✅ 模型加载成功 |
| `pooling_type=RANK` 原生产出 | ❌ 输出 NaN |

**转换脚本位置：** `scripts/convert_ettin_to_gguf.py`

### 2026-05-29 (下午) — NaN 根因定位与修复

**现象：** `createRankingContext` + `rankAll` 返回 `[NaN, NaN, NaN, NaN]`

**已修复的问题（逐步排查）：**

1. ~~缺少 `attention.causal` 参数~~ — 默认 `causal_attn=true`，ModernBERT 需要 `false`（已修复）
2. ~~缺少 `feed_forward_length`~~ — `n_ff` 推断为 0，导致 tensor shape 错误（已修复）
3. ~~缺少 `classifier.output_labels`~~ — `n_cls_out` 为 0（已修复）
4. ~~`cls_norm.weight` 命名错误~~ — 写为 `cls_norm.weight`（下划线），C++ 查找 `cls.norm.weight`（点号）（已修复）
5. ~~分类头 tensor 用 F16~~ — 最初误判为 Metal 需要 F32，实际根因是混合精度（见下文）

**根因：混合精度导致 NaN/崩溃**

```
Backbone (F16 weights) → hidden states = F16
Classifier head (F32): cls.weight, cls.norm.weight, cls.output.*
                        ↓
build_pooling() 中 F16 × F32 混合运算
  ├─ Metal backend: 静默返回 NaN（type promotion 不支持 F16×F32 binary op）
  └─ CPU backend:   binary_op: unsupported types → GGML_ABORT
```

具体崩溃点：
- Metal: `ggml-metal-ops.cpp:3088 — GGML_ASSERT(op->src[1]->type == GGML_TYPE_F32)`
- CPU:  `ggml-cpu/binary-ops.cpp:136 — unsupported types dst:f32 src0:f32 src1:f16`

**修复方案：整个模型转 F32**

修改 `scripts/convert_ettin_to_gguf.py`，所有 backbone tensors 从 `np.float16` 改为 `np.float32`，保持分类头为 `np.float32`。模型大小从 33 MB 增至 65 MB（17M params × 4 bytes，完全可接受）。

```python
def to_type(arr, dtype=np.float32):
    return arr.astype(np.float32)  # 全 F32，避免混合精度
```

**验证结果：**

| 状态 | 修改前 | 修改后 |
|:---|:---|:---|
| ✅ NaN | `[NaN, NaN, NaN, NaN]` | `[1.000000, 1.000000, 1.000000, 1.000000]` |
| ⚠️ sigmoid 饱和 | — | 全部 1.000000（logit ≥ 37） |

**剩余问题：sigmoid 饱和**

所有 score 恰好为 `1.000000000000000`（15 位小数），说明 logit ≥ 37，sigmoid 完全饱和。可能原因：

1. **`cls.norm.bias` 缺失** — C++ `build_norm(cur, cls_norm, NULL, ...)` 传 `mb=NULL`，但 Ettin 的 LayerNorm 训练时有 bias。无 bias 时归一化输出分布可能偏移，导致后续 OutProj 输出极大值。bias 数据已存在 GGUF metadata 中（`open_provence.rerank_head.ln.bias`），但未作为 GGUF tensor 写入 `cls.norm.bias`。
2. **MeanPool vs [CLS] Pool** — llama.cpp RANK pooling 对所有 token 做 mean pooling，但 Ettin 作为 sentence-transformers CrossEncoder，训练时可能使用 [CLS] token 或其他 pooling 策略。不同的 pooling 分布输入到分类头可能产生系统性偏移。

此问题与 NaN 无关，是独立的功能性缺陷。

**排查过程使用的脚本：**
- `scripts/test_ettin_rerank.mjs` — 基础测试
- `scripts/test_ettin_rerank_cpu.mjs` — CPU 后端测试（暴露 binary_op 错误）
- `scripts/check_tensors.mjs` — 读取 GGUF tensor 信息
- `scripts/test_ettin_rank_raw*.mjs` — 调试 embedding 原始值
- `scripts/test_ettin_discrimination.mjs` — 区分度测试

---

## 修订记录

### 2026-05-29 (下午)
**更新：** 完成 HF → GGUF 转换脚本，验证模型加载和推理，发现原生 RANK 模式 NaN 问题。

### 2026-05-29 (晚)
**更新：** NN 根因定位——混合精度（F16 backbone + F32 classifier head）导致 Metal NaN/CPU crash。修复为全 F32 模型。

**第二层 bug 发现：** `classifier.output_labels = ["LABEL_0"]` 触发 JS 侧 `LlamaRankingContext` 的两分类路径（`isTwoClassClassifier = true`），对 logit 做 `clamp(0,1)` 而非 sigmoid，掩盖了真实 logit 值。移除该 metadata 后 sigmoid 正常。

### 2026-05-29 (深夜) — C++ build_pooling 修复

**第三层 bug 修复完成：MeanPool → [CLS] Pool**

对 `llama-graph.cpp` 的 `build_pooling` 函数做了三项 C++ 更改：

**修复 1：CLS pooling（核心修复）**

```diff
-                if (arch == LLM_ARCH_MODERN_BERT) {
+                if (arch == LLM_ARCH_MODERN_BERT && hparams.pooling_type != LLAMA_POOLING_TYPE_CLS) {
```

原理：GGUF metadata 的 `pooling_type` 写入 `hparams.pooling_type`，JS 的 `createRankingContext` 显式设 `cparams.pooling_type = RANK` 使 switch 进入 RANK case。C++ 通过检查 **`hparams.pooling_type`**（≠ `cparams.pooling_type`）来决定用 [CLS] 还是 MeanPool：
- `pooling_type=CLS`（Ettin）→ [CLS] token pooling
- `pooling_type=RANK`（GTE 等）→ MeanPool（向后兼容）

同时需要修改 GGUF `pooling_type` 值：`PoolingType.RANK(4)` → `PoolingType.CLS(2)`。

**修复 2：`cls.norm.bias` 缺失**

Ettin 的 3_LayerNorm 有 bias（`norm.bias` [256]），但 llama.cpp 的 `build_pooling` 传 `NULL` 给 `build_norm`。添加了完整支持链：
1. `llama-model.h` — 新增 `cls_norm_b` 字段
2. `modern-bert.cpp` — 加载 `cls.norm.bias` tensor
3. `llama-model.cpp` — 传递 `cls_norm_b` 给 `build_pooling`
4. `llama-graph.h/.cpp` — 签名增加 `cls_norm_b` 参数，`build_norm` 调用从 `NULL` 改为 `cls_norm_b`
5. `convert_ettin_to_gguf.py` — 添加 `cls.norm.bias` GGUF tensor

**修复 3：`pooling_type` metadata 更正**

`PoolingType.RANK` → `PoolingType.CLS`，让 `hparams.pooling_type` 准确反映模型的实际 pooling 模式。

**验证结果：**

**修复前（tokenizer=bert）：**
```
Raw scores: [ '0.999999', '0.999999', '0.999999', '0.999998' ]
```
所有 logit ≈ 14.9，sigmoid 完全饱和。

**修复后（tokenizer=gpt2 + BPE merges）：**
```
Raw scores: [ '0.999929', '0.316099', '0.999236', '0.221770' ]
Sorted results:
  0.999953  NN training                      (relevant)  ✓
  0.999218  gradient descent                 (relevant)  ✓
  0.427508  weather                          (irrelevant)✓
  0.273429  pizza                            (irrelevant)✓
```
与 Python 基线几乎一致！

**根因分析：**

分数饱和的根因是 **tokenizer 配置错误**，而非模型容量或 C++ 代码问题：

| 发现 | 结论 |
|:---|---|
| Python 原始模型 | ✅ logit 范围 [-1, +10]，区分度好 |
| `tokenizer.ggml.model = "bert"` | ❌ WordPiece 无法处理 BPE tokenizer → 全 UNK |
| `tokenizer.ggml.model = "gpt2"` + merges | ✅ 正确 BPE tokenization → 正常 logit |
| C++ CLS pooling + norm bias | ✅ 与 Python 结果一致 |

**影响文件：**
- `scripts/convert_ettin_to_gguf.py` — `PoolingType.RANK→CLS`，添加 `cls.norm.bias` tensor
- `vendor/llama-addon/build.mjs` — 新增 7 个 C++ 源文件补丁（Patch 5-11 对应 llama-graph.cpp、llama-graph.h、llama-model.h、modern-bert.cpp、llama-model.cpp）
- `llama.cpp/src/llama-graph.cpp` — `build_pooling` 的 RANK case CLS 判断 + norm bias 支持

**三个 bug 层次更新：**
| Bug | 层次 | 修复 |
|:---|:---|:---|
| 混合精度 F16/F32 | C++ ggml | 全 F32 模型 |
| JS clamp 误判 | JS node-llama-cpp | 移除 `output_labels` |
| MeanPool vs CLS | C++ build_pooling | ✅ **已修复**（`hparams.pooling_type` 判断） |
| cls.norm.bias 缺失 | C++ build_pooling | ✅ **已修复**（`cls_norm_b` 支持链） |

---

## 总结

### 关键发现

1. **语义级别的限制** — Ettin 作为纯 encoder 的 raw hidden states 不适合直接用 dot/cosine 做 per-token relevance scoring。需要 trained head 来做表示变换。
2. **GGUF 转换问题** — 三个 Ettin GGUF 都没有 classifier head 权重。llama.cpp 的 C++ 代码支持，但 `convert_hf_to_gguf.py` 未集成 ModernBERT，导致第三方转换工具丢弃了头。
3. **Ettin 的 BPE tokenizer 是优点** — 如果解决了 head 问题，BPE（无 `\n` 丢失）比 XLM-RoBERTa 的 SentencePiece 更适合做代码 highlight。
4. **llama.cpp 原生支持 ModernBERT RANK pooling** — C++ 代码已实现 `build_pooling(RANK)` 的 ModernBERT 路径。三项 bug 修复后不再 NaN/饱和，但输出 logit 仍缺乏区分度。

### 后续路线

| 路线 | 可行性 | 工作 |
|:---|:---:|:---|
| ~~用原始 HF safetensors 重新转换 GGUF~~ | ✅ **已完成** | `scripts/convert_ettin_to_gguf.py` |
| 走 JS metadata 分类头（绕过原生 RANK） | ✅ 近期可行 | 修改 `SemanticHighlightReranker` 支持 dim=256 |
| 排查原生 RANK NaN 问题 | ✅ **已解决** | 根因：混合精度 F16/F32；修复：全 F32 模型 |
| JS `clamp(0,1)` 误判 | ✅ **已解决** | 移除 `classifier.output_labels` metadata |
| RANK mode sigmoid 饱和 | ✅ **C++ 已修复** | 四项优化：CLS pooling + norm bias + pooling_type + tokenizer fix |
| ~~Attention-based highlighting（collectKqSoftMax）~~ | ❌ **不可行** | 双向注意力不编码 query→code 相关性信号（见下文） |
| ~~Per-token + classifier head~~ | ❌ **不可行** | head 校准的是 CLS 池化分布，单 token hidden state 过 head 全饱和（sigmoid=0.9994） |
| 保持原 XLM-RoBERTa + PruningHead 路线 | ✅ 当前可用 | 无额外工作 |
| 找其他有 highlight head 的 BERT GGUF | ⚠️ 需搜索 | 评估模型可用性 |
| Encoder-decoder cross-attention（T5） | ⚠️ 理论可行，待 PoC | 见下方「探索方向」 |

### 2026-05-29 (晚) — Attention-based highlight 评估结论

**实验验证：** 修改 C++ addon 增加动态 layer 范围（`setKqSoftMaxLayerRange`），验证 `collectKqSoftMax` 对 ModernBERT 的兼容性。

#### 验证结果

| 验证项目 | 结论 |
|:---|---|:---:|
| `collectKqSoftMax` + ModernBERT 兼容性 | ✅ 全部 7 层 × 4 head 成功收集 |
| query→code mean attention 评分 | ⚠️ 弱信号，token 身份主导 |
| [CLS]→all attention 评分 | ⚠️ 同上 |
| 相关/无关 query 区分 | ❌ attention 分布几乎一致 |

#### 根因分析

ModernBERT 的**双向注意力**与 QRRanker 的**因果注意力**有本质区别：

| 模型 | 注意力类型 | query→code 相关性信号 |
|:---|:---:|:---:|
| Qwen3-4B (QRRanker) | 因果因果 | ✅ query tokens 只能 attend 到之前 token，天然编码相关性 |
| ModernBERT (Ettin) | 双向 | ❌ 所有 token 互相 attend，分布均匀，主要编码 token 自身显著性 |

**具体对比（同一段代码，不同 query）：**

```
Relevant query:   "how to train a neural network with gradient descent"
Irrelevant query: "weather forecast for Tokyo tomorrow"
```

Last-layer CLS attention top-3 几乎相同：
- Relevant: L2(docstring)=0.0201, L3(for)=0.0112, L8(for p)=0.0107
- Irrelevant: L11(return)=0.0290, L8(for p)=0.0129, L1(def)=0.0105

说明 attention 编码的是代码的**结构性显著性**而非**query 相关性**。

#### C++ addon 改动（已 revert）

新增 `setKqSoftMaxLayerRange()` 方法，使 layer 过滤范围可在 JS 侧动态配置：
- `vendor/llama-addon/AddonContext.h` — 新增 `kqLayerStart`/`kqLayerEnd` 字段 + 声明
- `vendor/llama-addon/AddonContext.cpp` — cbEval 改用动态范围 + JS 绑定

**结论：已 revert。** highlight 路线不可行，`collectKqSoftMax` 场景退回默认行为（硬编码 17-25）。源码已清理，仅当前二进制残留该符号，下次重编后消失。

#### JS 代理层（已 revert）

- `node-llama-cpp` 的 `LlamaContext` 需要同步 `setKqSoftMaxLayerRange`，在部署流程中加入
- **结论：已清理。** node_modules 手动补丁已还原（从 backup 恢复，d.ts 移除该声明）。

### 2026-05-29 (深夜) — Per-token + classifier head 验证

**思路：** 用 `createEmbeddingContext(pooling_type=NONE)` 获取每个 token 的 hidden state（维度 256），逐 token 过已训练好的分类头（Dense→GELU→LN→OutProj），得到 per-token 相关性分数。

理论上双向注意力让每个 code token 的 hidden state 已包含 query 上下文，分类头学的是"相关/不相关"方向，应该能给出区分度。

**结果：全 token sigmoid=0.9994，完全饱和，无任何区分度。**

```
Per-token logits (code region):
  [████████████████████] 0.9994  "def"
  [████████████████████] 0.9994  " train"
  [████████████████████] 0.9994  "loss"
  [████████████████████] 0.9994  "."
  [████████████████████] 0.9994  "backward"
  ... 全部 0.9994，无区分度 ...
```

**根因：** 分类头的 LayerNorm 和 GELU 是在 **CLS pooling 后的 hidden state 分布**上训练的。单个 token 的 hidden state 与 CLS 池化后的分布差异很大，导致 Dense→GELU 输出值域偏移，LayerNorm 归一化到饱和区域。

**脚本：** `scripts/evidence/260529-ettin-per-token-head.mjs`

**验证脚本中的关键实现：** `EttinClassifierHead` 类（约 80 行）——从 `open_provence.rerank_head.*` metadata 读取权重，完整实现了 Dense(256→256, GELU)→LN→OutProj(256→1) 前向传播，包括 row-major 矩阵乘法、tanh-approximation GELU、手动 LayerNorm。可供其他场景复用。

### 探索方向：T5 encoder-decoder cross-attention

双向 encoder 的三条路都走不通，但 **encoder-decoder 模型的 cross-attention** 天然提供 query→code 相关性信号：

```text-chart
Encoder: [code tokens] ──▶ hidden states (双向编码)
                              │
Decoder: [query tokens] ──▶ self-attn ──▶ cross-attn ──┘
                                            │
                                   cross_attn[query_i, code_j] =
                                   "解码 query 时多依赖 code token j？"
                                            │
                                   ▶ 直接 per-token relevance 信号 ✅
```

与 encoder-only 的本质区别：encoder 的 attention 是"信息路由"（把语义汇聚到当前 token），decoder 的 cross-attention 是"源语言查找"（解码前主动检索源端上下文）。后者才是你要的高亮。

#### llama.cpp 现状

- ✅ `t5.cpp` 有完整 encoder-decoder 实现（`DEC_CROSS_ATTN_Q/K/V/O` tensors）
- ✅ `build_attn_cross` → `build_attn_mha` → `cb(kq, "kq_soft_max", il)`，kq_soft_max 会被创建
- ⚠️ **layer index 冲突**：T5 decoder 层的 self-attn 和 cross-attn 用同一个 `il`，都打出 `kq_soft_max-{il}`，cbEval 会互相覆盖。需要 C++ 端用不同命名（如 `kq_soft_max_cross-{il}`）区分
- ⚠️ **最小模型 t5-small（60M）**比 Ettin（17M）大 3.5 倍，但比 Qwen3-4B（4B）小得多

#### 建议验证路径（PoC）：

```python
# 1. Python 快速验证（10分钟）
import torch
from transformers import AutoTokenizer, T5EncoderModel

model = T5EncoderModel.from_pretrained("google/t5-efficient-mini")  # 24M
# 构造 encoder-decoder 输入，提取 cross-attention
# 对比相关/无关 query 的 per-token 分数分布

# 2. 如果区分度好 → 投入工程（1-2天）
#    - C++ 命名修复（cross-attn 独立命名）
#    - GGUF 转换脚本
#    - JS 集成
# 3. 如果不行 → 放弃此方向
```

候选模型：
- `google/t5-efficient-mini` (24M) — 最小的 encoder-decoder
- `google/t5-small` (60M) — llama.cpp 已测试
- `castorini/monot5-base-msmarco` (220M) — 专为 reranking 训练，但较大

### 参考文档

- `docs/plans/260514-semantic-highlight-for-code-rerank.md` — 原 semantic-highlight 设计
- `docs/plans/260521-semantic-highlight-unified.md` — Unified GGUF 升级
- `docs/plans/260522-semantic-highlight-heatmap-alignment.md` — 热力图对齐 v1
- `docs/plans/260522-semantic-highlight-heatmap-alignment-v2.md` — 热力图对齐 v2，含 `\n` 丢失根因分析
- `scripts/convert_ettin_to_gguf.py` — Ettin HF → GGUF 转换脚本
- `scripts/test_ettin_rerank.mjs` — 原生 RANK 模式测试脚本
- `vendor/llama-addon/build.mjs` — 编译脚本，含 7 个 llama-graph 相关补丁
- `docs/08-llama-cpp-build-flow.md` — 编译流程文档
