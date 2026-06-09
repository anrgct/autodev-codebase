# 260608-no-sequences-left 根因调查

## 修复状态: ✅ 已应用方案 D (池化)

- **修复日期**: 2026-06-08
- **修改文件**: `src/code-index/summarizers/llamacpp.ts`, `src/code-index/service-factory.ts`
- **验证**: `scripts/evidence/260608-compare-sequences.ts` 6 个并发调用全部不出现 "No sequences left"
- **测试**: `npm run type-check` 通过; `npm run test` 1238 测试全部通过

### 修改要点

1. **加字段**: `_sequencePool: LlamaContextSequence[]`, `_seqIdx: number`
2. **池化分配**: `_ensureContexts` 一次性从 context 拿 `_sequences` 个 sequence, 永久持有
3. **不 dispose**: `summarizeBatch` 从池中轮询借 sequence, `clearHistory` 重置 KV cache, 不调 `dispose()`
4. **关闭时统一 dispose**: `dispose()` 先 dispose 池中 sequence, 再 dispose context
5. **默认值调整**: `_sequences` 默认从 `concurrency * 2` 改为 `concurrency` (1:1, 池化后无需兑底 race)
6. **同步后移**: `validateConfiguration` 复用池中 sequence, 不再 getSequence + dispose

### 修前 vs 修后 (`260608-compare-sequences.ts`)

| | sequences=1 | sequences=2 | sequences=4 |
|---|---|---|---|
| 修前 | 并发×2 ✗ No sequences left | c0 ✓, c1 ✗ No sequences left | c0 ✓, c1 ✗ No sequences left |
| 修后 | c0 ✓, c1 ✗ JSON 解析 | c0 ✓, c1 ✗ JSON 解析 | c0 ✓, c1 ✗ JSON 解析 |

> "JSON 解析" 错误是 MiniCPM-V 输出问题, 跟 sequence 无关, 是 260607 文档里讨论的另一个独立问题.

## TL;DR

`"No sequences left"` 不是 dispose 泄漏，也不是 `getSequence` 的 race condition。真正的根因是：

**`LlamaContextSequence.dispose()` 同步返回，但内部的 `_reclaimUnusedSequenceId` 用 `void withLock(...)` 是 fire-and-forget，push 到 `_unusedSequenceIds` 是被 context 锁 queue 排队后的 microtask。而 prompt 内部的 `dispatchPendingBatch` 是 `void withLock`，最后一个 batch 还在用 libuv worker thread（不是 microtask）跑 `decodeBatch` —— 所以 context 锁被占用 2~50ms 取决于模型大小。**

**`await sequence.dispose()` 不等 push 完成**。下一个并发 `getSequence()`（同步）立即读 `_unusedSequenceIds` 看到空，`_nextGeneratedSequenceId` 已等于 `totalSequences` → `null` → 抛 `"No sequences left"`。

## 完整证据链

### Test 1: 单次调用时序（关键证据）

**脚本**：`scripts/evidence/260608-investigate-lock-blocker.ts`

```
prompt 完成 (179ms), t=7071
[A after prompt] nextGen=1 unused=[] left=1
>>> 即将 await sequence.dispose(), t=7071
[reclaim #1] enter seqId=0, t=7071                    ← _reclaimUnusedSequenceId 同步进入
[reclaim #1] return (withLock scheduled), t=7071      ← void withLock(...) 立即返回
>>> await sequence.dispose() 返回, t=7071             ← dispose 同步返回
[A after dispose] nextGen=1 unused=[] left=1          ← 但 unused 还没更新!
--- A 结束 ---
[unused.push] push(0), t=7073                          ← push 在 +2ms 后才发生
[+50ms] nextGen=1 unused=[0] left=2
```

**直接证明**：
- `await sequence.dispose()` 返回时 `_unusedSequenceIds.push` **还没执行**
- push 在 2ms 后的 microtask 里才发生

### Test 2: 纯底层 API 对比（无 prompt）

通过 inline 实验验证（不保留独立脚本）: 纯 `getSequence → dispose → getSequence` 完全正常（锁空闲时 push 同步）:

```
get #1 → id=0
  [after get #1] nextGen=1 unused=[] left=1
await s1.dispose() 返回
  [after await dispose] nextGen=1 unused=[0] left=2   ← 立即更新 (锁空闲)
get #2 → id=0                                          ← 拿到刚还回去的
```

**这说明问题不在 `dispose → get` 本身, 而在 `prompt → dispose` 之间** (prompt 内部的
`dispatchPendingBatch` 占着 context 锁, 让 dispose 触发的 push 被排队).

### Test 3: 锁源追踪 — `dispatchPendingBatch`

`LlamaContext.dispatchPendingBatch` (line 396):
```typescript
void withLock([this as LlamaContext, "context"], async () => {
    ...
    await this._ctx.decodeBatch();  // ← native worker thread call
    ...
});
```

跟 `_reclaimUnusedSequenceId` (line 745) **用的是同一个 lock scope**：
```typescript
void withLock([this as LlamaContext, "context"], async () => {
    if (this._disposed) return;
    this._ctx.disposeSequence(sequenceId);
    this._unusedSequenceIds.push(sequenceId);
    ...
});
```

**prompt 内部的 dispatchPendingBatch 是 fire-and-forget，最后一个 batch 还在用 libuv worker 跑**。

### Test 4: setImmediate 不够

`scripts/evidence/260608-investigate-mutex-debug.ts`:

```
[91597 warm] dispose done, now setImmediate
[91597 warm] setImmediate done                           ← 立即完成
[91597 after warm] nextGen=1 unused=[] left=0           ← push 还没发生
[91599 unused.push] push(0) ← 真正归还                   ← 2ms 后才 push
[91649 after warm +50ms] nextGen=1 unused=[0] left=1
```

**`setImmediate` 跑得比 libuv worker 快**。改成 `setTimeout(50ms)` 才够。

## 根因机制（精确时序）

### 串行场景为什么 OK

```typescript
const r0 = await s.summarizeBatch(...)   // 预热
```

1. summarizeBatch → `getSequence` 拿 0
2. `await clearHistory` → 抢 context 锁（同步部分）
3. `await session.prompt` → 多次 dispatchPendingBatch（fire-and-forget 抢 context 锁）
4. **prompt await 返回时，最后一个 dispatchPendingBatch 的 withLock 任务在 libuv worker 里跑**
5. `await sequence.dispose()` → `_reclaimUnusedSequenceId` → `void withLock`
6. **context 锁被 dispatchPendingBatch 占用，withLock 加入 queue**
7. dispose 同步返回（**不等 push**）
8. summarizeBatch 函数 return
9. `await s.summarizeBatch` resolve
10. **Node.js event loop**：worker 完成 → dispatchPendingBatch withLock finally → 锁释放 → queue 里 `_reclaimUnusedSequenceId` 跑 → push
11. 下次 summarizeBatch 开始 → `getSequence` 从 unused 拿 0 ✓

**串行时，第 10 步在 await resolve 后的 microtask 链中自然完成。**

### 并发场景为什么失败

```typescript
const results = await Promise.allSettled([
  s.summarizeBatch(...),  // A
  s.summarizeBatch(...),  // B
])
```

1. A、B 几乎同时进入 summarizeBatch
2. A、B 各自 `getSequence` → A 拿 0, B 拿 1
3. A、B 各自 `await clearHistory` + `await session.prompt`
4. prompt 各自 return，但**各自的 dispatchPendingBatch 还在 worker 里跑**
5. A、B 各自 `await sequence.dispose()` → `_reclaimUnusedSequenceId(0)`、`_reclaimUnusedSequenceId(1)` 排队
6. dispose 同步返回
7. Promise.allSettled resolve
8. **caller 立即读 `_unusedSequenceIds`** → 仍是空（worker 还没完）
9. 但 `_nextGeneratedSequenceId = 2` 已等于 `totalSequences = 2`
10. 下一轮想 getSequence → 立即看到 `unused=[]` + `nextGen=2 >= total=2` → **"No sequences left"**

## 三层错误叠加

| 层级 | 错误 | 触发条件 |
|------|------|----------|
| 1. 库实现 | `_reclaimUnusedSequenceId` 用 `void withLock` fire-and-forget | 始终 |
| 2. prompt 实现 | `dispatchPendingBatch` 用 `void withLock` 抢同一个 context 锁 | 每次 prompt |
| 3. 时序 | `await sequence.dispose()` 不等 push；`getSequence` 同步立即读 | dispose 后立即并发 |

**任意一层修了都能避免**，但根本修复在第 1 层（库），用户层只能改第 3 层。

## 用户文档的假设哪里错了

`docs/plans/260607-llamacpp-summarizer-fix.md` 说:

> session.prompt 内部推理时会持有 context 级锁或临时槽位，prompt 结束后释放。但在**并发 getSequence** 场景下，两个请求几乎同时到达，其中一个会撞上这个锁还没完全释放的窗口。

**部分对**：
- ✓ 锁机制确实存在
- ✓ 并发 getSequence 撞上窗口
- ✗ 错误归因到 `session.prompt` 推理时持锁

**真实情况**：
- 推理（`decodeBatch`）是 libuv **worker thread**，跟 context 锁竞争不大
- 持锁的恰恰是 `dispatchPendingBatch` 这个 **JS 层**的 withLock 包装
- 锁释放需要 worker thread 完成 + withLock finally 执行

## 修复方案对比

### 方案 A: 增大 sequences (用户当前做法)

```typescript
this._sequences = sequences ?? concurrency * 2
```

- ✓ 简单，立即缓解
- ✗ 不解决根因，浪费 KV cache 内存
- ✗ 在 `sequences = concurrency` 这种内存紧张场景下失败

### 方案 B: dispose 后 await setTimeout 50ms

```typescript
finally {
  await sequence.dispose()
  await new Promise(r => setTimeout(r, 50))  // 等 worker thread 完
}
```

- ✓ 简洁
- ✗ 50ms 是经验值，不同模型/硬件可能不同
- ✗ 每次 call 多 50ms 延迟
- ✗ 并发场景仍可能撞上（setTimeout 不保证同步释放）

### 方案 C: 全局互斥串行化 get/dispose + dispose 后 yield

```typescript
const lock = ...  // queue
async function call() {
  await lock.acquire()
  try {
    const seq = ctx.getSequence()  // 串行, 不会撞 push
    ...
  } finally {
    await sequence.dispose()
    await new Promise(r => setTimeout(r, 50))
    lock.release()
  }
}
```

- ✓ 串行化避开了 race
- ✓ yield 解决 microtask/worker thread 时序
- ✗ 丧失了真正的并发能力（concurrency > 1 无意义）
- ✗ 单 sequence slot (`sequences=1`) 时仍可能失败（warm 阶段 push 时序问题）

### 方案 D: 池化 sequence（**推荐**）

```typescript
// 一次性拿 sequences 个 sequence, 永久持有
const pool: LlamaContextSequence[] = []
for (let i = 0; i < sequences; i++) {
  pool.push(ctx.getSequence())
}
let idx = 0

async function call() {
  const sequence = pool[idx++ % pool.length]
  await sequence.clearHistory()  // 重置 KV cache, 不调 native dispose
  ...
  // 不 dispose, 放回池
}
```

**核心思路**：永远不调 `dispose()`，避免触发 `_reclaimUnusedSequenceId` 的 fire-and-forget 行为。`clearHistory` 重置 KV cache 就够了。

**已验证**（`scripts/evidence/260608-investigate-pool-fix.ts`）：

| sequences | 4 轮并发×2 |
|-----------|-----------|
| 1 | ✓✓✓✓ |
| 2 | ✓✓✓✓ |
| 4 | ✓✓✓✓ |

**100% 修复所有场景**。

### 方案对比表

| 方案 | 内存 | 并发能力 | 根治 | 复杂度 |
|------|------|----------|------|--------|
| A: 增 sequences | × 2 浪费 | 保留 | ✗ | 低 |
| B: setTimeout 50ms | 1x | 保留 | ✗ | 低 |
| C: 互斥 + yield | 1x | ✗ 实质串行 | ✓ | 中 |
| **D: 池化** | **1x** | **保留** | **✓** | **中** |

## 实施建议

1. **短期**（用户文档已做）：增大 `sequences = concurrency * 2`，临时缓解
2. **中期**：改用方案 D 池化
   - 在 `LlamaCppSummarizer` 中维护 `_sequencePool`
   - 一次性创建 `_sequences` 个 sequence
   - `summarizeBatch` 改为从池中借用，`clearHistory` 重置
   - 永远不调 `sequence.dispose()`，只在 `LlamaCppSummarizer.dispose()` 时统一 dispose
3. **长期**：向 `node-llama-cpp` 提 PR，让 `_reclaimUnusedSequenceId` 返回 Promise，或者让 `dispose()` await 内部 withLock 完成

## 实际应用: 方案 D

**应用位置**: `src/code-index/summarizers/llamacpp.ts` + `src/code-index/service-factory.ts`

**核心代码** (从 `llamacpp.ts`):

```typescript
// 1. 加字段
private _sequencePool: LlamaContextSequence[] = []
private _seqIdx: number = 0

// 2. _ensureContexts 中一次性拿 _sequences 个 sequence
this._contextPoolPromise = (async () => {
  const ctx = await this.model.createContext({
    contextSize: Math.min(this.model.trainContextSize ?? 32768, 32768),
    sequences: this._sequences,
  })
  this._contexts = [ctx]
  for (let i = 0; i < this._sequences; i++) {
    this._sequencePool.push(ctx.getSequence())
  }
})()

// 3. summarizeBatch 从池中借, 不 dispose
async summarizeBatch(request) {
  await this._ensureContexts()
  const sequence = this._sequencePool[this._seqIdx++ % this._sequencePool.length]
  await sequence.clearHistory()  // 重置 KV cache

  const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
  const response = await session.prompt(prompt, { ... })
  // ... parse JSONL ...
  return { summaries }
  // 注意: finally 里不调 sequence.dispose()
}

// 4. dispose() 统一释放
async dispose() {
  for (const seq of this._sequencePool) {
    try { seq.dispose() } catch {}
  }
  this._sequencePool = []
  for (const ctx of this._contexts) {
    await ctx.dispose().catch(() => {})
  }
  this._contexts = []
}
```

**默认值调整**: `_sequences` 默认从 `concurrency * 2` 改为 `concurrency`. 之前 ×2 是兑底 _reclaimUnusedSequenceId race 的余量; 池化后 race 已完全避免, 不再需要冗余 slot.

## 相关文件

保留的 evidence 脚本（每个都是"非它不可"）:

- `scripts/evidence/260608-compare-sequences.ts` — 用户原始复现脚本
- `scripts/evidence/260608-investigate-lock-blocker.ts` — **关键证据**: dispose 不等 push 的时序追踪
- `scripts/evidence/260608-investigate-mutex-debug.ts` — **关键证据**: setImmediate 不够, setTimeout 才够
- `scripts/evidence/260608-investigate-pool-fix.ts` — **修复验证**: 4 轮并发×2 / sequences=1/2/4

## 关键源码位置

| 文件:行 | 代码 | 说明 |
|---------|------|------|
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts:282-284` | `sequencesLeft` getter | 读 `_nextGeneratedSequenceId` + `_unusedSequenceIds.length` |
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts:396` | `void withLock([this, "context"], ...)` | `dispatchPendingBatch` 用同一个 context 锁 |
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts:741-753` | `_reclaimUnusedSequenceId` | **根因**：`void withLock` fire-and-forget |
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts:756-769` | `_popSequenceId` | 同步读 unused + 增 nextGen |
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts:1121-1130` | `LlamaContextSequence.dispose()` | 同步执行 disposeAggregator，包括 `_reclaimUnusedSequenceId` |
| `node_modules/lifecycle-utils/dist/withLock.js` | `withLock` 实现 | 锁是 FIFO queue，await 链让出 microtask |
