# 260522-semantic-highlight-heatmap-alignment

## 主题/需求

semantic-highlight 的 `--debug-highlight` 热力图显示 `█▓░` 块而非实际 token 文本，且位置映射使用比例公式导致逐行错位。参照 QRRanker 修复方案（`260522-bpe-detokenize-limitation.md`）做同步改造。

### 结论：已修复，但有已知限制

四个独立问题均已修复，位置对齐和数据传递完全恢复。但由于 XLM-RoBERTa 的 `detokenize()` 本质上是**有损的**（丢弃 `\n` + 部分前导字符），个别 token 的文本无法精确还原，以有色色块降级显示。

以 `model.py` L130-145 为例说明修复效果和剩余限制：

**原始代码：**
```
130              checks.check_requirements("hub-sdk>=0.0.12")
131              session = HUBTrainingSession.create_session(model)
132              model = session.model_file
133              if session.train_args:  # training sent from HUB
134                  self.session = session
```

**修复前（无 token 文本，全 `█` 块）：**
```
130 █████████░ 0.107 │  ███████████████████████████████████
131 █████████░ 0.110 │  ████████████████████████████████████████████
134 ██████████ 0.118 │  ██████████████
```

**修复后（有 token 文本，`matched` 标记区分精确/降级）：**
```
130 █████████░ 0.107 │  check_requirements("hub-sdk>=0.0.12")   ← ✅ 精确匹配，回车符号丢失
131 █████████░ 0.110 │   session =░HUBTrainingSession.create_session(model)  ← ⚠️ = HUB 之间空格丢，行前面的空格符号和后面的回车符号丢失并且没有颜色
132 █████████░ 0.111 │   model = session.model_file                ← ✅ 精确匹配，回车符号丢失并且没有颜色
133 █████████░ 0.113 │   if session.train_args: # training sent from░HUB█████  ← ⚠️ self 丢
134 ██████████ 0.118 │  █session = session                       ← ⚠️ 前导 self. 丢
135 ░░░░░░░░░░ 0.000 │                                           ← ✅ 空行正确，回车符号丢失
```

**分析：**

| 现象 | 根因 | 处理 |
|------|------|------|
| `check_requirements(...)` 完整显示 | `detokenize([id])` 匹配成功 | `matched=true` → 显原文 |
| `=░HUB`（空格丢了） | XLM-RoBERTa 的 SentencePiece detokenizer 丢弃前导空格 | `matched=false` → 空白位 `░` |
| `from░HUB█████`（`self` 丢了） | `detokenize("self")` → `"s"`，`indexOf` 失败 | `matched=false` → 比例 `█` 块 |
| `░` 和 `█` 都有色 | 走 `score > 0 \|\| tokenLen > 0` 分支 | 按 score 着色（蓝/绿/黄/红色阶） |

以下为长 docstring/注释块的极端案例（L97-101），99% 的 token 无法匹配，仅残留个别词：

**原始代码：**
```
 97          model (Union[str, Path]): Path or name of the model to load or create.
 98              Can be a local file path, a model name from Ultralytics HUB, or a Triton Server model name.
 99          task (str, optional): The task type for the YOLO model. Can be "detect", "segment",
100              "classify", "pose", "obb", etc.
101          verbose (bool): If True, displays model info during loading.
```

**修复后输出：**
```
 97 ░░░░░░░░░░ 0.004486 │   model (Union[str, Path]): Path or name of the model to load or create. a▓▓▓▓▓▓
 98 ░░░░░░░░░░ 0.002897 │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░▓▓▓▓▓▓▓▓
 99 ░░░░░░░░░░ 0.002483 │  ▓▓▓▓ task▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
100 ░░░░░░░░░░ 0.001199 │  ▓▓▓▓▓▓▓▓▓ verbose▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓s▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░
101 ░░░░░░░░░░ 0.000661 │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

**分析：** L97 的 score 约 0.004（极低），只有"model"和几个符号精确匹配显示原文，其余全部降级为 `▓` 色块。L98-101 几乎全军覆没——XLM-RoBERTa 的 SentencePiece tokenizer 对英文自然语言文本的分词粒度与原始字符不一一对应，`detokenize([单个id])` 产出的子词片段无法在原文中精确 `indexOf` 定位。

### 背景

`260521-semantic-highlight-unified` 的 Step 3 实现了 reranker→highlighter 复用 forward pass（通过 `_semanticHighlightTokenProbs` + `_semanticHighlightCodeText`），但未传递 token 文本，导致 debug 热力图无法做 token 级着色。

QRRanker 在 `260522-bpe-detokenize-limitation` 中修复了两个根因（多行 token 压缩 + 窗口化 indexOf），semantic-highlight 需要同步移植。

### 目标

- 热力图显示实际 token 文本（而非 `█▓░` 块）
- 位置映射使用窗口化 indexOf（而非比例公式）
- 空格/换行按 QRRanker 风格有色显示
- 数据传参与 QRRanker 对齐（`_*TokenTexts` / `_*Input` / `_*ChunkScore`）

### 验证方式


配置 `demo/autodev-config.json`：

```json
"rerankerProvider": "semantic-highlight",
"rerankerGgufPath": "/Users/anrgct/workspace/open_provence_demo/output/semantic_highlight_gguf/semantic-highlight-bilingual-v1-Q8_0-unified.gguf",
"highlighterProvider": "semantic-highlight",
"highlighterGgufQrrankerPath": "/Users/anrgct/workspace/open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf", //无效，实际使用reranker传入的预计算数据
```

```bash
# 复现
npx tsx src/cli.ts search "where is the train method" --demo --debug-highlight --log-level=debug 2>/dev/null | grep -A20 "L130-145"

# 验证数据传递
npx tsx src/cli.ts search "where is the train method" --demo --debug-highlight --log-level=debug 2>/dev/null | grep -i "Heatmap fast"
```

**修复前输出（L130-145，无 token 文本）：**

```
  130 ██████████ 0.474643 │  ████████████████████████████████████
  1013 ██████████ 0.474454 │  ████████████
  1014 ██████████ 0.453782 │  ██████████████████████████████████████
  1015 ░░░░░░░░░░ 0.000000 │
```

**修复后输出（L130-145，有 token 文本 + matched 标记）：**

```
  130 ██████████ 0.471514 │  f reset_callbacks(self) -> None:
  1013 ██████████ 0.455375 │   """
  1014 █████████░ 0.420901 │   Resets all callbacks to their default functions.
  1015 ░░░░░░░░░░ 0.000000 │
```

## 代码背景

### 关键文件

| 文件 | 职责 |
|------|------|
| `rerankers/semantic-highlight.ts` | `rerank()` 产出 `_semanticHighlightTokenTexts` + `_semanticHighlightInput` 到 payload |
| `highlighters/semantic-highlight.ts` | 4 个函数改造：评分路径 + 渲染路径 |
| `interfaces/highlighter.ts` | `HighlightOptions` 新增 3 个 internal 字段 |
| `search-service.ts` | 补全 semantic-highlight 预计算字段转发 |

### 数据流

```text-chart
Reranker.rerank()
  │
  ├─ getEmbeddingsForTokens(input) → tokenProbs → _semanticHighlightTokenProbs
  ├─ model.tokenize(input) → detokenize([id]) → _semanticHighlightTokenTexts
  ├─ input → _semanticHighlightInput
  └─ candidate.content → _semanticHighlightCodeText
       │
       ↓ payload 传递
       │
SearchService.searchIndex()
  └─ 转发 _semanticHighlightTokenProbs / _semanticHighlightTokenTexts /
         _semanticHighlightInput / _semanticHighlightChunkScore → HighlightOptions
       │
       ↓ options 传递
       │
Highlighter.highlight() (fast path)
  ├─ 检测 _semanticHighlightTokenProbs → 跳过模型加载
  ├─ _aggregatePrecomputedProbsToLines() → 窗口化 indexOf 评分
  └─ _buildDebugTokenViewFromProbs() → token 级着色 + bar + 多行分段
```

## 关键决策

- **已修复**，参照 QRRanker 方案同步移植
- 修复范围：
  - **评分路径**：`_aggregateTokensToLines` + `_aggregatePrecomputedProbsToLines`
  - **渲染路径**：`_buildDebugTokenView` + `_buildDebugTokenViewFromProbs`
  - **数据传参**：reranker payload + search-service 转发 + HighlightOptions 接口
- XLM-RoBERTa 特殊性：`detokenize()` 丢 `\n` + 前导空格/字符，需 `matched` 标记区分精确匹配 vs 降级

## 实施记录

### 2026-05-22

**Step 1：数据传参**

reranker 新增 token 文本产出：

```typescript
// rerankers/semantic-highlight.ts: rerank()
const tokenIds = this._model!.tokenize(input);
const tokenTexts = tokenIds.map((id) => this._model!.detokenize([id]));
p["_semanticHighlightTokenTexts"] = tokenTexts;
p["_semanticHighlightInput"] = input;
```

`HighlightOptions` 接口新增：`_semanticHighlightTokenTexts`、`_semanticHighlightInput`、`_semanticHighlightChunkScore`。

`search-service.ts` 补全转发（参照 QRRanker 的 `_qrrankerTokenTexts` 模式）。

**Step 2：评分路径改造**

`_aggregateTokensToLines`（normal path）和 `_aggregatePrecomputedProbsToLines`（fast path）从比例映射改为窗口化 indexOf：

```typescript
// 修复前：比例映射
const codePos = (ti / totalTokens) * totalChars - codeOffset;

// 修复后：窗口化 indexOf + 降级
const text = tokenTexts[ti];
const searchFrom = Math.max(0, detokAcc - 5);
const idx = input.indexOf(text, searchFrom);
if (idx >= 0 && idx < detokAcc + text.length + 10) {
  codePos = idx - codeOffset;
  detokAcc = idx + text.length;
} else {
  codePos = detokAcc - codeOffset;  // 降级：允许漂移
  detokAcc += text.length;
}
```

同时将行匹配从 `charCount += lineLen` 改为预计算 `lineCharEnds[]` 数组。

**Step 3：渲染路径改造**

`_buildDebugTokenView`（normal path）和 `_buildDebugTokenViewFromProbs`（fast path）：

| 改造项 | 修复前 | 修复后 |
|--------|--------|--------|
| 着色粒度 | word 级 `wordRe` regex | token 级 |
| 位置映射 | 比例公式 | 窗口化 indexOf |
| 多行 token | 无 | `\n` 分段 + `↵` 标记 |
| 显示内容 | `█▓░` 块（无文本） | 原文 / 色块（按 `matched` 标记决定） |
| Stats | Tokens only | Tokens + Lines + Rerank |
| 颜色 | `227` 亮黄 | `215` 柔和黄（与 QRRanker 一致） |

**Step 4：BOS/EOS 偏移修复**

调试日志发现所有 chunk 的 `tokenTexts.length = precomputedProbs.length - 1`：

```
[LlamaCppHighlight] Heatmap fast: tokens=296, hasTexts=false, txtLen=295
```

根因：`getEmbeddingsForTokens(input)` 自动添加 BOS token（`<s>`），`model.tokenize(input)` 不添加。

修复：4 个函数统一做 BOS/EOS 补齐：

```typescript
// Normalize tokenTexts length: getEmbeddingsForTokens may add BOS/EOS
let hasTexts = false;
if (tokenTexts && tokenTexts.length >= totalTokens - 2 && tokenTexts.length < totalTokens) {
  const pad = totalTokens - tokenTexts.length;
  tokenTexts = [...Array(pad).fill(''), ...tokenTexts];
  hasTexts = true;
} else {
  hasTexts = !!(tokenTexts && tokenTexts.length === totalTokens);
}
```

**Step 5：`matched` 标记区分精确匹配 vs 降级**

XLM-RoBERTa 的 `detokenize()` 丢前导空格和部分字符（`def`→`f`、`#`→空），`indexOf` 在大量 token 上失败，残文直接显示导致视觉错乱。

修复：渲染分支按 `matched` 标记决定策略：

```typescript
let matched = false;
const idx = input.indexOf(text, searchFrom);
if (idx >= 0 && idx < searchTo) {
  matched = true;
  // ...
}

// 渲染分支
if (hasTexts && matched && /\r?\n/.test(text)) {
  // 多行分段 + ↵
} else if (hasTexts && matched && text.length > 0) {
  // 精确匹配 → 显示原文（纯空白 → ░）
} else if (score > 0 || (hasTexts && tokenLen > 0)) {
  // indexOf 失败/空文本 → 比例色块（空格/换行/缺字符统一用有色 █▓░）
}
```

**效果对比：**

修复前（无 `matched`）：`  self.session = session` → 显示残缺 `session = session`（丢 `self.` 和 `  `）

修复后（有 `matched`）：`  self.session = session` → 显示 `████session = session`（丢字符位置用 `█` 块，空格用 `░` 块）

### 函数改动汇总

| 文件 | 函数 | 改动 |
|------|------|------|
| `rerankers/semantic-highlight.ts` | `rerank()` | 新增 `tokenize` + `detokenize` 产出 token texts 到 payload |
| `highlighters/semantic-highlight.ts` | `_aggregatePrecomputedProbsToLines` | 新增 `tokenTexts` 参数；比例映射 → 窗口化 indexOf + BOS 补齐 |
| 同上 | `_aggregateTokensToLines` | 新增 `model.tokenize(input)` 获取 token 文本；比例映射 → 窗口化 indexOf + BOS 补齐 |
| 同上 | `_buildDebugTokenView` | word 级 regex → token 级着色；窗口化 indexOf + `matched` 标记；多行分段；Stats 新增 Lines 行 |
| 同上 | `_buildDebugTokenViewFromProbs` | 同上；新增 `tokenTexts` / `chunkScore` 参数；BOS/EOS 补齐；Stats 新增 `Rerank:` 行 |
| 同上 | `scoreRatioToAnsiFg` / `scoreToAnsiFg` | 颜色 `227`→`215`，与 QRRanker 色阶一致 |
| 同上 | `highlight()` (fast path) | 显式提取新字段并向下传递 |
| `interfaces/highlighter.ts` | `HighlightOptions` | 新增 `_semanticHighlightTokenTexts`、`_semanticHighlightInput`、`_semanticHighlightChunkScore` |
| `search-service.ts` | `searchIndex()` | 补全 semantic-highlight 预计算字段转发（参照 QRRanker 模式） |

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-05-22 | 初始文档，记录全部修复过程 |
| v2 | 2026-05-22 | **根因修复**：`getEmbeddingsForTokens` 实际只加 BOS（差 1），非 BOS+EOS（差 2）。手动用 API 加 BOS+EOS 导致 tokenTexts 比 probs 多 1 → `hasTexts=false`。改为**差值对齐**：`diff = probs.length - tokenize.length`，直接按 diff 补空字符串，不依赖 BOS/EOS API。reranker + normal path highlighter 统一使用此方案 |


### v2 代码变更（2026-05-22）

#### 问题定位

运行时诊断发现 `hasTexts=false`：

```
[diag] hasTexts=false  txtLen=297/296  indexOf-matched=0/296
```

`tokenTexts` 比 `probs` 多 1 个。添加 reranker 日志：

```
rawTokenize=504 probs=505 shouldPrependBos=true shouldAppendEos=true
```

**关键发现：** `getEmbeddingsForTokens(input)` 实际只加了 BOS（505 = 504 + 1），没有加 EOS。但 v1 的 BOS/EOS 镜像代码同时加了两个 → tokenTexts 长度变成 506，比 probs(505) 多 1 → normalization 条件 `txtLen < totalTokens` 为 false，且严格相等也不满足 → `hasTexts=false`。

#### 根因

`getEmbeddingsForTokens` 内部的 EOS 检测是 `resolvedInput.at(-1) !== endToken`，对于 XLM-RoBERTa 的特定输入格式，可能已存在等效 token 而不追加。而 `model.tokens.shouldAppendEosToken` API 返回 `true` 只是配置值，不代表运行时实际行为。

#### 修复方案：差值对齐

不再手动检测 BOS/EOS，直接用两者长度差值补齐：

**reranker**（`rerank()`）：

```typescript
// 修复前：手动 BOS/EOS 检测
const tokenIds = this._model!.tokenize(input);
const tokens = this._model!.tokens;
const bosAdded = tokens.shouldPrependBosToken && tokens.bos != null;
const eosAdded = tokens.shouldAppendEosToken && tokens.eos != null;
if (bosAdded) tokenIds.unshift(tokens.bos!);
if (eosAdded) tokenIds.push(tokens.eos!);
const tokenTexts = tokenIds.map((id, i) => {
  if ((i === 0 && bosAdded) || (i === tokenIds.length - 1 && eosAdded)) return "";
  return this._model!.detokenize([id]);
});

// 修复后：差值对齐
const rawIds = this._model!.tokenize(input);
const rawTexts = rawIds.map((id) => this._model!.detokenize([id]));
const diff = tokenProbs.length - rawTexts.length;  // 通常是 1（BOS）
const tokenTexts = diff > 0
  ? [...Array(diff).fill(""), ...rawTexts]
  : rawTexts;
```

**highlighter**（新增 `_tokenizeAlignedWithEmbeddings`）：

```typescript
// 修复前：手动 BOS/EOS mirror + 逐个 detokenize 判空
private _tokenizeAlignedWithEmbeddings(input: string): string[] {
  const baseIds = this._model.tokenize(input);
  const tokens = this._model.tokens;
  let allIds = [...baseIds];
  let bosAdded = false, eosAdded = false;
  if (tokens.shouldPrependBosToken && tokens.bos != null) {
    allIds = [tokens.bos, ...baseIds]; bosAdded = true;
  }
  if (tokens.shouldAppendEosToken && tokens.eos != null) {
    allIds.push(tokens.eos); eosAdded = true;
  }
  return allIds.map((id, i) => {
    if ((i === 0 && bosAdded) || (i === allIds.length - 1 && eosAdded)) return "";
    return this._model!.detokenize([id]);
  });
}

// 修复后：差值对齐
private _tokenizeAlignedWithEmbeddings(input: string, targetLen: number): string[] {
  const rawIds = this._model.tokenize(input);
  const rawTexts = rawIds.map((id) => this._model!.detokenize([id]));
  const diff = targetLen - rawTexts.length;  // 通常是 1（BOS）
  return diff > 0
    ? [...Array(diff).fill(""), ...rawTexts]
    : rawTexts;
}
```

**调用点更新**（`_aggregateTokensToLines` / `_buildDebugTokenView`）：

```typescript
// 修复前
const tokenTexts = this._tokenizeAlignedWithEmbeddings(input)

// 修复后
const tokenTexts = this._tokenizeAlignedWithEmbeddings(input, totalTokens)
```

#### 函数变更汇总

| 文件 | 函数 | 改动 |
|------|------|------|
| `rerankers/semantic-highlight.ts` | `rerank()` | 移除手动 BOS/EOS 检测（-15 行）→ `diff = tokenProbs.length - rawTexts.length` 补齐（+5 行） |
| `highlighters/semantic-highlight.ts` | `_tokenizeAlignedWithEmbeddings` | 新增参数 `targetLen`；BOS/EOS 镜像（25 行）→ 差值补齐（8 行） |
| 同上 | `_aggregateTokensToLines` | 传 `totalTokens` 给 `_tokenizeAlignedWithEmbeddings` |
| 同上 | `_buildDebugTokenView` | 同上 |

#### 验证

```
[diag] hasTexts=true  txtLen=296/296  indexOf-matched=293/296   ← 对齐 ✅
```

| chunk | probs | txtLen | 对齐 | matched |
|-------|-------|--------|------|---------|
| L30-67 | 296 | 296 | ✅ | 293/296 (99.0%) |
| L538-554 | 311 | 311 | ✅ | 305/311 (98.1%) |
| L984-1010 | 505 | 505 | ✅ | 256/505 (50.7%, docstring) |
| L1012-1033 | 549 | 549 | ✅ | 547/549 (99.6%) |

L31 热力图对比：

```
修复前: █████████████████████████████████████████████████████████████████████
修复后:   A base class for implementing YOLO models, unifying APIs across different model types.
```

#### 降级案例：已知限制的实际表现

**案例 1：自然语言文本不匹配**（L745-759，docstring 区域）

```
原始:  "data configuration file." / "Number of training epochs." / "batch size for training."
输出:
   755 ░░░░░░░░░░ 0.001487 │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ data▓▓▓ configuration file.▓▓
   756 ░░░░░░░░░░ 0.001258 │  ▓▓▓▓▓▓▓▓▓▓▓▓ Number of training epochs.▓▓▓▓
   757 ░░░░░░░░░░ 0.000997 │  ▓▓▓░░░░▓▓░░░░░░░░░ch▓▓▓▓▓▓▓▓▓ training.░░░g░░
   758 ░░░░░░░░░░ 0.000849 │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
   759 ░░░░░░░░░░ 0.000994 │  ░░░░░░░░░░░░▓▓▓ (e░▓▓▓░░░░░░░░░░c▓▓▓▓▓▓▓▓▓▓▓▓▓ (░░░░░░░░░░░░▓▓▓░░░░░░░
```

- `data`、`Number`、`training` 个别 token 匹配显示原文
- `"epochs"` → detokenize= `"epoch"` + `"s"` → indexOf 找不到原文的 `"epochs"` → ▓
- L758-759 几乎全军覆没，是 SentencePiece 子词碎片的极端案例

**案例 2：行前空格和行尾换行丢失**（L35、L42-43，代码行）

```
原始:  "      loaded from local files, Ultralytics HUB, or Triton Server."
       "          ckpt (Dict): The checkpoint data..."
       "          cfg (str): The configuration..."
输出:
    35 ░░░░░░░░░░ 0.004350 │   loaded from local files, Ultralytics░HUB, or Triton Server.
    42 ░░░░░░░░░░ 0.000759 │  ░ckpt (Dict): The checkpoint data if the model is loaded from a *.pt file.
    43 ░░░░░░░░░░ 0.000209 │  ░cfg (str): The configuration of the model if loaded from a *.yaml file.
```

- `"Ultralytics HUB"` 空格消失 → `"Ultralytics░HUB"`（detokenize 丢前导空格）
- `"          ckpt"` 前导空格 + `"ckpt"` 前导 `"c"` 丢失 → `"░ckpt"`
- 每行末尾 `
` 不显示（detokenize 丢弃）

## 总结

semantic-highlight debug 热力图经过两轮修复：

| 版本 | 问题 | 修复 |
|------|------|------|
| v1 | 比例映射偏移、多行 token 压缩、数据传参缺失 | 窗口化 indexOf + 多行分段 + payload 补全 |
| v2 | BOS/EOS 检测不准导致 `hasTexts=false` | 差值对齐，不依赖 BOS/EOS API |

**最终方案：** 核心逻辑 `tokenProbs.length - model.tokenize(input).length`，差几个补几个空字符串。简洁、不依赖 API 行为差异，reranker 和 normal path 统一。

**已知限制：**

1. **自然语言文本不匹配** — SentencePiece 把英文单词切成子词碎片（`"epochs"` → `["epoch", "s"]`），逐个 detokenize 后 indexOf("epoch") 找不到原文的 "epochs" → 大量 ▓ 色块。代码符号（def、trainer）分词粒度粗，匹配率高；docstring/注释（自然语言）被切碎，匹配率低。Qwen tokenizer（QRRanker）无此问题。

2. **行前空格和行尾换行不显示** — detokenize([id]) 丢弃前导空格和 
。matched=true 的 token 显示脱敏文本（无空格前缀）；matched=false 的空白 token 降级为比例色块，无法体现空白字符。根因同 #1，是 SentencePiece 固有问题。

3. **indexOf 失败的 token** 以比例色块（█▓░）显示，位置 ±5 字符内准确。

**参考：**
- QRRanker 修复文档：`docs/plans/260522-bpe-detokenize-limitation.md`
- semantic-highlight 统一文档：`docs/plans/260521-semantic-highlight-unified.md`
- semantic-highlight highlighter：`src/code-index/highlighters/semantic-highlight.ts`
- semantic-highlight reranker：`src/code-index/rerankers/semantic-highlight.ts`