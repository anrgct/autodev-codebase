#!/usr/bin/env npx tsx
/**
 * 快速观测混合注入 / free-running 生成输出
 * 用法: npx tsx scripts/evidence/260624-quick-gen.ts [query] [--log-level=debug]
 */
import { LlamaCppLlm2VecEmbedder } from "../../src/code-index/embedders/llamacpp-llm2vec.ts"
import { createLogger } from "../../src/utils/logger.ts"

// 从 demo 配置拿 LLM2Vec 模型路径
const MODEL_PATH = "/Users/anrgct/workspace/llm2vec-gen/gguf/qwen3-4b/qwen3-4b-llm2vec-unified-q8_0-mlp.gguf"

const logLevel = process.argv.includes("--log-level=debug") ? "debug" : "info"
const logger = createLogger({ level: logLevel })

async function main() {
  const query = process.argv[2] || "What is the capital of France?"

  const emb = new LlamaCppLlm2VecEmbedder(MODEL_PATH, undefined, logger)
  await emb.createEmbeddings(["dummy"])  // 触发初始化

  logger.info(`\n── generateFreeRunning(pure recon, baseline) ──`)
  const freeText = await emb.generateFreeRunning(query, 30)
  logger.info(`result: "${freeText}"`)

  logger.info(`\n── generateWithPrompt(mixed injection) ──`)
  const mixedText = await emb.generateWithPrompt(query, "Query: find relevant clues", 30)
  logger.info(`result: "${mixedText}"`)

  await emb.dispose()
}

main().catch(err => { console.error(err); process.exit(1) })
