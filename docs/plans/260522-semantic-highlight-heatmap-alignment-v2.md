# 260522-heatmap-token-text-missing

## 主题/需求

semantic-highlight `--debug-highlight` 热力图中，大量 token 以 `▓▓▓▓▓` 色块显示而非实际文本，影响调试可读性。

**问题表现：**

```
 97 ░░░░░░░░░░ 0.004486 │   model (Union[str, Path]): Path or name of the model to load or create. Can be a local file path, a▓▓▓▓▓▓
 98 ░░░░░░░░░░ 0.002734 │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░▓▓▓▓▓▓▓a▓▓▓▓▓▓▓ Server model.
```

**目标：** 尽可能显示原文 token 文本，色块只在真正无法定位时出现。

## 代码背景

| 文件 | 职责 |
|------|------|
| `src/code-index/highlighters/semantic-highlight.ts` | 热力图渲染，4 个函数 |
| `src/code-index/rerankers/semantic-highlight.ts` | 产出 `_semanticHighlightTokenTexts` |

**数据流：**

```
reranker.rerank()
  rawIds = model.tokenize(input)                    → 504 个 ID
  rawTexts = rawIds.map(id => detokenize([id]))     → [" model", " (", "Union", ...]
  diff = tokenProbs.length - rawTexts.length        → 1（BOS）
  tokenTexts = ["", ...rawTexts]                    → 505 个元素，对齐 probs
  payload._semanticHighlightTokenTexts = tokenTexts

highlighter._buildDebugTokenViewFromProbs()
  for each token ti:
    text = tokenTexts[ti]                           → e.g. " model"
    idx = input.indexOf(text, searchFrom)           → 可能失败！
    if matched: 显示原文
    else:       显示 ▓ 色块
```

**关键常量：**

- BOS token 占 index 0，`tokenTexts[0] = ""`
- `input` = `"${query} </s></s> ${code}"`（reranker 格式）
- `codeOffset` = `input.indexOf(codeChunk)`，热力图只显示 code 部分 token

## 关键决策

### 为什么大量 token 的 indexOf 会失败

XLM-RoBERTa 使用 SentencePiece 分词，**单词边界以 `▁`（U+2581）标记**，`detokenize([id])` 对于 word-initial token 返回带前导空格的文本：

```
tokenize(" local") → [token_id_▁local]
detokenize([token_id_▁local]) → " local"   ← 前导空格
```

但原始代码里，"local" 可能跟在换行符后（`\n    local`），不是跟在空格后。
`indexOf(" local", pos)` 在换行符位置前找不到前导空格 → **失败**。

更深层的问题：`detokAcc`（字符位置累加器）用 `text.length`（含虚拟空格）推进，
但原始字符串里这个 token 只占 `trimmed.length`（无空格）的字符数。
**累积漂移**：每次失败 + 空格不计，`detokAcc` 就偏离真实位置，后续 token 全错位。

### 为什么 trimStart() 方案（方法 1）效果有限

v3 修复在 indexOf 失败时用 `text.trimStart()` 重试，可以解决部分空格问题，
但 `detokAcc` 的漂移是**累积的**——早期几个 token 的空格漂移，导致后续 indexOf 的
`searchFrom` 位置偏移，即使 trimStart 也搜不到目标。

另外，XLM-RoBERTa 不仅有空格问题，还有：
- **子词碎片**：`"configuration"` → `["config", "uration"]`，
  `detokenize(["config"])` = `"config"`，在原文里能 indexOf 到；
  但 `"uration"` 没有前导标记，`indexOf("uration", pos)` 也能找到——这类不是问题。
- **丢失字符**：少数 token 的 `detokenize` 返回空或乱码（如 `#` → `""`，`def` → `"f"`），
  这类 token 无论如何都无法匹配。

### 真正的修复方向：字符级对齐

根本解法是不依赖 `detokenize` 的输出，而是**直接确定每个 token 在原始字符串中的字符范围**。

**方案 A：二分搜索对齐（精确，成本高）**

```
charPos = 0
for i in 0..n:
  二分搜索最小的 end，使 tokenize(input[0:end]).length == i+1
  tokenCharRange[i] = [charPos, end]
  charPos = end
```

需要约 n × log(maxTokenLen) 次 tokenize 调用（500 tokens × 6 = 3000 次），
每次是小字符串，应在 10ms 内完成，但仍是额外开销。

**方案 B：贪心前向匹配（近似，更快）**

从 `charPos` 开始，逐字符扩展，直到 `tokenize(input[charPos:charPos+len])` 产出的最后一个 token ID 等于当前 `tokenId`。

**方案 C：修复 detokAcc 漂移（不改 indexOf，只改推进量）**

当 exact indexOf 失败、trimStart indexOf 成功时：
- `detokAcc = idx2 + trimmed.length`（当前已做）✓
- 当两者都失败时，`detokAcc += text.length` 会引入漂移，
  **改为 `detokAcc += trimmed.length`**（或估算实际字符数）

## 实施计划

- [x] 方法 1：trimStart() 重试 — 已实施，效果有限
- [x] 方法 2A：修复失败分支的 detokAcc — 被 v4 间隙插入方案替代
- [ ] 方法 3：二分搜索字符级对齐（`_tokenizeWithCharOffsets`）
- [x] 方法 4：per-line `prevChunkEnd` 间隙插入 — 修复 `add_space_prefix` 后空格消失问题

## 实施记录

### 2026-05-22

**v1（前序工作）：** 比例映射 → 窗口化 indexOf，数据传参补全（payload + HighlightOptions + search-service）。

**v2（前序工作）：** BOS 对齐：`getEmbeddingsForTokens` 比 `tokenize` 多 1 个 token（BOS），
用 `diff = probs.length - rawTexts.length` 补空字符串，不依赖 BOS/EOS API。

**v3（本次）：** indexOf 失败时用 `text.trimStart()` 重试，`effectiveText` 变量传给渲染。
用户测试反馈：效果不明显，核心问题（detokAcc 漂移）未解决。

诊断：trimStart 解决了单次失败，但累积漂移问题在首个失败 token 之后就雪崩。

### 2026-05-23

**v4（间隙插入）：** `add_space_prefix` 修复后，`▁` 不再转为空格，`detokenize([▁track])` 从 `" track("` 变为 `"track("`。
单词间的空格变成「孤儿」字符，不属于任何 token 的显示文本，导致热力图输出 `deftrack(` 而非 `def track(`。

**修复方式：** 在 `_buildDebugTokenViewFromProbs` 和 `_buildDebugTokenView` 中：
1. 新增 per-line `prevChunkEnd[]` 数组，追踪每行上一个 token 在 `codeChunk` 中的结束位置
2. 每个 token 放置前，若 `codePos > prevChunkEnd[li]`，从 `codeChunk` 截取间隙字符插入
3. 间隙中空格保持原样（可读性），其他空白字符转为 `░`
4. 每个 token 放置后更新 `prevChunkEnd[li]`

**效果：** 单词间空格恢复显示。但 `\n` 丢失导致的 detokAcc 漂移仍然存在，`▓▓▓▓▓` 色块问题需方法 3 彻底解决。

**v5（比例映射 fallback）：** 将 indexOf 失败分支的 `codePos = detokAcc - codeOffset`（漂移的）改为 `Math.round((ti/totalTokens) * totalChars) - codeOffset`（比例映射，免疫漂移）。同时 `detokAcc += text.length` 改为 `Math.max(detokAcc, codePos + codeOffset + ...)`，防止后续搜索窗口偏离。

**改动范围：** 8 处替换，横跨 4 个方法：`_aggregatePrecomputedProbsToLines`, `_aggregateTokensToLines`, `_buildDebugTokenView`, `_buildDebugTokenViewFromProbs`。

**效果：** 比例映射不依赖 detokAcc，`\n` 累积漂移被阻断。但 indexOf 失败时 token 文本仍无法显示（`▓` 块保留），仅位置正确。彻底消除 `▓` 需正向 tokenize 匹配（行内比例映射）。

**运行方式（免构建）：** `npx tsx src/cli.ts search "query" --demo --debug-highlight`

**v6（行内比例映射）：** v5 的全局比例映射 (`ti/totalTokens`) 把 BOS/query 前缀 token 也映射到 code 区域，产生虚假间隙导致文本重复。改为行内比例：

1. 初始化 `perLineTokEst[li]` / `perLineTokIdx[li]`：按字符比例估算每行 token 数
2. fallback 时：全局比例 → 确定行号 → 行内比例 `lstart + (tokIdx/tokCount) * llen`
3. 行首 token 直接 snap 到 `lstart`（避免间隙重复）
4. 空文本 token 跳过显示（防止 BOS/query 污染 code 区域）

**效果：** 前半段（~14行内）文本完整可读，`deftrack(` → `def track(`。后半段 `\n` 漂移仍导致 `▓` 块，但位置由行内比例修正。

**v7（逐字符着色，最终方案）：** 彻底放弃 detokenize + indexOf 路径。在 debug 热力图渲染中改为逐字符着色：

1. 每个字符按全局位置 `(lineStart + ci + codeOffset) / totalChars * totalTokens` 映射到 token index
2. 取对应 token 的 score 着色，连续同色字符合并 ANSI 码减少输出
3. 显示的是原始 `codeLines` 文字，不是 detokenize 产物 → 永不出现 `▓` 乱码

**改动范围：** 仅 `_buildDebugTokenView` 和 `_buildDebugTokenViewFromProbs`（~60 行/函数）。`_aggregate*ToLines` 评分路径、reranker、interfaces、search-service 不动。

**效果：** 热力图显示真实代码文字，逐字符按 attention 分数变色。没有 detokenize 依赖，没有 `\n` 丢失问题。精度损失（比例映射而非精确 indexOf）在热力图场景下可接受。

**输出示例：**
```
  976 ██████████ 0.184 │  >>> def on_train_start(trainer):
  977 █████████░ 0.163 │  ...     print("Training is starting!")
  978 █████████░ 0.166 │  >>> model = YOLO("yolo11n.pt")
```

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-05-22 | 初始文档 |
| v2 | 2026-05-22 | 验证根因：`\n` 丢失是主导因素（41.5% 失败），`▁`→空格为次要；BGE 对比确认换模型无效；旧版比例映射回顾 |
| v2.1 | 2026-05-22 | 深挖 `▁`→空格根因：确认是 GGUF 转换时 `add_space_prefix` 误写为 `False`，非 SentencePiece 固有限制；当前版 `convert_hf_to_gguf.py` 可正确写入 `True` |
| v2.2 | 2026-05-22 | `convert_hf_to_gguf.py` bug 时间线分析；GGUF 原地 patch 修复（1 字节）；`\n` 丢失根因确认为 Normalizer 层 |
| v2.3 | 2026-05-23 | v4: per-line `prevChunkEnd` 间隙插入，修复 `add_space_prefix` 后空格消失 |
| v2.4 | 2026-05-23 | `▓▓▓▓▓` 问题延续（`\n` 丢失→detokAcc 漂移），需正向 tokenize 匹配（~2500次/热力图），暂搁置 |
| v2.5 | 2026-05-23 | v5 比例映射 fallback：8处替换，indexOf 失败时用比例映射替代漂移的 detokAcc，阻断 `\n` 累积偏差 |
| v2.6 | 2026-05-23 | v6 行内比例映射：perLineTokEst/Idx 追踪，行首 snap + 空文本跳过，消除 BOS 污染产生的重复文本 |
| v2.7 | 2026-05-23 | **v7 最终方案**：彻底放弃 detokenize+indexOf，改为逐字符着色。显示原始代码文字，永不出现 `▓` 乱码。仅改 `_buildDebugTokenView` / `_buildDebugTokenViewFromProbs` |

## 验证记录

### 2026-05-22 根因验证

**验证脚本：** `src/examples/verify-drifthypothesis.ts`

用 1964 字符的 Python 代码片段（65 个换行符）模拟实际场景，测试 XLM-RoBERTa 模型的 indexOf 匹配：

| 指标 | 数值 |
|------|------|
| Token 总数 | 482 |
| `▁` → 前导空格 | 167 (34.6%) |
| exact 匹配 | 277 |
| trimStart 救回 | 5 |
| **完全失败** | **200 (41.5%)** |
| detokAcc 最终偏差 | **-287**（应为 1964，实为 1677） |
| `detokenize(allTokens)` 换行符 | **0/65 全部丢失** |

**结论：原假设「`▁`→空格是主因」不完整。** `\n` 在 `detokenize([id])` 中被完全丢弃才是主导因素：

1. XLM-RoBERTa 的 SentencePiece tokenizer 把 `\n` 编码进相邻 token（如 `▁\ndef` → id=8），但 `detokenize([id=8])` 返回 `" de"`——`\n` 丢失
2. 65 个换行符在 input 中占位，但没有任何 token text 能匹配它们
3. 每经过一个 `\n`，`detokAcc` 落后 1 个字符；积累 ~10 个后偏移超过搜索窗口（10 字符），后续 token 全部错位
4. `▁`→空格问题（34.6% token 受影响）可通过 trimStart 部分救回，但 `\n` 丢失是**不可恢复的**

### 2026-05-22 BGE-Reranker-v2-m3 对比

换用 BGE-Reranker-v2-m3（同样基于 XLM-RoBERTa）测试：

| 指标 | XLM-RoBERTa | BGE-Reranker-v2-m3 |
|------|-------------|---------------------|
| `▁`→前导空格 | 167 (34.6%) | **0 (0%)** |
| `\n` 丢失 | 65/65 | 65/65 |
| indexOf 失败 | 200 | 199 |

BGE 的 GGUF tokenizer 对 `▁` 采用标准 SentencePiece 行为（移除而非转空格），因此没有前导空格问题。但 **`\n` 丢失问题完全一致**，失败数几乎相同（200 vs 199）。

**换模型解决不了问题。** 两个模型底层都是 SentencePiece，GGUF 转换时 tokenizer 配置不同只影响 `▁` 处理，不影响 `\n` 丢失。

### 2026-05-22 `▁`→空格根因：`add_space_prefix` 转换 bug

**调查发现：** XLM（SH）GGUF 的 `▁`→空格问题并非 SentencePiece 固有限制，而是 GGUF 转换时 `tokenizer.ggml.add_space_prefix` 被错误地写成了 `False`。

**在线 HF tokenizer_config.json 对比：**

| 字段 | SH (zilliz) | BGE-M3 (BAAI) |
|------|-------------|---------------|
| `tokenizer_class` | `XLMRobertaTokenizer` | `XLMRobertaTokenizer` |
| `add_prefix_space` | **未设置** | **未设置** |

两者在线 `tokenizer_config.json` **完全一致**，都没有显式设置 `add_prefix_space`。`XLMRobertaTokenizer` 类的构造函数默认值为 `True`：

```python
# transformers.XLMRobertaTokenizer.__init__
add_prefix_space: bool = True
```

**GGUF metadata 实际值：**

| 模型 | `tokenizer.ggml.add_space_prefix` | 预期 |
|------|----------------------------------|------|
| SH (XLM) GGUF | `False` ❌ | `True` |
| BGE-M3 GGUF | `True` ✅ | `True` |

**用当前版 `convert_hf_to_gguf.py` 模拟验证：**

```python
model = XLMRobertaModel(dir_model=DISGUISED, ...)
model.set_vocab()
# → tokenizer.ggml.add_space_prefix = True (BOOL) ✅
```

当前版会正确读取 `tokenizer.add_prefix_space = True` 并写入 GGUF。现存 SH GGUF 的 `False` 是旧版 `convert_hf_to_gguf.py` 的 bug。

**llama.cpp detokenize 中的影响链：**

```cpp
// src/llama-vocab.cpp:3414
bool remove_space = add_space_prefix;
```

- `add_space_prefix = True` → `remove_space = True` → **strip 前导 `▁`**（标准 SentencePiece 行为）
- `add_space_prefix = False` → `remove_space = False` → `▁` 被**转为空格保留**（SH 现况）

**结论：`▁`→空格问题可通过重新用当前版 `convert_hf_to_gguf.py` 转换 GGUF 修复。** 但 `\n` 丢失问题与此无关，仍需方法 3（字符级对齐）解决。

### 2026-05-22 `convert_hf_to_gguf.py` bug 时间线

**为什么 SH GGUF 的 `add_space_prefix` 是 `False`：** `convert_hf_to_gguf.py` 的 `XLMRobertaModel.set_vocab` 经历了三个版本的演进：

| 版本 | commit | 日期 | `add_prefix` 来源 | 对 SH 模型 |
|------|--------|------|-------------------|-----------|
| v1 内联 | `f4d2b8846` | 2024-09-28 | `sentencepiece_model.normalizer_spec.add_dummy_prefix` | ❌ 需要 `sentencepiece.bpe.model`（SH 没有） |
| v2 重构 | `5f5e39e1b` | 2025-04-28 | 抽出 `_xlmroberta_set_vocab`，仍仅 spm 路径 | ❌ 同上 |
| v3 tokenizer.json | `1274c8c35` | 2025-05-22 | `tokenizer.add_prefix_space`（HF tokenizer） | ✅ 正确 |

**当前 HEAD** 的 `XLMRobertaModel.set_vocab` → `_xlmroberta_set_vocab()` 已正确读取 `tokenizer.add_prefix_space = True`，**bug 已不存在**。SH GGUF 的 `False` 是旧版或不同转换路径产生的。

### 2026-05-22 `add_space_prefix` 修复

**修复方式：** 不改 tensor 数据，只 patch GGUF KV 区中 1 个字节（`0x00` → `0x01`）。脚本：`open_provence_demo/scripts/patch_add_space_prefix.py`

**修复结果：**

| 文件 | 修复前 | 修复后 |
|------|:---:|:---:|
| `F16.gguf` | `False` | `True` ✅ |
| `Q8_0.gguf` | `False` | `True` ✅ |
| `F16-unified.gguf` | `False` | `True` ✅ |
| `Q8_0-unified.gguf` | `False` | `True` ✅ |

**效果验证（node-llama-cpp）：**

| 指标 | 修复前 | 修复后 |
|------|:---:|:---:|
| `▁`→前导空格 | 8/16 (50%) | **0/16 (0%)** |
| `full detok` | `" def predict..."` | `"def predict..."` |

与 BGE-M3 GGUF 行为完全一致。备份文件为原地 `.bak` 后缀。

### 2026-05-22 `\n` 丢失根因确认：Normalizer 层（precompiled_charsmap）

**验证确认：** `\n` 丢失发生在 **Normalizer 层（tokenization 之前）**，不是 SentencePiece tokenization 本身，也无法通过 GGUF 配置修复。

用 HuggingFace 底层 `tokenizers` 库直接测试 normalize → tokenize 流程：

```python
tk = Tokenizer.from_file("tokenizer.json")

# \n 在 normalize 阶段就被转换了
tk.normalizer.normalize_str("\n    def")   # → "▁def"    (\n + 空格 → ▁)
tk.normalizer.normalize_str("test\nhello") # → "test hello" (\n → 空格)
```

**完整链路：**

```
原始文本: "\n    def predict(...):\n    local = True"
    ↓ Normalizer (precompiled_charsmap)
规范化:   "▁def predict(...): ▁local = True"    ← \n 全部变成空格/▁
    ↓ SentencePiece tokenize
Token:    [▁de, f, ▁predict, (, ...), :, ▁local, ▁=, ▁True]
    ↓ detokenize([id])
单 token:  "de", "f", " predict", ...           ← \n 已不可恢复
```

- HF 原生 `tokenizer.encode("\n")` 返回 `[]`（空列表）—— 纯换行符被完全忽略
- 即使 HF 原生 `tokenizer.decode(ids)` 也无法还原 `\n`
- `\n`→空格 的映射烧录在 `tokenizer.json` 的 `precompiled_charsmap` 中，是 XLM-RoBERTa tokenizer 的设计行为（将换行符视为普通空白字符）
- **不可通过 GGUF metadata 参数修复**

### 2026-05-22 旧版对比：为什么之前没有这个问题？

旧版高亮器 `llamacpp.ts`（commit `746e355`）使用**纯比例映射**，不依赖 `detokenize`：

```typescript
// 旧版：数学比例估算，永远不会失败
const approxCharPos = (ti / totalTokens) * totalChars
const codePos = approxCharPos - codeOffset
```

新版 `semantic-highlight.ts`（当前 commit `77d2eef`）引入了 `detokenize([id])` + `indexOf` 精确匹配，追求准确但暴露了 `detokenize` 的信息丢失。

## 总结

**修正后的根因：** `detokenize([id])` 对 XLM-RoBERTa SentencePiece tokenizer 存在两类信息丢失：

1. **`\n` → 完全丢失**（主导因素，占 41.5% 失败）：\n 在 tokenizer 的 **Normalizer 层（precompiled_charsmap）** 被转换为空格/`▁`，token 化之前就已消失。这是 XLM-RoBERTa tokenizer 的设计行为（烧录在 `tokenizer.json` 中），**不可通过 GGUF 配置参数修复**。
2. **`▁` → 前导空格**（次要因素，占 34.6% token 受影响）：根因是 GGUF 转换时 `tokenizer.ggml.add_space_prefix` 被旧版 `convert_hf_to_gguf.py` 误写为 `False`。**可修复**——用当前版重新转换即可正确写入 `True`，使 detokenize 按标准 SentencePiece 行为 strip `▁`。

**可行的下一步：**
1. 方法 2A 代价极小，但对 `\n` 丢失无效（失败时 `detokAcc += trimmed.length` 仍然无法匹配不存在字符）
2. 方法 3（二分 tokenize）是唯一能同时解决两类问题的彻底方案
3. 或者回退到旧版的比例映射方式（牺牲精度换可靠性），在热力图场景下精度损失可接受

**最终选择：v7 逐字符着色。** 彻底放弃 detokenize+indexOf 路径，改为逐字符比例映射着色原始代码文字。原因：
- XLM-RoBERTa 的 `\n` 丢失问题不可修复（Normalizer 层，烧录在 tokenizer.json）
- 为此引入 200+ 行 fallback 代码（v3-v6）得不偿失
- 热力图的核心价值是 bar 分数和颜色分布，不是 token 级别文本精确性
- 改动范围极小（仅 2 个 debug 渲染函数），数据管道（reranker/interfaces/search-service）保留以备后用

**参考文件：**
- highlighter: `src/code-index/highlighters/semantic-highlight.ts`
- reranker: `src/code-index/rerankers/semantic-highlight.ts`
- 旧版高亮器: `src/code-index/highlighters/llamacpp.ts`（commit `746e355`，纯比例映射）
- 验证脚本: `src/examples/verify-drifthypothesis.ts`
- 旧分析文档: `docs/plans/260522-semantic-highlight-heatmap-alignment.md`
