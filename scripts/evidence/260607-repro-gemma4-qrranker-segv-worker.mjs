#!/usr/bin/env node
/**
 * Worker：在子进程中执行 gemma-4 的 kq_soft_max / evaluate 测试。
 * 通过 stdout 输出 "[W]" 前缀的行供父进程判定。
 *
 * 注意：Metal SIGABRT 会直接杀死进程，所以需要用子进程隔离。
 * stdout/stderr 全部重定向，父进程根据内容判断结果。
 */
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

const MODEL = process.env._MODEL;
if (!MODEL) { process.exit(1); }

const CTX    = parseInt(process.env._CTX ?? "4096", 10);
const BS     = parseInt(process.env._BS ?? "512", 10);
const KQ     = process.env._KQ === "1";
const TOK    = parseInt(process.env._TOK ?? "128", 10);
const GPU    = process.env._GPU !== "0"; // default Metal

async function main() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled, gpu: GPU });
  const model = await llama.loadModel({ modelPath: MODEL });

  process.stdout.write(`[W] model loaded: nLayers=${model.fileInsights.totalLayers} ctxSize=${model.trainContextSize}\n`);

  const context = await model.createContext({
    contextSize: CTX,
    batchSize: BS,
    sequences: 1,
    flashAttention: false,
    collectKqSoftMax: KQ,
  });

  process.stdout.write(`[W] context created: contextSize=${context.contextSize} collectKqSoftMax=${KQ}\n`);

  // Build a prompt of approximately TOK tokens
  const seedText = "The quick brown fox jumps over the lazy dog. ";
  let prompt = "";
  while (true) {
    prompt += seedText;
    const tok = model.tokenize(prompt);
    if (tok.length >= TOK) break;
  }

  const tokens = model.tokenize(prompt).slice(0, TOK);
  process.stdout.write(`[W] tokens: ${tokens.length}\n`);

  const seq = context.getSequence();

  if (KQ) {
    // Simulate QRRanker setup for kq_soft_max
    const queryEnd = Math.floor(tokens.length / 4);
    context.setKqSoftMaxQueryRange(0, queryEnd);
    process.stdout.write(`[W] setKqSoftMaxQueryRange: [0, ${queryEnd})\n`);

    const nModelLayerBlocks = model.fileInsights.totalLayers - 1;
    context.setKqSoftMaxLayerRange(0, nModelLayerBlocks);
    process.stdout.write(`[W] setKqSoftMaxLayerRange: [0, ${nModelLayerBlocks})\n`);
  }

  process.stdout.write(`[W] evaluating ${tokens.length} tokens ...\n`);

  if (KQ) {
    // Decode-stage mode
    const gen = seq.evaluate(tokens, { temperature: 0.6 });
    const first = await gen.next();
    if (first.done || !first.value) {
      process.stdout.write(`[W] UNSUPPORTED: evaluate() returned empty first token\n`);
      return;
    }
    process.stdout.write(`[W] OK  prefill done, first token: ${first.value}\n`);

    try {
      const scores = context.getKqSoftMax();
      process.stdout.write(`[W] OK  getKqSoftMax() returned shape=[${scores.length}]\n`);
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? e.message : String(e);
      process.stdout.write(`[W] UNSUPPORTED: getKqSoftMax() threw: ${msg}\n`);
      return;
    }
  } else {
    // Prefill-only mode
    await seq.evaluateWithoutGeneratingNewTokens(tokens);
    process.stdout.write(`[W] OK  prefill-only done, no kq to read\n`);
  }

  process.stdout.write(`[W] OK  test passed\n`);
}

main().catch((e) => {
  const msg = e && typeof e === "object" && "message" in e ? e.message : String(e);
  process.stdout.write(`[W] UNSUPPORTED: top-level error: ${msg}\n`);
});
