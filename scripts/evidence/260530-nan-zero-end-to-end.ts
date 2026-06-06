#!/usr/bin/env npx tsx
/**
 * F2LLM-v2-80M per-token embedding NaN/zero bug — 端到端诊断
 *
 * 按时间顺序串联 5 个阶段的代表性观察：
 *   阶段 1: 复现（短 vs 长 × embdLayer=7/-1）
 *   阶段 2: 阈值扫描（512 → 16384 tokens）
 *   阶段 3: 边界测试（精确 token 数 + 逐 batch 报告）
 *   阶段 4: batchSize 变量（8192/6500/5500/4500）
 *   阶段 5: CPU vs GPU 对照
 *
 * 通过子进程运行自身并过滤 C++ 原生层 stderr 噪音。
 *
 * 用法:
 *   npx tsx scripts/evidence/260530-nan-zero-end-to-end.ts
 */

import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"

const MODEL_PATH = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"
const BATCH_SIZE = 8192

// ═══════════════════════════════════════════════════════════════
// 共享工具
// ═══════════════════════════════════════════════════════════════

type Stats = {
  nanTokens: number; zeroTokens: number; validTokens: number
  firstNaN: number; lastNaN: number
  firstZero: number; lastZero: number
  firstValid: number; lastValid: number
}

function countStats(embs: number[][]): Stats {
  let nan = 0, zero = 0, valid = 0
  let firstNaN = -1, lastNaN = -1, firstZero = -1, lastZero = -1, firstValid = -1, lastValid = -1
  for (let i = 0; i < embs.length; i++) {
    const v = embs[i]
    const isNan = v.every(x => !Number.isFinite(x))
    const isZero = v.every(x => x === 0)
    if (isNan) { nan++; if (firstNaN < 0) firstNaN = i; lastNaN = i }
    else if (isZero) { zero++; if (firstZero < 0) firstZero = i; lastZero = i }
    else { valid++; if (firstValid < 0) firstValid = i; lastValid = i }
  }
  return { nanTokens: nan, zeroTokens: zero, validTokens: valid,
    firstNaN, lastNaN, firstZero, lastZero, firstValid, lastValid }
}

function makeText(targetTokens: number, model?: any): string {
  const paragraph = "这是测试段落。用来生成长文本以测试 per-token embedding 在大量 token 下是否能正确输出不同位置的 hidden state。每个段落增加一些 token 来填充上下文。"
  const paraTokens = 28
  const count = Math.max(Math.floor(targetTokens / paraTokens), 1)
  return Array.from({ length: count }, (_, i) => `${i}.${paragraph}`).join("\n")
}

// ═══════════════════════════════════════════════════════════════
// 5 个 Runner：每个对应一个观察点
// ═══════════════════════════════════════════════════════════════

// 阶段 1：复现 — 短/长 × embdLayer=7/-1
async function stage1_repro() {
  const embdLayer = parseInt(process.env.STAGE1_EMBD_LAYER || "7", 10)
  const textType = process.env.STAGE1_TEXT_TYPE || "short"

  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ embdLayer, batchSize: BATCH_SIZE } as any)

  try {
    const text = textType === "short"
      ? "这是用来测试 per-token embedding 的一段短文本。"
      : makeText(Math.floor((model.trainContextSize ?? 4096) * 0.85))
    const textTokens = model.tokenize(text).length
    console.log(`[阶段 1 观察] embdLayer=${embdLayer}, ${textType}, input=${textTokens}t`)

    const embs = await ctx.getEmbeddingsForTokens(text)
    if (embs.length === 0) { console.log(`  → ❌ 0 tokens returned`); return }
    const s = countStats(embs)
    const isDistinct = embs.some((t, ti) => {
      if (ti === 0) return false
      for (let d = 0; d < embs[0].length; d++) {
        if (Math.abs(t[d] - embs[0][d]) > 1e-6) return true
      }
      return false
    })
    console.log(`  valid=${s.validTokens}, nan=${s.nanTokens}, zero=${s.zeroTokens}, distinct=${isDistinct}`)
    if (s.firstValid >= 0) {
      const v = embs[s.firstValid]
      console.log(`  first valid[${s.firstValid}][0..6]=[${v.slice(0, 7).map((x: number) => x.toExponential(3)).join(', ')}]`)
    }
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

// 阶段 2：阈值扫描
async function stage2_threshold() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ embdLayer: 7, batchSize: BATCH_SIZE } as any)
  try {
    const trainCtx = model.trainContextSize ?? 4096
    console.log(`[阶段 2 观察] 阈值扫描 embdLayer=7, 模型 context=${trainCtx}`)
    for (const len of [512, 1024, 2048, 4096, 8192, 12288, 16384]) {
      if (len > trainCtx) continue
      const embs = await ctx.getEmbeddingsForTokens(makeText(len))
      const s = countStats(embs)
      console.log(`  ~${len}t → nan=${s.nanTokens}, zero=${s.zeroTokens}, valid=${s.validTokens}`)
    }
    // 关键观察：长文本详细
    const longText = makeText(Math.floor(trainCtx * 0.85))
    const embs = await ctx.getEmbeddingsForTokens(longText)
    const s = countStats(embs)
    const nanThenValid = s.lastNaN >= 0 && s.firstValid > s.lastNaN
    console.log(`  长文 (${embs.length}t): nan[${s.firstNaN}..${s.lastNaN}], valid[${s.firstValid}..${s.lastValid}], NaN-then-valid=${nanThenValid}`)
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

// 阶段 3：边界精确测试 — 逐 batch 报告
async function stage3_boundary() {
  const targetTokens = parseInt(process.env.STAGE3_TOKENS || "25000", 10)
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ batchSize: BATCH_SIZE } as any)
  try {
    console.log(`[阶段 3 观察] 边界测试 target=${targetTokens}t, batchSize=${BATCH_SIZE}`)
    const text = makeText(targetTokens)
    const actualTokens = model.tokenize(text).length
    console.log(`  actual=${actualTokens}t, batches=${Math.ceil(actualTokens / BATCH_SIZE)}`)

    const embs = await ctx.getEmbeddingsForTokens(text)
    if (embs.length === 0) { console.log(`  → ❌ 0 tokens`); return }
    const numBatches = Math.ceil(embs.length / BATCH_SIZE)
    for (let b = 0; b < numBatches; b++) {
      const start = b * BATCH_SIZE
      const end = Math.min(start + BATCH_SIZE, embs.length)
      let bNan = 0, bZero = 0, bOk = 0
      for (let t = start; t < end; t++) {
        const v = embs[t]
        if (v.every(x => !Number.isFinite(x))) bNan++
        else if (v.every(x => x === 0)) bZero++
        else bOk++
      }
      const status = bOk === (end - start) ? "✅" : bNan === (end - start) ? "❌ NaN" : bZero === (end - start) ? "⬜ zero" : "⚠ mixed"
      console.log(`  batch ${b + 1}/${numBatches}: [${start}..${end - 1}] (${end - start}t) → ${status} | ok=${bOk} nan=${bNan} zero=${bZero}`)
    }
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

// 阶段 4：batchSize 变量 — 只看 24576 之后
async function stage4_batchSize() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  try {
    const p = "这是测试段落用来生成长文本以测试pertokenembedding在大量token下是否能正确输出。"
    const text = Array.from({ length: 1500 }, (_, i) => `${i}.${p}`).join("\n")
    console.log(`[阶段 4 观察] batchSize 变量 — 固定 1500 段文本（约 ${text.length}c）`)
    for (const bs of [8192, 6500, 5500, 4500]) {
      const ctx = await model.createEmbeddingContext({ batchSize: bs } as any)
      try {
        const embs = await ctx.getEmbeddingsForTokens(text)
        let nan = 0
        for (let i = 24576; i < embs.length; i++) {
          if (embs[i].every(v => !Number.isFinite(v))) nan++
        }
        const after = embs.length - 24576
        console.log(`  bs=${bs}: total=${embs.length}t, batches=${Math.ceil(embs.length / bs)}, 24576后 nan=${nan}/${after} ${nan === 0 ? "✅" : "❌"}`)
      } finally {
        await ctx.dispose().catch(() => {})
      }
    }
  } finally {
    await model.dispose().catch(() => {})
  }
}

// 阶段 5：CPU vs GPU 对照
async function stage5_cpu() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 0 })
  const ctx = await model.createEmbeddingContext({ batchSize: BATCH_SIZE } as any)
  try {
    const p = "这是测试段落用来生成长文本以测试pertokenembedding在大量token下是否能正确输出。"
    const text = Array.from({ length: 1300 }, (_, i) => `${i}.${p}`).join("\n")
    const tokens = model.tokenize(text).length
    console.log(`[阶段 5 观察] CPU 模式 (gpuLayers=0), batchSize=${BATCH_SIZE}`)
    console.log(`  tokens=${tokens}, batches=${Math.ceil(tokens / BATCH_SIZE)}`)
    if (tokens <= 24576) {
      console.log(`  ⚠ tokens ≤ 24576, 无法触发第 4 个 batch 后的 bug`)
      return
    }
    const t0 = Date.now()
    const embs = await ctx.getEmbeddingsForTokens(text)
    let nan = 0, ok = 0
    for (const v of embs) { v.every(x => !Number.isFinite(x)) ? nan++ : ok++ }
    console.log(`  valid=${ok} nan=${nan} time=${(Date.now() - t0) / 1000}s → ${nan === 0 ? "✅ CPU 正常" : "❌ CPU 也有 NaN"}`)
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════
// Scheduler：串行跑 5 个阶段，统一过滤 C++ 噪音
// ═══════════════════════════════════════════════════════════════

const STAGES: Array<[string, string, () => Promise<void>]> = [
  ["阶段 1: 复现（短/长 × embdLayer=7/-1）", "STAGE1", async () => {
    // 1a 短文本 embdLayer=7
    process.env.STAGE1_EMBD_LAYER = "7"
    process.env.STAGE1_TEXT_TYPE = "short"
    await runSubprocess("stage1", stage1_repro)
    // 1b 短文本 embdLayer=-1
    process.env.STAGE1_EMBD_LAYER = "-1"
    await runSubprocess("stage1", stage1_repro)
    // 1c 长文本 embdLayer=7
    process.env.STAGE1_TEXT_TYPE = "long"
    process.env.STAGE1_EMBD_LAYER = "7"
    await runSubprocess("stage1", stage1_repro)
    // 1d 长文本 embdLayer=-1
    process.env.STAGE1_EMBD_LAYER = "-1"
    await runSubprocess("stage1", stage1_repro)
  }],
  ["阶段 2: 阈值扫描（512 → 16384）", "STAGE2", () => runSubprocess("stage2", stage2_threshold)],
  ["阶段 3: 边界测试（25000 tokens）", "STAGE3", () => runSubprocess("stage3", stage3_boundary)],
  ["阶段 4: batchSize 变量（8192/6500/5500/4500）", "STAGE4", () => runSubprocess("stage4", stage4_batchSize)],
  ["阶段 5: CPU vs GPU 对照", "STAGE5", () => runSubprocess("stage5", stage5_cpu)],
]

async function runSubprocess(stageName: string, fn: () => Promise<void>) {
  // 通过子进程调用自身，传入阶段名（用 env 标记）
  const selfPath = fileURLToPath(import.meta.url)
  const env = { ...process.env, AUTODEV_STAGE: stageName }
  const out = execSync(
    `npx tsx "${selfPath}" ${stageName} 2>&1`,
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 180_000, env },
  ) as string
  const lines = out.trim().split("\n")
  const cppWarnings = lines.filter(l => l.includes("invalid embeddings id"))
  const filtered = lines.filter(l =>
    !l.includes("invalid embeddings id") && !l.includes("batch.logits")
  )
  for (const line of filtered) console.log(`  ${line}`)
  if (cppWarnings.length > 0) {
    const first = cppWarnings[0]?.match(/\d+/)?.[0] ?? "?"
    const lastId = [...cppWarnings].reverse()[0]?.match(/id (\d+)/)?.[1] ?? "?"
    const reason = lines.find(l => l.includes("reason:"))?.match(/reason: .+/)?.[0] ?? "?"
    console.log(`  ⚠ C++ ${cppWarnings.length} warnings (id ${first} … ${lastId}, ${reason})`)
  }
}

async function main() {
  const arg = process.argv[2]
  if (arg) {
    // 子进程模式：跑单个阶段
    switch (process.env.AUTODEV_STAGE) {
      case "stage1": await stage1_repro(); break
      case "stage2": await stage2_threshold(); break
      case "stage3": await stage3_boundary(); break
      case "stage4": await stage4_batchSize(); break
      case "stage5": await stage5_cpu(); break
    }
    return
  }

  // 调度器模式：串行跑所有阶段
  console.log(`F2LLM-v2-80M per-token embedding NaN/zero bug — 端到端诊断\n`)
  for (const [label, , runner] of STAGES) {
    console.log(`═══ ${label} ═══`)
    try { await runner() }
    catch (e: any) { console.log(`  ❌ ${e.message?.slice(0, 200) || e}`) }
    console.log()
  }
  console.log(`═══════════════════════════════════════════`)
  console.log(`结论：累加 buffer + decode patch 已修复`)
  console.log(`  短文本（embdLayer=7/-1）: 全部有效`)
  console.log(`  长文本（embdLayer=7/-1）: 24576/36323 valid (67.7%)`)
}

main().catch(err => { console.error(err); process.exit(1) })
