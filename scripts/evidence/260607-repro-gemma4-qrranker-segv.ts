#!/usr/bin/env npx tsx
/**
 * 复现 gemma-4-E2B-it-qat-mobile GGUF 在 QRRanker 中的 SIGSEGV
 *
 * 背景：gemma-4 架构在 @realtimex/node-llama-cpp 的 Metal 后端中触发
 *       `ggml-metal-device.cpp:901: not implemented` 错误，因为
 *       其矩阵乘法需要 Metal pipeline `mul_mm_id_map0`，但当前版本
 *       未实现该 pipeline。
 *
 * 通过子进程隔离：Metal 端的 ggml_abort() 会 C 级 abort，无法 JS try-catch。
 *
 * 测试矩阵：
 *   - Metal + collectKqSoftMax  (复现原始 crash)
 *   - Metal + 普通 evaluate     (定位是否 kq_soft_max 专属)
 *   - CPU  + collectKqSoftMax  (验证 CPU 后端是否可用)
 *   - CPU  + 普通 evaluate     (验证 CPU 后端 baseline)
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(DIR, "260607-repro-gemma4-qrranker-segv-worker.mjs");
const MODEL = "/Users/anrgct/llm_models/unsloth/gemma-4-E2B-it-qat-mobile-GGUF/gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf";

interface TestCase {
  name: string;
  contextSize: number;
  batchSize: number;
  collectKqSoftMax: boolean;
  promptTokens: number;
  gpu: boolean;
}

const TESTS: TestCase[] = [
  // ── Metal backend ──
  { name: "GPU+kq",     contextSize: 4096,  batchSize: 512,  collectKqSoftMax: true,  promptTokens: 128, gpu: true },
  { name: "GPU+prefill", contextSize: 4096,  batchSize: 512,  collectKqSoftMax: false, promptTokens: 128, gpu: true },

  // ── CPU backend ──
  { name: "CPU+kq",     contextSize: 4096,  batchSize: 512,  collectKqSoftMax: true,  promptTokens: 128,  gpu: false },
  { name: "CPU+prefill", contextSize: 4096,  batchSize: 512,  collectKqSoftMax: false, promptTokens: 128,  gpu: false },

  // ── CPU + 长 prompt（接近原始 crash 场景） ──
  { name: "CPU+long+kq", contextSize: 32768, batchSize: 4096, collectKqSoftMax: true,  promptTokens: 4096, gpu: false },
];

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  Gemma-4 QRRanker SIGSEGV 复现                               ║");
console.log("╠══════════════════════════════════════════════════════════════╣");
console.log(`║  模型: ${path.basename(MODEL)}`);
console.log(`║  测试: ${TESTS.length} 用例`);
console.log("╚══════════════════════════════════════════════════════════════╝\n");

interface Result {
  name: string;
  ok: boolean;
  crashDetail: string;
  out: string;
}

const results: Result[] = [];

for (const tc of TESTS) {
  process.stdout.write(`  [${tc.name}] `.padEnd(22));

  const child = spawn(process.execPath, [WORKER], {
    env: {
      ...process.env,
      _MODEL: MODEL,
      _CTX: String(tc.contextSize),
      _BS: String(tc.batchSize),
      _KQ: tc.collectKqSoftMax ? "1" : "0",
      _TOK: String(tc.promptTokens),
      _GPU: tc.gpu ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });

  const timer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 300_000);

  await new Promise<void>((done) => {
    child.on("close", () => { clearTimeout(timer); done(); });
    child.on("error", () => { clearTimeout(timer); done(); });
  });

  // ── 判定 ──
  const okLines = out.split("\n").filter((l) => l.startsWith("[W]"));

  // stderr 也可能包含 Metal abort 输出（通过 spawn 合并的 stdout+stderr）
  const allText = out;
  const metalError = allText.includes("ggml-metal-device.cpp") || allText.includes("not implemented");
  const nativeCrash = allText.includes("[CRASH]") || allText.includes("SIGSEGV");
  const jsError = okLines.some((l) => l.includes("UNSUPPORTED"));

  const hasOk = okLines.some((l) => l.includes("OK"));
  const exitSignal = child.exitCode === null ? child.signalCode : null;
  const crashedBySignal = exitSignal !== null; // SIGABRT, SIGSEGV etc.

  let icon: string;
  let crashDetail: string;

  if (hasOk) {
    icon = "✅ OK";
    crashDetail = "";
  } else if (metalError) {
    icon = "💥 METAL";
    crashDetail = "Metal 后端未实现 gemma-4 所需矩阵乘法 (ggml-metal-device.cpp:901)";
  } else if (nativeCrash) {
    icon = "💥 SIGSEGV";
    crashDetail = "原生层崩溃";
  } else if (crashedBySignal) {
    icon = "💥 ABORT";
    crashDetail = "进程被信号终止 (" + exitSignal + ")";
  } else if (jsError) {
    icon = "⚠️ UNSUPPORTED";
    crashDetail = okLines.filter((l) => l.includes("UNSUPPORTED")).pop()?.replace("[W] ", "") ?? "";
  } else {
    icon = "💥 CRASH";
    crashDetail = "未知崩溃";
  }

  console.log(icon);

  // 显示关键输出行
  for (const l of okLines.slice(-3)) {
    console.log("    " + l.trim());
  }

  // 如果崩溃了，显示 crash 详情
  if (!hasOk) {
    // 尝试从输出中找 Metal error（可能被管道 buffer 吞掉）
    const crashLines = allText.split("\n").filter((l) =>
      l.includes("ggml-metal") || l.includes("not implemented") || l.includes("SIGSEGV") || l.includes("CRASH")
    );
    console.log(`    ── 进程退出: signal=${child.signalCode ?? "-"}  code=${child.exitCode ?? "-"} ──`);
    if (crashLines.length) {
      console.log("    ── 关键错误 ──");
      for (const l of crashLines.slice(0, 3)) console.log("    " + l.trim());
    }
  }

  results.push({ name: tc.name, ok: hasOk, crashDetail, out });
}

// ── 汇总 ──
console.log("\n═══════════════════════════════════════════════════════════");
console.log("  结果汇总");
console.log("═══════════════════════════════════════════════════════════\n");

for (const r of results) {
  const status = r.ok ? " ✅" : " 💥";
  const detail = r.ok ? "OK" : r.crashDetail;
  console.log(`  ${r.name.padEnd(22)} ${status}  ${detail}`);
}

const crashes = results.filter((r) => !r.ok);
if (crashes.length) {
  console.log(`\n  根因分析`);
  console.log("  ────────");
  console.log("  模型: gemma-4-E2B-it-qat-mobile (Gemma 4 架构, 36 层)");
  console.log("  后端: Metal (Apple GPU)");
  console.log("  错误: ggml-metal-device.cpp:901 — not implemented");
  console.log("  原因: 当前 @realtimex/node-llama-cpp 绑定的 llama.cpp 版本中,");
  console.log("        Metal 后端缺少 gemma-4 架构所需的 mul_mm_id_map0 pipeline。");
  console.log("  建议:");
  console.log("    1. 升级 @realtimex/node-llama-cpp 到支持 gemma-4 的版本");
  console.log("    2. 或用 CPU 后端 (gpu: false) 规避——但推理速度会大幅下降");
} else {
  console.log(`\n  ✅ 全部通过（bug 可能已修复）`);
}
