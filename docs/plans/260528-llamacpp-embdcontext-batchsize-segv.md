# 260528-llamacpp-embdcontext-batchsize-segv

## 主题/需求

调查 `createEmbeddingContext` 在特定 batchSize（8192~32768）下触发 SIGSEGV 的根因。

**现象：** 调用 `model.createEmbeddingContext({ batchSize, embdLayer })` 时，batchSize 在 8192~32768 区间内进程以 SIGSEGV（exit 139）崩溃，4096 和 65536+ 正常。

**表现出的非单调模式：**

| batchSize | 结果 |
|-----------|------|
| 4096 | ✅ OK |
| 8192 | 💥 SIGSEGV |
| 16384 | 💥 SIGSEGV |
| 32768 | 💥 SIGSEGV |
| 65536 | ✅ OK |
| 131072 | ✅ OK |

## 代码背景

### 关键文件

| 文件 | 角色 |
|------|------|
| `src/code-index/embedders/llamacpp-llm.ts` | 调用者：`_contextSize` 作为 batchSize 传入 `createEmbeddingContext` |
| `src/cli.ts:20-28` | SIGSEGV 信号处理 + `process.abort()` |
| `node-llama-cpp/src/evaluator/LlamaEmbeddingContext.ts` | `createEmbeddingContext` → 委托给 `LlamaContext._create` |
| `node-llama-cpp/src/evaluator/LlamaContext/LlamaContext.ts` | `_create` 将 batchSize 传递给 `AddonContext` native 层 |
| `node-llama-cpp/llama/addon/AddonContext.cpp:413` | 设置 `context_params.n_batch = context_params.n_ubatch = batchSize` |
| `llama.cpp/src/llama-context.cpp:425` | `n_tokens = min(n_ctx, n_ubatch)` — 决定 graph tensor 维度 |
| `llama.cpp/ggml/src/ggml-metal/ggml-metal.cpp:202-210` | **崩溃点：** `ggml_metal_buffer_is_shared(res)` 空指针解引用 |
| `scripts/evidence/260528-repro-embdcontext-segv.ts` | 复现脚本（主控） |
| `scripts/evidence/260528-repro-embdcontext-segv-worker.mjs` | 复现脚本（worker 子进程） |

### 调用链

```
createEmbeddingContext({ batchSize, embdLayer })
  → LlamaEmbeddingContext._create()
    → model.createContext({ batchSize, _embeddings: true, _embdLayer })
      → LlamaContext._create()
        → new AddonContext(model, { batchSize, embeddings, embdLayer })
          → context_params.n_batch = batchSize
          → context_params.n_ubatch = batchSize
        → llama_init_from_model(model, params)
          → llama_context constructor
            → sched_reserve()
              → graph_reserve(n_tokens = min(n_ctx, n_ubatch))
                → model.build_graph(gparams)
                → ggml_backend_sched_reserve(sched, gf)
                  → ggml_gallocr_reserve_n_impl()
                    → ggml_backend_metal_buffer_type_shared_alloc_buffer(size)
                      → ggml_metal_buffer_init(dev, size, shared)  // returns NULL for certain sizes
                      → ggml_metal_buffer_is_shared(res)           // 💥 crash if res==NULL
```

## 关键决策

### 判定依据

崩溃的根因是 **ggml Metal 后端的 `ggml_backend_metal_buffer_type_alloc_buffer()` 缺少对 `ggml_metal_buffer_init()` 返回值的 NULL 检查**，这是 ggml 的一个 bug。

### 非单调模式的原因

| n_tokens | 调度策略 | 结果 |
|----------|----------|------|
| 4096 | tensor 小 → Metal 后端分配成功 | ✅ |
| 8192~32768 | tensor 中等 → 分配到 Metal；但 Metal `newBufferWithLength` 失败返回 NULL → 空指针解引用 | 💥 |
| 65536+ | tensor 极大 → ggml_gallocr 自动选择 CPU 后端，绕过有 bug 的 Metal 代码路径 | ✅ |

这不是内存不足（否则 65536+ 应更严重），而是 **Metal 后端针对特定 tensor 尺寸的分配失败 + 未做空检查**的组合问题。

### 修复方案

**已实施的修复（`llamacpp-llm.ts:131`）：**
```
// 修复前
this._contextSize = 8192;  // 硬编码 → 命中崩溃区间
// 修复后
this._contextSize = this._model.trainContextSize ?? 4096;  // 模型真实值 131072
```

此修复本质上是"用超大 batchSize 迫使调度器走 CPU 后端绕过 bug"。

**真正的修复应该在 ggml 上游：**
- 在 `ggml_backend_metal_buffer_type_alloc_buffer()` 中添加 `if (!res) return NULL;` 检查
- 或查明 `ggml_metal_buffer_init()` 在特定大小返回 NULL 的 Metal 驱动原因

## 实施记录

### 2026-05-28

**1. 初步调查（handoff 文档）**
- 阅读 `/tmp/handoff-llamacpp-llm-segv-crash-*.md`
- 已实施的修复：`_contextSize = model.trainContextSize ?? 4096`
- 已添加 SIGSEGV handler + `process.abort()` 解决 `signal-exit` 死锁
- batchSize 扫描结果已记录，但未解释非单调模式

**2. 深入源码追踪**
- 追踪 JS 层 `createEmbeddingContext` → `LlamaContext._create` → `AddonContext` native 层
- 确认 `n_batch = n_ubatch = batchSize` 在 AddonContext.cpp:413-414
- 确认 `n_tokens = min(n_ctx, n_ubatch)` 在 llama-context.cpp:425

**3. macOS 崩溃报告解析**
- 读取 5 个 `.ips` 文件：
  - 第 1 个是原始 SIGSEGV：`EXC_BAD_ACCESS` at `0x10` 在 `ggml_metal_buffer_is_shared`
  - 后续 4 个是 `process.abort()` 产生的 SIGABRT
- 完整堆栈：`ggml_metal_buffer_is_shared` → `ggml_backend_metal_buffer_type_shared_alloc_buffer` → `ggml_gallocr_reserve_n_impl` → `ggml_backend_sched_reserve` → `llama_context::graph_reserve` → `sched_reserve`

**4. ggml Metal 后端代码分析**
- 定位到 `ggml-metal.cpp:202-210`
- 确认 `ggml_metal_buffer_init()` 返回 NULL 时，`ggml_metal_buffer_is_shared(res)` 空指针解引用
- 确认非单调模式的根因：ggml_gallocr 针对超大 tensor 自动切换到 CPU 后端

**5. 创建复现脚本**
- `scripts/evidence/260528-repro-embdcontext-segv.ts` — 主控
- `scripts/evidence/260528-repro-embdcontext-segv-worker.mjs` — worker（被 spawn)
- 子进程隔离模式避免 SIGSEGV 杀死主进程
- 使用 `[W] OK dim=` 输出内容判定成功/失败，不受 `process.abort()` 干扰
- 明确复现崩溃区间：8192~32768

## 修订记录

### 2026-05-28
**问题：** 复现脚本最初不退出、误判所有 batchSize 为 SEGV
**修复：**
- `clearTimeout` 防止 timer 阻止事件循环退出
- 用输出内容（`[W] OK dim=`）而非 exit code 判定成功，因为 `signal-exit` 死锁让成功的子进程也触发 SIGABRT

## 总结

### 关键发现

1. **根因**：ggml Metal 后端的 `ggml_backend_metal_buffer_type_alloc_buffer()` 在 `ggml_metal_buffer_init()` 返回 NULL 时未做检查，导致 `ggml_metal_buffer_is_shared(NULL)` 空指针解引用
2. **触发条件**：batchSize 在 8192~32768 区间（n_tokens = min(n_ctx, n_ubatch) 控制 tensor 维度）
3. **非单调解释**：超大 batchSize（65536+）让 tensor 大到调度器自动选择 CPU 后端，绕过 Metal bug
4. **当前修复**：使用 `model.trainContextSize`（131072）作为 batchSize，利用上述绕过机制

### 后续建议

- 向 ggml 上游提交修复：在 `ggml-metal.cpp:206` 添加 `if (!res) return NULL;`
- 调查 `ggml_metal_buffer_init()` 在 8192~32768 区间失败的具体 Metal 驱动原因（可能是 Metal `newBufferWithLength:options:` 对特定 alignment 大小返回 nil）
- 复现脚本已验证可用于回归测试和上游修复验证
