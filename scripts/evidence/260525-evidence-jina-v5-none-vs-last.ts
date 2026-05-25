/**
 * 证据脚本：对比 jina-v5 在 pooling_type=NONE vs LAST 下的 embedding 输出。
 *
 * 用法：
 *   npx tsx src/examples/evidence-jina-v5-none-vs-last.ts
 *
 * 前置条件：
 *   - 需要 .bak_pooling_last 备份文件存在（原始 LAST 版本）
 *   - 脚本会自动切换 GGUF：NONE → 测试 → LAST → 测试 → 恢复 LAST
 *   - 因此 GGUF 当前状态无关紧要，脚本会自行处理
 *
 * 测试内容：
 *   1. NONE GGUF: Variant B (mean pool of content tokens, skip CLS)
 *   2. NONE GGUF: Variant D (last content token)
 *   3. LAST GGUF: pooled embedding (getEmbeddingFor)
 *   4. 三者的余弦相似度对比
 *   5. 三者各自的 inter-chunk 判别力
 *
 * 关键结论（2026-05-25）：
 *   - D (NONE last) ≡ LAST-gguf (cos=1.0) — 完全相同
 *   - B (NONE mean) ≠ LAST-gguf — 判别力优于 LAST
 *   - A (CLS) 不可用 — 同类 chunk cos=0.67
 */

import { getLlama, LlamaLogLevel } from "node-llama-cpp";
import { execSync } from "node:child_process";

const MODEL_PATH =
  "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0.gguf";
const MODEL_BAK = MODEL_PATH + ".bak_pooling_last";

function cosSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d] * b[d];
    na += a[d] * a[d];
    nb += b[d] * b[d];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const texts = [
  "def save_model(path): pass",
  "def train_model(data): pass",
  "# Utility functions for I/O",
  "class Model:",
  "def predict(x): return x",
];

async function main() {
  // Ensure GGUF starts as NONE for the first two passes
  console.log("[Setting GGUF to NONE for testing...]");
  execSync(
    `python3 -c "
import struct, os
f = open('${MODEL_PATH}', 'r+b')
data = f.read()
idx = data.find(b'eurobert.pooling_type')
kl = struct.unpack('<Q', data[idx-8:idx])[0]
vo = idx + kl + 4
f.seek(vo)
f.write(struct.pack('<I', 0))
f.flush(); os.fsync(f.fileno()); f.close()
print('Set to NONE')
"`,
  );

  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });

  // ═══════════════════════════════════════════════
  // Pass 1: NONE GGUF → Variant B (mean content[1..])
  // ═══════════════════════════════════════════════
  console.log("=== NONE GGUF: Variant B (mean pool, skip CLS) ===\n");
  const modelNone = await llama.loadModel({ modelPath: MODEL_PATH });
  const noneEmbB: number[][] = [];
  for (const text of texts) {
    const ctx = await modelNone.createEmbeddingContext({} as any);
    const pt = await ctx.getEmbeddingsForTokens(text);
    const dim = pt[0].length;
    const content = pt.slice(1); // skip CLS at position 0
    const mean = new Array(dim).fill(0);
    for (const e of content) for (let d = 0; d < dim; d++) mean[d] += e[d];
    for (let d = 0; d < dim; d++) mean[d] /= content.length;
    noneEmbB.push(mean);
    console.log(`  "${text.slice(0, 40)}" → ${mean.slice(0, 4).map((v: number) => v.toFixed(4))}`);
    await ctx.dispose();
  }

  // ═══════════════════════════════════════════════
  // Pass 2: NONE GGUF → Variant D (last content token)
  // ═══════════════════════════════════════════════
  console.log("\n=== NONE GGUF: Variant D (last token) ===\n");
  const modelNone2 = await llama.loadModel({ modelPath: MODEL_PATH });
  const noneEmbD: number[][] = [];
  for (const text of texts) {
    const ctx = await modelNone2.createEmbeddingContext({} as any);
    const pt = await ctx.getEmbeddingsForTokens(text);
    noneEmbD.push(pt[pt.length - 1]);
    console.log(`  "${text.slice(0, 40)}" → ${pt[pt.length - 1].slice(0, 4).map((v: number) => v.toFixed(4))}`);
    await ctx.dispose();
  }
  await (modelNone as any).dispose?.();
  await (modelNone2 as any).dispose?.();

  // ═══════════════════════════════════════════════
  // Switch to LAST GGUF
  // ═══════════════════════════════════════════════
  console.log("\n[Switching GGUF to LAST...]");
  execSync(`cp "${MODEL_BAK}" "${MODEL_PATH}"`);

  // ═══════════════════════════════════════════════
  // Pass 3: LAST GGUF → pooled embedding
  // ═══════════════════════════════════════════════
  console.log("\n=== LAST GGUF: Pooled embedding ===\n");
  const modelLast = await llama.loadModel({ modelPath: MODEL_PATH });
  const lastEmb: number[][] = [];
  for (const text of texts) {
    const ctx = await modelLast.createEmbeddingContext({} as any);
    const pooled = await ctx.getEmbeddingFor(text);
    const pv = Array.from(pooled.vector);
    lastEmb.push(pv);
    console.log(`  "${text.slice(0, 40)}" → ${pv.slice(0, 4).map((v: number) => v.toFixed(4))}`);
    await ctx.dispose();
  }
  await (modelLast as any).dispose?.();

  // ═══════════════════════════════════════════════
  // Cross-mode cosine similarity
  // ═══════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  Cross-mode Cosine Similarity");
  console.log("═".repeat(60) + "\n");

  for (let i = 0; i < texts.length; i++) {
    console.log(`"${texts[i].slice(0, 45)}":`);
    console.log(`  cos(B-mean   , D-last)    = ${cosSim(noneEmbB[i], noneEmbD[i]).toFixed(4)}`);
    console.log(`  cos(B-mean   , LAST-gguf) = ${cosSim(noneEmbB[i], lastEmb[i]).toFixed(4)}`);
    console.log(`  cos(D-last   , LAST-gguf) = ${cosSim(noneEmbD[i], lastEmb[i]).toFixed(4)}`);
  }

  // ═══════════════════════════════════════════════
  // Inter-chunk discrimination
  // ═══════════════════════════════════════════════
  console.log("\n─── Inter-chunk cos (lower = better discrimination) ───");
  for (const [label, embs] of [
    ["B (NONE mean pool)", noneEmbB],
    ["D (NONE last token)", noneEmbD],
    ["LAST-gguf (pooled)", lastEmb],
  ] as [string, number[][]][]) {
    console.log(`\n  ${label}:`);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        console.log(`    cos("${texts[i].slice(0, 20)}", "${texts[j].slice(0, 20)}") = ${cosSim(embs[i], embs[j]).toFixed(4)}`);
      }
    }
  }

  // ═══════════════════════════════════════════════
  // Restore GGUF to LAST (production state)
  // ═══════════════════════════════════════════════
  console.log("\n[Restoring GGUF to LAST (production state)...]");
  execSync(
    `python3 -c "
import struct, os
f = open('${MODEL_PATH}', 'r+b')
data = f.read()
idx = data.find(b'eurobert.pooling_type')
kl = struct.unpack('<Q', data[idx-8:idx])[0]
vo = idx + kl + 4
f.seek(vo)
f.write(struct.pack('<I', 3))
f.flush(); os.fsync(f.fileno()); f.close()
print('Restored to LAST')
"`,
  );
  console.log("Done.");
}

main().catch(console.error);
