# 260609-llamacpp-prefix-caching

## 主题/需求

为 `LlamaCppSummarizer` 启用 KV cache 复用（prefix caching），让同一文件的多 batch 摘要共享公共前缀，减少重复 token 评估开销。

**验收基线：**
```bash
npm run dev -- outline src/code-index/embedders/llamacpp-llm.ts --summarize --clear-cache --log-level=debug
```
实测基线耗时 **55.40s**。目标：**< 55s**。

**最终结果：方案 F 成功，55.40s → ~20s（2.75x），0 失败。**

---

## 代码背景

**主文件：** `src/code-index/summarizers/llamacpp.ts`

**调用链：** `commands/outline.ts` → 循环调用 `extractOutline` → 每个文件新建 `LlamaCppSummarizer` → `generateSummariesWithRetry` → `summarizeBatch`

**底层依赖：** `@realtimex/node-llama-cpp` v0.163.0
- `LlamaChatSession.prompt()` 内部自动检测 prefix 重叠并复用 KV cache
- `LlamaContextSequence.adaptStateToTokens(tokens)` 抹掉不匹配尾部，保留匹配 prefix
- `sequence.compareContextTokens(tokens)` 返回 `firstDifferentIndex`
- `lastEvaluationContextWindow.minimumOverlapPercentageToPreventContextShift` 默认 0.5（重叠 < 50% 时不重用）

**配置（`autodev-config.json`）：**
- `summarizerProvider: "llamacpp"`
- `summarizerLlamaCppModelPath: MiniCPM-V-4_6-Q8_0.gguf`（视觉多模态模型）
- `summarizerBatchSize: 2`、`summarizerConcurrency: 2`

**目标文件统计（实测）：**
- `src/code-index/embedders/llamacpp-llm.ts` 有 **24 个代码块**
- batchSize=2 → **12 个 batch**
- 单文件 ~9K tokens 文档
- 单 batch prompt ~10K tokens（系统指令 + 文件路径 + shared context + 2 snippets + 输出格式）

## 关键计算：prefix caching 的潜在收益

**原始 batch 结构：**
```
Batch N prompt = [system ~30] + [File: path ~10] + [Shared Context: doc ~9000] + [Snippets N] + [Output format ~100]
                |______________ stable prefix ~9140 tokens ______________|__ variable ~1000 tokens __|
```

- 单 batch prompt ~10K tokens
- 12 个 batch 共享前 ~9K tokens 的稳定 prefix
- 理论 prefix caching 命中率：~90%
- 单 batch prefill 耗时：~5s（10K tokens @ ~2K tokens/s）
- 理论上可节省：11 batches × 5s × 90% = ~50s

---

## 方案 A-E：5 次失败尝试（2026-06-09）

以下 5 次尝试均未达成目标。此处保留记录用于理解失败路径。

### 方案 A：持久 session + 删除 clearHistory

**假设：** 让 chat history 单调累积，库自动复用 prefix cache。

**实施：** 删除 `sequence.clearHistory()`，每个 sequence 绑定持久 session + wrapper，contextSize 32K。

**结果：** `2m31s`（慢 2.8x）。chat history 累积超过 32K → context shift 抹掉 shared context → prefix cache 完全失效。

### 方案 A'：contextSize 提到 64K

**结果：** `4m8s`（慢 4.6x）。12 batch × 10K = 120K，64K 仍不够。

### 方案 B：底层 evaluate + adaptStateToTokens

**假设：** 绕开 chat session，manual 控制 KV cache。

**结果：** `2m10s`（慢 2.4x）。prefix cache 命中了（inEval 从 25K 降到 1K），但 raw `evaluate` 的 generation 阶段缺少 session 内部的批处理优化，且有并发竞争（同一 seq 被两个操作同时使用）。

### 方案 D：eraseContextTokenRanges 跳过 prefix 比对

**结果：** `2m18s`（慢 2.6x）。t_adapt 优化到 1-15ms，但 generation 阶段仍占主导。

### 方案 E：contextSize=128K + 持久 session

**结果：** `3m37s`（慢 4x）。KV cache 分配成本 + 长序列比对成本抵消所有收益，库未触发 prefix cache。

### 五连败后的误判

当时总结的"关键收获"认为：
- prefix caching 天花板太低（prefill 占比 < 25%，generation 占 80%+）
- 底层 API 不可避免的 generation 降速
- 建议放弃 prefix caching 方向

**以上判断均被方案 F 推翻。** 失败原因不是理论上限不够，而是 **API 使用方法不对**——把 shared prefix 放在了 user message 而非 system prompt 中。

---

## 方案 F：system prompt 分离 + setChatHistory 裁剪（✅ 成功）

### 根因分析

回顾方案 A-E 的共同失败路径：

1. **方案 A/A'/E**：prompt 全部塞进 user message → chat history 累积 → 超过 contextSize → context shift → shared context（在 user message 中）被抹掉 → prefix 失效
2. **方案 B/D**：manual KV cache 虽然让 prefix 命中，但：
   - Raw `evaluate` 缺少 session 的生成优化（token prediction 等）
   - 并发竞争（两个操作使用同一 sequence）

关键发现：**`adaptStateToTokens` 在 session 路径中正常工作，不需要手动调用。** 它被 `alignCurrentSequenceStateWithCurrentTokens()` 在每次 `evaluateWithContextShift` 中自动触发。

### 核心洞察

**把 stable prefix 放进 system prompt，variable content 放进 user message。**

```
方案 A (失败):
  [system: "You are helpful"]          ← ~30 tokens
  [user: 指令 + 文档 + snippets1]       ← ~10K  ← shared context 在这里
  [model: response1]
  [user: 指令 + 文档 + snippets2]       ← ~10K  ← 重复但无用
  → 累积 120K → context shift → shared context 被抹

方案 F (成功):
  [system: 指令 + 文档]                 ← ~9K   ← shared context 在这里！
  [user: snippets1]                     ← ~1K
  [model: response1]                    ← ~0.2K
  → setChatHistory([system])            ← 裁剪到 system-only
  [system: 指令 + 文档]                 ← ~9K   ← adaptStateToTokens 匹配!
  [user: snippets2]                     ← ~1K   ← 只 eval 新内容
```

`LlamaChatSession` 的 `systemPrompt` 在 context shift 时会被保留。将 ~9K shared context 放入 system prompt 后：

- KV cache 恒定 ~10.2K（system 9K + user 1K + model 0.2K），**永不触发 context shift**
- `alignCurrentSequenceStateWithCurrentTokens` 中的 `adaptStateToTokens` 自动检测 system prompt 匹配，只 evaluate 新 user tokens
- `setChatHistory` 清除 `_lastEvaluation` 不影响 prefix 检测——`adaptStateToTokens` 在 `alignCurrentSequenceStateWithCurrentTokens` 中独立于 `_lastEvaluation` 工作
- session 保持不变 → generation 速度不受影响

### 实施

**文件：** `src/code-index/summarizers/llamacpp.ts`

改动要点：

| 改动 | 说明 |
|------|------|
| `buildPrompt` → `buildSystemPrompt` + `buildUserPrompt` | 拆分为稳定前缀（指令+文件路径+shared document）和可变内容（snippets+输出格式） |
| `_fileSession` 文件级 session | session 按 filePath 复用，同一文件所有 batch 共享一个 sequence |
| 删除 per-batch `clearHistory()` | 只在新建文件 session 时清一次 KV cache |
| `setChatHistory([system])` 每 batch 后 | 裁剪 chat history 到 system-only，防止累积超 contextSize |
| `_batchChain` 串行化 | 同一 sequence 的 batch 必须顺序执行，并发调用自动排队 |
| `systemOnlyHistory` snapshot | 用 `session.getChatHistory()` 保存初始 system message，确保 `text` 格式匹配 `generateInitialChatHistory` 输出 |

### 实测结果

```
$ time npm run dev -- outline src/code-index/embedders/llamacpp-llm.ts --summarize --clear-cache --log-level=debug

Processing 24 blocks in 12 batches (batch size: 2, concurrency: 2, max retries: 3)
Progress: 5/12 batches completed
Progress: 10/12 batches completed
Progress: 12/12 batches completed

real    ~20s    (vs 基线 55.40s, 2.75x 提升)
```

**所有 12 个 batch 一次性成功，0 重试 0 失败。**

| 指标 | 基线 | 方案 F | 提升 |
|------|------|--------|------|
| 总耗时 | 55.40s | ~20s | **2.75x** |
| batch 失败 | 0 | **0** | - |
| KV cache 大小 | 每次重建 | 恒定 ~10.2K | - |
| context shift | 无（基线每次都重建） | **永不触发** | - |

### MiniCPM-V 智能引号问题

初版方案 F 出现 batch 7 连续 3 次 JSON 解析失败，走 fallback individual processing。调试发现：

```
模型输出: {"summary":"...表示。"}       ← " 是 U+201D (RIGHT DOUBLE QUOTATION MARK)
JSON期望: {"summary":"...表示。"}       ← 需要 U+0022 (ASCII QUOTATION MARK)
```

MiniCPM-V 在中文摘要以 `。` 结尾时，会输出中文右引号 `"` (U+201D) 替代 ASCII `"` (U+0022) 作为 JSON 字符串闭合引号。修复：在 JSON 解析前做引号归一化：

```typescript
const normalizedText = responseText
  .replace(/[\u201c\u201d]/g, '"')   // left/right double quotes → ASCII
  .replace(/[\u2018\u2019]/g, "'")   // left/right single quotes → ASCII
```

该修复不依赖 `tryRepairJson`/`extractCompleteJsonObject` 兜底，从源头消除了解析失败。

---

## 关键收获

### 1. prefix caching 的正确打开方式

不是手动调 `adaptStateToTokens`，不是绕开 session，不是增大 contextSize。而是：

> **把 shared prefix 放进 system prompt，让 session 内部的 `alignCurrentSequenceStateWithCurrentTokens` 自动处理 KV cache 对齐。**

`getContextWindow` 中基于 `_lastEvaluation` 的 prefix 检测只是一个优化——跳过重新格式化 chat history。真正的 KV cache 对齐在 `alignCurrentSequenceStateWithCurrentTokens` 中，它独立于 `_lastEvaluation` 工作。

### 2. `setChatHistory` 清除 `_lastEvaluation` 不影响 prefix caching

`setChatHistory` 会将 `_lastEvaluation` 置为 `undefined` 且 `_canUseContextWindowForCompletion` 置为 `false`。这导致下一次 `session.prompt()` 走 `getContextWindow` 的非优化路径——完整格式化 chat history 再 tokenize（开销 < 几 ms）。但 `alignCurrentSequenceStateWithCurrentTokens` 中的 `adaptStateToTokens` 仍会正确检测 KV cache 中的 system prompt 前缀并只 evaluate 新 tokens。

### 3. 方案 A-E 失败的根本原因

不是 prefix caching 的"天花板低"，不是 generation 不可优化，不是库的 API 不足。而是 **shared context (~9K tokens) 被放在了 user message 中，每次 context shift 都会被抹掉**。

将 shared context 移到 system prompt 后：
- KV cache 恒定 ~10.2K（远 < 32K contextSize）
- 永不触发 context shift
- prefix 命中率 ~90%
- 保留了 session 的全部生成优化

### 4. 并发模型变化

方案 F 将同一文件的 batch 串行化（共享 sequence），而非之前的并行（不同 sequence 独立跑）。由于 prefix cache 消除了 ~90% 的 prefill 开销，串行化的整体吞吐量反而高于并行无缓存的方案。

---

## 后续可探索方向

### 已验证有效

- [x] **system prompt 分离**：55.40s → ~20s（2.75x）
- [x] **智能引号归一化**：消除 MiniCPM-V 中文输出的 JSON 解析失败

### 可进一步尝试

1. **增大 batchSize**（2 → 4 或 8）：当前 batch 已串行化，增大 batchSize 减少 batch 数量直接减少轮次
2. **换纯文本模型**（如 Qwen3.5-0.8B）：generation 速度 2-3x 提升，在已有 prefix cache 基础上叠加
3. **跨文件 prefix cache**：不同文件的 system instruction 前缀可复用，需将 summarizer 生命周期从 per-file 提升到 per-CLI-call

---

## 修订记录

### 2026-06-09（方案 A）
**问题：** 持久 session + 不调 clearHistory 失败
**原因：** chat history 累积超过 32K contextSize，触发 context shift 抹掉 shared context

### 2026-06-09（方案 A'）
**问题：** 增大 contextSize 到 64K 仍失败
**原因：** 12 batch × 10K = 120K，64K 仍不够

### 2026-06-09（方案 B）
**问题：** 底层 evaluate 命中 prefix cache 但总耗时翻倍
**原因：** raw `evaluate` 缺少 session 生成优化 + 并发竞争

### 2026-06-09（方案 D）
**问题：** 跳过 prefix 比对但总耗时仍翻倍
**原因：** 同上，generation 阶段 + 并发问题

### 2026-06-09（方案 E）
**问题：** contextSize=128K + 持久 session 完全失败
**原因：** KV cache 分配/比对开销，库未触发 prefix cache

### 2026-06-09（最终判定-已推翻）
~~**结果：** 5 次尝试均未达成 < 55s 目标~~
~~**决策：** 不再继续 prefix caching 方向~~

### 2026-06-09（方案 F ✅）
**问题：** 方案 A-E 把 shared context 放在 user message 中，context shift 抹掉 prefix
**方案：** shared context 移入 system prompt + per-batch `setChatHistory([system])` 裁剪 + 智能引号归一化
**结果：** 55.40s → ~20s（**2.75x**），0 失败，0 重试
**关键洞察：** `adaptStateToTokens` 在 `alignCurrentSequenceStateWithCurrentTokens` 中独立于 `_lastEvaluation` 工作，`setChatHistory` 清除 `_lastEvaluation` 不影响 prefix 检测。不需手动调 `adaptStateToTokens`，不需绕开 session，不需增大 contextSize。

---

## 验证命令

```bash
# 基线（修改前）
time npm run dev -- outline src/code-index/embedders/llamacpp-llm.ts --summarize --clear-cache --log-level=info

# 方案 F（当前）
time npm run dev -- outline src/code-index/embedders/llamacpp-llm.ts --summarize --clear-cache --log-level=debug
```

## 参考资料

- `node-llama-cpp` 源码：`/Users/anrgct/workspace/node-llama-cpp-therealtimex`
- `alignCurrentSequenceStateWithCurrentTokens`：`src/evaluator/LlamaChat/LlamaChat.ts:3180` — 内部调用 `adaptStateToTokens`，真正的 prefix 对齐位置
- `getContextWindow`：`src/evaluator/LlamaChat/LlamaChat.ts:1471` — 基于 `_lastEvaluation` 的优化（非必需）
- `LlamaChatSession.setChatHistory`：`src/evaluator/LlamaChatSession/LlamaChatSession.ts:1248` — 清除 `_lastEvaluation` 和 `_canUseContextWindowForCompletion`
- `LlamaContextSequence.adaptStateToTokens`：`src/evaluator/LlamaContext/LlamaContext.ts:1264`
- `ChatWrapper.generateInitialChatHistory`：`src/ChatWrapper.ts:285`
- 260607 任务文档：`docs/plans/260607-llamacpp-summarizer-fix.md`
- 260608 根因分析：`docs/plans/260608-no-sequences-left-root-cause.md`
