#!/usr/bin/env npx tsx
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"
const M = "/Users/anrgct/llm_models/mradermacher/F2LLM-v2-80M-GGUF/F2LLM-v2-80M.Q8_0-pooling-NONE.gguf"

async function testBS(bs: number) {
  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: M, gpuLayers: 99 })
  const ctx = await model.createEmbeddingContext({ batchSize: bs } as any)
  try {
    const p = "这是测试段落用来生成长文本以测试pertokenembedding在大量token下是否能正确输出。"
    const text = Array.from({ length: 1500 }, (_, i) => `${i}.${p}`).join("\n")
    const embs = await ctx.getEmbeddingsForTokens(text)
    let nan = 0
    for (let i = 24576; i < embs.length; i++) if (embs[i].every(v => !Number.isFinite(v))) nan++
    const after = embs.length - 24576
    console.log(`batchSize=${bs}: tokens=${embs.length} batches=${Math.ceil(embs.length/bs)} batch4+ nan=${nan}/${after} ${nan===0?"✅":"❌"}`)
  } finally { await ctx.dispose().catch(()=>{}); await model.dispose().catch(()=>{}) }
}
async function main() {
  for (const bs of [8192, 6500, 5500, 4500]) await testBS(bs)
}
main()
