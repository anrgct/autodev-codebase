/**
 * 证据脚本：验证 jina-v5 的 getEmbeddingsForTokens 返回的是池化向量而非逐 token hidden states。
 *
 * 用法：
 *   npx tsx src/examples/evidence-jina-v5-pooling.ts
 *
 * 预期输出：
 *   - getEmbeddingsForTokens 对 "hello world" 返回 3 个向量
 *   - 所有向量完全相同（逐元素差 < 1e-6）
 *   - 等同于 getEmbeddingFor 返回的池化向量
 *
 * 结论：
 *   late-chunking 中按 chunk 边界取任意 token 位置都得到同一个向量，
 *   四种 pooling 模式效果完全一致——late-chunking 是 no-op。
 */

import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

const MODEL_PATH =
  "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0-pooling-NONE.gguf";

async function main() {
  console.log("=" .repeat(72));
  console.log("  jina-v5 getEmbeddingsForTokens 返回池化向量证据");
  console.log("=".repeat(72));

  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });
  const model = await llama.loadModel({ modelPath: MODEL_PATH });

  // ── 模型元数据 ──────────────────────────────────────────
  console.log("\n📦 模型元数据");
  console.log(`   architecture : ${model.fileInsights.architecture ?? "(undefined)"}`);
  console.log(`   totalLayers  : ${model.fileInsights.totalLayers}`);
  console.log(`   hasEncoder   : ${model.fileInsights.hasEncoder}`);
  console.log(`   hasDecoder   : ${model.fileInsights.hasDecoder}`);
  console.log(`   contextSize  : ${(model as any).trainContextSize}`);

  // ── 实验设计 ──────────────────────────────────────────
  const texts = [
    "def save_model(path): pass",           // chunk 1: 保存模型
    "def load_model(path): pass",           // chunk 2: 加载模型
    "# Utility functions for I/O",          // chunk 3: 工具函数
  ];
  const concatText = texts.join("\n\n");

  console.log("\n🧪 测试文本（模拟 3 个 chunk 拼接）");
  texts.forEach((t, i) => console.log(`   chunk ${i + 1}: "${t}"`));

  // ── 测试 1: getEmbeddingFor（标准池化 API） ─────────
  console.log("\n─── 测试 1: getEmbeddingFor（标准池化）───");
  const ctx1 = await model.createEmbeddingContext({} as any);
  const pooledEmb = await ctx1.getEmbeddingFor(concatText);
  const pooled = Array.from(pooledEmb.vector);
  console.log(`   维度       : ${pooled.length}`);
  console.log(`   [0..4]     : [${pooled.slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);
  await ctx1.dispose();

  // ── 测试 2: getEmbeddingsForTokens（逐 token API） ──
  console.log("\n─── 测试 2: getEmbeddingsForTokens（逐 token）───");
  const ctx2 = await model.createEmbeddingContext({} as any);
  const perToken = await ctx2.getEmbeddingsForTokens(concatText);
  console.log(`   token 数量  : ${perToken.length}`);

  // 逐元素比较
  const dim = perToken[0].length;
  const allSame = perToken.every((t) => {
    for (let d = 0; d < dim; d++) {
      if (Math.abs(t[d] - perToken[0][d]) > 1e-6) return false;
    }
    return true;
  });

  console.log(`   每个维度     : ${dim}`);
  console.log(`   token[0]    : [${perToken[0].slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);
  console.log(`   token[1]    : [${perToken[1].slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);
  if (perToken.length > 2) {
    console.log(`   token[-1]   : [${perToken[perToken.length - 1].slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);
  }
  console.log(`   ─────────────────────────────────────────────`);
  console.log(`   所有 token 向量完全相同?  ${allSame ? "✅ 是" : "❌ 否"}`);

  // ── 测试 3: 与池化向量比较 ──────────────────────────
  console.log("\n─── 测试 3: token 向量 vs 池化向量 ───");
  const sameAsPooled = perToken.every((t) => {
    for (let d = 0; d < dim; d++) {
      if (Math.abs(t[d] - pooled[d]) > 1e-6) return false;
    }
    return true;
  });
  console.log(`   token 向量 == 池化向量?  ${sameAsPooled ? "✅ 是（完全相同）" : "❌ 否"}`);

  // ── 测试 4: 模拟 late-chunking 按 span 取 last token ─
  console.log("\n─── 测试 4: 模拟 late-chunking per-chunk last-token ───");

  // tokenize 各 chunk, 计算 span（简化版 _computeTokenSpans 逻辑）
  const sepTokens = model.tokenize("\n\n");
  const sepLen = (sepTokens as any[]).length;  // Token[] → count
  const chunkLens = texts.map((t) => {
    const tokens = model.tokenize(t);
    return (tokens as any[]).length;
  });

  // 按 spans 取 last token
  let offset = 0;
  const chunkEmbs: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const end = offset + chunkLens[i];
    const lastIdx = Math.min(end - 1, perToken.length - 1);
    chunkEmbs.push(perToken[lastIdx]);
    console.log(`   chunk ${i + 1} span [${offset}, ${end}) → lastIdx=${lastIdx}`);
    console.log(`            [${perToken[lastIdx].slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);
    offset = end + (i < texts.length - 1 ? sepLen : 0);
  }

  // chunk 间余弦相似度
  console.log("\n   chunk 间余弦相似度（L2 归一化后）:");
  const norms = chunkEmbs.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
  for (let i = 0; i < chunkEmbs.length; i++) {
    for (let j = i + 1; j < chunkEmbs.length; j++) {
      let dot = 0;
      for (let d = 0; d < dim; d++) {
        dot += (chunkEmbs[i][d] / norms[i]) * (chunkEmbs[j][d] / norms[j]);
      }
      console.log(`   cos(chunk${i + 1}, chunk${j + 1}) = ${dot.toFixed(6)}`);
    }
  }

  await ctx2.dispose();

  // ── 测试 5（对照）: 独立 last-token 模式下单 chunk ──
  console.log("\n─── 测试 5: 对照 — 独立 last-token（模拟 last-token 模式）───");
  const ctx3 = await model.createEmbeddingContext({} as any);

  for (let i = 0; i < texts.length; i++) {
    const tk = await ctx3.getEmbeddingsForTokens(texts[i]);
    const last = tk[tk.length - 1];
    // 与 late-chunking 的 chunk embedding 比较
    let dot = 0;
    let nA = 0;
    let nB = 0;
    for (let d = 0; d < dim; d++) {
      dot += last[d] * chunkEmbs[i][d];
      nA += last[d] * last[d];
      nB += chunkEmbs[i][d] * chunkEmbs[i][d];
    }
    const cos = dot / (Math.sqrt(nA) * Math.sqrt(nB));
    console.log(`   chunk ${i + 1}: cos(late-chunked, last-token) = ${cos.toFixed(6)}`);
  }
  await ctx3.dispose();

  // ── 判决 ────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("  判决");
  console.log("=".repeat(72));
  console.log();
  if (allSame && sameAsPooled) {
    console.log("  ❌ getEmbeddingsForTokens 返回的是池化向量复制 N 次，");
    console.log("     不是真正的逐 token hidden states。");
    console.log();
    console.log("  → late-chunking 中所有 chunk 的 last-token embedding 相同");
    console.log("  → 四种 pooling 模式（late-chunking / last-token / mean / qr-weighted）");
    console.log("    对 jina-v5 效果完全一致——late-chunking 是 no-op。");
    console.log();
    console.log("  根因：jina-v5 GGUF 的 pooling_type 不是 NONE。");
    console.log("  修复：用 --pooling none 重新转换 GGUF，");
    console.log("        或换用因果 LLM（如 MiniCPM-V-4.6）做 late-chunking。");
  } else {
    console.log("  ✅ 逐 token hidden states 不同——late-chunking 应正常工作。");
  }
  console.log();
}

main().catch((err) => {
  console.error("脚本执行失败:", err);
  process.exit(1);
});
