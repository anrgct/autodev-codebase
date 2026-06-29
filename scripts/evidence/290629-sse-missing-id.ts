/**
 * 复现 & 验证：advisor 模式下代理注入的 SSE 事件缺少 `id` 字段。
 *
 * ## 现象
 *
 * Escalate 代理（advisor 模式）的 SSE 响应中：
 * 1. 上游 DeepSeek API 的事件包含 `id` 字段
 * 2. proxy 注入的合成事件（advisor begin/end、tier switch 等）缺少 `id` 字段
 * 3. `streamProAsReasoning` 中 content → reasoning_content 重写时丢弃了原始事件的 `id`
 *
 * 导致 SSE 事件流中出现有 id / 无 id 的不一致，某些 SSE 客户端（如严格校验的）
 * 可能因此丢弃事件。
 *
 * ## 根因
 *
 * src/escalate/dispatcher.ts:
 *
 *   函数                         | 问题
 *   ----------------------------|-------------------------------
 *   buildAdvisorBeginEvent()    | payload 无 `id`
 *   buildAdvisorEndEvent()      | payload 无 `id`
 *   buildTierSwitchEvent()      | payload 无 `id`
 *   buildProxyErrorEvent()      | payload 无 `id`
 *   streamProAsReasoning()      | L1907 只构造 { choices: [...] }，丢弃顶层 `id`
 *
 * ## 修复
 *
 * - 4 个合成事件构建函数 → 添加 `id: randomUUID()`
 * - streamProAsReasoning → 重写时保留 `parsed.id`
 *
 * ## 用法
 *
 *   # 前提：escalate 代理已启动（npx tsx src/cli.ts escalate --mode advisor）
 *   npx tsx scripts/evidence/290629-sse-missing-id.ts
 *
 * ## 判定标准
 *
 *   所有 data: 事件都有 id 字段                         → ✅ 修复生效
 *   存在 data: 事件缺少 id 字段（排除 data: [DONE]）    → ❌ bug 存在
 *
 * ## 修复记录
 *
 *   日期: 2026-06-29
 *   文件: src/escalate/dispatcher.ts
 *   函数: buildAdvisorBeginEvent, buildAdvisorEndEvent, buildTierSwitchEvent,
 *         buildProxyErrorEvent, streamProAsReasoning
 *   文档: docs/plans/260624-advisor-mode.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as jsoncParser from 'jsonc-parser'

// 从项目 autodev-config.json 读取配置（支持 JSONC 注释）
function loadConfig(): { proxyUrl: string; apiKey: string; mode: string } {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const configPath = path.resolve(__dirname, '..', '..', 'autodev-config.json')
  const raw = fs.readFileSync(configPath, 'utf-8')
  const cfg = jsoncParser.parse(raw) as Record<string, unknown>

  const host = String(cfg.escalateHost ?? 'localhost')
  const port = String(cfg.escalatePort ?? '8080')
  const apiKey = String(cfg.escalateApiKey ?? '')
  const mode = String(cfg.escalateMode ?? 'advisor')
  const proxyUrl = `http://${host}:${port}/v1/chat/completions`

  console.error(`配置: host=${host}, port=${port}, mode=${mode}, key=${apiKey ? apiKey.slice(0, 8) + '...' : '(空)'}`)
  return { proxyUrl, apiKey, mode }
}

const { proxyUrl: PROXY_URL, apiKey: API_KEY, mode: MODE } = loadConfig()

interface TestCase {
  label: string
  messages: Array<{ role: string; content: string }>
}

interface SseEventInfo {
  lineNum: number
  hasId: boolean
  idValue?: string
  hasObject: boolean
  hasCreated: boolean
  hasModel: boolean
  modelValue?: string
  hasContent: boolean
  hasReasoning: boolean
  toolCalls?: boolean
  finishReason?: string
  raw: string
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
  const events: SseEventInfo[] = []
  const missingIdEvents: SseEventInfo[] = []

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('data:')) continue

    const payload = l.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    try {
      const j = JSON.parse(payload) as Record<string, unknown>
      const c = j?.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string }> | undefined
      const delta = c?.[0]?.delta

      const info: SseEventInfo = {
        lineNum: i,
        hasId: typeof j.id === 'string' && j.id.length > 0,
        idValue: typeof j.id === 'string' ? j.id : undefined,
        hasObject: j.object === 'chat.completion.chunk',
        hasCreated: typeof j.created === 'number',
        hasModel: typeof j.model === 'string' && j.model.length > 0,
        modelValue: typeof j.model === 'string' ? j.model : undefined,
        hasContent: typeof delta?.content === 'string' && (delta.content as string).length > 0,
        hasReasoning: typeof delta?.reasoning_content === 'string' && (delta.reasoning_content as string).length > 0,
        toolCalls: delta?.tool_calls !== undefined,
        finishReason: c?.[0]?.finish_reason as string | undefined,
        raw: payload.slice(0, 200),
      }
      events.push(info)

      if (!info.hasId || !info.hasObject || !info.hasCreated || !info.hasModel) {
        missingIdEvents.push(info)
      }
    } catch { /* 忽略解析错误 */ }
  }

  // ---- 输出结果 ----
  console.error(`结果: ${lines.length}行, ${events.length} 个 data 事件`)
  console.error(`  其中 ${missingIdEvents.length} 个缺少 id/object/created/model 任一字段`)

  if (missingIdEvents.length > 0) {
    console.error(`  ❌ 字段缺失的事件:`)
    for (const e of missingIdEvents) {
      const missing: string[] = []
      if (!e.hasId) missing.push('id')
      if (!e.hasObject) missing.push('object')
      if (!e.hasCreated) missing.push('created')
      if (!e.hasModel) missing.push('model')
      const tags: string[] = []
      if (e.hasContent) tags.push('content')
      if (e.hasReasoning) tags.push('reasoning_content')
      if (e.toolCalls) tags.push('tool_calls')
      if (e.finishReason) tags.push(`finish=${e.finishReason}`)
      const tagStr = tags.length > 0 ? tags.join(', ') : '(空delta)'
      console.error(`    行${e.lineNum}: 缺[${missing.join(',')}] | ${tagStr} | raw: ${e.raw.slice(0, 100)}`)
    }
  } else {
    console.error(`  ✅ 所有 data 事件都包含 id/object/created/model 字段`)
  }

  // 额外检查：advisorbash begin/end 事件
  const advisorEvents = events.filter(e =>
    e.hasReasoning && (e.raw.includes('consulting advisor') || e.raw.includes('back to flash'))
  )
  if (advisorEvents.length > 0) {
    const advisorMissingId = advisorEvents.filter(e => !e.hasId)
    console.error(`  advisor 分隔事件: ${advisorEvents.length} 个, 缺少id: ${advisorMissingId.length}`)
    if (advisorMissingId.length > 0) {
      console.error(`    ❌ advisor begin/end 事件缺少 id！`)
    }
  }

  // 额外检查：[DONE] 只能在最后出现一次。
  // pro 子流的 [DONE] 若被转发，真实 SSE 客户端会提前终止流，
  // 丢失后续 advisor end + flash retry 内容。
  const doneLines = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim() === 'data: [DONE]')
  if (doneLines.length > 1) {
    console.error(`  ❌ [DONE] 出现 ${doneLines.length} 次（应只 1 次），位置: ${doneLines.map(x => x.i).join(',')} —— pro 子流 [DONE] 泄漏！`)
  } else if (doneLines.length === 1) {
    const isLast = doneLines[0].i >= events[events.length - 1].lineNum
    console.error(`  ✅ [DONE] 仅 1 次，位置 ${doneLines[0].i}/${lines.length}（${isLast ? '在末尾' : '⚠️ 不在末尾'}）`)
  }

  // 额外检查：tier switch 事件
  const tierSwitchEvents = events.filter(e =>
    e.hasReasoning && e.raw.includes('proxy: now on')
  )
  if (tierSwitchEvents.length > 0) {
    const tierMissingId = tierSwitchEvents.filter(e => !e.hasId)
    console.error(`  tier switch 事件: ${tierSwitchEvents.length} 个, 缺少id: ${tierMissingId.length}`)
    if (tierMissingId.length > 0) {
      console.error(`    ❌ tier switch 事件缺少 id！`)
    }
  }

  // 保存原始响应到 tmp
  const fn = `/tmp/repro-sse-id-${label.replace(/[^a-z0-9]/g, '_')}-${Date.now()}.log`
  fs.writeFileSync(fn, raw)
  console.error(`  日志: ${fn}`)
}

async function main() {
  console.error(`Escalate 模式: ${MODE}`)
  console.error()

  const tests: TestCase[] = [
    // 会触发 tool call 的请求 - advisor 模式更可能被触发
    { label: 'advisorbash测试', messages: [{ role: 'user', content: '这是一个测试调用，请让advisor回复一句简单的确认消息，说明 advisor 工具正常工作。' }] },
  ]

  for (const tc of tests) {
    await test(tc)
  }

  console.error('\n✅ 完成。')
  console.error('判定: 如果所有 data 事件都有 id → 修复生效')
  console.error('      如果 advisor/tier-switch 事件缺少 id → bug 存在')
}

main().catch(err => { console.error('错误:', err); process.exit(1) })
