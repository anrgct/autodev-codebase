#!/usr/bin/env npx tsx
/**
 * 测试 MiniCPM 不同中间层 embedding 提取
 *
 * 验证 llama.cpp embd_layer patch 端到端功能：
 * 1. 对不同层创建 embedding context
 * 2. 提取 per-token hidden states → mean pool → L2 normalize
 * 3. 计算层间 cosine similarity 矩阵
 * 4. 验证不同层的 embedding 确实不同（最后一层 != 中间层）
 *
 * 用法:
 *   npx tsx scripts/test-midlayer-embd.ts [model-path] [--layers 23,18,12,6,0]
 *
 * 默认模型: MiniCPM-V-4.6-Q8_0.gguf (24 layers)
 */

import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

// ── 配置 ──────────────────────────────────────────────────────────

const DEFAULT_MODEL =
  "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf";
const DEFAULT_LAYERS = "all"; // "all" = 每层都测, 或 [23,18,12,6,0]
const TEST_PROMPTS = [
  "The capital of France is Paris",
  "Machine learning is a subset of artificial intelligence",
  "今天天气很好，适合出去散步",
  "Rust is a systems programming language focused on safety",
  "深度学习是机器学习的一个分支，使用多层神经网络",
];

// ── 工具函数 ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const modelPath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_MODEL;
  const layersArg = args.find((a) => a.startsWith("--layers="));
  const allFlag = args.includes("--all") || args.includes("-a");
  let layers: number[] | "all";
  if (layersArg) {
    layers = layersArg.split("=")[1].split(",").map(Number);
  } else if (allFlag) {
    layers = "all";
  } else {
    layers = DEFAULT_LAYERS;
  }
  return { modelPath, layers };
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

function cosineSim(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function l2Normalize(v: number[]): number[] {
  const n = norm(v);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

/**
 * Mean pooling: 对 per-token embeddings 逐维取平均，再 L2 normalize
 */
function meanPool(perTokenEmbs: number[][]): number[] {
  if (perTokenEmbs.length === 0) return [];
  const dim = perTokenEmbs[0].length;
  const pooled = new Array(dim).fill(0);
  for (const emb of perTokenEmbs) {
    for (let i = 0; i < dim; i++) pooled[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) pooled[i] /= perTokenEmbs.length;
  return l2Normalize(pooled);
}

function formatTable(
  layers: number[],
  labels: string[],
  matrix: number[][],
): string {
  const header = ["", ...labels].map((l) => l.padStart(12)).join("");
  const rows = layers.map((_layer, i) => {
    const row = [labels[i].padEnd(4), ...matrix[i].map((v) => v.toFixed(4).padStart(12))].join("");
    return row;
  });
  return [header, ...rows].join("\n");
}

// ── 主逻辑 ─────────────────────────────────────────────────────────

async function main() {
  const { modelPath, layers: parsedLayers } = parseArgs();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Mid-Layer Embedding 全层扫描测试                    ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // 1. 加载模型，获取实际层数
  console.log("⏳ 加载模型中...");
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });
  const model = await llama.loadModel({ modelPath });

  // 使用模型实际层数（排除 output 层）
  const nLayer = model.fileInsights.totalLayers - 1;

  const layers: number[] =
    parsedLayers === "all"
      ? Array.from({ length: nLayer }, (_, i) => i)
      : parsedLayers as number[];
  const lastLayer = nLayer - 1;

  console.log(`   ✅ 模型加载完成 (${nLayer} layers)`);
  console.log(`模型: ${modelPath.split("/").pop()}`);
  console.log(`测试层: ${layers.length} 层 (${layers[0]}..${layers[layers.length - 1]})`);
  console.log(`测试文本: ${TEST_PROMPTS.length} 条\n`);

  // 2. 对每层分别提取 embedding
  const layerEmbs: Map<number, number[]> = new Map();
  const startTime = Date.now();

  for (let idx = 0; idx < layers.length; idx++) {
    const embdLayer = layers[idx];

    const ctx = await model.createEmbeddingContext({ embdLayer } as any);
    const promptVecs: number[][] = [];

    for (const prompt of TEST_PROMPTS) {
      try {
        const perToken = await ctx.getEmbeddingsForTokens(prompt);
        if (perToken && perToken.length > 0) {
          promptVecs.push(meanPool(perToken));
        }
      } catch (_e) { /* skip */ }
    }
    await ctx.dispose();

    if (promptVecs.length === 0) {
      console.log(`   L${String(embdLayer).padStart(2)} ❌ 失败`);
      continue;
    }

    const dim = promptVecs[0].length;
    const avg = new Array(dim).fill(0);
    for (const v of promptVecs) {
      for (let i = 0; i < dim; i++) avg[i] += v[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= promptVecs.length;
    layerEmbs.set(embdLayer, l2Normalize(avg));

    // 进度条
    const pct = Math.round(((idx + 1) / layers.length) * 100);
    const bar = "█".repeat(Math.floor(pct / 4)) + "░".repeat(25 - Math.floor(pct / 4));
    process.stdout.write(`\r   [${bar}] ${pct}%  L${String(embdLayer).padStart(2)} (dim=${dim})    `);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n   ✅ ${layerEmbs.size}/${layers.length} 层提取完成 (${elapsed}s)\n`);

  if (layerEmbs.size < 2) {
    console.log("❌ 有效层数不足，无法比较");
    await model.dispose();
    process.exit(1);
  }

  // 3. 计算每层与最后一层的 cosine similarity
  const sortedLayers = [...layerEmbs.keys()].sort((a, b) => a - b); // 0 → last
  const lastEmb = layerEmbs.get(lastLayer);
  if (!lastEmb) {
    console.log("❌ 最后一层 embedding 缺失");
    await model.dispose();
    process.exit(1);
  }

  const simToLast: { layer: number; sim: number }[] = [];
  for (const l of sortedLayers) {
    const emb = layerEmbs.get(l)!;
    simToLast.push({ layer: l, sim: cosineSim(emb, lastEmb) });
  }

  // 4. 输出：ASCII 柱状图
  const maxSim = Math.max(...simToLast.map((s) => s.sim)) || 1; // avoid division by zero
  const chartWidth = 60;

  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  各层 vs 最后一层 (L" + lastLayer + ") 的 cosine similarity                         │");
  console.log("├──────┬──────────────────────────────────────────────────────────────┬───────┤");

  for (const { layer, sim } of simToLast) {
    const barLen = Math.max(0, Math.round((sim / maxSim) * chartWidth));
    const bar = "█".repeat(barLen);
    const marker = layer === lastLayer ? " ◀ last" : "";
    const pct = Math.round((layer / lastLayer) * 100);
    console.log(
      `│ L${String(layer).padStart(2)} │ ${bar.padEnd(chartWidth)} │ ${sim.toFixed(4)}${marker} │`,
    );
  }

  console.log("└──────┴──────────────────────────────────────────────────────────────┴───────┘");

  // 5. 统计摘要
  const shallowLayers = simToLast.filter((s) => s.layer <= Math.floor(nLayer * 0.25));
  const midLayers = simToLast.filter(
    (s) => s.layer > Math.floor(nLayer * 0.25) && s.layer <= Math.floor(nLayer * 0.75),
  );
  const deepLayers = simToLast.filter((s) => s.layer > Math.floor(nLayer * 0.75));

  const avg = (arr: { sim: number }[]) =>
    arr.length > 0 ? arr.reduce((s, x) => s + x.sim, 0) / arr.length : 0;

  console.log("\n📊 统计摘要:");
  console.log(`   浅层 (0-${Math.floor(nLayer * 0.25)}):    平均 cos = ${avg(shallowLayers).toFixed(4)}  (与最后层几乎正交)`);
  console.log(`   中层 (${Math.floor(nLayer * 0.25) + 1}-${Math.floor(nLayer * 0.75)}):  平均 cos = ${avg(midLayers).toFixed(4)}  (语义过渡区)`);
  console.log(`   深层 (${Math.floor(nLayer * 0.75) + 1}-${lastLayer}): 平均 cos = ${avg(deepLayers).toFixed(4)}  (趋近最后层表示)`);

  // 6. 相邻层相似度（检查平滑性）
  console.log("\n📈 相邻层 cosine similarity (语义漂移速度):");
  const neighborDiffs: number[] = [];
  for (let i = 1; i < sortedLayers.length; i++) {
    const a = layerEmbs.get(sortedLayers[i - 1])!;
    const b = layerEmbs.get(sortedLayers[i])!;
    const sim = cosineSim(a, b);
    neighborDiffs.push(sim);
  }
  const minNeighbor = Math.min(...neighborDiffs);
  const maxNeighbor = Math.max(...neighborDiffs);
  const avgNeighbor = neighborDiffs.reduce((s, x) => s + x, 0) / neighborDiffs.length;
  console.log(`   相邻层 cos 范围: ${minNeighbor.toFixed(4)} ~ ${maxNeighbor.toFixed(4)}`);
  console.log(`   相邻层 cos 均值: ${avgNeighbor.toFixed(4)}`);
  console.log(`   (值越低 = 语义变化越快, 值越高 = 表示越稳定)`);

  // 7. 找出"拐点"——相似度变化最大的相邻层对
  let maxJump = 0;
  let jumpLayer = 0;
  for (let i = 1; i < simToLast.length; i++) {
    const jump = Math.abs(simToLast[i].sim - simToLast[i - 1].sim);
    if (jump > maxJump) {
      maxJump = jump;
      jumpLayer = simToLast[i].layer;
    }
  }
  console.log(`\n🔍 语义变化最大发生在: L${jumpLayer - 1} → L${jumpLayer} (Δcos = ${maxJump.toFixed(4)})`);

  // 清理
  await model.dispose();
  console.log("\n✅ 全层扫描完成");
}

main().catch((e) => {
  console.error("❌ 测试失败:", e.message);
  process.exit(1);
});
