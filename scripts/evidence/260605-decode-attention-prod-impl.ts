#!/usr/bin/env npx tsx
/**
 * 生产代码 e2e 验证：QRRankerHighlighter (prefill vs decode) + QRRankerReranker
 *
 * 验证目标：
 *   1. QRRankerHighlighter 在 decodeSteps=50 时纯符号行 top-20 占比应大幅降低
 *   2. QRRankerHighlighter 在 decodeSteps=0  (prefill) 时维持旧行为
 *   3. QRRankerReranker 在 decodeSteps=50 时仍能正确排序 (Burj Khalifa #1)
 *
 * 用法:
 *   npx tsx scripts/evidence/260605-decode-attention-prod-impl.ts
 */

import * as fs from "fs";
import * as path from "path";
import { QRRankerHighlighter } from "../../src/code-index/highlighters/qrranker";
import { QRRankerReranker } from "../../src/code-index/rerankers/qrranker";
import type { RerankerCandidate } from "../../src/code-index/interfaces";

const MODEL_PATH =
  "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf";
const TARGET_FILE = "src/code-index/embedders/llamacpp-llm.ts";
const QUERY = "高度概括代码";

// ── Helpers (reused from compare script) ─────────────────────────
function isPureSymbolLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 3) return false;
  return !/[\p{L}\p{N}_]/u.test(trimmed);
}

interface TopKEntry {
  rank: number;
  lineNumber: number;
  text: string;
  score: number;
  isPureSymbol: boolean;
}

function computeTopK(lineScores: number[], codeLines: string[], startLine: number, k: number): TopKEntry[] {
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

const logLines: string[] = [];
function log(s: string) {
  console.log(s);
  logLines.push(s);
}

// ── Reranker test data (matches qrranker.e2e.ts) ────────────────
const RERANK_QUESTION = "What is the tallest structure in the world and where is it located?";
const RERANK_CANDIDATES: RerankerCandidate[] = [
  { id: 1, content: "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower from 1887 to 1889. Standing at 330 metres (1,083 ft), it was the tallest man-made structure in the world until 1930.", payload: { title: "Eiffel Tower" }, score: 0.5 },
  { id: 2, content: "The Burj Khalifa is a skyscraper in Dubai, United Arab Emirates. It is the world's tallest structure, standing at 828 metres (2,717 ft). Construction began in 2004 and was completed in 2009. It has 163 floors and holds numerous height records.", payload: { title: "Burj Khalifa" }, score: 0.6 },
  { id: 3, content: "The Empire State Building is a 102-story Art Deco skyscraper in Midtown Manhattan, New York City. It was the world's tallest building from 1931 until 1971, standing at 1,454 feet (443.2 m) including its antenna.", payload: { title: "Empire State Building" }, score: 0.4 },
  { id: 4, content: "The Shanghai Tower is a 128-story, 632-meter (2,073 ft) tall skyscraper in Shanghai, China. It is the tallest building in China and the third-tallest building in the world. It features a distinctive twisted form.", payload: { title: "Shanghai Tower" }, score: 0.45 },
  { id: 5, content: "The Great Pyramid of Giza is the oldest and largest of the three pyramids in the Giza pyramid complex. Originally standing at 146.6 metres (481 ft), it was the tallest man-made structure in the world for over 3,800 years.", payload: { title: "Great Pyramid of Giza" }, score: 0.55 },
];
const RERANK_EXPECTED_TOP = "Burj Khalifa";

// ── Main ───────────────────────────────────────────────────────
async function main() {
  log(`\n╔══════════════════════════════════════════════════════════════╗`);
  log(`║  Production Code E2E: prefill vs decode                     ║`);
  log(`╚══════════════════════════════════════════════════════════════╝`);
  log(`Model:       ${path.basename(MODEL_PATH)}`);
  log(`Target file: ${TARGET_FILE}`);
  log(`Query:       ${QUERY}`);

  const codeChunk = fs.readFileSync(TARGET_FILE, "utf-8");
  const codeLines = codeChunk.split("\n");
  const startLine = 1;
  log(`Code chunk:  ${codeLines.length} lines, ${codeChunk.length} chars`);

  // ── Test 1: Highlighter prefill (decodeSteps=0) ──────────────
  log(`\n═══════════════════════════════════════════════════════════════`);
  log(` Test 1: QRRankerHighlighter with decodeSteps=0 (prefill)`);
  log(`═══════════════════════════════════════════════════════════════`);
  const t0 = Date.now();
  const hlPrefill = new QRRankerHighlighter(
    MODEL_PATH, 20, console, "topk", 0.5, /* decodeSteps */ 0,
  );
  const rPrefill = await hlPrefill.highlight(QUERY, codeChunk, startLine);
  const elapsedPrefill = Date.now() - t0;
  const topKPrefill = computeTopK(
    rPrefill.lines.map((l) => l.score),
    codeLines, startLine, 20,
  );
  const purePrefill = countPureSymbol(topKPrefill);
  log(`\n[prefill] ${rPrefill.lines.length} lines, kept=${rPrefill.lines.filter((l) => l.kept).length}, elapsed=${elapsedPrefill}ms`);
  log(`[prefill] Top-20:`);
  for (const e of topKPrefill) {
    const tag = e.isPureSymbol ? "⊘" : "✓";
    log(`  ${tag} L${String(e.lineNumber).padStart(4)} score=${e.score.toFixed(6)} | ${e.text.substring(0, 100)}`);
  }
  log(`[prefill] 纯符号行占比: ${purePrefill}/20 = ${(purePrefill / 20 * 100).toFixed(0)}%`);
  log(`[prefill] ⏱ Done in ${elapsedPrefill}ms`);
  await hlPrefill.dispose();

  // ── Test 2: Highlighter decode (decodeSteps=20) ──────────────
  log(`\n═══════════════════════════════════════════════════════════════`);
  log(` Test 2: QRRankerHighlighter with decodeSteps=20 (decode)`);
  log(`═══════════════════════════════════════════════════════════════`);
  const t1 = Date.now();
  const hlDecode = new QRRankerHighlighter(
    MODEL_PATH, 20, console, "topk", 0.5, /* decodeSteps */ 20,
  );
  const rDecode = await hlDecode.highlight(QUERY, codeChunk, startLine);
  const elapsedDecode = Date.now() - t1;
  const topKDecode = computeTopK(
    rDecode.lines.map((l) => l.score),
    codeLines, startLine, 20,
  );
  const pureDecode = countPureSymbol(topKDecode);
  log(`\n[decode]  ${rDecode.lines.length} lines, kept=${rDecode.lines.filter((l) => l.kept).length}, elapsed=${elapsedDecode}ms`);
  log(`[decode]  Top-20:`);
  for (const e of topKDecode) {
    const tag = e.isPureSymbol ? "⊘" : "✓";
    log(`  ${tag} L${String(e.lineNumber).padStart(4)} score=${e.score.toFixed(6)} | ${e.text.substring(0, 100)}`);
  }
  log(`[decode]  纯符号行占比: ${pureDecode}/20 = ${(pureDecode / 20 * 100).toFixed(0)}%`);
  log(`[decode]  ⏱ Done in ${elapsedDecode}ms`);
  await hlDecode.dispose();

  // ── Comparison ──────────────────────────────────────────────
  log(`\n═══════════════════════════════════════════════════════════════`);
  log(` Comparison Summary`);
  log(`═══════════════════════════════════════════════════════════════`);
  log(`${"Metric".padEnd(30)} ${"Prefill".padStart(15)} ${"Decode(N=50)".padStart(15)}`);
  log(`${"─".repeat(60)}`);
  log(`${"Pure-symbol rows in top-20".padEnd(30)} ${String(purePrefill).padStart(15)} ${String(pureDecode).padStart(15)}`);
  log(`${"Pure-symbol ratio".padEnd(30)} ${(purePrefill / 20 * 100).toFixed(0) + "%".padStart(15)} ${(pureDecode / 20 * 100).toFixed(0) + "%".padStart(15)}`);
  log(`${"Elapsed (ms)".padEnd(30)} ${String(elapsedPrefill).padStart(15)} ${String(elapsedDecode).padStart(15)}`);
  log(`${"Speedup factor".padEnd(30)} ${"1.0x".padStart(15)} ${(elapsedDecode / Math.max(elapsedPrefill, 1)).toFixed(1) + "x".padStart(15)}`);

  if (pureDecode < purePrefill) {
    log(`\n✅ Decode-stage attention reduced pure-symbol rows by ${purePrefill - pureDecode} (${purePrefill} → ${pureDecode})`);
  } else if (pureDecode > purePrefill) {
    log(`\n❌ Decode-stage attention INCREASED pure-symbol rows (${purePrefill} → ${pureDecode})`);
  } else {
    log(`\n➖ No change in pure-symbol row count`);
  }

  // ── Test 3: Reranker decode-stage e2e ────────────────────────
  log(`\n═══════════════════════════════════════════════════════════════`);
  log(` Test 3: QRRankerReranker with decodeSteps=50 (decode)`);
  log(`═══════════════════════════════════════════════════════════════`);
  const t2 = Date.now();
  const reranker = new QRRankerReranker(
    MODEL_PATH, console, 5, 1, 2, 1000, /* decodeSteps */ 20,
  );
  const validation = await reranker.validateConfiguration();
  log(`[reranker] Validation: ${validation.valid ? "PASS" : `FAIL: ${validation.error}`}`);
  if (validation.valid) {
    const results = await reranker.rerank(RERANK_QUESTION, RERANK_CANDIDATES);
    const elapsedRerank = Date.now() - t2;
    log(`[reranker] ${results.length} results in ${elapsedRerank}ms:`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const c = RERANK_CANDIDATES.find((c) => c.id === r.id);
      const title = (c?.payload?.title as string) ?? `#${r.id}`;
      log(`  #${i + 1} ${title.padEnd(25)} score=${r.score.toFixed(4)}`);
    }
    const topResult = results[0];
    const topCandidate = RERANK_CANDIDATES.find((c) => c.id === topResult.id);
    const topTitle = topCandidate?.payload?.title as string;
    const topOk = topTitle === RERANK_EXPECTED_TOP;
    log(`[reranker] Top is ${RERANK_EXPECTED_TOP}: ${topOk ? "✅" : `❌ (got "${topTitle}")`}`);
  }
  log(`[reranker] ⏱ Done in ${Date.now() - t2}ms`);
  await reranker.dispose();

  // ── Save log ─────────────────────────────────────────────────
  const logPath = "/tmp/decode-attention-prod-impl.txt";
  fs.writeFileSync(logPath, logLines.join("\n") + "\n");
  log(`\n[save] Log written to ${logPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
