// 验证长文本下 getEmbeddingsForTokens 的零向量问题
import { getLlama, LlamaLogLevel } from "node-llama-cpp"

const MODEL_PATH = "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0-pooling-NONE.gguf"

async function main() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: MODEL_PATH })

  // 生成长文本 ~2000 tokens
  const text = "# Ultralytics YOLO\nclass Model:\n  def __init__(self):\n    pass\n  def train(self):\n    pass\n  def predict(self):\n    pass\n".repeat(60)
  const tokens = model.tokenize(text).length
  console.log(`total tokens: ${tokens}`)

  // 测试不同配置
  const configs = [
    { label: "默认 {}", opts: {} },
    { label: "batchSize=8192", opts: { batchSize: 8192 } },
    { label: "batchSize=8192+embdLayer=11", opts: { batchSize: 8192, embdLayer: 11 } },
  ]

  for (const cfg of configs) {
    const ctx = await model.createEmbeddingContext(cfg.opts as any)
    const embs = await ctx.getEmbeddingsForTokens(text)
    let zeroCount = 0, lastValid = -1
    for (let i = 0; i < embs.length; i++) {
      const sum = embs[i].reduce((a: number, b: number) => a + Math.abs(b), 0)
      if (sum === 0) zeroCount++
      else lastValid = i
    }
    const firstZero = (() => { for (let i = 0; i < embs.length; i++) { const s = embs[i].reduce((a: number, b: number) => a + Math.abs(b), 0); if (s === 0) return i } return -1 })()
    console.log(`\n${cfg.label}:`)
    console.log(`  embeddings: ${embs.length}, dim: ${embs[0].length}`)
    console.log(`  零向量: ${zeroCount}/${embs.length}`)
    console.log(`  首个零向量位置: ${firstZero}`)
    console.log(`  最后有效位置: ${lastValid}`)
    await ctx.dispose()
  }

  // 也测一下 trainContextSize
  console.log(`\nmodel metadata:`)
  console.log(`  contextSize: ${(model as any).trainContextSize}`)
  
  await model.dispose()
}
main().catch(console.error)
