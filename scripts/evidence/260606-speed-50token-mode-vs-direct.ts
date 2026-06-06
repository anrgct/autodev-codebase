#!/usr/bin/env npx tsx
/**
 * 速度 A/B：QRRanker 推理模式 50 token vs 直接回答 50 token
 *
 * 验证假设：开启 collectKqSoftMax + 每步 setKqSoftMaxQueryRange + getKqSoftMax
 * 是否会拖慢 token 生成速度？如果 A/B 几乎无差，说明 QRRanker 的"在 decode
 * 阶段读 attention"方案在性能上几乎无成本。
 *
 * 用法:
 *   npx tsx scripts/evidence/260606-speed-50token-mode-vs-direct.ts
 *   npx tsx scripts/evidence/260606-speed-50token-mode-vs-direct.ts --n-tokens=50 --runs=3
 *
 * 输出:
 *   stdout — 详细对比报告
 *   /tmp/speed-50token-mode-vs-direct.txt — 同内容
 */

import * as fs from "fs";
import * as path from "path";
import {
  getLlama,
  LlamaLogLevel,
  type Token,
} from "@realtimex/node-llama-cpp";

const MODEL_PATH =
  "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf";
const TARGET_FILE = "src/code-index/embedders/llamacpp-llm.ts";
const QUERY = "高度概括代码";

// ── 复用 260605 脚本里的常量 ─────────────────────────────
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
function parseArgs(): { nTokens: number; runs: number; warmup: number } {
  const args = process.argv.slice(2);
  let nTokens = 50;
  let runs = 3;
  let warmup = 1;
  for (const a of args) {
    const get = (k: string) => {
      const prefix = `--${k}=`;
      if (a.startsWith(prefix)) return a.slice(prefix.length);
      return undefined;
    };
    if (get("n-tokens")) nTokens = parseInt(get("n-tokens")!, 10);
    else if (get("runs")) runs = parseInt(get("runs")!, 10);
    else if (get("warmup")) warmup = parseInt(get("warmup")!, 10);
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: npx tsx scripts/evidence/260606-speed-50token-mode-vs-direct.ts " +
          "[--n-tokens=N] [--runs=N] [--warmup=N]",
      );
      process.exit(0);
    }
  }
  if (nTokens < 1 || nTokens > 5000) throw new Error(`--n-tokens 必须在 1..5000`);
  if (runs < 1 || runs > 20) throw new Error(`--runs 必须在 1..20`);
  if (warmup < 0 || warmup > 10) throw new Error(`--warmup 必须在 0..10`);
  return { nTokens, runs, warmup };
}

// ── Prompt（与 260605 同步） ────────────────────────────────
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

// ── 高精度计时 ──────────────────────────────────────────────
const ns = (): bigint => process.hrtime.bigint();
const ms = (b: bigint): number => Number(b) / 1e6;

interface RunTimings {
  prefillMs: number;     // iter 1 (prefill + sample token_1)
  restDecodeMs: number;  // iter 2..N+1 total
  totalMs: number;
  perTokenAvgMs: number; // (total - prefill) / (nTokens - 1)
  tokensPerSec: number;  // 1000 / perTokenAvgMs
  generatedTokens: Token[];
  generatedText: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function min(xs: number[]): number {
  return Math.min(...xs);
}
function max(xs: number[]): number {
  return Math.max(...xs);
}
function stddev(xs: number[]): number {
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

// ── 单次 A 组：推理模式 ─────────────────────────────────────
async function runReasoningMode(
  model: any,
  allTokens: Token[],
  promptLength: number,
  queryStart: number,
  queryEnd: number,
  nModelLayerBlocks: number,
  nDecode: number,
): Promise<RunTimings> {
  const ctx = await model.createContext({
    contextSize: Math.min(model.trainContextSize ?? 32768, allTokens.length + 1024 + nDecode),
    batchSize: Math.min(allTokens.length, 4096),
    sequences: 1,
    flashAttention: false,
    collectKqSoftMax: true,
  } as any);

  try {
    const sequence = ctx.getSequence();

    // Set layer range (mimic QRRanker)
    if (nModelLayerBlocks !== QR_QRRANKER_NLAYER) {
      const mappedStart = Math.round(QR_START_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      const mappedEnd = Math.round(QR_END_LAYER * nModelLayerBlocks / QR_ORIGINAL_NLAYER);
      ctx.setKqSoftMaxLayerRange(mappedStart, mappedEnd);
    }

    // Pre-iter 1: set query range to query slice (mimic QRRanker)
    ctx.setKqSoftMaxQueryRange(queryStart, queryEnd);

    const tStart = ns();
    const gen = sequence.evaluate(allTokens, { temperature: 0 } as any);

    // iter 1: prefill + yield token_1
    const tPrefillStart = ns();
    const r1 = await gen.next();
    if (r1.done || !r1.value) throw new Error("iter 1 done prematurely");
    const token1 = r1.value;
    const tPrefillEnd = ns();

    const generatedTokens: Token[] = [token1];

    // iter 2..N+1: 每个 token 前 setKqSoftMaxQueryRange 到当前 decode 位置，
    // await .next() 后 getKqSoftMax(所有 16 个 QR heads)
    for (let i = 0; i < nDecode - 1; i++) {
      const decodePos = promptLength + i;
      ctx.setKqSoftMaxQueryRange(decodePos, decodePos + 1);
      const r = await gen.next();
      if (r.done || !r.value) break;
      generatedTokens.push(r.value);
      // Read kq_soft_max for all QR heads (this is the cost we care about)
      const shape = ctx.getKqSoftMaxShape();
      const nHead = shape.nHead;
      for (const { layer: rawLayer, head: rawHead } of QR_HEADS) {
        const head = nHead === QR_SOURCE_NHEAD
          ? rawHead
          : Math.min(Math.round(rawHead * nHead / QR_SOURCE_NHEAD), nHead - 1);
        const layer = nModelLayerBlocks === QR_QRRANKER_NLAYER
          ? rawLayer
          : Math.min(Math.round(rawLayer * nModelLayerBlocks / QR_ORIGINAL_NLAYER), nModelLayerBlocks - 1);
        ctx.getKqSoftMax(layer);
      }
    }
    const tEnd = ns();

    const generatedText = model.detokenize(generatedTokens);
    const prefillMs = ms(tPrefillEnd - tPrefillStart);
    const totalMs = ms(tEnd - tStart);
    const perTokenAvgMs = (totalMs - prefillMs) / Math.max(nDecode - 1, 1);

    return {
      prefillMs,
      restDecodeMs: totalMs - prefillMs,
      totalMs,
      perTokenAvgMs,
      tokensPerSec: 1000 / Math.max(perTokenAvgMs, 0.001),
      generatedTokens,
      generatedText,
    };
  } finally {
    await ctx.dispose();
  }
}

// ── 单次 B 组：直接回答 ─────────────────────────────────────
async function runDirectMode(
  model: any,
  allTokens: Token[],
  nDecode: number,
): Promise<RunTimings> {
  const ctx = await model.createContext({
    contextSize: Math.min(model.trainContextSize ?? 32768, allTokens.length + 1024 + nDecode),
    batchSize: Math.min(allTokens.length, 4096),
    sequences: 1,
    flashAttention: false,
    // collectKqSoftMax: false (default)
  } as any);

  try {
    const sequence = ctx.getSequence();

    const tStart = ns();
    const gen = sequence.evaluate(allTokens, { temperature: 0 } as any);

    // iter 1: prefill + yield token_1
    const tPrefillStart = ns();
    const r1 = await gen.next();
    if (r1.done || !r1.value) throw new Error("iter 1 done prematurely");
    const token1 = r1.value;
    const tPrefillEnd = ns();

    const generatedTokens: Token[] = [token1];
    // iter 2..N+1: decode + sample
    for (let i = 0; i < nDecode - 1; i++) {
      const r = await gen.next();
      if (r.done || !r.value) break;
      generatedTokens.push(r.value);
    }
    const tEnd = ns();

    const generatedText = model.detokenize(generatedTokens);
    const prefillMs = ms(tPrefillEnd - tPrefillStart);
    const totalMs = ms(tEnd - tStart);
    const perTokenAvgMs = (totalMs - prefillMs) / Math.max(nDecode - 1, 1);

    return {
      prefillMs,
      restDecodeMs: totalMs - prefillMs,
      totalMs,
      perTokenAvgMs,
      tokensPerSec: 1000 / Math.max(perTokenAvgMs, 0.001),
      generatedTokens,
      generatedText,
    };
  } finally {
    await ctx.dispose();
  }
}

// ── 日志 ───────────────────────────────────────────────────
const logLines: string[] = [];
function log(s: string) {
  console.log(s);
  logLines.push(s);
}

function fmt(v: number, p = 2): string {
  return v.toFixed(p);
}

function summarize(label: string, runs: RunTimings[]) {
  const totalArr = runs.map((r) => r.totalMs);
  const prefillArr = runs.map((r) => r.prefillMs);
  const decodeArr = runs.map((r) => r.restDecodeMs);
  const tpsArr = runs.map((r) => r.tokensPerSec);
  const perTokArr = runs.map((r) => r.perTokenAvgMs);
  log(`\n  ${label} (${runs.length} runs):`);
  log(`    ${"metric".padEnd(20)} ${"min".padStart(10)} ${"median".padStart(10)} ${"mean".padStart(10)} ${"max".padStart(10)} ${"stddev".padStart(10)}`);
  log(`    ${"─".repeat(70)}`);
  for (const [name, arr] of [
    ["totalMs", totalArr],
    ["prefillMs", prefillArr],
    ["decodeSumMs", decodeArr],
    ["perTokenMs", perTokArr],
    ["tokens/s", tpsArr],
  ] as Array<[string, number[]]>) {
    log(
      `    ${name.padEnd(20)} ${fmt(min(arr)).padStart(10)} ${fmt(median(arr)).padStart(10)} ${fmt(mean(arr)).padStart(10)} ${fmt(max(arr)).padStart(10)} ${fmt(stddev(arr)).padStart(10)}`,
    );
  }
  return {
    totalMedian: median(totalArr),
    prefillMedian: median(prefillArr),
    decodeMedian: median(decodeArr),
    perTokenMedian: median(perTokArr),
    tpsMedian: median(tpsArr),
  };
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const { nTokens, runs, warmup } = parseArgs();

  log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
  log(`║  速度 A/B：推理模式 ${nTokens} token vs 直接回答 ${nTokens} token${" ".repeat(Math.max(0, 20 - String(nTokens).length * 2))}║`);
  log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  log(`Model:       ${path.basename(MODEL_PATH)}`);
  log(`Target file: ${TARGET_FILE}`);
  log(`Query:       ${QUERY}`);
  log(`N tokens:    ${nTokens}`);
  log(`Runs:        ${runs} (warmup ${warmup})`);
  log(`Sampling:    greedy (temperature=0)`);
  log(`Prompt size: <see below>`);

  // 加载目标文件
  const codeChunk = fs.readFileSync(TARGET_FILE, "utf-8");
  const codeLines = codeChunk.split("\n");
  log(`Code chunk:  ${codeLines.length} lines, ${codeChunk.length} chars`);

  // 加载模型（只加载一次）
  log(`\n[load] Loading model...`);
  const t0 = Date.now();
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled, gpu: "metal" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  const nModelLayerBlocks = model.fileInsights.totalLayers - 1;
  log(`[load] Model loaded in ${Date.now() - t0}ms (nLayerBlocks=${nModelLayerBlocks})`);

  // 构建 prompt & tokenize
  const fullPrompt = buildPrompt(QUERY, codeChunk);
  const allTokens = model.tokenize(fullPrompt);
  log(`[tokenize] Full prompt: ${allTokens.length} tokens`);

  // 定位 query range
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
  // query 位置：queryFullTokens 在 allTokens 里的起点
  const queryStart = findSubseq(allTokens, queryFullTokens, 0);
  const queryEnd = queryStart + queryFullTokens.length;
  log(`[tokenize] query range = [${queryStart}, ${queryEnd})`);

  // ── Warmup（两个模式都做，避免冷启动偏差） ────────────────
  log(`\n[warmup] running ${warmup} warmup pass(es) per mode (results discarded)...`);
  for (let w = 0; w < warmup; w++) {
    log(`  warmup ${w + 1}/${warmup}: reasoning mode...`);
    await runReasoningMode(model, allTokens, allTokens.length, queryStart, queryEnd, nModelLayerBlocks, nTokens);
    log(`  warmup ${w + 1}/${warmup}: direct mode...`);
    await runDirectMode(model, allTokens, nTokens);
  }
  log(`[warmup] done`);

  // ── A 组（推理模式）正式运行 ─────────────────────────────
  log(`\n═══════════════════════════════════════════════════════════════════════════`);
  log(` A 组: 推理模式 (collectKqSoftMax=true + 每步 setKqSoftMaxQueryRange + getKqSoftMax)`);
  log(`═══════════════════════════════════════════════════════════════════════════`);
  const aRuns: RunTimings[] = [];
  for (let i = 0; i < runs; i++) {
    log(`\n  [A] run ${i + 1}/${runs} ...`);
    const r = await runReasoningMode(
      model, allTokens, allTokens.length, queryStart, queryEnd, nModelLayerBlocks, nTokens,
    );
    aRuns.push(r);
    log(`    total=${fmt(r.totalMs)}ms  prefill=${fmt(r.prefillMs)}ms  decode=${fmt(r.restDecodeMs)}ms  perToken=${fmt(r.perTokenAvgMs)}ms  tps=${fmt(r.tokensPerSec, 1)}`);
  }
  const aSum = summarize("A 组 (推理模式)", aRuns);

  // ── B 组（直接回答）正式运行 ─────────────────────────────
  log(`\n═══════════════════════════════════════════════════════════════════════════`);
  log(` B 组: 直接回答 (collectKqSoftMax=false, 不访问 kq_soft_max)`);
  log(`═══════════════════════════════════════════════════════════════════════════`);
  const bRuns: RunTimings[] = [];
  for (let i = 0; i < runs; i++) {
    log(`\n  [B] run ${i + 1}/${runs} ...`);
    const r = await runDirectMode(model, allTokens, nTokens);
    bRuns.push(r);
    log(`    total=${fmt(r.totalMs)}ms  prefill=${fmt(r.prefillMs)}ms  decode=${fmt(r.restDecodeMs)}ms  perToken=${fmt(r.perTokenAvgMs)}ms  tps=${fmt(r.tokensPerSec, 1)}`);
  }
  const bSum = summarize("B 组 (直接回答)", bRuns);

  // ── Sanity check: A/B 输出是否一致 ───────────────────────
  log(`\n═══════════════════════════════════════════════════════════════════════════`);
  log(` Sanity Check: A/B 输出是否完全一致 (greedy 应确定性)`);
  log(`═══════════════════════════════════════════════════════════════════════════`);
  const aIds = aRuns[0].generatedTokens.map(Number);
  const bIds = bRuns[0].generatedTokens.map(Number);
  const sameLength = aIds.length === bIds.length;
  const sameContent = sameLength && aIds.every((id, i) => id === bIds[i]);
  log(`  A length=${aIds.length}  B length=${bIds.length}  same=${sameContent}`);
  log(`  A[0..9] ids: ${aIds.slice(0, 10).map((x) => x.toString()).join(", ")}`);
  log(`  B[0..9] ids: ${bIds.slice(0, 10).map((x) => x.toString()).join(", ")}`);
  if (!sameContent) {
    let firstDiff = -1;
    for (let i = 0; i < Math.min(aIds.length, bIds.length); i++) {
      if (aIds[i] !== bIds[i]) { firstDiff = i; break; }
    }
    if (firstDiff >= 0) {
      log(`  ⚠️ 首个不一致在 token #${firstDiff}: A=${aIds[firstDiff]}  B=${bIds[firstDiff]}`);
      log(`    A="${aRuns[0].generatedText.substring(0, 60)}..."`);
      log(`    B="${bRuns[0].generatedText.substring(0, 60)}..."`);
    }
  }

  log(`\n  完整生成文本 (A 第 1 次, ${aRuns[0].generatedText.length} chars):`);
  log(`  ┌${"─".repeat(100)}`);
  for (let i = 0; i < aRuns[0].generatedText.length; i += 100) {
    log(`  │ ${aRuns[0].generatedText.substring(i, i + 100)}`);
  }
  log(`  └${"─".repeat(100)}`);

  // ── 对比总结 ─────────────────────────────────────────────
  log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
  log(`║  对比总结 (median)                                                       ║`);
  log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  log(`\n${"指标".padEnd(20)} ${"A 推理模式".padStart(15)} ${"B 直接回答".padStart(15)} ${"差值(A-B)".padStart(15)} ${"比率 A/B".padStart(10)}`);
  log(`${"─".repeat(75)}`);
  const rows: Array<[string, number, number, "ms" | "x"]> = [
    ["prefill (ms)", aSum.prefillMedian, bSum.prefillMedian, "ms"],
    ["decode 总和 (ms)", aSum.decodeMedian, bSum.decodeMedian, "ms"],
    ["per-token (ms)", aSum.perTokenMedian, bSum.perTokenMedian, "ms"],
    ["tokens/s", aSum.tpsMedian, bSum.tpsMedian, "ms"],
    ["total (ms)", aSum.totalMedian, bSum.totalMedian, "ms"],
  ];
  for (const [name, a, b, unit] of rows) {
    const diff = a - b;
    const ratio = b > 0 ? a / b : 0;
    log(
      `${name.padEnd(20)} ${fmt(a).padStart(15)} ${fmt(b).padStart(15)} ${(diff >= 0 ? "+" : "") + fmt(diff).padStart(15)} ${fmt(ratio, 3).padStart(10)}x`,
    );
  }

  // 解读
  const totalSlowdownPct = (aSum.totalMedian / bSum.totalMedian - 1) * 100;
  const decodeSlowdownPct = (aSum.decodeMedian / bSum.decodeMedian - 1) * 100;
  log(`\n[解读]`);
  if (Math.abs(totalSlowdownPct) < 5) {
    log(`✅ 总体速度差异 < 5%（A 比 B 慢 ${totalSlowdownPct.toFixed(2)}%），QRRanker 推理模式几乎没有额外成本`);
  } else if (totalSlowdownPct > 0) {
    log(`⚠️ A 比 B 慢 ${totalSlowdownPct.toFixed(2)}%（推理模式有 ${totalSlowdownPct.toFixed(1)}% 开销）`);
  } else {
    log(`🤔 A 比 B 快 ${(-totalSlowdownPct).toFixed(2)}%（不太可能，需要检查方法学）`);
  }
  if (Math.abs(decodeSlowdownPct) < 5) {
    log(`✅ decode 阶段差异 < 5%（${decodeSlowdownPct.toFixed(2)}%），kq_soft_max 收集对 decode 影响极小`);
  } else if (decodeSlowdownPct > 0) {
    log(`⚠️ decode 阶段慢 ${decodeSlowdownPct.toFixed(2)}%，可能来自 setKqSoftMaxQueryRange 或 getKqSoftMax 调用`);
  } else {
    log(`🤔 decode 阶段 A 比 B 快 ${(-decodeSlowdownPct).toFixed(2)}%`);
  }

  if (!sameContent) {
    log(`\n❌ A/B 输出不一致（greedy 应确定性，可能存在隐藏副作用）`);
  } else {
    log(`\n✅ A/B 输出完全一致，确认速度差异是唯一变量`);
  }

  // 保存日志
  const logPath = "/tmp/speed-50token-mode-vs-direct.txt";
  fs.writeFileSync(logPath, logLines.join("\n") + "\n");
  log(`\n[save] Log written to ${logPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
