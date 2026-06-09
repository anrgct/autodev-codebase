#!/usr/bin/env npx tsx
/**
 * 260608-investigate-lock-blocker.ts
 *
 * 通过追踪 _reclaimUnusedSequenceId 何时真正 push 到 _unusedSequenceIds,
 * 找到在 dispose 后到 push 之间, 谁占着 context 锁
 */

import { getLlama, QwenChatWrapper, LlamaChatSession, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import * as jsoncParser from "jsonc-parser"
import * as fs from "fs"
import * as path from "path"

function snap(ctx: any, label: string) {
  console.log(
    `  [${label}] ` +
    `nextGen=${ctx._nextGeneratedSequenceId} ` +
    `unused=[${ctx._unusedSequenceIds.join(",")}] ` +
    `left=${ctx.sequencesLeft}`
  )
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  const config = jsoncParser.parse(fs.readFileSync(
    path.join(process.env.HOME || "~", ".autodev-cache", "autodev-config.json"), "utf-8"))
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
  const model = await llama.loadModel({ modelPath: config.summarizerLlamaCppModelPath })

  const ctx = await model.createContext({
    contextSize: Math.min(model.trainContextSize ?? 32768, 32768),
    sequences: 2,
  })

  // patch _reclaimUnusedSequenceId
  const origReclaim = ctx._reclaimUnusedSequenceId.bind(ctx)
  let reclaimCallCount = 0
  ;(ctx as any)._reclaimUnusedSequenceId = function(seqId: number) {
    reclaimCallCount++
    console.log(`  [reclaim #${reclaimCallCount}] enter seqId=${seqId}, t=${Date.now() % 100000}`)
    const r = origReclaim(seqId)
    console.log(`  [reclaim #${reclaimCallCount}] return (withLock scheduled), t=${Date.now() % 100000}`)
    return r
  }

  // patch _unusedSequenceIds.push
  const ctxAny = ctx as any
  const unusedArr = ctxAny._unusedSequenceIds
  const origPush = unusedArr.push.bind(unusedArr)
  unusedArr.push = function(...args: any[]) {
    console.log(`  [unused.push] push(${args.join(",")}), t=${Date.now() % 100000}`)
    return origPush(...args)
  }

  const prompt = `你是一个翻译。请把 "hello world" 翻译成中文。只输出翻译结果。`

  async function oneCall(tag: string) {
    console.log(`\n--- ${tag} 开始 t=${Date.now() % 100000} ---`)
    const sequence = ctx.getSequence()
    console.log(`  get → id=${(sequence as any)._sequenceId}`)

    await sequence.clearHistory()
    const chatWrapper = new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })
    const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })

    const t0 = Date.now()
    const response = await session.prompt(prompt, { temperature: 0, maxTokens: 64 })
    const t1 = Date.now()
    console.log(`  prompt 完成 (${t1 - t0}ms), t=${Date.now() % 100000}`)
    snap(ctx, `${tag} after prompt`)

    console.log(`  >>> 即将 await sequence.dispose(), t=${Date.now() % 100000}`)
    await sequence.dispose()
    console.log(`  >>> await sequence.dispose() 返回, t=${Date.now() % 100000}`)
    snap(ctx, `${tag} after dispose`)

    console.log(`--- ${tag} 结束 ---`)
  }

  console.log("\n=== 单次调用时序追踪 ===\n")
  await oneCall("A")

  await sleep(50)
  snap(ctx, "+50ms")

  await ctx.dispose()
}

main().catch(e => { console.error(e); process.exit(1) })
