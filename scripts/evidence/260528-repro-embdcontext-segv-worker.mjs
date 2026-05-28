#!/usr/bin/env node
// Worker: 测试单个 batchSize 的 createEmbeddingContext
// 通过环境变量 _BS 接收 batchSize
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";
import { writeSync } from "fs";

const MODEL = "/Users/anrgct/llm_models/openbmb/MiniCPM5-1B-GGUF/MiniCPM5-1B-Q8_0.gguf";
const BS = parseInt(process.env["_BS"] || "0", 10);

if (!BS) { writeSync(2, "E: _BS not set\n"); process.exit(1); }

writeSync(1, `[W] Loading model ...\n`);
const llama = await getLlama({ logLevel: LlamaLogLevel.error });
const model = await llama.loadModel({ modelPath: MODEL });

writeSync(1, `[W] createEmbeddingContext batchSize=${BS} ...\n`);
const ctx = await model.createEmbeddingContext({ batchSize: BS, embdLayer: -1 });

writeSync(1, `[W] getEmbeddingsForTokens ...\n`);
const embs = await ctx.getEmbeddingsForTokens("Hello, world!");

if (!embs || !embs.length) {
  writeSync(2, "[W] Empty embeddings\n");
  await ctx.dispose();
  process.exit(1);
}

writeSync(1, `[W] OK  dim=${embs[0].length}\n`);
await ctx.dispose();
process.exit(0);
