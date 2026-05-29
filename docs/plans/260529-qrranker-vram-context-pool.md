# 260529-qrranker-vram-context-pool

## 问题流水账

### [Bug 1] contextSize 硬编码 32768 → VRAM 溢出

**发现：** `search "where is the actual train method implementation"` 报 `InsufficientMemoryError`

> ⚠️ 用户 Mac 有 **96GB** 统一内存，理论上完全充足。报错说明不是系统总内存不够，而是 llama.cpp Metal 后端的 **单次 Metal buffer 分配上限** 或 **node-llama-cpp 的 VRAM 预检逻辑** 过于保守触发的限制。

**根因：** `qrranker.ts:306` 和 `highlighters/qrranker.ts:806` 的 `contextSize: Math.max(32768, tokens.length + 256)`。实际 tokens 只有 3292，但强制分配 32K KV cache。QRRanker 模型（0.6B @ Q8）的 32K KV cache ≈ 1.6GB，加上其他模型同时驻留（F2LLM×2、QRRankerHighlighter），超出可用显存。

**修复：**
- `Math.max(32768, ...)` → `Math.min(model.trainContextSize ?? 32768, tokens.length + 1024)`
- 动态分配：只分配当前 batch 需要的 token 数 + 1K 缓冲，上限为模型最大上下文

**涉及文件：** `qrranker.ts`, `highlighters/qrranker.ts`

---

### [Bug 2] 硬编码 32768 不是所有模型的 max context

**发现：** 用户指出 32768 是模型的最大上下文，不应改上限

**根因：** 不同模型有不同的 `trainContextSize`（Qwen3-0.6B 是 32768，但 `QRRanker-q8_0.gguf` 元数据报 262144）。硬编码 32768 对大模型不够，对小模型又浪费。

**修复：**
- 所有硬编码 `32768` 替换为 `model.trainContextSize ?? 32768`
- `llamacpp-llm-rerank.ts` 的 pool contextSize 也同步修复

**涉及文件：** `qrranker.ts`, `highlighters/qrranker.ts`, `llamacpp-llm-rerank.ts`

---

### [Bug 3] QRRanker 每次 batch 都 create/dispose context

**发现：** 与 `llamacpp-llm-rerank.ts` 对比，后者有 context 池复用

**根因：** `_rerankBatch` 内每次 `model.createContext(...)` + `context.dispose()`。重复创建销毁的开销在并发场景下尤其明显。

**修复：**
- 新增 `_contexts: LlamaContext[]` + `_contextPoolPromise` 字段
- 新增 `_ensureContexts()`：预创建 `concurrency` 个 context（同 `llamacpp-llm-rerank.ts` 模式）
- `_rerankBatch` 改为接收 `LlamaContext` 参数而非 `LlamaModel`，从池中轮询取用
- 保留 batch tokens 超过池上限时创建临时更大 context 的回退逻辑
- `rerank()` 先 `_ensureContexts()` 后分派 batch

**涉及文件：** `qrranker.ts`

---

### [Bug 4] `rerankerGgufPath` 被多个 provider 共用，语义混淆

**发现：** 用户本以为是 qrranker 专用，实际上是 llamacpp/llamacpp-llm/qrranker/semantic-highlight 共用

**根因：** 配置项复用导致用户注释掉 `rerankerGgufPath` 后 qrranker 静默不被创建（`service-factory` 判断 `config.provider === 'qrranker' && config.ggufPath`），rerank 无提示失效。

**修复：**
- 新增专用配置项 `rerankerGgufQrrankerPath`
- `RerankerConfig` 新增 `ggufQrrankerPath` 字段
- `service-factory`：qrranker 优先读 `ggufQrrankerPath`，降级到 `ggufPath`
- 所有 snapshot 类型同步更新
- CLI `config` 子命令元数据注册新字段

**涉及文件：** `interfaces/config.ts`, `interfaces/reranker.ts`, `config-manager.ts`, `service-factory.ts`, `commands/config/metadata.ts`, `demo/autodev-config.json`

---

### [Bug 5] QRRanker-q8_0.gguf 的 `trainContextSize=262144` 远超可用显存

**发现：** context 池创建时报 `contextSize=262144`，立即 `InsufficientMemoryError`

**根因：** 模型的 GGUF 元数据报告 262K 上下文，`_ensureContexts()` 直接用该值创建 context。对 0.6B 模型，262K KV cache = 12GB+，远超出 Mac 可用 Metal buffer。

**修复：**
- `_ensureContexts()` 中 `Math.min(rawSize, 32768)` 封顶
- 保留 `_rerankBatch` 的临时 context fallback：如果真有 batch 需要超过 32K，创建独立临时 context

**涉及文件：** `qrranker.ts`

---

### [Bug 6] `--debug-highlight` 不输出

**发现：** `search "Berlin is..." --debug-highlight` 只有搜索结果，没有 token 热力图

**根因：** refactoring 后 `QRRankerReranker.validateConfiguration()` 也会预创建 2×32K context 池。加上高亮器在 validate 阶段也加载了同一模型（600MB GGUF 再载入一次），总计显存：
- F2LLM-80M × 2 = 160MB
- QRRanker 模型 × 2（reranker + highlighter 各自加载）= 1.2GB
- reranker 2×32K KV cache = 3.2GB
- 高亮器 4K context = 0.2GB
→ 超出可用 Metal buffer → 高亮器 validate 失败 → `highlighter = undefined` → 无高亮输出

**修复：**
- 两个类的 `validateConfiguration()` 都只验证模型加载，不创建 context
- context 推迟到首次 `rerank()`/`highlight()` 调用时懒加载

**涉及文件：** `qrranker.ts`, `highlighters/qrranker.ts`

---

### [Bug 7] context 池 `Promise.all` 并行创建导致 Metal GGML_ASSERT 崩溃

**发现：** 第 2 个 context 创建失败后触发 `GGML_ASSERT([rsets->data count] == 0) failed`，进程 ABORT

> ⚠️ 96GB 机器上同样触发，确认非内存不足，而是 **llama.cpp Metal 后端的 bug**：分配失败后的 cleanup 路径 `ggml_metal_device_free()` 尝试释放尚未初始化的 Metal buffer，导致断言崩潰。见 [llama.cpp#17869](https://github.com/ggml-org/llama.cpp/pull/17869)。

**根因：** `Promise.all` 同时申请 2 个 32K context，KV cache 分配瞬态峰值超限。Metal 后端的资源清理路径有 bug，在分配失败后的 `ggml_metal_device_free()` 中触发向未初始化的 Metal 缓冲区写入。

**修复：**
- `Promise.all` → `for` 循环逐个顺次创建
- 每个 `createContext` 包 `try/catch`，失败时 break 并 warn 日志
- 极端情况（0 个 context 创建成功）返回原始分不做 rerank

**涉及文件：** `qrranker.ts`

---

## 最终架构状态

### 配置字段命名规范

| 字段 | 用途 | provider |
|------|------|----------|
| `rerankerGgufPath` | 专用 reranker GGUF（cross-encoder） | `llamacpp`, `llamacpp-llm` |
| `rerankerGgufQrrankerPath` | QRRanker GGUF（attention-based） | `qrranker` |
| `rerankerGgufLlmPath` | LLM backbone GGUF | `llamacpp-llm` |

### Context 生命周期

```
validateConfiguration() → 只加载模型，不创建 context
         ↓
rerank(query, candidates) → _ensureModel() → _ensureContexts()
         ↓                        ↓               ↓
    already done                check    逐个顺次创建 context(s)
         ↓                        ↓               ↓
   分发 batch → 轮询复用         cached          try/catch skip
         ↓
    ...所有 batch 完成... → 返回结果
```

### 逐批 fallback 策略

```
_rerankBatch(context, query, batch):
  1. 计算 batch 所需 token 数：neededSize = tokens.length + 1024
  2. 如果 context.contextSize < neededSize:
     创建临时更大 context → 用完后 dispose
  3. 否则直接复用池中 context
```
