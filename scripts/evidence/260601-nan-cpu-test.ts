#!/usr/bin/env npx tsx
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"
const M = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"
async function main() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: M, gpuLayers: 0 })
  const ctx = await model.createEmbeddingContext({ batchSize: 8192 } as any)
  try {
    const p = "这是测试段落用来生成长文本以测试pertokenembedding在大量token下是否能正确输出。"
    const text = Array.from({length: 1300}, (_,i) => `${i}.${p}`).join("\n")
    const tokens = model.tokenize(text).length
    console.log(`CPU: tokens=${tokens} batches=${Math.ceil(tokens/8192)}`)
    if (tokens <= 24576) { console.log("⚠ too few tokens to trigger batch 4"); return }
    const t0 = Date.now()
    const embs = await ctx.getEmbeddingsForTokens(text)
    let nan=0, ok=0
    for (const v of embs) { v.every(x => !Number.isFinite(x)) ? nan++ : ok++ }
    console.log(`valid=${ok} nan=${nan} time=${(Date.now()-t0)/1000}s → ${nan==0?"✅ CPU OK":"❌ CPU NaN"}`)
  } finally { await ctx.dispose().catch(()=>{}); await model.dispose().catch(()=>{}) }
}
main().catch(e => console.error(e.message))
