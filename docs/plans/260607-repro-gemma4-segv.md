# 260607 Gemma-4 QRRanker SIGSEGV 复现与归因

## 主题/需求

排查 gemma-4-E2B-it-qat-mobile GGUF 模型在 QRRanker 中导致 SIGSEGV 崩溃的问题，编写复现脚本定位根因。

**涉及配置：**
```json
"rerankerGgufQrrankerPath": "/Users/anrgct/llm_models/unsloth/gemma-4-E2B-it-qat-mobile-GGUF/gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf"
```

## 代码背景

- **QRRanker**: `src/code-index/rerankers/qrranker.ts` — `_collectDecodeStageAttention()` 方法
- **Highlighter**: `src/code-index/highlighters/qrranker.ts` — `_collectDecodeAttention()` 方法
- **依赖**: `@realtimex/node-llama-cpp` 封装 llama.cpp，使用 Metal (Apple GPU) 后端
- **复现脚本**: `scripts/evidence/260607-repro-gemma4-qrranker-segv.ts` + `260607-repro-gemma4-qrranker-segv-worker.mjs`

Crash 发生在 `evaluate()` → llama.cpp 的 Metal 后端编译计算图时。正常工作的模型（如 Qwen3.5-4B）走同一路径不崩溃。

## 运行现象

### 原始 crash 日志

```
[QRRanker] Processing 17681 tokens with batchSize=4096
[CRASH] SIGSEGV at ...
[CRASH] Likely a native addon crash (@realtimex/node-llama-cpp / llama.cpp)
```

进程被 SIGSEGV 直接杀死，无 JS 层异常可 catch。

### 复现脚本输出（最终）

```
  GPU+kq                  💥  进程被信号终止 (SIGSEGV)
  GPU+prefill             💥  进程被信号终止 (SIGSEGV)
  CPU+kq                  ✅  OK
  CPU+prefill             ✅  OK
  CPU+long+kq             ✅  OK
```

- GPU 下无论 `collectKqSoftMax` 与否，**所有 evaluate 都 SIGSEGV**
- CPU 下 **evaluate 正常**，但 `getKqSoftMax()` 返回 `"A number was expected"`（CPU 端也不支持 kq_soft_max）

## 归因分析

**关键错误（从内联 `node -e` 测试捕获）：**

```
ggml-metal-device.cpp:901: not implemented

 1  ggml_metal_library_get_pipeline_mul_mm_id_map0
 2  ggml_metal_op_mul_mat
 3  ggml_metal_op_encode
```

gemma-4 架构使用了一种需要 Metal pipeline `mul_mm_id_map0` 的矩阵乘法（ID-based matrix multiplication，用于 MoE 或多 LoRA 路由），但当前 `@realtimex/node-llama-cpp` 绑定的 llama.cpp 版本中，Metal 后端未实现该 pipeline。

**`abort()` 细节：**

- ggml 调用 `ggml_abort()` → `abort()`，C 级终止进程
- stderr 管道缓冲区在 abort 后丢失（`spawn` 的 pipe 模式收不到）
- JS 层 `try-catch` 拦不住，必须用子进程隔离 + exit signal 检测
- exit code = 139 (128 + 11 = SIGSEGV)

**为何 Qwen3.5-4B 等其他模型不崩溃：**

因为这些模型不需要 `mul_mm_id_map0`，使用常规的 `mul_mat` Metal pipeline 即可。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 子进程隔离 | `child_process.spawn` 执行 worker | Metal 的 `abort()` 直接杀进程，无法 try-catch |
| 检测方式 | 组合 `[W] OK` stdout + exit signal | stderr 在 abort 后可能丢失，双保险 |
| CPU 对照 | `getLlama({ gpu: false })` | 验证是否是 Metal 专属问题 |
| worker 语言 | `.mjs` 纯 JS（非 `.ts`） | 父进程用 `npx tsx`，子进程用 `node` 直接跑，更快 |

## 实施计划

- [x] 编写复现脚本，覆盖 GPU/CPU + kq/no-kq 矩阵
- [x] 确认 GPU evaluate 崩溃根因
- [x] 记录本次排查过程到 task doc

## 实施记录

### 2026-06-07

1. **定位代码位置**: 找到 `_collectDecodeStageAttention` 和 `_collectDecodeAttention`，确认日志行位置并添加了 prefill/decode 计时（在此次排查前已完成）。
2. **初版复现脚本**: 写 repro 主控 + worker，4 用例都崩溃但显示模块加载错误。
3. **修复 worker 语法**: `.mjs` 文件是纯 JS，不能用 TypeScript `as` 语法，改为 `(e && typeof e === "object" && "message" in e ? e.message : String(e))` 模式。
4. **缩小范围**: 即使 `collectKqSoftMax=false` 也崩溃，排除 kq_soft_max 原因。
5. **直接内联测试**: `node -e` 方式捕获到关键错误 `ggml-metal-device.cpp:901: not implemented`。
6. **CPU 测试**: `gpu: false` 下 evaluate 成功，确认是 Metal 后端专属问题。
7. **管道丢失问题**: 发现 `spawn` 的子进程 stderr pipe 在 abort 后丢失数据，改用 exit signal (SIGSEGV) 做检测兜底。
8. **最终脚本完成**: 5 用例矩阵，清晰显示 GPU 崩溃、CPU 正常工作。

## 修订记录

（本记录暂无修订）

## 总结

**根本原因：** `@realtimex/node-llama-cpp` 绑定的 llama.cpp Metal 后端缺少 gemma-4 架构所需的 `mul_mm_id_map0` pipeline，任何 GPU 上的 evaluate 操作都会 SIGSEGV。

**经验教训：**
- Metal 后端的 `ggml_abort()` 会直接 `abort()` 进程，无法 JS try-catch，必须用子进程隔离 + exit signal 检测
- `spawn` 的管道在 `abort()` 后可能丢失数据，两个通道（stderr 和 stdout）都可能不完整
- 排查时应先做最小复现排除干扰因素（先不看 kq_soft_max，只看 evaluate 本身）

**后续建议：**
1. 升级 `@realtimex/node-llama-cpp` 到新版，其 llama.cpp 可能已支持 gemma-4 Metal
2. 或恢复使用 Qwen3.5-4B 作为 QRRanker 模型
3. CPU 后端可作临时规避方案，但推理速度极慢
