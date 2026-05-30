#!/usr/bin/env npx tsx
/**
 * 复现 F2LLM-v2-80M per-token embedding 全零/NaN 的 bug。
 * 比较短文本 vs 长文本（接近 context 上限），embdLayer=7 vs -1。
 *
 * 用法:
 *   npx tsx scripts/evidence/260530-per-token-zero-repro.ts
 *   npx tsx scripts/evidence/260530-per-token-zero-repro.ts --runner <embdLayer> <short|long>
 *
 * 说明: 当带 --runner 参数时，执行实际的模型加载和 embedding 测试；
 *       否则作为调度器，通过子进程运行自身并过滤 C++ 原生层 stderr 噪音。
 */

import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"

const MODEL_PATH = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"
const SHORT_TEXT = "这是用来测试 per-token embedding 的一段短文本。"

// ═══════════════════════════════════════════════════════════════
// Runner mode: --runner <embdLayer> <short|long>
// ═══════════════════════════════════════════════════════════════
async function runRunner() {
  const embdLayer = parseInt(process.argv[3] || "7", 10)
  const textType = process.argv[4] || "short"

  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ embdLayer, batchSize: 8192 } as any)

  try {
    let text: string
    if (textType === "short") {
      text = SHORT_TEXT
    } else {
      const ctxSize = model.trainContextSize ?? 4096
      const targetTokens = Math.floor(ctxSize * 0.85)
      const paragraph = "这是测试段落。用来生成长文本以测试 per-token embedding 在大量 token 下是否能正确输出不同位置的 hidden state。每个段落增加一些 token 来填充上下文。"
      const testPara = `0.${paragraph}`
      const paraTokens = model.tokenize(testPara).length
      const count = Math.floor(targetTokens / paraTokens)
      text = Array.from({ length: Math.max(count, 1) }, (_, i) => `${i}.${paragraph}`).join("\n")
    }

    const textTokens = model.tokenize(text).length
    console.log(`input: ${textTokens} tokens`)

    const embs = await ctx.getEmbeddingsForTokens(text)
    if (embs.length === 0) { console.log(`→ ❌ 0 tokens returned`); return }

    let nanTokens = 0, zeroTokens = 0, okTokens = 0, firstOkIdx = -1
    for (let t = 0; t < embs.length; t++) {
      const vec = embs[t]
      const isNaN = vec.every(v => !Number.isFinite(v))
      const isZero = vec.every(v => v === 0)
      if (isNaN) nanTokens++
      else if (isZero) zeroTokens++
      else okTokens++
      if (firstOkIdx < 0 && !isNaN && !isZero) firstOkIdx = t
    }

    const isDistinct = embs.some((t, ti) => {
      if (ti === 0) return false
      for (let d = 0; d < embs[0].length; d++) {
        if (Math.abs(t[d] - embs[0][d]) > 1e-6) return true
      }
      return false
    })

    console.log(`tokens=${embs.length}, nan=${nanTokens}, zero=${zeroTokens}, valid=${okTokens}`)
    if (firstOkIdx >= 0) {
      const v = embs[firstOkIdx]
      console.log(`ref[0..6]=[${v.slice(0, 7).map(x => x.toExponential(3)).join(', ')}]`)
    }
    console.log(`→ ${(okTokens > 0 && isDistinct) ? '✅ per-token 正常' : '❌ 全部无效或全同'}`)
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════
// Scheduler mode (default): run each test in subprocess, filter C++ noise
// ═══════════════════════════════════════════════════════════════
async function runScheduler() {
  console.log(`F2LLM-v2-80M per-token embedding — 短/长文本对比\n`)

  const selfPath = fileURLToPath(import.meta.url)
  const tests: Array<[string, string, string]> = [
    ["短文本 embdLayer=7",  "7",  "short"],
    ["短文本 embdLayer=-1", "-1", "short"],
    ["长文本 embdLayer=7",  "7",  "long"],
    ["长文本 embdLayer=-1", "-1", "long"],
  ]

  for (const [label, embdLayer, textType] of tests) {
    console.log(`═══ ${label} ═══`)
    try {
      const out = execSync(
        `npx tsx "${selfPath}" --runner ${embdLayer} ${textType} 2>&1`,
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
      ) as string
      const lines = out.trim().split("\n")
      const cppCount = lines.filter(l => l.includes("invalid embeddings id")).length
      for (const line of lines.filter(l => !l.includes("invalid embeddings id") && !l.includes("batch.logits"))) {
        console.log(`  ${line}`)
      }
      if (cppCount > 0) {
        const first = lines.find(l => l.includes("invalid embeddings id"))?.match(/\d+/)?.[0] ?? "?"
        const lastId = [...lines].reverse().find(l => l.includes("invalid embeddings id"))?.match(/id (\d+)/)?.[1] ?? "?"
        const reason = lines.find(l => l.includes("reason:"))?.match(/reason: .+/)?.[0] ?? "?"
        console.log(`  ⚠ C++ ${cppCount} warnings (id ${first} … ${lastId}, ${reason})`)
      }
    } catch (e: any) {
      console.log(`  ❌ ${e.message?.slice(0, 100) || e}`)
    }
    console.log()
  }

  console.log(`═══════════════════════════════════════════`)
  console.log(`结论：短文本正常 → C++ addon 无 bug`)
  console.log(`      长文本失败  → llama_get_embeddings_ith slot 限制 (batchSize)`)
}

// ═══════════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════════
if (process.argv[2] === "--runner") {
  runRunner().catch(err => { console.error(err.message); process.exit(1) })
} else {
  runScheduler()
}
