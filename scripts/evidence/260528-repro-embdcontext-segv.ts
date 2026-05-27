#!/usr/bin/env npx tsx
/**
 * 复现 llama.cpp Metal 后端 createEmbeddingContext 的 batchSize SEGV
 *
 * batchSize 在 8192~32768 区间触发 ggml Metal 后端空指针解引用。
 * 用 [W] OK 行判断是否成功，不受 process.abort() 干扰。
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(DIR, "260528-repro-embdcontext-segv-worker.mjs");
const BATCHES = [4096, 8192, 16384, 32768, 65536, 131072];

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  createEmbeddingContext · batchSize SEGV 复现            ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  Test:   ${BATCHES.map(String).join("  ")}`);
console.log("╚══════════════════════════════════════════════════════════╝");

interface Result { bs: number; ok: boolean; out: string; }

const results: Result[] = [];

for (const bs of BATCHES) {
  process.stdout.write(`  batchSize=${String(bs).padEnd(8)} `);

  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, _BS: String(bs) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });

  const timer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 120_000);

  await new Promise<void>((done) => {
    child.on("close", () => { clearTimeout(timer); done(); });
    child.on("error", () => { clearTimeout(timer); done(); });
  });

  // ── 判定：用输出内容，不用 exit code ──
  //    "[W] OK dim=" 出现 → createEmbeddingContext 成功
  //    否则 → 崩溃
  const ok = out.includes("[W] OK  dim=");
  const icon = ok ? "✅ OK" : "💥 SEGV";
  console.log(icon);

  for (const l of out.split("\n").filter((l) => l.startsWith("[W]")).slice(-1)) {
    console.log("    " + l.trim());
  }
  results.push({ bs, ok, out });
}

// ── 汇总 ──
console.log("\n═══════════════════════════════════════════════════════════");
console.log("  结果");
console.log("═══════════════════════════════════════════════════════════\n");

for (const r of results) {
  const last = r.out.split("\n").filter((l) => l.startsWith("[W]")).pop() || "";
  const info = r.ok ? "OK" : last.replace("[W] ", "");
  console.log(`  ${String(r.bs).padEnd(8)}  ${r.ok ? " ✅" : " 💥"}  ${info}`);
}

const crashes = results.filter((r) => !r.ok);
if (crashes.length) {
  const vals = crashes.map((r) => r.bs);
  console.log(`\n  💥 崩溃区间：${Math.min(...vals)} ~ ${Math.max(...vals)}`);
} else {
  console.log("\n  ✅ 全部通过（bug 可能已修复）");
}
