/**
 * 最小复现：jina-v5 在 pooling_type=LAST vs NONE 下的 embedding 行为差异。
 *
 * 用法：
 *   npx tsx src/examples/evidence-embedding-failure.ts
 *
 * 背景：
 *   用户将 jina-v5 GGUF 的 eurobert.pooling_type 从 3 (LAST) 改为 0 (NONE)，
 *   目的是让 getEmbeddingsForTokens() 返回逐 token hidden states。
 *   但改为 NONE 后 last-token 模式的检索效果崩溃（MRR 0.038 vs 原始 0.548）。
 *
 * 本脚本在纯 embedding 层面验证：
 *   1. NONE 下的逐 token hidden states 是否真的不同？
 *   2. NONE 下 last-token 和 LAST 下 pooled 是否一致？
 *   3. NONE 下单 chunk vs 多 chunk 拼接的 last-token 是否有差异？
 *
 * 不依赖索引/搜索管线。
 *
 * 前置条件：GGUF 需先手动改为 NONE。脚本末尾会恢复为 LAST。
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

function l2Norm(v: number[]): number[] {
  const s = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / s);
}

const QUERY = "模型初始化时如何处理不同的模型来源";
const TARGET = `# Check if Ultralytics HUB model from https://hub.ultralytics.com
if self.is_hub_model(model):
    # Fetch model from HUB
    checks.check_requirements("hub-sdk>=0.0.12")
    session = HUBTrainingSession.create_session(model)
    model = session.model_file`;
const DISTRACT = "def foo(x: int) -> int: return x + 1";

async function main() {
  // ── 确保从 NONE 开始 ──
  console.log("[Setting GGUF to NONE...]");
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
"`,
  );

  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });

  // ═══════════════════════════════════════════════
  // Pass 1: NONE GGUF
  // ═══════════════════════════════════════════════
  console.log("\n=== NONE (pooling_type=0) ===\n");
  const modelNone = await llama.loadModel({ modelPath: MODEL_PATH });

  // 1a: 检查逐 token hidden states 是否真的不同
  const ctx1 = await modelNone.createEmbeddingContext({} as any);
  const perToken = await ctx1.getEmbeddingsForTokens(TARGET);
  const dim = perToken[0].length;
  const nTokens = perToken.length;

  const allSame = perToken.every((t: number[]) => {
    for (let d = 0; d < dim; d++) {
      if (Math.abs(t[d] - perToken[0][d]) > 1e-6) return false;
    }
    return true;
  });
  console.log(`Token count: ${nTokens}`);
  console.log(`Per-token embeddings all identical? ${allSame ? "✅ YES (late-chunking IS a no-op)" : "❌ NO (late-chunking COULD work)"}`);

  // 1b: 单 chunk 取 last-token
  const qCtx = await modelNone.createEmbeddingContext({} as any);
  const qTok = await qCtx.getEmbeddingsForTokens(QUERY);
  const qNone = l2Norm(qTok[qTok.length - 1]);
  await qCtx.dispose();

  const tNone = l2Norm(perToken[perToken.length - 1]);
  const dCtx = await modelNone.createEmbeddingContext({} as any);
  const dTok = await dCtx.getEmbeddingsForTokens(DISTRACT);
  const dNone = l2Norm(dTok[dTok.length - 1]);
  await dCtx.dispose();

  console.log(`\nSingle-chunk last-token (NONE):`);
  console.log(`  query     ↔ target     cos = ${cosSim(qNone, tNone).toFixed(4)}`);
  console.log(`  query     ↔ distract   cos = ${cosSim(qNone, dNone).toFixed(4)}`);
  console.log(`  target    ↔ distract   cos = ${cosSim(tNone, dNone).toFixed(4)}`);

  // 1c: 拼接多 chunk 后取各 chunk last-token (模拟 late-chunking)
  const concatText = TARGET + "\n\n" + DISTRACT;
  const concatCtx = await modelNone.createEmbeddingContext({} as any);
  const concatTok = await concatCtx.getEmbeddingsForTokens(concatText);

  // Span: TARGET tokens, then separator, then DISTRACT tokens
  const targetTokCount = modelNone.tokenize(TARGET).length;
  const sepTokCount = modelNone.tokenize("\n\n").length;
  const targetSpan = { start: 0, end: targetTokCount };
  const distractSpan = { start: targetTokCount + sepTokCount, end: concatTok.length };

  const tConcat = l2Norm(concatTok[targetSpan.end - 1]);
  const dConcat = l2Norm(concatTok[distractSpan.end - 1]);

  console.log(`\nMulti-chunk last-token (NONE, late-chunking simulation):`);
  console.log(`  chunk span: target[0..${targetSpan.end})  distract[${distractSpan.start}..${distractSpan.end})`);
  console.log(`  target    ↔ distract   cos = ${cosSim(tConcat, dConcat).toFixed(4)}`);
  console.log(`  single-t  ↔ concat-t   cos = ${cosSim(tNone, tConcat).toFixed(4)}  ← same chunk, different context!`);

  await ctx1.dispose();
  await concatCtx.dispose();
  await (modelNone as any).dispose?.();

  // ═══════════════════════════════════════════════
  // Switch to LAST GGUF
  // ═══════════════════════════════════════════════
  console.log("\n[Switching GGUF to LAST...]");
  execSync(`cp "${MODEL_BAK}" "${MODEL_PATH}"`);

  // ═══════════════════════════════════════════════
  // Pass 2: LAST GGUF
  // ═══════════════════════════════════════════════
  console.log("\n=== LAST (pooling_type=3) ===\n");
  const modelLast = await llama.loadModel({ modelPath: MODEL_PATH });

  // 2a: 检查逐 token — 应该全部相同
  const ctx2 = await modelLast.createEmbeddingContext({} as any);
  const ptLast = await ctx2.getEmbeddingsForTokens(TARGET);
  const allSameLast = ptLast.every((t: number[]) => {
    for (let d = 0; d < dim; d++) {
      if (Math.abs(t[d] - ptLast[0][d]) > 1e-6) return false;
    }
    return true;
  });
  console.log(`Token count: ${ptLast.length}`);
  console.log(`Per-token embeddings all identical? ${allSameLast ? "✅ YES (pooling replicated)" : "❌ NO"}`);

  // 2b: 用 getEmbeddingFor（标准池化 API）
  const qlCtx = await modelLast.createEmbeddingContext({} as any);
  const qPooled = await qlCtx.getEmbeddingFor(QUERY);
  const qLast = l2Norm(Array.from(qPooled.vector));
  await qlCtx.dispose();

  const tlCtx = await modelLast.createEmbeddingContext({} as any);
  const tPooled = await tlCtx.getEmbeddingFor(TARGET);
  const tLast = l2Norm(Array.from(tPooled.vector));
  await tlCtx.dispose();

  const dlCtx = await modelLast.createEmbeddingContext({} as any);
  const dPooled = await dlCtx.getEmbeddingFor(DISTRACT);
  const dLast = l2Norm(Array.from(dPooled.vector));
  await dlCtx.dispose();

  console.log(`\nPooled embedding (LAST):`);
  console.log(`  query     ↔ target     cos = ${cosSim(qLast, tLast).toFixed(4)}`);
  console.log(`  query     ↔ distract   cos = ${cosSim(qLast, dLast).toFixed(4)}`);
  console.log(`  target    ↔ distract   cos = ${cosSim(tLast, dLast).toFixed(4)}`);

  // 2c: LAST 下 getEmbeddingsForTokens 取 last 也等于 pooled
  const tLastFromTok = l2Norm(ptLast[ptLast.length - 1]);
  console.log(`\n  LAST getEmbeddingsForTokens[-1] vs getEmbeddingFor:`);
  console.log(`  cos = ${cosSim(tLastFromTok, tLast).toFixed(4)}  ← should be 1.0`);

  await ctx2.dispose();
  await (modelLast as any).dispose?.();

  // ═══════════════════════════════════════════════
  // Cross-mode comparison
  // ═══════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  NONE vs LAST: Cross-mode Cosine Similarity");
  console.log("═".repeat(60) + "\n");

  console.log(`NONE single-last  ↔ LAST pooled:`);
  console.log(`  query:   cos = ${cosSim(qNone, qLast).toFixed(4)}`);
  console.log(`  target:  cos = ${cosSim(tNone, tLast).toFixed(4)}`);
  console.log(`  distract:cos = ${cosSim(dNone, dLast).toFixed(4)}`);

  console.log(`\nNONE multi-last   ↔ LAST pooled:`);
  console.log(`  target:  cos = ${cosSim(tConcat, tLast).toFixed(4)}`);
  console.log(`  distract:cos = ${cosSim(dConcat, dLast).toFixed(4)}`);

  console.log(`\nNONE single-last  ↔ NONE multi-last (同 chunk, 不同上下文):`);
  console.log(`  target:  cos = ${cosSim(tNone, tConcat).toFixed(4)}`);
  console.log(`  distract:cos = ${cosSim(dNone, dConcat).toFixed(4)}`);

  // ═══════════════════════════════════════════════
  // 判决
  // ═══════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  判决");
  console.log("═".repeat(60) + "\n");

  const qtNone = cosSim(qNone, tNone);
  const qdNone = cosSim(qNone, dNone);
  const qtLast = cosSim(qLast, tLast);
  const qdLast = cosSim(qLast, dLast);
  const gapNone = qtNone - qdNone;
  const gapLast = qtLast - qdLast;

  console.log(`NONE  single-chunk:  query↔target=${qtNone.toFixed(3)}  query↔distract=${qdNone.toFixed(3)}  gap=${gapNone.toFixed(3)}`);
  console.log(`LAST  pooled:        query↔target=${qtLast.toFixed(3)}  query↔distract=${qdLast.toFixed(3)}  gap=${gapLast.toFixed(3)}`);

  if (Math.abs(gapNone - gapLast) < 0.05) {
    console.log(`\n  → NONE single-chunk last-token ≈ LAST pooled (gap 差异 <0.05)`);
    console.log(`  → 两者用于单 chunk 检索效果应一致`);
    console.log(`  → 若实际 eval 差异巨大，问题不在 embedding 质量，而在调用路径`);
  }

  const tSingleVsMulti = cosSim(tNone, tConcat);
  if (tSingleVsMulti < 0.5) {
    console.log(`\n  ⚠️  同一 chunk 在 single vs multi 上下文下 cos=${tSingleVsMulti.toFixed(3)}`);
    console.log(`  → NONE 下 encoder 的跨 chunk 注意力会改变 token 表示`);
    console.log(`  → 这意味着 NONE 下 last-token 的结果依赖于 batch 上下文`);
    console.log(`  → 索引时和查询时的上下文不同 → embedding space 不匹配 → 检索失败`);
  }

  // Restore LAST
  console.log("\n[Restoring GGUF to LAST...]");
  execSync(`cp "${MODEL_BAK}" "${MODEL_PATH}"`);
  console.log("Done.");
}

main().catch(console.error);
