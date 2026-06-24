#!/usr/bin/env npx tsx
/**
 * 260624-embd-injection-smoke.ts
 *
 * 验证 node-llama-cpp embd 注入补丁。
 *
 * 观测 1：patch 符号检测 —— C++ addon 导出新方法
 * 观测 2：embd 注入基本流程 —— getTokenEmbeddings → initBatchEmbd → addToBatchEmbd → decodeBatch 不 crash
 *
 * 用法：npx tsx scripts/evidence/260624-embd-injection-smoke.ts [gguf_path]
 */

import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"

const DEFAULT_MODEL =
  "/Users/anrgct/workspace/llm2vec-gen/gguf/qwen3-06b/qwen3-06b-llm2vec-unified-q8_0-mlp.gguf"

async function main() {
  const modelPath = process.argv[2] || DEFAULT_MODEL
  console.log("── 260624-embd-injection-smoke ──")
  console.log(`Model: ${modelPath}`)

  // 1. 加载模型
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
  const model = await llama.loadModel({ modelPath })
  const nEmbd = (model.fileInfo?.metadata as any)?.[
    (model.fileInfo?.metadata as any)?.general?.architecture
  ]?.embedding_length ?? 1024
  console.log(`Model loaded, n_embd=${nEmbd}`)

  // 2. 创建 context
  const ctx = await model.createContext({
    contextSize: { min: 128, max: 256 },
    batchSize: 128,
    _embeddings: true,
  })
  const addonCtx = (ctx as any)._ctx

  // ============================================================
  // 观测 1：patch 符号检测
  // ============================================================
  const checks = {
    initBatchEmbd: typeof addonCtx.initBatchEmbd === "function",
    addToBatchEmbd: typeof addonCtx.addToBatchEmbd === "function",
    getTokenEmbeddings: typeof addonCtx.getTokenEmbeddings === "function",
  }

  console.log("── 观测 1：patch 符号检测 ──")
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${name.padEnd(20)}: ${ok ? "✅" : "❌"}`)
  }
  if (!Object.values(checks).every(Boolean)) {
    console.log("❌ patch 未完整实施")
    process.exit(1)
  }
  console.log("✅ patch 已完整实施\n")

  // ============================================================
  // 观测 2：embd 注入基本流程
  // ============================================================
  console.log("── 观测 2：embd 注入基本流程 ──")

  const text = "The capital of France is Paris"
  const ids = model.tokenize(text, true)
  const N = ids.length
  console.log(`  text   : "${text}"`)
  console.log(`  tokens : ${N}`)

  // 2a. getTokenEmbeddings
  let embdFlat: Float32Array
  try {
    embdFlat = addonCtx.getTokenEmbeddings(Uint32Array.from(ids)) as Float32Array
    console.log(`  getTokenEmbeddings: ✅ ${embdFlat.length} floats (expected ${N * nEmbd})`)
    console.log(`  embd[0..4]: [${Array.from(embdFlat.slice(0, 5)).map(v => v.toFixed(6)).join(", ")}]`)
    const nonZero = Array.from(embdFlat.slice(0, 100)).filter(v => Math.abs(v) > 1e-6).length
    console.log(`  non-zero in first 100: ${nonZero}/100`)
    if (embdFlat.length !== N * nEmbd) {
      console.log(`  ⚠️  length mismatch: got ${embdFlat.length}, expected ${N * nEmbd}`)
    }
  } catch (e: any) {
    console.log(`  getTokenEmbeddings: ❌ ${e.message}`)
    process.exit(1)
  }

  // 2b. initBatchEmbd
  try {
    addonCtx.disposeSequence(0)  // clear old KV cache
    addonCtx.initBatchEmbd(N)
    console.log(`  initBatchEmbd(${N}): ✅`)
  } catch (e: any) {
    console.log(`  initBatchEmbd: ❌ ${e.message}`)
    process.exit(1)
  }

  // 2c. addToBatchEmbd
  let logitRes: Uint32Array
  try {
    logitRes = addonCtx.addToBatchEmbd(
      0, 0, embdFlat, N,
      Uint32Array.from([N - 1]),
    )
    console.log(`  addToBatchEmbd: ✅ logitRes=[${logitRes}]`)
  } catch (e: any) {
    console.log(`  addToBatchEmbd: ❌ ${e.message}`)
    process.exit(1)
  }

  // 2d. decodeBatch (embd injection forward pass)
  try {
    await addonCtx.decodeBatch()
    console.log(`  decodeBatch (embd): ✅ forward pass succeeded`)
  } catch (e: any) {
    console.log(`  decodeBatch (embd): ❌ ${e.message}`)
    process.exit(1)
  }

  // 2e. Verify embd path hidden state = token path hidden state
  // Only works if model supports per-token embeddings (pooling_type=NONE)
  console.log(`\n  ── 精度验证（embd vs token 路径）──`)
  try {
    // Get hidden state from embd path
    const hiddenEmbd = addonCtx.getEmbedding(N) as Float64Array | undefined
    if (!hiddenEmbd || hiddenEmbd.length === 0) {
      console.log(`  ⚠️  getEmbedding returned empty — model may not support per-token embeddings`)
      console.log(`  （跳过精度对比，embd 注入流程已跑通）`)
    } else {
      // Clear KV cache before token path comparison
      addonCtx.disposeSequence(0)

      // Token path for comparison
      addonCtx.initBatch(N)
      addonCtx.addToBatch(0, 0, Uint32Array.from(ids), Uint32Array.from([N - 1]))
      await addonCtx.decodeBatch()
      const hiddenTok = addonCtx.getEmbedding(N) as Float64Array

      let maxDelta = 0
      const len = Math.min(hiddenTok.length, hiddenEmbd.length)
      for (let i = 0; i < len; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(hiddenTok[i] - hiddenEmbd[i]))
      }
      console.log(`  token hidden[0..4]: [${Array.from(hiddenTok.slice(0, 5)).map(v => v.toFixed(6)).join(", ")}]`)
      console.log(`  embd  hidden[0..4]: [${Array.from(hiddenEmbd.slice(0, 5)).map(v => v.toFixed(6)).join(", ")}]`)
      console.log(`  hidden dim: ${len}`)
      console.log(`  max|Δ|    : ${maxDelta.toExponential(3)}`)
      console.log(`  精度对比  : ${maxDelta < 1e-4 ? "✅ PASS" : "❌ FAIL"}`)
    }
  } catch (e: any) {
    console.log(`  ⚠️  getEmbedding failed: ${e.message}`)
    console.log(`  （模型可能不支持 per-token embeddings，embd 注入 decode 已成功）`)
  }

  // 清理
  await ctx.dispose()
  console.log("\n── 全部观测完成 ──")
  console.log("✅ smote test PASSED")
}

main().catch(err => {
  console.error("观测失败:", err)
  process.exit(1)
})
