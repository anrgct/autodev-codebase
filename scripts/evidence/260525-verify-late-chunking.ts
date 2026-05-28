/**
 * 在 BPE span 修复后，验证 late-chunking 的 embedding 质量。
 *
 * 核心问题：同一段代码在"独立编码"(last-token)和"拼接编码"(late-chunking)
 * 下的 last-token embedding 余弦相似度是多少？
 */
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import { readFileSync } from "node:fs"
import path from "node:path"

const MODEL_PATH = "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0-pooling-NONE.gguf"
const CODE_PATH = path.resolve(import.meta.dirname ?? __dirname, "../../demo/model.py")

function cosSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let d = 0; d < a.length; d++) {
    dot += a[d] * b[d]
    na += a[d] * a[d]
    nb += b[d] * b[d]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function l2Norm(v: number[]): number[] {
  const s = Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  if (s === 0) return v.map(() => 0)
  return v.map(x => x / s)
}

function computeSpansProgressive(
  model: any,
  texts: string[],
  separator: string,
  prefixLen: number,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let prevEnd = prefixLen
  for (let i = 0; i < texts.length; i++) {
    const prefix = texts.slice(0, i + 1).join(separator)
    const tokens = model.tokenize(prefix).map((t: any) => typeof t === "number" ? t : Number(t))
    const currEnd = tokens.length
    spans.push({ start: prevEnd, end: currEnd })
    prevEnd = currEnd
  }
  return spans
}

async function main() {
  console.log("=".repeat(70))
  console.log("  Late-chunking vs Single-chunk 诊断 (BPE span 修复后)")
  console.log("=".repeat(70))

  const llama = await getLlama({ logLevel: LlamaLogLevel.warn })
  const model = await llama.loadModel({ modelPath: MODEL_PATH })

  const codeText = readFileSync(CODE_PATH, "utf-8")
  const SEP = "\n\n"

  // 取真实代码 chunk：用前 3 个逻辑区
  const lines = codeText.split("\n")
  const chunk1 = lines.slice(0, 40).join("\n")
  const chunk2 = lines.slice(40, 80).join("\n")
  const chunk3 = lines.slice(80, 120).join("\n")

  const QUERIES = [
    "模型初始化时如何处理不同的模型来源",
    "train 末尾用 best/last 权重更新模型",
    "export 文档中的 format/half/int8 等参数",
  ]

  // ── 1. 独立编码 (last-token 模式) ──
  console.log("\n[1] 独立编码 (single-chunk last-token)")
  const sEmbs: number[][] = []
  for (const text of [chunk1, chunk2, chunk3]) {
    const ctx = await model.createEmbeddingContext({ batchSize: 8192 } as any)
    const tok = await ctx.getEmbeddingsForTokens(text)
    const emb = l2Norm(tok[tok.length - 1])
    sEmbs.push(emb)
    console.log(`  ${text.slice(0, 50).replace(/\n/g, " ")}: ${tok.length} tokens`)
    await ctx.dispose()
  }

  const qEmbs: number[][] = []
  for (const q of QUERIES) {
    const ctx = await model.createEmbeddingContext({ batchSize: 8192 } as any)
    const tok = await ctx.getEmbeddingsForTokens(q)
    qEmbs.push(l2Norm(tok[tok.length - 1]))
    await ctx.dispose()
  }

  // ── 2. 拼接编码 (late-chunking, 用修复后的 progressive prefix) ──
  console.log("\n[2] 拼接编码 (late-chunking, BPE span 修复)")
  const bodyText = chunk1 + SEP + chunk2 + SEP + chunk3
  const fullTokens = model.tokenize(bodyText).map((t: any) => typeof t === "number" ? t : Number(t))
  const spans = computeSpansProgressive(model, [chunk1, chunk2, chunk3], SEP, 0)

  console.log(`  bodyText tokens: ${fullTokens.length}`)
  console.log(`  spans: [${spans.map(s => `[${s.start},${s.end})`).join(", ")}]`)

  // 验证 span 总和
  const spanEnd = spans[spans.length - 1].end
  if (spanEnd !== fullTokens.length) {
    console.log(`  ❌ span 总和 ${spanEnd} != fullTokens ${fullTokens.length} — span 计算仍有 bug!`)
  } else {
    console.log(`  ✅ span 总和 = fullTokens = ${fullTokens.length}`)
  }

  const lcCtx = await model.createEmbeddingContext({ batchSize: 8192 } as any)
  let embs = await lcCtx.getEmbeddingsForTokens(bodyText)

  // CLS trim
  if (embs.length === fullTokens.length + 1) {
    console.log("  → CLS trim: slice(1)")
    embs = embs.slice(1)
  } else if (embs.length !== fullTokens.length) {
    console.log(`  ❌ embeddings 数 ${embs.length} != tokens ${fullTokens.length}`)
    await lcCtx.dispose()
    await model.dispose()
    return
  }

  const lEmbs_last = spans.map(s => l2Norm(embs[s.end - 1]))
  // 也试 mean pool
  const lEmbs_mean = spans.map(s => {
    const chunkEmbs = embs.slice(s.start, s.end)
    const dim = chunkEmbs[0].length
    const pooled = new Array(dim).fill(0)
    for (const e of chunkEmbs) {
      for (let d = 0; d < dim; d++) pooled[d] += e[d]
    }
    for (let d = 0; d < dim; d++) pooled[d] /= chunkEmbs.length
    return l2Norm(pooled)
  })
  await lcCtx.dispose()

  // ── 3. 对比 ──
  console.log("\n" + "=".repeat(70))
  console.log("  对比")
  console.log("=".repeat(70))

  // 3a: 同 chunk single vs late-chunking（两种 pooling）
  console.log("\n  ▶ 同 chunk: single vs late-chunking")
  for (let i = 0; i < 3; i++) {
    const c_last = cosSim(sEmbs[i], lEmbs_last[i])
    const c_mean = cosSim(sEmbs[i], lEmbs_mean[i])
    console.log(`   chunk${i+1}: last=${c_last.toFixed(4)}  mean=${c_mean.toFixed(4)}`)
  }

  // 3b: Query vs chunk (single-chunk)
  console.log("\n  ▶ Query vs chunk (single-chunk, last-token 模式):")
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const scores = sEmbs.map((e, ci) => ({ label: `chunk${ci+1}`, score: cosSim(qEmbs[qi], e) }))
    scores.sort((a, b) => b.score - a.score)
    const correct = scores[0].label === `chunk${qi+1}`
    console.log(`   q[${qi}] "${QUERIES[qi].slice(0, 16)}..."  Top1=${scores[0].label} score=${scores[0].score.toFixed(4)} ${correct ? "✅" : "❌"}`)
  }

  // 3c: Query vs chunk (late-chunking, last-token pool)
  console.log("\n  ▶ Query vs chunk (late-chunking last-token pool):")
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const scores = lEmbs_last.map((e, ci) => ({ label: `chunk${ci+1}`, score: cosSim(qEmbs[qi], e) }))
    scores.sort((a, b) => b.score - a.score)
    const correct = scores[0].label === `chunk${qi+1}`
    console.log(`   q[${qi}] "${QUERIES[qi].slice(0, 16)}..."  Top1=${scores[0].label} score=${scores[0].score.toFixed(4)} ${correct ? "✅" : "❌"}`)
  }

  // 3d: Query vs chunk (late-chunking, mean pool)
  console.log("\n  ▶ Query vs chunk (late-chunking mean pool):")
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const scores = lEmbs_mean.map((e, ci) => ({ label: `chunk${ci+1}`, score: cosSim(qEmbs[qi], e) }))
    scores.sort((a, b) => b.score - a.score)
    const correct = scores[0].label === `chunk${qi+1}`
    console.log(`   q[${qi}] "${QUERIES[qi].slice(0, 16)}..."  Top1=${scores[0].label} score=${scores[0].score.toFixed(4)} ${correct ? "✅" : "❌"}`)
  }

  await model.dispose()
}

main().catch(console.error)
