#!/usr/bin/env npx tsx
/**
 * A/B 实验：QRRanker prefill vs decode attention 对比
 *
 * 验证假设：当前在 prefill 阶段取 attention 导致 `}` 等纯符号行在 top-K 中占比过高。
 * 如果改在 decode 阶段（prefill 后生成 N 个 token）取 attention，分布是否更聚焦于语义内容？
 *
 * 用法:
 *   npx tsx scripts/evidence/260605-decode-attention-comparison.ts
 *   npx tsx scripts/evidence/260605-decode-attention-comparison.ts --n-decode=5
 *
 * 输出:
 *   stdout — 详细对比报告（两组 top-20 + 统计）
 *   /tmp/decode-attention-result.txt — 同内容
 */

import * as fs from "fs";
import * as path from "path";
import { getLlama, LlamaLogLevel, type Token } from "@realtimex/node-llama-cpp";

const MODEL_PATH =
  "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf";
const TARGET_FILE = "src/code-index/embedders/llamacpp-llm.ts";
const QUERY = "高度概括代码";

// ── QR Heads（从 qrranker.ts 同步） ─────────────────────────────
const QR_HEADS: Array<{ layer: number; head: number }> = [
  { layer: 20, head: 15 }, { layer: 21, head: 11 }, { layer: 17, head: 27 },
  { layer: 23, head: 10 }, { layer: 22, head:  4 }, { layer: 21, head: 10 },
  { layer: 21, head:  8 }, { layer: 21, head: 18 }, { layer: 18, head: 15 },
  { layer: 18, head: 19 }, { layer: 17, head: 25 }, { layer: 17, head: 17 },
  { layer: 24, head: 13 }, { layer: 17, head:  4 }, { layer: 19, head: 12 },
  { layer: 21, head: 31 },
];
const QR_START_LAYER = 17;
const QR_END_LAYER = 25;
const QR_QRRANKER_NLAYER = 25;
const QR_ORIGINAL_NLAYER = 36;
const QR_SOURCE_NHEAD = 32;

// ── CLI 参数 ────────────────────────────────────────────────
function parseArgs(): { nDecode: number } {
  const args = process.argv.slice(2);
  let nDecode = 3;
  for (const a of args) {
    if (a.startsWith("--n-decode=")) nDecode = parseInt(a.slice("--n-decode=".length), 10);
    else if (a === "--help" || a === "-h") {
      console.log("用法: npx tsx scripts/evidence/260605-decode-attention-comparison.ts [--n-decode=N]");
      process.exit(0);
    }
  }
  if (nDecode < 1 || nDecode > 200) throw new Error(`--n-decode 必须在 1..200 之间，得到 ${nDecode}`);
  return { nDecode };
}

// ── Prompt（与 qrranker.ts buildPrompt 同步，但加 正确的 chatml 结束符） ──
//
// 原生 MiniCPM-V-4.6 chatml 模板末尾：
//   <|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n
// 第一个控制 "进入 assistant 模式"，第二个空 think 块控制 "跳过思考直接回答"。
// 之前 buildPrompt 缺这三行，模型继续在 user 模式生成 (复述 query + 自己 think)。
function buildPrompt(query: string, codeChunk: string): string {
  return (
    "<|im_start|>user\nHere are some retrieved chunks:\n\n" +
    `[1] Title: code\n${codeChunk}\n\n` +
    "Use the retrieved chunks to answer the user's query.\n\n" +
    `Query: ${query}<|im_end|>\n` +
    "<|im_start|>assistant\n" +
    "<think>\n\n</think>\n\n"
  );
}

// ── 纯符号行判定（与 qrranker.ts isPureSymbolLine 同步） ───────
function isPureSymbolLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 3) return false;
  return !/[\p{L}\p{N}_]/u.test(trimmed);
}

// ── Token → Line 映射（与 qrranker.ts tokensToLines 同步，不含 penalty） ─
function tokensToLines(
  codeChunk: string,
  codeLines: string[],
  perTokenScores: Float32Array,
  codeStart: number,
  codeEnd: number,
  tokens: Token[],
  model: { detokenize: (toks: Token[]) => string },
): number[] {
  const codeChars = codeChunk.length;
  const codeTokenCount = codeEnd - codeStart;
  if (codeTokenCount === 0) return new Array(codeLines.length).fill(0);

  const lineCharEnds: number[] = new Array(codeLines.length);
  let charAcc = 0;
  for (let li = 0; li < codeLines.length; li++) {
    charAcc += codeLines[li].length + (li < codeLines.length - 1 ? 1 : 0);
    lineCharEnds[li] = charAcc;
  }

  const lineScores = new Array<number>(codeLines.length).fill(0);
  const lineCounts = new Array<number>(codeLines.length).fill(0);

  let detokAcc = 0;
  for (let ti = 0; ti < codeTokenCount; ti++) {
    const tokenScore = perTokenScores[codeStart + ti];
    const text = model.detokenize([tokens[codeStart + ti]]);

    let codePos: number;
    if (text.length > 0) {
      const searchFrom = Math.max(0, detokAcc - 5);
      const searchTo = Math.min(codeChars, detokAcc + text.length + 10);
      const idx = codeChunk.indexOf(text, searchFrom);
      if (idx >= 0 && idx < searchTo) {
        codePos = idx;
        detokAcc = idx + text.length;
      } else {
        codePos = detokAcc;
        detokAcc += text.length;
      }
    } else {
      codePos = detokAcc;
    }

    if (codePos < 0 || codePos >= codeChars) continue;

    let lineStart = 0;
    for (let i = 0; i < codeLines.length; i++) {
      if (codePos >= lineStart && codePos < lineCharEnds[i]) {
        lineScores[i] += tokenScore;
        lineCounts[i]++;
        break;
      }
      lineStart = lineCharEnds[i];
    }
  }

  for (let i = 0; i < lineScores.length; i++) {
    if (lineCounts[i] > 0) lineScores[i] /= lineCounts[i];
  }

  return lineScores;
}

// ── 从 kq_soft_max 聚合 per-kv 分数（与 qrranker.ts computePerTokenScores 同步） ─
function aggregateKqSoftMax(
  context: any,
  queryStart: number,
  queryEnd: number,
  nModelLayerBlocks: number,
  nHead: number,
  silent = false,
): Float32Array {
  const shape = context.getKqSoftMaxShape();
  const nKv = shape.nKv;
  const nTokens = shape.nTokens;
  const layers: number[] = shape.layers;

  if (!silent) {
    console.log(`  kq_soft_max shape: nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, nLayers=${shape.nLayers}, layers=[${layers.join(",")}]`);
  }

  const scores = new Float32Array(nKv);
  let validHeads = 0;

  for (const { layer: rawLayer, head: rawHead } of QR_HEADS) {
    const head = nHead === QR_SOURCE_NHEAD
      ? rawHead
      : Math.min(Math.round(rawHead * nHead / QR_SOURCE_NHEAD), nHead - 1);
    const layer = nModelLayerBlocks === QR_QRRANKER_NLAYER
      ? rawLayer
      : Math.min(Math.round(rawLayer * nModelLayerBlocks / QR_ORIGINAL_NLAYER), nModelLayerBlocks - 1);

    const layerData = context.getKqSoftMax(layer);
    if (!layerData) {
      if (!silent) console.log(`  [skip] layer ${layer} (raw=${rawLayer}) data missing`);
      continue;
    }

    const nQueryTokens = queryEnd - queryStart;
    for (let q = 0; q < nQueryTokens; q++) {
      for (let kv = 0; kv < nKv; kv++) {
        scores[kv] += layerData[head * nTokens * nKv + q * nKv + kv];
      }
    }
    validHeads++;
  }

  const normalizer = validHeads * (queryEnd - queryStart);
  if (normalizer > 0) {
    for (let kv = 0; kv < nKv; kv++) scores[kv] /= normalizer;
  }

  return scores;
}

// ── 统计 top-K ─────────────────────────────────────────────
interface TopKEntry {
  rank: number;
  lineNumber: number;
  text: string;
  score: number;
  isPureSymbol: boolean;
}

function computeTopK(
  lineScores: number[],
  codeLines: string[],
  startLine: number,
  k: number,
): TopKEntry[] {
  return lineScores
    .map((s, i) => ({ score: s, index: i }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry, rank) => ({
      rank: rank + 1,
      lineNumber: startLine + entry.index,
      text: codeLines[entry.index],
      score: entry.score,
      isPureSymbol: isPureSymbolLine(codeLines[entry.index]),
    }))
    .sort((a, b) => a.lineNumber - b.lineNumber);
}

function countPureSymbol(entries: TopKEntry[]): number {
  return entries.filter((e) => e.isPureSymbol).length;
}

// ── 日志 helper ────────────────────────────────────────────
const logLines: string[] = [];
function log(s: string) {
  console.log(s);
  logLines.push(s);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const { nDecode } = parseArgs();

  log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
  log(`║  QRRanker Prefill vs Decode Attention A/B 对比实验                       ║`);
  log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  log(`Model:       ${path.basename(MODEL_PATH)}`);
  log(`Target file: ${TARGET_FILE}`);
  log(`Query:       ${QUERY}`);
  log(`N decode:    ${nDecode}`);
  log(`Sampling:    greedy (temperature=0)`);

  // 读取目标文件
  const codeChunk = fs.readFileSync(TARGET_FILE, "utf-8");
  const codeLines = codeChunk.split("\n");
  const startLine = 1;
  log(`Code chunk:  ${codeLines.length} lines, ${codeChunk.length} chars`);

  // 加载模型
  log(`\n[load] Loading model...`);
  const t0 = Date.now();
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled, gpu: "metal" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  log(`[load] Model loaded in ${Date.now() - t0}ms`);
  const nModelLayerBlocks = model.fileInsights.totalLayers - 1;

  // 构建 prompt & tokenize
  const fullPrompt = buildPrompt(QUERY, codeChunk);
  const allTokens = model.tokenize(fullPrompt);
  log(`[tokenize] Full prompt: ${allTokens.length} tokens`);

  // 定位 code/query token 范围（与 qrranker.ts tokenizeWithRanges 同步）
  const codeTokens = model.tokenize(codeChunk);
  const suffixMarker = model.tokenize("Use the retrieved chunks");
  const queryFull = `Query: ${QUERY}`;
  const queryFullTokens = model.tokenize(queryFull);

  function findSubseq(haystack: Token[], needle: Token[], from = 0): number {
    if (needle.length === 0) return -1;
    const firstId = Number(needle[0]);
    for (let i = from; i <= haystack.length - needle.length; i++) {
      if (Number(haystack[i]) !== firstId) continue;
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (Number(haystack[i + j]) !== Number(needle[j])) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  const codeStart = findSubseq(allTokens, codeTokens.slice(0, 3), 0);
  const suffixStart = codeStart >= 0 ? findSubseq(allTokens, suffixMarker, codeStart) : -1;
  const codeEnd = suffixStart > codeStart ? suffixStart : allTokens.length;
  const queryStart = suffixStart >= 0 ? findSubseq(allTokens, queryFullTokens, suffixStart) : -1;
  const queryEnd = queryStart >= 0 ? queryStart + queryFullTokens.length : allTokens.length;

  log(`[tokenize] code [${codeStart}, ${codeEnd}), query [${queryStart}, ${queryEnd})`);

  // 创建 context
  const batchSize = Math.min(allTokens.length, 4096);
  const context = await model.createContext({
    contextSize: Math.min(model.trainContextSize ?? 32768, allTokens.length + 1024),
    batchSize,
    sequences: 1,
    flashAttention: false,
    collectKqSoftMax: true,
  } as any);

  try {
    const sequence = context.getSequence();

    // ─── Layer range scaling（与 qrranker.ts 同步） ───
    if (nModelLayerBlocks !== QR_QRRANKER_NLAYER) {
      const mappedStart = Math.round(QR_START_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      const mappedEnd = Math.round(QR_END_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      context.setKqSoftMaxLayerRange(mappedStart, mappedEnd);
      log(`[ctx] Layer range scaled: [${mappedStart}, ${mappedEnd})`);
    }

    // ============================================================
    // 流程：使用 evaluate() async generator（一次性）
    //   iter 1 (i=0): decode prompt, sample, yield token_1
    //     query range = [queryStart, queryEnd] → 收集 prefill attention
    //   iter 2 (i=1): decode token_1 at position promptLength, sample, yield token_2
    //     之前 set range = [promptLength, promptLength+1] → 收集 token_1 位置 attention
    //   iter k (i=k-1): decode token_{k-1} at position promptLength+k-2, yield token_k
    //     之前 set range = [promptLength+k-2, promptLength+k-1] → 收集 token_{k-1} 位置 attention
    //
    // 因此我们总共需要 nDecode 次 .next()（生成 nDecode 个 token），
    // iter 1 收集 prefill（Arm A），iter 2..nDecode+1 收集 generated token 位置（Arm B）
    // ============================================================

    log(`\n[ctx] setKqSoftMaxQueryRange(queryStart=${queryStart}, queryEnd=${queryEnd})  # iter 1: prefill`);
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);

    const gen = sequence.evaluate(allTokens, { temperature: 0 } as any);
    const promptLength = allTokens.length;

    // iter 1: prefill + yield token_1
    log(`\n[gen] iter 1: prefill, awaiting token_1...`);
    const t1 = await gen.next();
    if (t1.done || !t1.value) {
      log(`❌ iter 1 提前结束`);
      return;
    }
    const token1 = t1.value;
    const token1Text = model.detokenize([token1]);
    log(`[gen] token_1 yielded: pos=${promptLength}  text="${token1Text}"`);

    // 读取 prefill attention → Arm A
    const shapeA = context.getKqSoftMaxShape();
    const realNHead = shapeA.nHead;
    log(`\n═══════════════════════════════════════════════════════════════════════════`);
    log(` Arm A: Prefill Attention (query positions [${queryStart}, ${queryEnd}))`);
    log(`═══════════════════════════════════════════════════════════════════════════`);
    const armAPerTokenScores = aggregateKqSoftMax(
      context, queryStart, queryEnd, nModelLayerBlocks, realNHead, false,
    );
    const armALineScores = tokensToLines(
      codeChunk, codeLines, armAPerTokenScores,
      codeStart, codeEnd, allTokens, model,
    );
    const armATopK = computeTopK(armALineScores, codeLines, startLine, 20);
    const armAPureCount = countPureSymbol(armATopK);

    log(`\n[ArmA] Top-20 (penalty=1, 无过滤):`);
    for (const e of armATopK) {
      log(`  L${e.lineNumber} | score=${e.score.toFixed(6)} | ${e.text.length > 120 ? e.text.substring(0, 120) + "..." : e.text}`);
    }
    log(`[ArmA] 纯符号行占比: ${armAPureCount}/20 = ${(armAPureCount / 20 * 100).toFixed(0)}%`);

    // ============================================================
    // Arm B: 收集 generated tokens 的 kq_soft_max
    // ============================================================
    log(`\n═══════════════════════════════════════════════════════════════════════════`);
    log(` Arm B: Decode Attention (${nDecode} generated tokens)`);
    log(`═══════════════════════════════════════════════════════════════════════════`);

    const generatedTokens: Array<{ tokenId: number; text: string; position: number; scores: Float32Array }> = [];
    // token_1 已经在 iter 1 yield 了，它的 attention 在 iter 2 时收集
    // iter 2 decode token_1 at position promptLength

    let lastYielded: Token = token1;
    let fullGeneratedText = "";
    for (let i = 0; i < nDecode; i++) {
      // 这次 .next() 会 decode lastYielded，位置 = promptLength + i
      const decodePos = promptLength + i;

      // 切换 query range 到 decodePos（这是要 decode 的 token 的位置）
      log(`\n[gen] iter ${i + 2}: setKqSoftMaxQueryRange(${decodePos}, ${decodePos + 1}), awaiting token_${i + 2}...`);
      context.setKqSoftMaxQueryRange(decodePos, decodePos + 1);

      const t = await gen.next();
      if (t.done || !t.value) {
        log(`[gen] iter ${i + 2}: 提前结束 (done=${t.done})`);
        break;
      }
      const newTok = t.value;
      const newTokText = model.detokenize([newTok]);
      log(`[gen] token_${i + 2} yielded: pos=${decodePos + 1}  text="${newTokText}"`);
      fullGeneratedText += newTokText;

      // 读取 kq_soft_max：这是 decodePos 位置的 attention（属于 lastYielded 的位置）
      // shape 在每次 decode 后会更新
      const shapeB = context.getKqSoftMaxShape();
      if (shapeB.nTokens !== 1) {
        log(`  ⚠️ 期望 nTokens=1, 实际=${shapeB.nTokens}`);
      }
      const scores = aggregateKqSoftMax(
        context, decodePos, decodePos + 1, nModelLayerBlocks, realNHead, true,
      );
      const sumScores = scores.reduce((a, b) => a + b, 0);
      const maxScores = Math.max(...scores);
      log(`  scores: sum=${sumScores.toExponential(2)}  max=${maxScores.toExponential(2)}  nKv=${scores.length}`);

      generatedTokens.push({
        tokenId: Number(newTok),
        text: newTokText,
        position: decodePos, // 这个位置对应 lastYielded
        scores,
      });

      lastYielded = newTok;
    }

    log(`\n[ArmB] Captured ${generatedTokens.length} generated token attentions`);
    for (const gt of generatedTokens) {
      log(`  - token at pos=${gt.position}  text="${gt.text}"  sum=${gt.scores.reduce((a, b) => a + b, 0).toExponential(2)}  max=${Math.max(...gt.scores).toExponential(2)}`);
    }

    // 打印完整生成文本（高亮可读性）
    log(`\n[ArmB] 完整生成文本 (${fullGeneratedText.length} chars):`);
    log(`┌${"─".repeat(100)}`);
    // 按 100 字符换行
    for (let i = 0; i < fullGeneratedText.length; i += 100) {
      log(`│ ${fullGeneratedText.substring(i, i + 100)}`);
    }
    log(`└${"─".repeat(100)}`);

    if (generatedTokens.length === 0) {
      log(`[ArmB] ❌ 没有捕获到 generated token attention`);
      return;
    }

    // ── Helper: KV scores → line scores → top-K ──
    function computeArmBFromKvScores(kvScores: Float32Array): { topK: TopKEntry[]; pureCount: number } {
      const codeScores = new Float32Array(codeEnd - codeStart);
      for (let i = 0; i < codeEnd - codeStart; i++) {
        const kvIdx = codeStart + i;
        if (kvIdx < kvScores.length) codeScores[i] = kvScores[kvIdx];
      }
      const perTokenScores = new Float32Array(allTokens.length);
      for (let i = 0; i < codeScores.length; i++) perTokenScores[codeStart + i] = codeScores[i];
      const lineScores = tokensToLines(codeChunk, codeLines, perTokenScores, codeStart, codeEnd, allTokens, model);
      const topK = computeTopK(lineScores, codeLines, startLine, 20);
      const pureCount = countPureSymbol(topK);
      return { topK, pureCount };
    }

    // ── 策略 1: 平均所有 generated token ──
    const avgScores = new Float32Array(generatedTokens[0].scores.length);
    for (const gt of generatedTokens) {
      for (let i = 0; i < avgScores.length; i++) avgScores[i] += gt.scores[i] / generatedTokens.length;
    }
    const rAvg = computeArmBFromKvScores(avgScores);

    // ── 策略 2: 最后一个 generated token ──
    const rLast = computeArmBFromKvScores(generatedTokens[generatedTokens.length - 1].scores);

    // ── 策略 3: max attention score 最高的 token ──
    let bestIdx = 0;
    let bestMax = -Infinity;
    for (let i = 0; i < generatedTokens.length; i++) {
      const max = Math.max(...generatedTokens[i].scores);
      if (max > bestMax) { bestMax = max; bestIdx = i; }
    }
    const bestToken = generatedTokens[bestIdx];
    log(`[ArmB] Max策略选择 token#${bestIdx + 1} "${bestToken.text}"（max score=${bestMax.toExponential(2)}）`);
    const rMax = computeArmBFromKvScores(bestToken.scores);

    // ── 策略 4: 越靠后权重越高（线性加权平均） ──
    const N = generatedTokens.length;
    const totalWeight = N * (N + 1) / 2;  // sum(1..N)
    const weightedScores = new Float32Array(generatedTokens[0].scores.length);
    for (let ti = 0; ti < N; ti++) {
      const w = (ti + 1) / totalWeight;  // 越靠后 w 越大
      for (let i = 0; i < weightedScores.length; i++) {
        weightedScores[i] += generatedTokens[ti].scores[i] * w;
      }
    }
    const rWeighted = computeArmBFromKvScores(weightedScores);
    log(`[ArmB] 加权策略 linear weight: 首 weight=${(1/totalWeight).toExponential(4)} 末 weight=${(N/totalWeight).toExponential(4)}`);

    const armBStrategies = [
      { label: "策略1: 平均所有 token", key: "Avg", result: rAvg },
      { label: "策略2: 最后一个 token", key: "Last", result: rLast },
      { label: "策略3: Max score 最高", key: "Max", result: rMax },
      { label: "策略4: 线性加权(越后越高)", key: "Wgt", result: rWeighted },
    ];

    // ── 打印三个策略的 top-20 ──
    for (const s of armBStrategies) {
      log(`\n[ArmB] ${s.label} (penalty=1, 无过滤):`);
      for (const e of s.result.topK) {
        log(`  L${e.lineNumber} | score=${e.score.toFixed(6)} | ${e.text.length > 120 ? e.text.substring(0, 120) + "..." : e.text}`);
      }
      log(`[ArmB] 纯符号行占比: ${s.result.pureCount}/20 = ${(s.result.pureCount / 20 * 100).toFixed(0)}%`);
    }

    // ============================================================
    // 四路对比总结
    // ============================================================
    log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
    log(`║  四路对比总结                                                            ║`);
    log(`╚══════════════════════════════════════════════════════════════════════════╝`);
    log(`\n${"指标".padEnd(20)} ${"Prefill".padStart(10)} ${"Avg".padStart(10)} ${"Last".padStart(10)} ${"Max".padStart(10)} ${"Wgt".padStart(10)}`);
    log(`${"─".repeat(70)}`);
    log(`${"纯符号行 top-20".padEnd(20)} ${String(armAPureCount).padStart(10)} ${String(rAvg.pureCount).padStart(10)} ${String(rLast.pureCount).padStart(10)} ${String(rMax.pureCount).padStart(10)} ${String(rWeighted.pureCount).padStart(10)}`);
    log(`${"纯符号行占比".padEnd(20)} ${(armAPureCount / 20 * 100).toFixed(0) + "%".padStart(10)} ${(rAvg.pureCount / 20 * 100).toFixed(0) + "%".padStart(10)} ${(rLast.pureCount / 20 * 100).toFixed(0) + "%".padStart(10)} ${(rMax.pureCount / 20 * 100).toFixed(0) + "%".padStart(10)} ${(rWeighted.pureCount / 20 * 100).toFixed(0) + "%".padStart(10)}`);

    // 行号重叠分析（各策略 vs Prefill）
    const armAIndices = new Set(armATopK.map((e) => e.lineNumber));
    for (const s of armBStrategies) {
      const bIndices = new Set(s.result.topK.map((e) => e.lineNumber));
      const intersect = [...armAIndices].filter((x) => bIndices.has(x));
      log(`${"重叠(Prefill∩" + s.key + ")".padEnd(24)} ${String(intersect.length).padStart(12)}`);
    }

    // 解读
    log(`\n[解读]`);
    for (const s of armBStrategies) {
      if (s.result.pureCount < armAPureCount) {
        log(`✅ ${s.label} 减少了 ${armAPureCount - s.result.pureCount} 个纯符号行`);
      } else if (s.result.pureCount > armAPureCount) {
        log(`❌ ${s.label} 反而多了 ${s.result.pureCount - armAPureCount} 个纯符号行`);
      } else {
        log(`➖ ${s.label} 无差异`);
      }
    }

  } finally {
    await context.dispose();
  }

  // 写日志文件
  const logPath = "/tmp/decode-attention-result.txt";
  fs.writeFileSync(logPath, logLines.join("\n") + "\n");
  log(`\n[save] Log written to ${logPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
