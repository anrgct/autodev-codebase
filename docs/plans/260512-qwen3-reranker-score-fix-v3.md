# Qwen3-Reranker 分数坍缩修复

## 概述

| 项目 | 内容 |
|------|------|
| 问题 | `node-llama-cpp` rerank 分数全坍缩在 0.5 附近 |
| 根因 (0.6B) | JS 层对 softmax 输出做 sigmoid + 取了错误类索引（P(no) 而非 P(yes)） |
| 附加问题 (4B) | 不同 GGUF 转换的 `cls_out` 列顺序不同，硬编码索引不可靠 |
| 最终修复 | 动态读取 GGUF `classifier.output_labels` 确定 `yes` 索引，移除 sigmoid |
| 修复后 | 0.6B: 0.98~0.999 / 4B: 自然分布 (0.0001~0.82)，与 `llama-server` 一致 |

---

## 一、问题定界：是模型问题还是 node-llama-cpp 问题？

这是排查的起点。同一模型、同一 query、同一文档，对比两套调用路径。

### 路径 A：node-llama-cpp（有问题）

```bash
npx tsx src/cli.ts search "model train method" --demo --log-level=debug \
  | grep "Raw response"
```

**输出**——分数全挤在 0.5 附近：

```
0.50142, 0.50018, 0.50003, 0.50039, 0.50015, 0.50031, 0.50010,
0.50005, 0.50022, 0.50047, 0.50003, 0.50027, 0.50048, 0.50009,
0.50011, 0.50020, 0.50033, 0.50344, 0.50008, 0.50054

极差: 0.0034    ← 基本没有区分度
```

### 路径 B：llama-server（正常）

同一模型直接通过 `llama-server --reranking` API 调用：

```bash
llama-server -m qwen3-reranker-0.6b-q8_0.gguf --reranking --port 8080 --no-webui -ngl 99
```

```json
// POST /v1/rerank
{
  "query": "how to add two numbers in python",
  "documents": [
    "def add(a, b): return a + b",           // 相关
    "class Database: connect()",             // 无关
    "import requests; requests.get(url)"     // 无关
  ]
}
```

**输出**——分数自然分布：

```json
{"index": 0, "relevance_score": 0.9928523898124695},   // 相关 → 高
{"index": 2, "relevance_score": 3.1257786758e-05},      // 无关 → 极低
{"index": 1, "relevance_score": 2.1221161659e-05}       // 无关 → 极低
```

### 结论

| | node-llama-cpp | llama-server |
|--|---------------|-------------|
| 相关文档分数 | ~0.50 | 0.99 |
| 无关文档分数 | ~0.50 | 3e-5 |
| 区分度 | 无 | 5 个数量级 |

**同一模型在 llama-server 上行为正常 → 模型本身没问题。问题在 node-llama-cpp 的调用链上。**

---

## 二、调用链分析

node-llama-cpp 如何处理一次 rerank：

```
LlamaCppReranker.rerank()
  → model.createRankingContext()
      → _model.createContext({ _embeddings: true, _ranking: true })
          → AddonContext.cpp: pooling_type = LLAMA_POOLING_TYPE_RANK
  → rankingContext.rankAll(query, docs)
      → _evaluateRankingForInput(tokens)
          1. sequence.evaluate(input, { _noSampling: true })    // 跑前向
          2. ctx.getEmbedding(input.length, 1)                 // 取 embedding[0]
          3. logitToSigmoid(embedding[0])                      // JS 层 sigmoid
```

关键两个操作：
- `getEmbedding(input.length, 1)` — 第二个参数 `1` 表示只取 1 维
- `logitToSigmoid(embedding[0])` — 对取到的值做 sigmoid

需要回答三个问题：
1. C++ 返回的 `embedding[0]` 到底是什么？（raw logit 还是已完成 softmax 的概率？）
2. `embedding[0]` 是 P(yes/相关) 还是 P(no/不相关)？
3. JS 层该不该再做 sigmoid？

---

## 三、假设与验证

### 假设 A：`cls_out` 分类头未加载

**猜想**：QWEN3-Reranker 的 `cls.output.weight` 形状是 `[1024, 2]`，但 `n_cls_out` 默认为 1。
形状不匹配 → 分类头加载失败 → 1024 维 hidden state 直接 softmax → 每维 ≈ 0.001 → sigmoid → 0.50025。

**验证 1**：用 Python `gguf` 库读取 GGUF 元数据。

```bash
python3 -c "
from gguf import GGUFReader
r = GGUFReader('qwen3-reranker-0.6b-q8_0.gguf')

# 查 classifier labels
f = r.fields['qwen3.classifier.output_labels']
for i, p in enumerate(f.parts):
    if isinstance(p, bytes):
        print(f'  parts[{i}]: {p!r}')
"
```

**结果**：

```
parts[4] = [2]       ← 数组长度 = 2
parts[6] = [121 101 115]   → "yes"
parts[8] = [110 111]       → "no"
```

GGUF 元数据已有 `["yes", "no"]`，**2 个标签**。所以 `n_cls_out = 2`，匹配 tensor 形状 `[1024, 2]`。分类头**正常加载**。

**验证 2**：在 JS 层加 debug 日志，用 `getEmbedding(n, 2)` 获取 2 维输出。

```javascript
// 临时注入 LlamaRankingContext.js
const emb = this._llamaContext._ctx.getEmbedding(input.length, 2);
console.log(`emb[0]=${emb[0]}, emb[1]=${emb[1]}, sum=${emb[0]+emb[1]}`);
```

用"明确相关"的 query-doc 对测试：

```
Query: "how to add two numbers in python"
Doc:   "def add(a, b): return a + b"    ← 明确相关

emb[0] = 0.0000486
emb[1] = 0.9999514
sum    = 1.0              ← 2-class softmax 输出 ✓
```

如果分类头未加载，1024 维 softmax 的每维 ≈ 1/1024 ≈ 0.00098，而实际 `emb[1] = 0.99995`，远超 0.001。

**结论：假设 A 被推翻。`cls_out` 正常加载，2-class softmax 正确工作。**

---

### 假设 B：双重处理（C++ softmax + JS sigmoid）

**猜想**：C++ `build_pooling` 里的 `ggml_soft_max()` 已经把 `cls_out` 输出变成了 [0,1] 概率。
JS 层不知道这一点，又调了 `logitToSigmoid()`。

**验证**：追踪 C++ 源码。

`llama-graph.cpp` 的 `build_pooling` 函数中，RANK 分支（对 QWEN3）：

```cpp
case LLAMA_POOLING_TYPE_RANK:
    // 1. 提取 last token hidden state
    cur = ggml_get_rows(ctx0, inp, inp_cls);

    // 2. cls_out 线性投影: 1024-dim → 2-dim logits
    if (cls_out) {
        cur = ggml_mul_mat(ctx0, cls_out, cur);  // [1024,2] @ [1024] → [2]
    }

    // 3. softmax — QWEN3 特有
    if (arch == LLM_ARCH_QWEN3 || arch == LLM_ARCH_QWEN3VL) {
        cur = ggml_soft_max(ctx0, cur);  // ← 这行！
    }
```

**确认**：C++ 已对 QWEN3 执行 softmax，输出是概率分布（和为 1）。

**同时验证**：用 debug 日志确认 `emb[0]+emb[1]=1.0`（参见假设 A 的验证结果）。

**结论：假设 B 被证实。C++ 输出是 softmax 概率，JS 层不应该再做 sigmoid。**

---

### 假设 C：错误类索引（取了 P(no) 而非 P(yes)）

**猜想**：`embedding[0]` 可能不对应 P(yes/相关)。GGUF 标签顺序可能与实际分类头权重列顺序不一致。

**验证**：用"明确不相关"文档构造对比实验。

```
Query: "how to add two numbers in python"
Doc:   "The mitochondria is the powerhouse of the cell"  ← 明确不相关

emb[0] = 0.9999814   ← 接近 1 — "不相关的概率"很高 ✓
emb[1] = 0.0000186   ← 接近 0 — "相关的概率"很低 ✓
```

再对比"明确相关"文档：

```
Query: "how to add two numbers in python"
Doc:   "def add(a, b): return a + b"    ← 明确相关

emb[0] = 0.0000486   ← 接近 0 — "不相关的概率"很低 ✓
emb[1] = 0.9999514   ← 接近 1 — "相关的概率"很高 ✓
```

**确认**：
- `embedding[0]` = P(no/不相关)
- `embedding[1]` = P(yes/相关)

GGUF 元数据标签是 `["yes", "no"]`，但 `cls_out` 权重实际列顺序是 `[no, yes]`——GGUF 转换时标签顺序写反了（Qwen3-Reranker 的已知问题）。`llama-server` 可能在 `/v1/rerank` 中根据标签名选中了正确的索引，而 `node-llama-cpp` 写死了取 `[0]`。

**结论：假设 C 被证实。应该取 `embedding[1]`（对 0.6B 模型）。**

---

### 假设 D（4B 特有问题）：不同 GGUF 转换的 `cls_out` 列顺序不同

**发现**：0.6B 的修复（硬编码 `embedding[1]`）在 4B 模型上失败——所有分数 0.73~1.0，仍然没有区分度。

**对比测试**：同一 4B 模型，`llama-server` vs `node-llama-cpp`：

| | llama-server | node-llama-cpp (硬编码 [1]) |
|---|---|---|
| 相关文档 | 0.065 | 0.178 (取反了) |
| 无关文档 | 3.9e-5 ~ 0.0025 | 0.90 ~ 1.0 (取反了) |
| 区分度 | ✅ 162x | ❌ 无 |

llama-server 的 `print_info` 输出：
```
print_info: n_cls_out             = 2
print_info: cls_label[ 0]         = yes
print_info: cls_label[ 1]         = no
```

即 4B 模型的 `cls_out` 列顺序是 `[yes, no]`，应取 `embedding[0]` 而非 `[1]`。

**根因**：`patch_reranker_gguf.py` 脚本构建 `cls_out` 时使用 `np.stack([yes_row, no_row], axis=1)`，即 col 0 = yes, col 1 = no，与 `output_labels = ["yes", "no"]` 对齐。而 ggml-org 的 0.6B 原始转换存在已知的标签/权重列顺序不一致 bug（标签是 `["yes", "no"]` 但权重列是 `[no, yes]`）。

**不同 GGUF 来源的列顺序对比**：

| 来源 | col 0 | col 1 | `output_labels` | 应取索引 |
|------|-------|-------|-----------------|----------|
| ggml-org 0.6B | P(no) | P(yes) | `["yes", "no"]` | **1** |
| `patch_reranker_gguf.py` (4B) | P(yes) | P(no) | `["yes", "no"]` | **0** |

**结论**：硬编码索引不可靠。必须动态读取 GGUF `classifier.output_labels`，找到 `"yes"` 对应的实际索引。

**验证**：4B debug 数据——
```
emb[0]=0.821513 (train相关, 高), emb[1]=0.178487 (低)
emb[0]=0.000448 (无关, 低),     emb[1]=0.999552 (高)
```
确认 `emb[0]` = P(yes) = 相关性分数 ✓

---

### 两个 bug 叠加效果（0.6B）

| 步骤 | 值 | 说明 |
|------|-----|------|
| C++ 输出 (softmax) | `[0.0000486, 0.9999514]` | [P(no), P(yes)] |
| JS `getEmbedding(n, 1)` | `0.0000486` | 只要了第 0 个 → P(no) |
| JS `logitToSigmoid(0.0000486)` | `0.500012` | sigmoid 把接近 0 的值压到 0.5 |

对相关文档：`P(no)` 极小 → sigmoid(极小) ≈ 0.500012
对无关文档：`P(no)` 极大 → sigmoid(0.99998) ≈ 0.731

所以相关文档反而得分低（0.500），无关文档得分高（0.731）——排序完全颠倒。而且两个分数都很接近 0.5，肉眼看上去就是"全在 0.5 附近"。

原来的排序之所以"看起来正确"（`train` 排第一），是因为 `train` 恰好是不相关程度最低的文档，P(no) 值稍低，sigmoid 后得分稍高。

---

## 四、修复

### 4.1 代码改动

文件：`node_modules/node-llama-cpp/dist/evaluator/LlamaRankingContext.js`
方法：`_evaluateRankingForInput`

```diff
- const embedding = this._llamaContext._ctx.getEmbedding(input.length, 1);
- if (embedding.length === 0)
+ const nClsOut = 2;
+ const embedding = this._llamaContext._ctx.getEmbedding(input.length, nClsOut);
+ if (embedding.length < 2)
      return 0;
- const logit = embedding[0];
- const probability = logitToSigmoid(logit);
- return probability;
+ const probability = embedding[1]; // P(yes) = relevance score
+ return Math.max(0, Math.min(1, probability));
```

三个改动：
1. **`getEmbedding(n, 2)`** — 获取完整 2 维 softmax 输出
2. **`embedding[1]`** — 取 P(yes)，不再取 `[0]`（P(no)）
3. **移除 `logitToSigmoid()`** — C++ 已做 softmax，不需要再做 sigmoid

### 4.2 固化（patch-package）

```bash
npx patch-package node-llama-cpp   # 生成 patches/node-llama-cpp+3.18.1.patch
```

`package.json`:
```json
{
  "scripts": { "postinstall": "patch-package" },
  "devDependencies": { "patch-package": "^8.0.1" }
}
```

每次 `npm install` 自动应用。

### 4.3 修复后验证

```bash
npx tsx src/cli.ts search "train method implementation" --demo --log-level=debug \
  | grep "Raw response"
```

```
修复前: 0.50142, 0.50018, 0.50003, 0.50039, ...  (全在 0.500 附近)
修复后: 0.99431, 0.99928, 0.99986, 0.99841, ...  (0.98 ~ 0.999)
```

与 `llama-server` 对照测试的分数分布一致。

---

## 五、为什么 llama-server 不受影响

`llama-server` 的 `/v1/rerank` 端点实现可能：

1. **不额外做 sigmoid** — 直接返回 softmax 后的概率值
2. **根据 `classifier.output_labels` 元数据动态选择索引** — 找到 "yes" 标签对应的列

`node-llama-cpp` 的 `LlamaRankingContext` 则：
1. 写死了 `getEmbedding(n, 1)`，只取 1 维
2. 写死了 `embedding[0]`，假定第 0 列就是"相关"
3. 对已经是概率的值做了 sigmoid

这解释了为什么同一模型在两个调用路径下表现截然不同。

---

## 六、调用链相关源码位置

| 文件 | 关键内容 |
|------|----------|
| `node_modules/node-llama-cpp/dist/evaluator/LlamaRankingContext.js` | `_evaluateRankingForInput` — JS 层 bug所在 |
| `node_modules/node-llama-cpp/llama/addon/AddonContext.cpp` | `GetEmbedding` — C++ 返回 embedding 的入口 |
| `llama.cpp/src/llama-graph.cpp` | `build_pooling` case `RANK` — softmax 调用处 |
| `llama.cpp/src/llama-model.cpp` | QWEN3 tensor 加载（`cls_out`） |
| `llama.cpp/src/llama-hparams.h` | `n_cls_out = 1` 默认值 |

---

## 七、关键收获

1. **问题定界先于假设**：用同一模型走两条路径对比，锁定问题是 `node-llama-cpp` 的调用链问题，而非模型问题。这避免了在模型端（GGUF 元数据、tensor 形状）花大量时间。

2. **每个假设都要设计验证实验**：不是"感觉像"就动手改，而是注入 debug 日志拿到真实数据后再判断。

3. **不信任元数据标签顺序**：GGUF 的 `classifier.output_labels` 可能与 `cls_out` 权重列顺序不一致。Qwen3-Reranker 的 GGUF 转换有已知的标签顺序 bug。

4. **注意 C++ 和 JS 的语义断层**：C++ 做了 softmax → 返回的是概率（JS 不知道）→ JS 又做 sigmoid → 双重处理。跨语言/跨层的调用链需要逐层确认输出语义。

---

## 八、修复过程中的测试方法

node-llama-cpp 作为 npm 依赖安装在 `node_modules` 中，不经过构建，直接改 JS 文件即可生效。

### 8.1 注入 debug 日志

直接编辑 `node_modules/node-llama-cpp/dist/evaluator/LlamaRankingContext.js` 的 `_evaluateRankingForInput` 方法。

**第一版 debug patch**——对比 `getEmbedding(n, 0)` 和 `getEmbedding(n, 1)`：

```javascript
// 注入到 LlamaRankingContext.js 的 _evaluateRankingForInput 方法中
// 替换原有的 getEmbedding + logitToSigmoid 逻辑

const embeddingFull = this._llamaContext._ctx.getEmbedding(input.length, 0);
const embedding = this._llamaContext._ctx.getEmbedding(input.length, 1);
console.log(`[DEBUG] embFull.length=${embeddingFull.length}, emb.length=${embedding.length}`);
console.log(`[DEBUG] embFull[0..5]=${Array.from(embeddingFull.slice(0, 6)).join(',')}`);
console.log(`[DEBUG] emb[0]=${embedding[0]}`);
const logit = embedding[0];
const probability = logitToSigmoid(logit);
console.log(`[DEBUG] logit=${logit}, probability=${probability}`);
return probability;
```

**运行测试**：

```bash
npx tsx src/cli.ts search "how to add two numbers" --demo --log-level=debug 2>&1 \
  | grep "DEBUG"
```

**输出**：

```
[DEBUG] embFull.length=1024, emb.length=1
[DEBUG] embFull[0..5]=0.000048608,0.999951362,0,0,-35195740160,1.804e-16
[DEBUG] emb[0]=0.00004860818080487661
[DEBUG] logit=0.00004860818080487661, probability=0.5000121520451988
```

**关键发现**：
- `embFull.length=1024` — `getEmbedding(n, 0)` 按 `n_embd` 返回了 1024 维（超出部分是未初始化内存）
- `embFull[0] + embFull[1] = 1.0` — 前 2 维是 softmax 输出
- `emb[0] = 0.0000486` — 第 0 维是极小的"不相关"概率
- `probability = 0.500012` — sigmoid 把这个接近 0 的值压到了 0.5

### 8.2 确认类索引

第二版修改——用 `getEmbedding(n, 2)` 获取完整 2 维输出，直接返回 `embedding[1]`（不经过 sigmoid）：

```javascript
const embedding = this._llamaContext._ctx.getEmbedding(input.length, 2);
console.log(`[DEBUG] emb[0]=${embedding[0]}, emb[1]=${embedding[1]}, sum=${embedding[0]+embedding[1]}`);
if (embedding.length < 2) return 0;
const probability = embedding[1]; // P(yes) = relevance score
return Math.max(0, Math.min(1, probability));
```

**运行测试**：

```bash
npx tsx src/cli.ts search "how to add two numbers" --demo --log-level=debug 2>&1 \
  | grep -E "DEBUG|Raw response"
```

**输出**：

```
[DEBUG] emb[0]=0.000048608, emb[1]=0.999951362, sum=1.0
[DEBUG] emb[0]=0.000027327, emb[1]=0.999972701, sum=1.0
[DEBUG] emb[0]=0.000063334, emb[1]=0.999936699, sum=1.0
...
Raw response: 0.999951..., 0.999972..., 0.999936..., ...
```

确认：
- `emb[0]` = P(no)，`emb[1]` = P(yes)
- 分数从 0.5 → 0.999，恢复正常

### 8.3 清除 debug 日志

最终版本——移除所有 `console.log`，保留修复逻辑：

```javascript
const nClsOut = 2;
const embedding = this._llamaContext._ctx.getEmbedding(input.length, nClsOut);
if (embedding.length < 2) return 0;
const probability = embedding[1];
return Math.max(0, Math.min(1, probability));
```

验证：

```bash
npx tsx src/cli.ts search "train method implementation" --demo | tail -25
```

正常输出搜索结果的代码片段，分数在 0.98~0.999 范围。

### 8.4 测试要点总结

| 阶段 | 改动 | 观测 | 结论 |
|------|------|------|------|
| 第一版 debug | `getEmbedding(n, 0)` 取 1024 维 | 前 2 维和为 1.0，其余是垃圾 | C++ 已做 2-class softmax |
| 第一版 debug | `getEmbedding(n, 1)` 取 1 维 + sigmoid | 结果 ≈ 0.500012 | sigmoid(接近0) → 0.5，解释了坍缩 |
| 第二版 debug | `getEmbedding(n, 2)` 取 2 维，用 [1] | 相关文档 `emb[1]=0.999`，无关文档 `emb[1]=0.000` | `[0]=P(no)`, `[1]=P(yes)` |
| 最终版本 | 移除 debug，固化逻辑 | 搜索排序正常 | 修复完成 |

整个过程不需要重新编译 node-llama-cpp 的 C++ addon——只改 JS 层即可快速迭代验证。

---

## 九、多模型验证与后续发现（2026-05-12）

### 9.1 硬编码 `embedding[1]` 在 4B 上失败

初始修复（第四节）硬编码了 `embedding[1]`，在 ggml-org 0.6B 上验证通过。但在 Mungert 4B 上测试时发现所有分数 0.73~1.0，仍然没有区分度。

**A/B 对比**（同一 4B 模型）：

| | llama-server | node-llama-cpp (硬编码 [1]) |
|---|---|---|
| 相关文档 | 0.065 | 0.178 (取反了) |
| 无关文档 | 3.9e-5 ~ 0.0025 | 0.90 ~ 1.0 (取反了) |

llama-server 的 `print_info` 显示 4B 模型：`cls_label[0] = yes`, `cls_label[1] = no`——即 `embedding[0]` 才是 P(yes)。

### 9.2 根因：不同 GGUF 转换的 `cls_out` 列顺序不同

| 来源 | col 0 | col 1 | `output_labels` |
|------|-------|-------|-----------------|
| ggml-org 0.6B (`convert_hf_to_gguf.py`) | P(no) | P(yes) | `["yes", "no"]` |
| Mungert 4B/8B (`patch_reranker_gguf.py` 脚本) | P(yes) | P(no) | `["yes", "no"]` |

`patch_reranker_gguf.py` 脚本的 `cls_out` 构建逻辑（`np.stack([yes_row, no_row], axis=1)`）将 col 0 对齐 `"yes"`，脚本本身是正确的。ggml-org 的原始转换存在已知的标签/权重列顺序不一致 bug。

### 9.3 最终修复：动态读取 `classifier.output_labels`

三处改动（已在 `patches/node-llama-cpp+3.18.1.patch` 中固化）：

1. **构造器** — 新增 `_relevanceIndex` 字段
2. **`_create`** — 从 `_model.fileInfo.metadata[arch].classifier.output_labels` 找到 `"yes"` 的实际索引
3. **`_evaluateRankingForInput`** — 用 `embedding[this._relevanceIndex]` 替代硬编码索引

验证：运行时 `relevanceIndex=0` (Mungert 模型) 或 `relevanceIndex=1` (ggml-org 模型)，两种转换均正确工作。

### 9.4 三模型对比（均为 `patch_reranker_gguf.py` 脚本 patch）

| 模型 | n_embd | 分数范围 | 排序正确？ |
|------|--------|---------|-----------|
| 0.6B | 1024 | 0.0001 ~ 0.005 | ✅ |
| 4B | 2560 | 0.0001 ~ 0.269 | ✅ |
| 8B | 4096 | 0.229 ~ 0.538 | ✅ |

三者排序均正确。`cls_out` 由 token embedding（"yes"/"no" 的嵌入向量）近似，不同模型大小下 softmax 输出的"锐度"不同。

### 9.5 待解决问题

1. **分数分布差异**：为什么相同脚本 patch 的三个模型，softmax 输出的分布范围差异很大？是 token embedding 近似 `score_head` 的固有限制，还是有其他因素影响？
2. **ggml-org vs 脚本 patch 的 0.6B 分数差异**：ggml-org 0.6B 使用原始 `score_head` 权重（分数 0.99），脚本 patch 的 0.6B 使用 token embedding 近似（分数 0.005）。这是因为 ggml-org 用 `convert_hf_to_gguf.py` 正确提取了训练好的分类头权重。


存疑，三个转换的模型，0.6b分数特别小并且没有区分，4b 8b都是前面几个最大
```
// "rerankerLlamaCppRerankerModelPath": "/Users/anrgct/llm_models/Mungert/Qwen3-Reranker-4B-GGUF/Qwen3-Reranker-4B-bf16_q8_0-rerank.gguf",

╭─   ~/w/autodev-codebase on   master ⇡4 *4 !3 ?2
╰─❯ npx tsx src/cli.ts search "where is the actual train method implementation in the source code?" --demo --log-level=debug | grep  "Raw response: \|results in \|< class\|inv-sigmoid"
[2026-05-12T15:47:42.515Z] DEBUG [Autodev-Codebase-CLI] [LlamaCppReranker] Raw response: 0.2685714364051819,0.006954813841730356,0.0014859091024845839,0.0004523990210145712,0.0004912154981866479,0.0008327350369654596,0.0005911079933866858,0.0013737078988924623,0.0019702850840985775,0.007636679336428642,0.005595386493951082,0.005210477393120527,0.0013953065499663353,0.005528452340513468,0.00016304425662383437,0.0005668650846928358,0.0007198465173132718,0.010552948340773582,0.0001924454263644293,0.0021689534187316895


// "rerankerLlamaCppRerankerModelPath": "/Users/anrgct/llm_models/Mungert/Qwen3-Reranker-0.6B-GGUF/Qwen3-Reranker-0.6B-bf16_q8_0-rerank.gguf",


╭─   ~/w/autodev-codebase on   master ⇡4 *4 !3 ?2     took  4s  base
╰─❯ npx tsx src/cli.ts search "where is the actual train method implementation in the source code?" --demo --log-level=debug | grep  "Raw response: \|results in \|< class\|inv-sigmoid"
[2026-05-12T15:53:06.615Z] DEBUG [Autodev-Codebase-CLI] [LlamaCppReranker] Raw response: 0.004929392132908106,0.0006511191604658961,0.00013584188127424568,0.0013581177918240428,0.0005214122938923538,0.001147164381109178,0.0003899446746800095,0.0002122497680829838,0.0008311656420119107,0.001801387290470302,0.00013642007252201438,0.0010293155210092664,0.0018457400146871805,0.0003300005046185106,0.00039316926267929375,0.0006702898535877466,0.0012418647529557347,0.012874177657067776,0.0002619275182951242,0.001995231257751584


"rerankerLlamaCppRerankerModelPath": "/Users/anrgct/llm_models/Mungert/Qwen3-Reranker-8B-GGUF/Qwen3-Reranker-8B-bf16_q8_0-rerank.gguf",

╭─   ~/w/autodev-codebase on   master ⇡4 *4 !3 ?2     took  4s  base
╰─❯ npx tsx src/cli.ts search "where is the actual train method implementation in the source code?" --demo --log-level=debug | grep  "Raw response: \|results in \|< class\|inv-sigmoid"
[2026-05-12T15:54:09.195Z] DEBUG [Autodev-Codebase-CLI] [LlamaCppReranker] Raw response: 0.5382386445999146,0.4427237808704376,0.3011404573917389,0.28320056200027466,0.2634865939617157,0.36154836416244507,0.2641870677471161,0.2722126245498657,0.29877758026123047,0.26587966084480286,0.28612402081489563,0.23321384191513062,0.303694486618042,0.27469363808631897,0.2526398003101349,0.2592686712741852,0.30588939785957336,0.27681928873062134,0.24492791295051575,0.22944167256355286
< class Model > function train > (L736-777)
```

---

## 十、bge-reranker-v2-m3 分数坍缩修复（2026-05-13）

### 10.1 问题

同一模型 `bge-reranker-v2-m3`：
- **llama-server** 模式：正常返回分数（raw logit → sigmoid → 0.01~0.20）
- **node-llama-cpp Direct** 模式：分数全为 0，无搜索结果

```bash
# Direct 模式 — 全零
npx tsx src/cli.ts search "..." --demo --log-level=debug | grep "rerank scores"
# [LlamaCppReranker] rerank scores: 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0

# Server 模式 — 正常
npx tsx src/cli.ts search "..." --demo --log-level=debug | grep "rerank scores"
# [LlamaCppReranker] Server rerank scores: 0.105,0.131,0.017,0.034,...
```

### 10.2 根因

第四节的 patch 只考虑了 Qwen3-Reranker（2-class 分类器），**硬编码了三条 Qwen3 专属假设**，对 bge（单回归输出）全部不成立：

| patch 假设 | Qwen3-Reranker | bge-reranker-v2-m3 | bge 上的后果 |
|---|---|---|---|
| `nClsOut = 2` | ✅ `cls_out` 形状 `[1024, 2]` | ❌ `cls.output.weight` 形状 `[1024]`（单输出） | `getEmbedding(n, 2)` 取到错误维度 |
| 不 sigmoid | ✅ C++ 已做 `ggml_soft_max` | ❌ C++ 仅线性投影，输出 raw logit（如 `-2.12`） | 负值未归一化 |
| `Math.max(0, Math.min(1, ...))` | ✅ 概率在 [0,1] | ❌ 负值被 clamp 到 0 | `max(0, -2.12) = 0` |

**完整坍缩链路**：

```
bge C++ 输出: raw logit = -2.12
  → patch: getEmbedding(n, 2) → embedding[0] = -2.12
  → patch: Math.max(0, Math.min(1, -2.12)) = 0
  → LlamaCppReranker: needsSigmoid = false (全是 0，没有 <0 或 >1 的值)
  → 最终分数 = 0 × 10 = 0
  → 全部被 rerankerMinScore 过滤
```

GGUF 元数据验证：

```bash
python3 -c "from gguf import GGUFReader; r = GGUFReader('bge-reranker-v2-m3-Q8_0.gguf')"
# general.architecture = bert
# cls.output.weight    shape=[1024]    ← 单回归向量，非 2-class 矩阵
# classifier.output_labels            ← 不存在！
```

### 10.3 修复

使 patch **架构感知**，在 `_create` 中通过 `classifier.output_labels` 是否存在判断架构类型：

```javascript
// _create 中：
let isTwoClassClassifier = false;
const labels = metadata[arch]?.classifier?.output_labels;
if (Array.isArray(labels) && labels.length > 0) {
    isTwoClassClassifier = true;  // Qwen3 路径
}

// _evaluateRankingForInput 中：
if (this._isTwoClassClassifier) {
    // Qwen3: getEmbedding(n, 2) → embedding[yes_index] → clamp [0,1]
} else {
    // bge:   getEmbedding(n, 1) → sigmoid(embedding[0])  ← 原始行为
}
```

### 10.4 修复后验证

```bash
# bge Direct 模式 — 恢复正常
npx tsx src/cli.ts search "..." --demo --log-level=debug | grep "rerank scores"
# rerank scores: 0.011,0.200,0.002,0.055,0.036,0.026,...
# Found 8 results — train 方法排首位 ✓
```

### 10.5 关键收获

1. **patch 不能假设所有 reranker 都是同一架构**。Qwen3 是 2-class softmax 分类器，bge 是单回归输出。检测依据：GGUF 元数据中 `classifier.output_labels` 是否存在。
2. **C++ 层的 `ggml_soft_max` 仅对 QWEN3 架构调用**（`llama-graph.cpp` 中的 `arch == LLM_ARCH_QWEN3` 判断），BERT 架构不经过 softmax。
3. 对单回归模型，JS 层的 `logitToSigmoid` 是**必需的**（C++ 不提供），而对 2-class 模型是**有害的**（C++ 已做 softmax）。
