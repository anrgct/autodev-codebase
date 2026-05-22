# 260522-bpe-detokenize-limitation

## 主题/需求

debug 热力图中逐 token 渲染的文本与原始 codeChunk 空白/换行位置不对齐，视觉效果错乱。定位根因并修复。

### 结论：已修复

两个独立根因：

1. **多行 token 压缩到单行** — BPE token 文本含换行符时，整段被 break 压到一行，用 ↵ 标记换行
2. **位置映射不精确** — 字符长度比例映射公式依赖逐个 detokenize 字符长度，但 detokenize([单个id]) 可能增删前导空格

### 背景

QRRanker highlighter 的 precomputed 路径中，reranker 对 code 区域 token 逐个 `model.detokenize([id])` 得到文本，传给 highlighter 做逐 token 着色渲染。

### 目标

- 确认问题是否可修复 → 已修复
- 修复方案见"实施记录 > 最终修复"

### 验证方式

**猜测原因实验：**

```bash
# 逐个 vs 全量 detokenize 对比（覆盖 XLM-RoBERTa / MiniCPM / Qwen 四种模型）
npx tsx src/examples/bpe-detokenize-bug.ts
```

**热力图偏移复现：**

配置 `demo/autodev-config.json`：

```json
"rerankerProvider": "qrranker",
"rerankerGgufPath": "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf",
"highlighterProvider": "qrranker",
"highlighterGgufQrrankerPath": "/Users/anrgct/workspace/open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf", //无效，实际使用reranker传入的预计算数据
```

运行：

```bash
npx tsx src/cli.ts search "where is the train method" --demo --debug-highlight --log-level=debug 2>/dev/null | grep -A20 '"model.py" (L538-554)'
```

输出：

```
[Debug Highlight] "model.py" (L538-554)
═══ Token Attention Heatmap ═══
   538 ██████████ 0.000303 │   x in ARGV for x in ("predict", "track", "mode=predict", "mode=track")↵░░░░░░░ )↵↵
   539 █████████░ 0.000284 │  ░░░░░░░ custom
   540 ░░░░░░░░░░ 0.000000 │
   541 █████░░░░░ 0.000161 │   = {"conf":░0.25, "batch":░1, "save": is_cli, "mode": "predict"}░ # method defaults↵░░░░░░░ args
   542 ████░░░░░░ 0.000108 │   = {**self.overrides, **custom, **kwargs}░ # highest priority args on the right↵░░░░░░░ prompts
   543 ██░░░░░░░░ 0.000074 │   = args.pop("prompts", None)░ # for SAM-type models↵↵░░░░░░░ if
   544 ░░░░░░░░░░ 0.000000 │
   545 ████░░░░░░ 0.000133 │   not self.predictor:↵░░░░░░░░░░░
   546 ███░░░░░░░ 0.000101 │   self.predictor = (predictor or self._smart_load("predictor"))(overrides=args, _callbacks=self.callbacks)↵░░░░░░░░░░░
   547 █░░░░░░░░░ 0.000044 │   self.predictor.setup_model(model=self.model, verbose=is_cli)↵░░░░░░░
   548 ███░░░░░░░ 0.000079 │   else:░ # only update args if predictor is already setup↵░░░░░░░░░░░
   549 █████░░░░░ 0.000145 │   self.predictor.args = get_cfg(self.predictor.args, args)↵░░░░░░░░░░░
   550 ██░░░░░░░░ 0.000051 │   if "project" in args or "name" in args:↵░░░░░░░░░░░░░░░
   551 █░░░░░░░░░ 0.000045 │   self.predictor.save_dir = get_save_dir(self.predictor.args)↵░░░░░░░
   552 ███░░░░░░░ 0.000101 │   if prompts and hasattr(self.predictor, "set_prompts"):░ # for SAM-type models↵░░░░░░░░░░░
   553 █░░░░░░░░░ 0.000037 │   self.predictor.set_prompts(prompts)↵░░░░░░░
   554 ██████░░░░ 0.000167 │   return self.predictor.predict_cli(source=source) if is_cli else self.predictor(source=source, stream=stream)↵↵
```

每一个 `↵` 和 `░░░` 都是本该在下一行/右边显示的内容，被挤到了本行末尾。

修复后输出（完全对齐原文）：

```
   538 |   x in ARGV for x in ("predict", "track", "mode=predict", "mode=track")
   539 |  ░░░░░░░ )
   540 |
   541 |  ░░░░░░░ custom = {"conf":0.25, ...
```

## 代码背景

### 关键文件

| 文件 | 职责 |
|------|------|
| `rerankers/qrranker.ts` | `_rerankBatch()` 末尾 `codeTokenIds.map(id => model.detokenize([id]))` 产出预 detokenize 文本 (qrranker.QRRankerReranker._rerankBatch:393) |
| `highlighters/qrranker.ts` | `buildTokenHeatmapFromTexts()` 使用预 detokenize 文本渲染热力图 (QRRankerHighlighter.highlight:647) |
| `highlighters/qrranker.ts` | `buildTokenHeatmap()` 非 precomputed 路径同样逐个 detokenize (buildTokenHeatmap:101) |

### 数据流

```text-chart
reranker._rerankBatch()
  │
  ├─ evaluateWithoutGeneratingNewTokens → kq_soft_max
  ├─ computeQRScores → perChunkTokenScores
  ├─ 定位 code 区域 token IDs
  └─ model.detokenize([id]) × N → _qrrankerTokenTexts: string[]
       │
       ↓ payload 传递
       │
highlighter.highlight() → buildTokenHeatmapFromTexts()
  └─ 累计字符长度定位 + 逐 token 着色
```

## 关键决策

- **已修复**，非已知限制
- 修复范围：
  - 渲染路径：`buildTokenHeatmap` + `buildTokenHeatmapFromTexts`（多行分段 + 窗口化 indexOf）
  - 评分路径：`tokensToLines` + `_mapPrecomputedToLines`（窗口化 indexOf）
- 修复前评分路径在用比例映射（`tokensToLines` 用字符长度比，`_mapPrecomputedToLines` 用 token 索引比），导致空白行错误继承跨行 BPE token 的高分
- XLM-RoBERTa：`indexOf` 查找失败时降级，不崩溃但位置可能不够精确


## 实施记录

### 2026-05-22

**初始假设：** "逐个 detokenize 拼接 ≠ 全文 detokenize"，类似 Python `[tokenizer.decode([id]) for id in ids]` ≠ `tokenizer.decode(ids)`。

**实测结果：**

```bash
# QRRanker-q8_0 (Qwen tokenizer)
$ npx tsx src/examples/bpe-detokenize-bug.ts /path/to/QRRanker-q8_0.gguf
Group detok vs original match: true   ← 完全一致

# Qwen3-Reranker-0.6B (Qwen tokenizer)
Group detok vs original match: true   ← 完全一致

# semantic-highlight (XLM-RoBERTa tokenizer)
Group detok vs original match: false  ← 丢 \n
Original:     "    def train(\n        \"\"\"doc\"\"\"\n"
Detokenized:  " def train( \"\"\"doc\"\"\""
```

**结论修正：** 不是"逐个 vs 全量"的问题——两种方式结果一致。根因是 XLM-RoBERTa tokenizer 的 `detokenize()` 丢弃换行符，Qwen tokenizer 完整保留。

**影响范围：** 所有模型的 debug 热力图逐 token 渲染均受影响（两个根因对所有 tokenizer 都触发）。bar 分数和行级选择不受影响（使用独立的 `tokensToLines` / `_mapPrecomputedToLines` 路径）。

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-05-22 | 初始文档，"逐个 vs 全量"假设 |
| v2 | 2026-05-22 | 实测修正：根因是 XLM-RoBERTa 丢 `\n`，非逐个/全量差异 |
| v3 | 2026-05-22 | MiniCPM-V-4.6 补测：detokenize 保留 `\n`，原文匹配。热力图错乱根因改为累计字符长度偏差 |
| v4 | 2026-05-22 | **最终修复**：定位两个独立根因（多行 token 压缩 + 位置映射不精确），均已修复 |
| v5 | 2026-05-22 | 评分路径同步修复：`tokensToLines` 和 `_mapPrecomputedToLines` 改用窗口化 indexOf |

### 2026-05-22（MiniCPM 实测修正）

**补测结果：** MiniCPM-V-4.6（Qwen tokenizer）`detokenize()` 完整保留 `\n`，`detokenize([全部token]) === 原文`。但热力图仍然错乱 — 说明问题不在 detokenize 输出内容本身。详见下方"最终修复"。

### 2026-05-22（最终修复）

**修正：两个独立根因，均已修复。**

**根因 1：多行 token 压缩到单行**

`break` 把含换行符的 BPE token 整段文本压到一行，用 `↵` 标记。修复：按换行符分段，逐段分配到连续行。

**根因 2：位置映射公式不可靠**

原公式 `(detokAcc / totalDetokLen) * codeChars` 假设逐个 detokenize 字符总长等于原文。实测即使 Qwen tokenizer 下 `detokenize([全部id]) === 原文`，`sum(detokenize([单个id]).length)` 仍可能与 `codeChars` 有偏差（BPE 边界前导空格差异），导致 `codePos` 为浮点数而非精确整数：

```
// 实测
codePos=70.58659217877096  // 应为 70
codePos=71.59497206703911  // 应为 71
```

修复：窗口化 `indexOf` 精确查找。

- 尝试 1：全量 `indexOf` → 高频子串（逗号、`trainer` 等）在原文其他位置重复出现，匹配到错误位置
- 尝试 2：纯 `detokAcc` → 无缩放累积漂移，长文档偏移越来越大
- 最终方案：**窗口化 `indexOf`** — `detokAcc` 提供近似位置作为搜索起点，`indexOf(text, searchFrom)` 在 ±5 字符窄窗口内精确匹配，命中后 `detokAcc` 同步为精确位置，消除累积漂移

```typescript
// 最终方案
let detokAcc = 0;
for (let ti = 0; ti < totalTokens; ti++) {
  const text = texts[ti];
  let codePos: number;
  if (text.length > 0) {
    const searchFrom = Math.max(0, detokAcc - 5);
    const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
    const idx = codeChunk.indexOf(text, searchFrom);
    if (idx >= 0 && idx < searchTo) {
      codePos = idx;
      detokAcc = idx + text.length;  // 精确同步
    } else {
      codePos = detokAcc;
      detokAcc += text.length;       // 降级：允许漂移
    }
  } else {
    codePos = detokAcc;
  }
  // ... 行匹配 + 多行分段 ...
}
```

**结果：** 热力图与原文逐行对齐，L538-554、L736-777、L1025-1026 均验证通过。`type-check` ✅ | `build` ✅

**补充：评分路径同步修复**

同样的问题也存在于 `tokensToLines`（forward pass）和 `_mapPrecomputedToLines`（precomputed），它们用比例映射为每行计算 bar 分数。修复前空白行会错误继承跨行 BPE token 的高分（如 L1025 显示 0.000239 实际应为 0）。改为窗口化 indexOf 后评分与渲染一致。

## 总结

两个独立根因均已修复：

1. **多行 token 压缩** → 按换行符分段分配到连续行
2. **位置映射不精确** → 窗口化 indexOf 替代比例映射，覆盖渲染路径和评分路径

修复后：
- 热力图与原文逐行对齐，`↵` 标记 BPE 换行边界
- 空白行评分不再错误继承跨行 token 的高分
- `type-check` ✅ | `build` ✅ | L538-554、L736-777、L1025-1026 均验证


**参考：**
- 复现脚本：`src/examples/bpe-detokenize-bug.ts`
- QRRanker highlighter：`src/code-index/highlighters/qrranker.ts`
- QRRanker reranker：`src/code-index/rerankers/qrranker.ts`
