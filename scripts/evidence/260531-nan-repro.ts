#!/usr/bin/env npx tsx
/**
 * 复现并分析 F2LLM-v2-80M per-token embedding NaN 问题。
 *
 * 目的：
 * 1. 确认 NaN 出现在长文本的哪个位置
 * 2. 分析 NaN 是否与 micro-batch 边界对齐
 * 3. 测试不同 embdLayer 和 pooling 模式
 *
 * 用法:
 *   npx tsx scripts/evidence/260531-nan-repro.ts
 */

import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"

const MODEL_PATH = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"

async function main() {
  console.log("═══ F2LLM-v2-80M NaN 复现分析 ═══\n")

  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const trainCtx = model.trainContextSize ?? 4096
  console.log(`模型 context: ${trainCtx} tokens, ${model.fileInsights.totalLayers} 层总`)

  try {
    // ═══ Test 1: 短文本（基准） ═══
    console.log(`\n─── Test 1: 短文本 (embdLayer=7) ───`)
    await testEmbeddings(model, generateShortText(), 7)

    // ═══ Test 2: 中等长度 → 找 NaN 出现阈值 ═══
    const lengths = [512, 1024, 2048, 4096, 8192, 12288, 16384]
    for (const len of lengths) {
      if (len > trainCtx) continue
      console.log(`\n─── Test 2a: ~${len} tokens (embdLayer=7) ───`)
      await testEmbeddings(model, generateText(len, trainCtx), 7)
    }

    // ═══ Test 3: 长文本详细分析 ═══
    console.log(`\n─── Test 3: 长文本详细分析 (embdLayer=7) ───`)
    const longText = generateText(Math.floor(trainCtx * 0.85), trainCtx)
    await analyzeEmbeddings(model, longText, 7, 8192)

    // ═══ Test 4: embdLayer=-1 对照 ═══
    console.log(`\n─── Test 4: 长文本 (embdLayer=-1) ───`)
    await testEmbeddings(model, longText, -1)

  } finally {
    await model.dispose().catch(() => {})
  }
}

function generateShortText(): string {
  return "这是用来测试 per-token embedding 的一段短文本。包含多个句子来验证不同位置的 hidden state 是否有区分度。"
}

function generateText(targetTokens: number, ctxSize: number): string {
  const paragraph = "这是测试段落。用来生成长文本以测试 per-token embedding 在大量 token 下是否能正确输出不同位置的 hidden state。每个段落增加一些 token 来填充上下文。通过长文本验证 transformer hidden state 的数值稳定性。"
  const paraTokens = 28
  const count = Math.floor(targetTokens / paraTokens)
  return Array.from({ length: Math.max(count, 1) }, (_, i) => `${i}.${paragraph}`).join("\n")
}

async function testEmbeddings(model: any, text: string, embdLayer: number) {
  const ctx = await model.createEmbeddingContext({ embdLayer, batchSize: 8192 } as any)
  try {
    const textTokens = model.tokenize(text).length
    const embs = await ctx.getEmbeddingsForTokens(text)

    const stats = countEmbeddingStats(embs)
    console.log(`  input=${textTokens}t, output=${embs.length}vec, ` +
      `nan=${stats.nanTokens} (${(stats.nanTokens/embs.length*100).toFixed(1)}%), ` +
      `zero=${stats.zeroTokens} (${(stats.zeroTokens/embs.length*100).toFixed(1)}%), ` +
      `valid=${stats.validTokens} (${(stats.validTokens/embs.length*100).toFixed(1)}%)`)

    if (stats.firstValid >= 0) {
      const v = embs[stats.firstValid]
      console.log(`  firstValid[${stats.firstValid}][0..4]=[${v.slice(0,5).map(x=>x.toFixed(4)).join(', ')}]`)
    }
    if (stats.nanTokens > 0) {
      console.log(`  NaN 范围: [${stats.firstNaN}..${stats.lastNaN}] (连续 ${stats.nanTokens} 个)`)
    }
    if (stats.zeroTokens > 0) {
      console.log(`  Zero 范围: [${stats.firstZero}..${stats.lastZero}] (连续 ${stats.zeroTokens} 个)`)
    }

    return stats
  } finally {
    await ctx.dispose().catch(() => {})
  }
}

async function analyzeEmbeddings(
  model: any, text: string, embdLayer: number, batchSize: number
) {
  const ctx = await model.createEmbeddingContext({ embdLayer, batchSize } as any)
  try {
    const embs = await ctx.getEmbeddingsForTokens(text)
    const stats = countEmbeddingStats(embs)

    console.log(`  总向量: ${embs.length}, 维度: ${embs[0]?.length || 0}`)
    console.log(`  NaN: ${stats.nanTokens} 个, 范围 [${stats.firstNaN}..${stats.lastNaN}]`)
    console.log(`  Zero: ${stats.zeroTokens} 个, 范围 [${stats.firstZero}..${stats.lastZero}]`)
    console.log(`  Valid: ${stats.validTokens} 个`)

    // 分析 NaN 与 micro-batch 边界的关系
    console.log(`\n  ═══ NaN 区域分析 ═══`)
    const totalDims = (embs[0]?.length || 0)

    // 检查是否前 N 个全部 NaN，后面全部有效
    const nanThenValid = stats.lastNaN >= 0 && stats.firstValid > stats.lastNaN
    console.log(`  NaN-then-valid 模式: ${nanThenValid ? "✅ 是" : "❌ 否"}`)

    // 检查 NaN 边界与 batchSize 的关系
    if (stats.lastNaN >= 0) {
      const nanBlockStart = stats.firstNaN
      const nanBlockEnd = stats.lastNaN + 1
      console.log(`  NaN 块: [${nanBlockStart}, ${nanBlockEnd}) = ${nanBlockEnd - nanBlockStart} 个`)
      console.log(`  NaN 块 / batchSize = ${(nanBlockEnd / batchSize).toFixed(3)} 个批次`)

      // 检查是否是前 N 个 micro-batch 全部 NaN
      const fullNanBatches = Math.floor(nanBlockEnd / batchSize)
      const remainder = nanBlockEnd % batchSize
      console.log(`  完整 NaN 批次: ${fullNanBatches} 个 (各 ${batchSize} tokens)`)
      console.log(`  末尾残余: ${remainder} 个`)
    }

    // 检查有效区域的向量是否真正不同
    if (stats.validTokens >= 2) {
      const validStart = stats.firstValid
      const ref = embs[validStart]
      let sameCount = 0
      for (let i = validStart + 1; i < embs.length; i++) {
        if (embs[i].every((v: number, d: number) => !Number.isFinite(v))) continue
        if (embs[i].every((v: number) => v === 0)) continue
        let allSame = true
        for (let d = 0; d < totalDims; d++) {
          if (!Number.isFinite(embs[i][d])) continue
          if (Math.abs(embs[i][d] - ref[d]) > 1e-6) { allSame = false; break }
        }
        if (allSame) sameCount++
      }
      const distinctCount = stats.validTokens - sameCount - 1 // -1 for ref itself
      console.log(`  Valid 区域: ref=${validStart}, 全同=${sameCount}, 区分=${distinctCount}`)
    }

    // 打印 NaN→Valid 过渡区域的详细值（5个边界前后）
    if (stats.nanTokens > 0 && stats.validTokens > 0) {
      console.log(`\n  ═══ NaN→Valid 过渡区 ═══`)
      const border = stats.lastNaN
      for (let i = Math.max(0, border - 3); i <= Math.min(embs.length - 1, border + 3); i++) {
        const label = i <= border ? "NaN" : "Valid"
        const v = embs[i]
        const isNan = v.every((x: number) => !Number.isFinite(x))
        const isZero = v.every((x: number) => x === 0)
        const tag = isNan ? "NAN" : isZero ? "ZERO" : "OK"
        console.log(`  [${i}] ${tag}: ${v.slice(0, 5).map((x: number) => x.toExponential(3)).join(', ')}`)
      }
    }

    // 检查第一个有效批次的分布
    if (stats.firstValid >= 0 && stats.firstValid < embs.length) {
      console.log(`\n  ═══ 第一个有效批次分析 ═══`)
      const firstBatchStart = Math.floor(stats.firstValid / batchSize) * batchSize
      const batchEnd = Math.min(firstBatchStart + batchSize, embs.length)
      let nanInBatch = 0, zeroInBatch = 0, validInBatch = 0
      for (let i = firstBatchStart; i < batchEnd; i++) {
        const v = embs[i]
        if (v.every((x: number) => !Number.isFinite(x))) nanInBatch++
        else if (v.every((x: number) => x === 0)) zeroInBatch++
        else validInBatch++
      }
      console.log(`  Batch [${firstBatchStart}..${batchEnd}): nan=${nanInBatch}, zero=${zeroInBatch}, valid=${validInBatch}`)
    }

  } finally {
    await ctx.dispose().catch(() => {})
  }
}

function countEmbeddingStats(embs: number[][]) {
  let nanTokens = 0, zeroTokens = 0, validTokens = 0
  let firstNaN = -1, lastNaN = -1
  let firstZero = -1, lastZero = -1
  let firstValid = -1, lastValid = -1

  for (let i = 0; i < embs.length; i++) {
    const v = embs[i]
    const isNan = v.every((x: number) => !Number.isFinite(x))
    const isZero = v.every((x: number) => x === 0)

    if (isNan) {
      nanTokens++
      if (firstNaN < 0) firstNaN = i
      lastNaN = i
    } else if (isZero) {
      zeroTokens++
      if (firstZero < 0) firstZero = i
      lastZero = i
    } else {
      validTokens++
      if (firstValid < 0) firstValid = i
      lastValid = i
    }
  }

  return { nanTokens, zeroTokens, validTokens, firstNaN, lastNaN, firstZero, lastZero, firstValid, lastValid }
}

main().catch(err => { console.error(err); process.exit(1) })
