# 260523-qrranker-ubatch-overflow-fix

## 主题

小说语义搜索场景下，QRRanker 对长文本执行 `evaluateWithoutGeneratingNewTokens` 后，`kq_soft_max` 读回异常，导致崩溃、NaN 分数或空数据。

复现命令：

```bash
npx tsx src/cli.ts search "陈黄皮的媳妇是谁？" \
  --debug-highlight \
  --path="/Users/anrgct/workspace/novel" \
  --log-level=debug
```

相关配置：

```json
"rerankerProvider": "qrranker",
"rerankerGgufPath": "/Users/anrgct/workspace/open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf",
"rerankerBatchSize": 10,
"rerankerConcurrency": 2,
"highlighterProvider": "qrranker",
"highlighterGgufQrrankerPath": "/Users/anrgct/workspace/open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf"
```

## 最终结论

这不是单一 bug，而是两个问题叠加：

1. **C++ cbEval 的 micro-batch offset 跟踪错误**：旧逻辑用 `kq_soft_max.ne[1]` 是否变化推断 batch 边界，连续等长 micro-batch 时不会推进 offset，导致 query 所在 batch 没有被采集，JS 侧表现为 `layerData.length=0` / `shortHeads=16`。

2. **Metal 下 `batchSize=8192` 仍会部分 head NaN**：offset 修复后，`15003 tokens @ batchSize=8192` 仍复现 `okHeads=3, nanHeads=13`；同一输入降到 `batchSize=4096` 后 `okHeads=16, nanHeads=0`。当前采用保守规避：QRRanker/Highlighter 的 Metal ubatch 降为 `4096`。

最终方案：

- C++ addon 在 `AddToBatch()` 记录当前 JS decode batch 的真实起点 `firstTokenContextIndex`。
- `cbEval()` 用 `kqCurrentBatchTokenStart` 计算 query 与当前 micro-batch 的交集，不再从 tensor shape 推断 offset。
- `cbEval()` 只复制 query token rows 到 CPU，避免完整 `kq_soft_max` 张量超过 V8 ArrayBuffer 限制。
- TS 侧在 decode 前调用 `context.setKqSoftMaxQueryRange(queryStart, queryEnd)`。
- QRRanker reranker/highlighter 的 ubatch 使用 `Math.min(tokens.length, 4096)`。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `vendor/llama-addon/AddonContext.h` | 新增 `kqQueryStart` / `kqQueryEnd` / `kqCurrentBatchTokenStart`，新增 `SetKqSoftMaxQueryRange` 声明 |
| `vendor/llama-addon/AddonContext.cpp` | `cbEval` query slice 累积；`AddToBatch` 记录 batch 起点；注册 `setKqSoftMaxQueryRange` |
| `src/code-index/rerankers/qrranker.ts` | decode 前设置 query range；`ubatch=4096`；按 query-relative layout 读取 |
| `src/code-index/highlighters/qrranker.ts` | 同 reranker |
| `src/examples/repro-kq-softmax-nan.ts` | 增强为矩阵复现工具，支持 `--target` / `--targets` / `--batch-size` / `--cpu` |
| `vendor/llama-addon/build-trigger.mjs` | 避免 CMake ARM `try_run` 卡住：设置 `GGML_NATIVE=OFF` 和固定 ARM arch |
| `vendor/llama-addon/build.sh` | 复制 hash 版 Metal dylib |
| `scripts/deploy-llamacpp-patch.ts` | 部署 hash 版 Metal dylib |

## 原始症状

修复前崩溃：

```text
[QRRanker] Tokenized: 14289 tokens, 10 chunks, query [14268, 14289)
[QRRanker] Processing 14289 tokens with batchSize=8192
[QRRanker] kq_soft_max shape: nKv=8192, nTokens=8192, nHead=8, nLayers=2, layers=[23,19]
[CodeIndexSearchService] Error during search: RangeError: Invalid typed array length: -1523
    at new Float32Array (<anonymous>)
    at QRRankerReranker.computeQRScores (qrranker.ts:232)
```

中间尝试 `Math.max(tokens.length, 8192)` 后，不再是旧崩溃，但暴露更大的 Metal/ArrayBuffer 问题：

```text
[QRRanker] Tokenized: 15317 tokens, 10 chunks, query [15296, 15317)
[QRRanker] Processing 15317 tokens with batchSize=15317
[QRRanker] kq_soft_max shape: nKv=15360, nTokens=15317, nHead=16, nLayers=2, layers=[23,19]
[QRRanker] 10 docs in 34886ms, Scores:  #1 NaN ... #10 NaN
```

这个方向已废弃：把所有 token 塞进单 micro-batch 会导致 Metal compute buffer 巨大，`graph_reserve` 可到数十 GB 并 SIGSEGV/OOM。

## 调查过程

### 1. `Math.min` / `Math.max` 都不是完整答案

旧修复：

```ts
Math.min(tokens.length, 8192)
```

问题：tokens 超过 8192 时 llama.cpp 会拆成多个 micro-batch，旧 `cbEval` 每次覆盖写入，只保留最后一批。

尝试：

```ts
Math.max(tokens.length, 8192)
```

问题：强制单 micro-batch 会让 `kq_soft_max` / compute buffer 过大，长输入下 Metal 内存压力不可接受。

结论：应保留 micro-batch，但 C++ 侧必须跨 batch 累积 query slice。

### 2. 完整张量不能传回 JS

以 `15317 tokens` 为例：

```text
nKv=15360, nTokens=15317, nHead=16
15360 * 15317 * 16 floats ~= 3.76B floats ~= 15GB
```

完整 `Float32Array` 超过 V8 ArrayBuffer 上限，且 QRRanker 实际只需要 query token rows：

```text
nQueryTokens ~= 21
21 * 15360 * 16 floats ~= 20MB/layer
```

结论：C++ addon 应只复制 `queryStart..queryEnd` 对应的 rows。

### 3. offset 推断 bug

旧实现曾用 `n_tokens_mb` 变化推断新 batch：

```cpp
if (n_tokens_mb != ctx->kqLastMicroBatchTokens && n_tokens_mb > 16) {
    ctx->kqEvalTokenOffset += ctx->kqLastMicroBatchTokens;
}
```

该逻辑在连续等长 batch 时失效：

```text
21630 @ 8192 => 8192 + 8192 + 5246
15003 @ 4096 => 4096 + 4096 + 4096 + 2715
```

第二个/第三个等长 batch 不推进 offset，query 所在末批完全不被采集。

修复：

- `AddToBatch()` 在 `batch.n_tokens == 0` 时记录 `firstTokenContextIndex`。
- `cbEval()` 使用 `kqCurrentBatchTokenStart` 计算当前 micro-batch 的绝对 token 范围。
- 写入 CPU buffer 时使用 query-relative offset：`query_dst_start = batch_start + mb_query_start - kqQueryStart`。

### 4. Metal `8192` NaN 仍存在

offset 修复后仍保留的现象：

```text
target=14972, actual tokens=15003, batchSize=8192
okHeads=3, nanHeads=13, shortHeads=0
```

同一输入降到 `4096`：

```text
target=14972, actual tokens=15003, batchSize=4096
okHeads=16, nanHeads=0, shortHeads=0
```

结论：剩余 NaN 与 Metal 下较大 micro-batch / compute buffer / `kq_soft_max` tensor 读回有关。当前不继续在 8192 上硬修，先用 4096 规避。

## 复现工具

脚本：

```bash
npx tsx src/examples/repro-kq-softmax-nan.ts --target=14972 --batch-size=4096
npx tsx src/examples/repro-kq-softmax-nan.ts --target=21630 --batch-size=4096
```

功能：

- `--target=N`：指定目标 token 数。
- `--targets=a,b,c`：批量跑矩阵。
- `--batch-size=N`：指定 context batch/ubatch。
- `--cpu` / `--gpu=false`：切换后端。
- 输出 JS decode batch 切分、query 落在哪个 batch。
- 区分 `NaN`、全零/非正、`short data` 和正常 head。

关键实测矩阵：

| target | actual tokens | batchSize | 预期切分 | 结果 |
|--------|---------------|-----------|----------|------|
| 10820 | 10820 | 8192 | 8192 + 2628 | 16/16 heads 正常 |
| 14972 | 15003 | 8192 | 8192 + 6811 | 3/16 heads 正常，13/16 heads NaN |
| 21630 | 21630 | 8192 | 8192 + 8192 + 5246 | offset 修复前 `shortHeads=16` |
| 14972 | 15003 | 4096 | 4096 + 4096 + 4096 + 2715 | offset 修复后 16/16 heads 正常 |
| 21630 | 21630 | 4096 | 4096 x 5 + 1150 | offset 修复后 16/16 heads 正常 |

最终验证结果：

```text
target=14972 tokens=15003 ok=16 nan=0 zero=0 short=0 scoreNonZero=15003
target=21630 tokens=21630 ok=16 nan=0 zero=0 short=0 scoreNonZero=21630
```

## 构建与部署

构建：

```bash
npm run build:llamacpp
```

曾卡在 CMake ARM feature `try_run`，已通过 `vendor/llama-addon/build-trigger.mjs` 固定 CMake 参数规避：

```ts
cmakeOptions: {
  GGML_NATIVE: "OFF",
  GGML_CPU_ARM_ARCH: "armv8.6-a+dotprod+i8mm",
}
```

部署：

```bash
npx tsx scripts/deploy-llamacpp-patch.ts
```

部署脚本现在会复制 hash 版 dylib，例如：

```text
libllama.metal.b8390.<hash>.dylib
libggml.metal.b8390.<hash>.dylib
```

原因：新编译的 `llama-addon.node` 可能依赖 hash 版 dylib，缺失时 `dlopen` 会失败。

## 已验证

```bash
npx tsc -p tsconfig.json --noEmit
npx tsx src/examples/repro-kq-softmax-nan.ts --target=14972 --batch-size=4096
npx tsx src/examples/repro-kq-softmax-nan.ts --target=21630 --batch-size=4096
```

结果：

```text
target=14972 tokens=15003 ok=16 nan=0 zero=0 short=0 scoreNonZero=15003
target=21630 tokens=21630 ok=16 nan=0 zero=0 short=0 scoreNonZero=21630
```

## 待确认

- 真实搜索命令尚需在最终 patch 部署后再跑一次，确认业务链路不再 NaN：

```bash
npx tsx src/cli.ts search "陈黄皮的媳妇是谁？" \
  --path="/Users/anrgct/workspace/novel" \
  --log-level=debug
```

- `patches/node-llama-cpp+3.18.1.patch` 需要确认已包含最终 C++ offset 修复和 build/deploy 相关改动。
- `batchSize=4096` 是保守规避，不是 Metal 8192 NaN 的根治。后续可评估升级 llama.cpp、CPU backend 对比或 adaptive batch size。

## 参考

- `docs/plans/260519-qrranker-llamacpp-patch.md`
- `vendor/llama-addon/AddonContext.cpp`
- `vendor/llama-addon/AddonContext.h`
- `src/code-index/rerankers/qrranker.ts`
- `src/code-index/highlighters/qrranker.ts`
- `src/examples/repro-kq-softmax-nan.ts`
