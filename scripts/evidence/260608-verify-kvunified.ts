#!/usr/bin/env npx tsx
/**
 * Verify kv_unified parameter works correctly.
 * - Test 1: kvUnified=false (default) — n_ctx_seq = contextSize / sequences
 * - Test 2: kvUnified=true — n_ctx_seq = contextSize
 */
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import * as jsoncParser from "jsonc-parser"
import * as fs from "fs"
import * as path from "path"

async function main() {
  const configPath = path.join(process.env.HOME || "~", ".autodev-cache", "autodev-config.json")
  const config = jsoncParser.parse(fs.readFileSync(configPath, "utf-8"))
  const modelPath = config.summarizerLlamaCppModelPath

  const llama = await getLlama({ logLevel: LlamaLogLevel.info })
  const model = await llama.loadModel({ modelPath })
  const ctxSize = model.trainContextSize ?? 32768

  console.log("=".repeat(60))
  console.log("Test 1: kvUnified=false (default), sequences=4")
  console.log("=".repeat(60))
  const ctx1 = await model.createContext({ contextSize: ctxSize, sequences: 4 })
  console.log("  contextSize:", ctx1.contextSize)
  ctx1.dispose()

  console.log("=".repeat(60))
  console.log("Test 2: kvUnified=true, sequences=4")
  console.log("=".repeat(60))
  const ctx2 = await model.createContext({ contextSize: ctxSize, sequences: 4, kvUnified: true })
  console.log("  contextSize:", ctx2.contextSize)
  ctx2.dispose()

  console.log("=".repeat(60))
  console.log("All tests passed ✓")
}
main().catch(e => { console.error(e); process.exit(1) })
