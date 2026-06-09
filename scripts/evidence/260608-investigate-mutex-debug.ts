#!/usr/bin/env npx tsx
/**
 * 260608-investigate-mutex-debug.ts
 * 调试: 为什么 sequences=1 + mutex + setImmediate 仍然失败
 */

import { getLlama, QwenChatWrapper, LlamaChatSession, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import * as jsoncParser from "jsonc-parser"
import * as fs from "fs"
import * as path from "path"

const T = () => (Date.now() % 100000).toString().padStart(5, "0")
function snap(ctx: any, label: string) {
  console.log(`  [${T()} ${label}] nextGen=${ctx._nextGeneratedSequenceId} unused=[${ctx._unusedSequenceIds.join(",")}] left=${ctx.sequencesLeft}`)
}

async function main() {
  const config = jsoncParser.parse(fs.readFileSync(
    path.join(process.env.HOME || "~", ".autodev-cache", "autodev-config.json"), "utf-8"))
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
  const model = await llama.loadModel({ modelPath: config.summarizerLlamaCppModelPath })

  const prompt = `你是一个翻译。请把 "hello world" 翻译成中文。只输出翻译结果。`

  const ctx = await model.createContext({
    contextSize: Math.min(model.trainContextSize ?? 32768, 32768),
    sequences: 1,
  })

  // patch _unusedSequenceIds.push
  const ctxAny = ctx as any
  const unusedArr = ctxAny._unusedSequenceIds
  const origPush = unusedArr.push.bind(unusedArr)
  unusedArr.push = function(...args: any[]) {
    console.log(`  [${T()} unused.push] push(${args.join(",")}) ← 真正归还`)
    return origPush(...args)
  }

  let mutex: Promise<any> = Promise.resolve()

  async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = mutex
    let release: () => void
    mutex = new Promise<void>(r => { release = r })
    console.log(`  [${T()} mutex] acquire, prev=${prev === Promise.resolve() ? "init" : "queued"}`)
    try {
      await prev
      console.log(`  [${T()} mutex] got lock, run fn`)
      return await fn()
    } finally {
      console.log(`  [${T()} mutex] release`)
      release!()
    }
  }

  async function call(tag: string) {
    return await withMutex(async () => {
      console.log(`  [${T()} ${tag}] try getSequence`)
      const sequence = ctx.getSequence()
      console.log(`  [${T()} ${tag}] got id=${(sequence as any)._sequenceId}`)
      try {
        await sequence.clearHistory()
        const chatWrapper = new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })
        const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper })
        const r = await session.prompt(prompt, { temperature: 0, maxTokens: 32 })
        console.log(`  [${T()} ${tag}] prompt done`)
        return r
      } finally {
        await sequence.dispose()
        console.log(`  [${T()} ${tag}] dispose done, now setImmediate`)
        await new Promise(r => setTimeout(r, 50))
        console.log(`  [${T()} ${tag}] setTimeout done`)
      }
    })
  }

  console.log(`\n=== sequences=1, mutex + setImmediate, warm + conc×2 ===\n`)
  try { await call("warm") } catch (e: any) { console.log(`  warm 失败: ${e.message}`) }
  snap(ctx, "after warm")

  // 等一会儿看完整状态
  await new Promise(r => setTimeout(r, 50))
  snap(ctx, "after warm +50ms")

  console.log(`\n>>> 触发并发×2 <<<\n`)
  const [r1, r2] = await Promise.allSettled([
    call("c1"),
    call("c2"),
  ])
  console.log(`\n  c1: ${r1.status}${r1.status === 'rejected' ? ' ' + (r1.reason as Error).message : ''}`)
  console.log(`  c2: ${r2.status}${r2.status === 'rejected' ? ' ' + (r2.reason as Error).message : ''}`)

  await ctx.dispose()
}

main().catch(e => { console.error(e); process.exit(1) })
