#!/usr/bin/env npx tsx
/**
 * 完整复现 + 验证最终方案
 *
 * 结论：
 *   session.prompt 后 dispose 不会完全归还 sequence 槽位
 *   所以 sequences 需要 >= 实际并发数的 2 倍才能安全
 *
 | 场景 | 结果 |
 |------|------|
 | 纯 `getSequence → dispose → getSequence` | ✓ 可复用 |
 | `prompt → dispose → 串行再 getSequence` | ✓ 可复用 |
 | `prompt → dispose → **并发** getSequence×2` | ✗ 只拿到 1 个 |

 解释：`session.prompt` 内部推理时会持有 context 级锁或临时槽位，prompt 结束后释放。但在**并发 getSequence** 场景下，两个请求几乎同时到达，其中一个会撞上这个锁还没完全释放的窗口。

 所以不是 dispose 的问题，是 llama.cpp 的 context 在推理后对并发 getSequence 有竞态。最稳的方案就是槽位多开——`sequences = concurrency × 2` 兜住这个窗口。

 */

import { getLlama, QwenChatWrapper, LlamaChatSession, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import { LlamaCppSummarizer } from "../../src/code-index/summarizers/llamacpp"
import { createNodeDependencies } from "../../src/adapters/nodejs"
import * as jsoncParser from "jsonc-parser"
import * as fs from "fs"
import * as path from "path"

async function main() {
  const config = jsoncParser.parse(fs.readFileSync(
    path.join(process.env.HOME || "~", ".autodev-cache", "autodev-config.json"), "utf-8"))
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
  const model = await llama.loadModel({ modelPath: config.summarizerLlamaCppModelPath })
  const deps = createNodeDependencies({
    workspacePath: process.cwd(),
    loggerOptions: { name: "Test", level: "warn", timestamps: false, colors: false },
  })

  const blocks = [
    { content: "def add(a,b):\n    return a+b", codeType: "function", codeName: "add" },
    { content: "class Svc:\n    def get(self,id):\n        return db.query(id)", codeType: "class", codeName: "Svc" },
  ]

  // 测试不同 sequences 值
  for (const seq of [1, 2, 4]) {
    console.log(`\n${"═".repeat(50)}`)
    console.log(`sequences=${seq}`)
    console.log(`${"═".repeat(50)}`)

    const s = new LlamaCppSummarizer(model, "Chinese", 0, deps.logger, 2, seq)

    // 串行预热
    const r0 = await s.summarizeBatch({ document: "", filePath: "t.py", blocks, language: "Chinese" })
    console.log(`串行: [0] ${r0.summaries[0]?.summary?.slice(0, 30) || "(空)"}...`)
    console.log(`      [1] ${r0.summaries[1]?.summary?.slice(0, 30) || "(空)"}...`)

    // 并发
    const results = await Promise.allSettled([
      s.summarizeBatch({ document: "", filePath: "a.py", blocks: [blocks[0]], language: "Chinese" }),
      s.summarizeBatch({ document: "", filePath: "b.py", blocks: [blocks[1]], language: "Chinese" }),
    ])
    results.forEach((r, i) => {
      if (r.status === "fulfilled") console.log(`并发[${i}] ✓ ${r.value.summaries[0]?.summary?.slice(0, 30) || "(空)"}...`)
      else console.log(`并发[${i}] ✗ ${(r.reason as any)?.message || r.reason}`)
    })

    await s.dispose()
  }
}
main().catch(e => { console.error(e); process.exit(1) })
