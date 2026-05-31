#!/usr/bin/env npx tsx
/**
 * P12 验证后的诊断脚本：精确测试 NaN 边界。
 * 
 * 发现：P12 将 8192 zero → 8192 NaN，证明 NaN 来自 transformer 计算而非 ggml_get_rows。
 * 本脚本测试不同 token 总数下的行为，精确确定触发条件。
 *
 * 用法:
 *   npx tsx scripts/evidence/260601-nan-boundary-test.ts
 *   npx tsx scripts/evidence/260601-nan-boundary-test.ts --tokens 25000
 *   npx tsx scripts/evidence/260601-nan-boundary-test.ts --tokens 24577
 */
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"

const MODEL_PATH = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"

async function main() {
  const targetTokens = parseInt(process.argv[3] || "25000", 10)
  
  console.log(`\n═══ F2LLM-v2-80M NaN 边界测试: ${targetTokens} tokens ═══`)
  
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ batchSize: 8192 } as any)
  
  try {
    // Generate text of approximately targetTokens length
    const paragraph = "这是测试段落。用来生成长文本以测试 per-token embedding 在大量 token 下是否能正确输出不同位置的 hidden state。每个段落增加一些 token 来填充上下文。"
    const paraTokens = model.tokenize(`0.${paragraph}`).length
    const count = Math.max(Math.floor(targetTokens / paraTokens), 1)
    const text = Array.from({ length: count }, (_, i) => `${i}.${paragraph}`).join("\n")
    
    const actualTokens = model.tokenize(text).length
    console.log(`input: ${actualTokens} tokens (target: ${targetTokens})`)
    console.log(`batches: ${Math.ceil(actualTokens / 8192)} × 8192, last: ${actualTokens % 8192 || 8192}`)
    
    if (actualTokens <= 24576) {
      console.log(`⚠  total ≤ 24576 (3×8192), 无法测试边界——需 > 24576`)
    }
    
    const embs = await ctx.getEmbeddingsForTokens(text)
    if (embs.length === 0) { console.log(`→ ❌ 0 tokens returned`); return }
    
    // Per-batch analysis
    let nanTokens = 0, zeroTokens = 0, okTokens = 0
    const batchSize = 8192
    const numBatches = Math.ceil(embs.length / batchSize)
    
    for (let b = 0; b < numBatches; b++) {
      const start = b * batchSize
      const end = Math.min(start + batchSize, embs.length)
      let bNan = 0, bZero = 0, bOk = 0
      
      for (let t = start; t < end; t++) {
        const vec = embs[t]
        const isNaN = vec.every(v => !Number.isFinite(v))
        const isZero = vec.every(v => v === 0)
        if (isNaN) { bNan++; nanTokens++ }
        else if (isZero) { bZero++; zeroTokens++ }
        else { bOk++; okTokens++ }
      }
      
      const status = bOk === (end - start) ? "✅" : bNan === (end - start) ? "❌ NaN" : bZero === (end - start) ? "⬜ zero" : "⚠ mixed"
      console.log(`  batch ${b + 1}/${numBatches}: pos[${start}..${end - 1}] (${end - start} tokens) → ${status} | ok=${bOk} nan=${bNan} zero=${bZero}`)
    }
    
    console.log(`total: tokens=${embs.length}, nan=${nanTokens}, zero=${zeroTokens}, valid=${okTokens}`)
    
    // Show first value from first ok token and first NaN token
    const firstOk = embs.findIndex(v => !v.every(x => !Number.isFinite(x)) && !v.every(x => x === 0))
    const firstNan = embs.findIndex(v => v.every(x => !Number.isFinite(x)))
    if (firstOk >= 0) console.log(`  first valid[${firstOk}]: [${embs[firstOk].slice(0,5).map(x => x.toExponential(3)).join(', ')}]`)
    if (firstNan >= 0) console.log(`  first NaN[${firstNan}]: [${embs[firstNan].slice(0,5).map(x => String(x)).join(', ')}]`)
    
  } finally {
    await ctx.dispose().catch(() => {})
    await model.dispose().catch(() => {})
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
