# 260607-llamacpp-summarizer-fix

## 主题/需求

修复 `codebase outline --summarize` 命令中 LlamaCPP 摘要生成器的两个问题：

1. **"No sequences left" 错误** — 并发 batch 处理时 sequence slot 耗尽，导致所有代码块摘要生成失败
2. **"Expected ',' or '}' after property value in JSON" 错误** — MiniCPM-V 模型输出非法 JSON（多余 `]` 或尾部 `"`），导致 JSON 解析失败

预期成果：所有 batch 的摘要都能成功生成，无需重试或回退到单个处理。

## 代码背景

- **主文件**：`src/code-index/summarizers/llamacpp.ts`
- **调用链**：`outline.ts` → `generateSummariesWithRetry()` → `LlamaCppSummarizer.summarizeBatch()`
- **底层依赖**：`@realtimex/node-llama-cpp` 库的 `LlamaModel.createContext()` / `LlamaContext.getSequence()`
- **模型配置**（`autodev-config.json`）：
  - `summarizerProvider: "llamacpp"`
  - `summarizerLlamaCppModelPath: "MiniCPM-V-4_6-Q8_0.gguf"`（视觉多模态模型）
  - `summarizerBatchSize: 2`, `summarizerConcurrency: 2`
- **核心类**：`LlamaCppSummarizer` 使用 `QwenChatWrapper` 生成会话，每次创建 `LlamaChatSession` 进行 prompt

## 运行现象

### 现象 1：No sequences left

```
WARN  Batch 2 failed (attempt 1/3): No sequences left. Retrying in 1000ms...
WARN  Batch 2 failed after 3 attempts. Falling back to individual processing...
WARN  Failed to summarize method loadConfig: No sequences left
...
```

11 个代码块分成 6 个 batch（batch size=2），并发 2。几乎全部 batch 失败，最终所有摘要显示 `[Summary failed: No sequences left]`。

### 现象 2：JSON 解析错误

```
WARN  Batch 5 failed (attempt 1/3): Expected ',' or '}' after property value in JSON at position 273 (line 1 column 274)
```

每次触发时 position 273 固定不变，说明模型输出是一致的非法 JSON。重试 3 次后回退到单个处理，单个处理成功（摘要能生成）。

## 归因分析

### 问题 1：Sequence 泄漏 + 并发冲突

`@realtimex/node-llama-cpp` 的 `LlamaContext` 默认只有 **1 个 sequence slot**（`getDefaultContextSequences()` 返回 1）。

`LlamaCppSummarizer._ensureContexts()` 创建了 `_concurrency`（=2）个 context 对象，但：

1. **Sequence 泄漏**：`context.getSequence()` 从池中取出 slot，但从未调用 `sequence.dispose()` 归还。JavaScript `FinalizationRegistry` 在 GC 时才会回收，但不及时。
2. **并发冲突**：同时运行的 batch 都通过 `request.blocks.length % contexts.length` 选中同一个 context（batchSize=2, contexts=2 → `2 % 2 = 0` → 总命中 Context 0），而 Context 0 只有 1 个 slot。
3. **累积耗尽**：调用一次消耗一个 slot 永不归还，后续所有调用无论哪个 context 都 `No sequences left`。

### 问题 2：模型输出非法 JSON

```
模型输出: {"summaries": ["text1", "text2"]]}
                                         ↑ 多余的 ]
正确:    {"summaries": ["text1", "text2"]}
```

MiniCPM-V-4.6 在处理文本 JSON 格式化时不稳定，偶尔在数组末尾多输出一个 `]` 或在对象末尾添加多余的 `"`。这是**视觉多模态模型**在纯文本任务上的输出质量问题。

原有 `extractCompleteJsonObject` 只跟踪 `{}` 深度，不跟踪 `[]`，因此无法处理多余的 `]`——它会返回 `{...]]}` 包含所有字符，`JSON.parse` 仍失败。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| **Context 创建序列数** | `sequences: this._concurrency` | 每个 context 分配足够 slot 支持并发访问 |
| **Sequence 释放时机** | `try/finally { sequence.dispose() }` | 确保异常路径也能归还 slot |
| **Context 分配策略** | 原子计数器 `_contextIndex++` | 按调用序号轮询，避免所有 batch 打同一个 context |
| **JSON 修复策略** | 逐字重建，跳过多余括号 | `substring` 截取会包含多余字符；逐字重建只保留有效字符 |
| **Fallback 链** | `tryRepairJson` → `extractCompleteJsonObject` | `tryRepairJson` 更强大，保留旧方法做兜底 |

## 实施计划

- [x] 修复 Sequence 泄漏和并发冲突
- [x] 增加 JSON 容错修复
- [x] 添加调试日志定位问题
- [x] 验证修复效果

## 实施记录

### 2026-06-07

**Step 1：修复 Sequence 泄漏**

在 `summarizeBatch()` 中把 `context.getSequence()` 的使用包裹在 `try/finally` 内，确保异常路径也能释放：

```typescript
const sequence = context.getSequence()
try {
  // ... 使用 sequence ...
  return { summaries }
} finally {
  sequence.dispose()
}
```

同时修复 `validateConfiguration()` 中相同的泄漏问题。

**Step 2：修复并发冲突**

创建 context 时指定 `sequences: this._concurrency`（=2），使每个 context 有足够 slot 支持 2 个并发调用。

**Step 3：优化 Context 分配**

添加 `_contextIndex` 计数器，用 `contexts[this._contextIndex++ % contexts.length]` 替代 `contexts[request.blocks.length % contexts.length]`。

**Step 4：添加调试日志**

两次添加 `console.error` 打印模型原始输出以排查 JSON 解析失败原因。第一次使用 `this.logger?.warn` 但消息未出现在输出中（logger 未正确传递或级别过滤），后续改用 `console.error` 成功捕获。

**Step 5：修复 JSON 解析**

第一次 `tryRepairJson` 实现使用 `lastValidEnd + substring` 方式，但 substring 会包含 `{` 和 `}` 之间的所有字符（包括多余的 `]`）。

第二次改为**逐字重建**：遍历字符时只将有效括号字符加入 `result`，遇到多余的 `]` 直接跳过。经 `node -e` 测试验证三种场景：

- `{"summaries": ["text1", "text2"]]}` → 修复成功 ✅
- `{"summaries": ["text1", "text2"]}"` → 修复成功 ✅
- `{"summaries": ["text1", "text2"]}` → 正常通过 ✅

## 修订记录

### 2026-06-07
**问题：** `git checkout` 误操作将所有修复回退到原始状态
**修复：** 重新通过 `write_file` 一次性写入完整修复文件

### 2026-06-07
**问题：** 第一次 `tryRepairJson` 使用 `substring` 截取，包含多余字符
**修复：** 改为逐字重建方式，只保留有效括号

## 后续调查 (260608) — 根本修复

### 发现: 之前的归因部分错误

260608 调查发现 `docs/plans/260608-no-sequences-left-root-cause.md` 中详述:

1. **不是 "Sequence 泄漏"**: 原 260607 误以为 "未调 dispose 导致 slot 永不归还" 是根因. 实际上
   `LlamaContextSequence.dispose()` 会通过 FinalizationRegistry 调 `_reclaimUnusedSequenceId`,
   GC 后也能归还. 实际问题是 `await sequence.dispose()` 不等归还完成.

2. **不是 "并发选同一个 context"**: 实际只有一个 context (`_ensureContexts` 只创建一个),
   `request.blocks.length % contexts.length` 优化是多余的.

3. **真正根因**: `_reclaimUnusedSequenceId` 内部 `void withLock(...)` 是 fire-and-forget.
   `await sequence.dispose()` 返回时 push 到 `_unusedSequenceIds` 还在 microtask 里.
   下一次并发 `getSequence()` 同步读 unused 看到空, nextGen 已到上限 → "No sequences left".
   锁源是 `dispatchPendingBatch` (同一个 context 锁 scope, `await decodeBatch` 是 libuv worker).

4. **`sequences = concurrency * 2` 冱底是治标不治本**: 增量 slot 能缓解但浪费内存,
   根本上是库层面的 fire-and-forget 锁问题.

### 根本修复: 方案 D — 池化 sequence

修改 `src/code-index/summarizers/llamacpp.ts`:

- 一次性从 context 拿 `_sequences` 个 sequence, 永久持有 (`_sequencePool`)
- `summarizeBatch` 从池中轮询借, `clearHistory` 重置 KV cache, **不调 dispose**
- `dispose()` 关闭时统一释放
- `_sequences` 默认从 `concurrency * 2` 改为 `concurrency` (1:1, 不再需要冱底)

修改 `src/code-index/service-factory.ts`: 传递 `sequences` 参数 (默认 = 并发数).

### 验证结果

- `npm run type-check` 干净
- `npm run test` 125 个测试文件 1238 个测试全部通过
- 原始 6 个并发调用: 全部不再出现 "No sequences left"
- 4 轮并发×2 (sequences=1/2/4) 全部成功

详见 `docs/plans/260608-no-sequences-left-root-cause.md` 的完整证据链.

## 总结

### 关键收获

1. **`@realtimex/node-llama-cpp` 的内存管理**: `getSequence()` 取得的 slot 需要被 `dispose()` 归还,
   但 260608 调查发现 `await dispose()` 不等归还完成. 池化方案是避开的根本方式.
2. **模型选型影响**: MiniCPM-V (视觉多模态) 在纯文本 JSON 格式化任务上不稳定; 纯文本模型 (如 Qwen) 更适合此场景.
3. **JSON 修复策略**: 对 LLM 输出的 JSON 应有多种 fallback 策略, 且需要正确处理括号嵌套.

### 后续优化建议

1. 换用纯文本 GGUF 模型 (如 Qwen3.5-0.8B) 可以彻底避免 JSON 格式化问题
2. 可考虑引入更通用的 JSON 修复库 (如 `jsonrepair`), 处理更多边缘情况
3. 长远看应支持模型热切换, 无需修改配置文件
4. **向 `node-llama-cpp` 提 PR**: 让 `_reclaimUnusedSequenceId` 返回 Promise, 或让
   `dispose()` await 内部 withLock 完成, 避免用户踩同样的坑
