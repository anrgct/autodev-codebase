/**
 * 复现 & 验证：advisor 模式下 SSE content 事件空行丢失 + [DONE] 位置错误。
 *
 * ## 现象
 *
 * Escalate 代理（advisor 模式）的 SSE 响应中：
 * 1. content 事件之间缺少空行分隔符（\n\n），连续 data: 行被 SSE 客户端拼接为
 *    单事件，JSON.parse() 失败：
 *      SyntaxError: Unexpected non-whitespace character after JSON at position 319
 * 2. data: [DONE] 出现在推理结束之后、内容之前（而非末尾），客户端提前终止流。
 *
 * ## 根因
 *
 * src/escalate/dispatcher.ts → peekAdvisorStream():
 *
 *   事件类型        | 处理方式              | 问题
 *   ---------------|-----------------------|-------------------------------
 *   reasoning      | 立即转发              | ✅ 正确
 *   空行（分隔符）   | !line.isData → 立即转发 | ❌ content 缓冲期间空行被提前转发
 *   content        | 缓冲到 passthroughBytes | ❌ 流结束才 flush
 *   [DONE]         | line.done → 立即转发   | ❌ content 缓冲期间 [DONE] 被提前转发
 *
 * 结果：空行和 [DONE] 跑到 content 数据前面，content 事件失去 \n\n 分隔符。
 *
 * ## 修复
 *
 * 引入 bufMode 标志位：content/tool_call 缓冲时进入 buffering 状态，后续空行、
 * [DONE]、非 delta 行全部跟随缓冲；reasoning 立即转发并重置 bufMode。
 *
 * ## 用法
 *
 *   # 前提：escalate 代理已启动（npx tsx src/cli.ts escalate）
 *   npx tsx scripts/evidence/280628-sse-content-blank-line-loss.ts
 *
 * ## 判定标准
 *
 *   content 空行缺失: 0/N    → ✅ 修复生效
 *   content 空行缺失: N/N    → ❌ bug 存在
 *   [DONE] 偏中             → ❌ [DONE] 过早
 *
 * ## 修复记录
 *
 *   日期: 2026-06-28
 *   文件: src/escalate/dispatcher.ts
 *   方法: peekAdvisorStream() — bufMode 标志位
 *   文档: docs/plans/260624-advisor-mode.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as jsoncParser from 'jsonc-parser'

// 从项目 autodev-config.json 读取配置（支持 JSONC 注释）
function loadConfig(): { proxyUrl: string; apiKey: string } {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const configPath = path.resolve(__dirname, '..', '..', 'autodev-config.json')
  const raw = fs.readFileSync(configPath, 'utf-8')
  // jsonc-parser 直接处理注释和尾逗号，不需要额外替换
  const cfg = jsoncParser.parse(raw) as Record<string, unknown>

  const host = String(cfg.escalateHost ?? 'localhost')
  const port = String(cfg.escalatePort ?? '8080')
  const apiKey = String(cfg.escalateApiKey ?? '')
  const proxyUrl = `http://${host}:${port}/v1/chat/completions`

  console.error(`配置: host=${host}, port=${port}, key=${apiKey ? apiKey.slice(0,8)+'...' : '(空)'}`)
  return { proxyUrl, apiKey }
}

const { proxyUrl: PROXY_URL, apiKey: API_KEY } = loadConfig()

interface TestCase {
  label: string
  messages: Array<{ role: string; content: string }>
}

async function test({ label, messages }: TestCase) {
  console.error(`\n=== ${label} ===`)
  const body = JSON.stringify({ messages, stream: true })
  console.error(`发送: ${body.slice(0, 200)}...`)

  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'Accept': 'text/event-stream',
    },
    body,
  })

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
    return
  }

  // 流式读取完整响应
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let raw = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) raw += decoder.decode(value, { stream: true })
    if (done) break
  }

  // ---- SSE 分析 ----
  const lines = raw.split('\n')
  const contentPositions: number[] = []      // content 事件所在行号
  const reasoningPositions: number[] = []    // reasoning 事件所在行号
  let prevContentLine = -1
  let missingBlank = 0

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('data:')) continue

    const payload = l.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    try {
      const j = JSON.parse(payload)
      const c = j?.choices?.[0]?.delta?.content
      const r = j?.choices?.[0]?.delta?.reasoning_content

      // 统计 content 事件
      if (typeof c === 'string' && c.length > 0) {
        contentPositions.push(i)
        // 相邻 content 行之间缺少空行 → bug
        if (prevContentLine >= 0 && i === prevContentLine + 1) missingBlank++
        prevContentLine = i
      }

      // 统计 reasoning 事件
      if (typeof r === 'string' && r.length > 0) reasoningPositions.push(i)
    } catch { /* 忽略解析错误 */ }
  }

  const doneIdx = lines.findIndex(l => l.trim() === 'data: [DONE]')

  // ---- 输出结果 ----
  console.error(
    `结果: ${lines.length}行, reasoning=${reasoningPositions.length}, content=${contentPositions.length}`
  )

  if (contentPositions.length > 1) {
    const pct = missingBlank > 0
      ? `❌ 有 ${missingBlank}/${contentPositions.length - 1} 个 content 之间缺少空行`
      : `✅ 所有 ${contentPositions.length - 1} 个 content 间隔都有空行分隔符`
    console.error(`  content 空行: ${pct}`)
  }

  const doneEarly = doneIdx >= 0 && contentPositions.length > 0 && doneIdx < contentPositions[0]
  console.error(
    `  [DONE] 位置: ${doneIdx}/${lines.length}` +
    (doneEarly ? ` ⚠️ 在第一个 content (行${contentPositions[0]}) 之前` : ` ✅ 正常`)
  )

  // 保存原始响应到 tmp
  const fs = await import('fs')
  const fn = `/tmp/repro-${label.replace(/[^a-z0-9]/g, '_')}-${Date.now()}.log`
  fs.writeFileSync(fn, raw)
  console.error(`  日志: ${fn}`)
}

async function main() {
  // 三种不同复杂度的请求覆盖不同场景
  const tests: TestCase[] = [
    { label: '你好', messages: [{ role: 'user', content: '你好' }] },
    { label: 'readme', messages: [{ role: 'user', content: '请读取README.md文件的内容' }] },
    { label: '工具调用', messages: [{ role: 'user', content: '用read_file工具读取README.md的第一行' }] },
  ]

  for (const tc of tests) {
    await test(tc)
  }

  console.error('\n✅ 完成。对比 /tmp/repro-*.log 中 content 行的 blank_before 即可确认修复状态。')
}

main().catch(err => { console.error('错误:', err); process.exit(1) })
