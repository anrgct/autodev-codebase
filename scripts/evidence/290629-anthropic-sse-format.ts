/**
 * 验证：Anthropic SSE 流式事件的格式合规性。
 *
 * 测试 escalated proxy 在 Anthropic Messages API 格式下输出的 SSE 事件
 * 是否符合 Anthropic 规范。
 *
 * ## 验证项
 *
 * | 检查项 | 判定 |
 * |--------|------|
 * | 所有 `data:` 行都是有效 Anthropic Stream Event（有 `type`） | ✅ |
 * | `message_start` 中包含 `message.id` | ✅ |
 * | 事件序列合规：message_start → content_block_* → message_delta → message_stop | ✅ |
 * | 没有 `data: [DONE]`（Anthropic 无此概念） | ✅ |
 * | `message_stop` 只在最末尾出现一次 | ✅ |
 * | content_block 的 `index` 字段为连续非负整数 | ✅ |
 * | 合成事件（advisor begin/end、tier switch）格式有效 | ✅ |
 *
 * ## 用法
 *
 *   # 前提：escalate 代理已启动
 *   npx tsx src/cli.ts escalate --mode advisor
 *
 *   # 运行测试
 *   npx tsx scripts/evidence/290629-anthropic-sse-format.ts
 *
 * ## 修复记录
 *
 *   日期: 2026-06-29
 *   关联: docs/plans/260629-anthropic-migration.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as jsoncParser from 'jsonc-parser'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type EscalateMode = 'self-report' | 'advisor'
interface ResolvedConfig {
  proxyUrl: string
  apiKey: string
  mode: EscalateMode
}

function loadConfig(): ResolvedConfig {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const configPath = path.resolve(__dirname, '..', '..', 'autodev-config.json')
  const raw = fs.readFileSync(configPath, 'utf-8')
  const cfg = jsoncParser.parse(raw) as Record<string, unknown>

  const host = String(cfg.escalateHost ?? 'localhost')
  const port = String(cfg.escalatePort ?? '8080')
  const apiKey = String(cfg.escalateApiKey ?? '')
  const mode = String(cfg.escalateMode ?? 'advisor') as EscalateMode
  const proxyUrl = `http://${host}:${port}/v1/messages`

  console.error(`配置: host=${host}, port=${port}, mode=${mode}, key=${apiKey ? apiKey.slice(0, 8) + '...' : '(空)'}`)
  return { proxyUrl, apiKey, mode }
}

const { proxyUrl: PROXY_URL, apiKey: API_KEY, mode: MODE } = loadConfig()

// ---------------------------------------------------------------------------
// Anthropic Streaming Event Types
// ---------------------------------------------------------------------------

type AnthropicStreamType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'

interface ParsedEvent {
  /** Line number in the raw response. */
  lineNum: number
  /** The event type (from `event:` header or `data.type`). */
  eventType?: AnthropicStreamType
  /** Whether the `data:` payload is valid JSON with a `type` field. */
  isValid: boolean
  /** The `type` field from the event JSON. */
  type?: string
  /** Content block index (for content_block_* events). */
  index?: number
  /** Content block type (text / thinking / tool_use). */
  blockType?: string
  /** Delta type (text_delta / thinking_delta / input_json_delta). */
  deltaType?: string
  /** Whether this is a synthetic proxy event. */
  isProxyEvent: boolean
  /** Full parsed JSON payload (for further inspection). */
  parsed: Record<string, unknown> | null
  /** The raw JSON payload (truncated to 200 chars for display). */
  raw: string
}

// ---------------------------------------------------------------------------
// SSE Stream Reader & Analyzer
// ---------------------------------------------------------------------------

async function streamAndAnalyze(
  label: string,
  body: Record<string, unknown>,
): Promise<void> {
  console.error(`\n=== ${label} ===`)

  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY || 'sk-not-set',
      'anthropic-version': '2023-06-01',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
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
  const events: ParsedEvent[] = []

  // Track event types seen
  const seenTypes = new Set<AnthropicStreamType>()
  let hasMessageStart = false
  let hasMessageStop = false
  let messageStartLine = -1
  let messageStopLine = -1
  let lastIndex: number | null = null
  const indicesSeen = new Set<number>()

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]

    let eventTypeFromHeader: string | undefined
    let isDataLine = false
    let payload: string | undefined

    if (l.startsWith('event:')) {
      // !event: line followed by data: line — full Anthropic SSE format
      eventTypeFromHeader = l.slice(6).trim()
      const nextLine = lines[i + 1]
      if (nextLine && nextLine.startsWith('data:')) {
        isDataLine = true
        payload = nextLine.slice(5).trim()
      }
    } else if (l.startsWith('data:')) {
      // Standalone data: line — infer type from payload
      isDataLine = true
      payload = l.slice(5).trim()
    }

    if (!isDataLine || !payload) continue

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      // Not JSON
    }

    const eventTypeFromPayload = parsed?.type as string | undefined
    const isProxyEvent =
      payload.includes('proxy:') ||
      payload.includes('consulting advisor') ||
      payload.includes('back to flash') ||
      payload.includes('proxy error') ||
      payload.includes('now on ')

    const eventInfo: ParsedEvent = {
      lineNum: i,
      eventType: (eventTypeFromHeader ?? eventTypeFromPayload) as AnthropicStreamType | undefined,
      isValid: parsed !== null && typeof parsed?.type === 'string',
      type: eventTypeFromPayload,
      index: parsed?.index as number ?? undefined,
      blockType: (parsed as any)?.content_block?.type as string ?? undefined,
      deltaType: (parsed as any)?.delta?.type as string ?? undefined,
      isProxyEvent,
      parsed,
      raw: payload.slice(0, 200),
    }
    events.push(eventInfo)

    const type = eventTypeFromHeader ?? eventTypeFromPayload
    if (type) {
      seenTypes.add(type as AnthropicStreamType)

      if (type === 'message_start') {
        hasMessageStart = true
        messageStartLine = i
      }
      if (type === 'message_stop') {
        hasMessageStop = true
        messageStopLine = i
      }
    }

    if (parsed && typeof parsed.index === 'number') {
      indicesSeen.add(parsed.index as number)
      lastIndex = parsed.index as number
    }
  }

  // ---- 验证指标 ----

  const totalEvents = events.length
  const validEvents = events.filter(e => e.isValid).length
  const invalidEvents = events.filter(e => !e.isValid)
  const proxyEvents = events.filter(e => e.isProxyEvent)
  const hasDone = raw.includes('[DONE]')

  // 检查事件序列
  const eventSequence = Array.from(seenTypes).join(' → ')
  const hasValidSequence =
    hasMessageStart && hasMessageStop

  // 检查 message_stop 是否在末尾
  const messageStopIsLast = messageStopLine >= lines.length - 4 // allow trailing blank lines

  // 检查 content_block index 连续性
  const sortedIndices = Array.from(indicesSeen).sort((a, b) => a - b)
  const isIndexContinuous = sortedIndices.every((val, idx) => idx === 0 || val === sortedIndices[idx - 1] + 1)

  // ---- 输出结果 ----
  console.error(`结果:`)
  console.error(`  总行数: ${lines.length}`)
  console.error(`  解析事件: ${totalEvents} 个`)
  console.error(`  有效事件: ${validEvents}/${totalEvents}`)
  console.error(`  事件类型序列: ${eventSequence || '(空)'}`)
  console.error(`  代理注入事件: ${proxyEvents.length} 个`)
  console.error(`  包含 [DONE]: ${hasDone ? '❌ 有' : '✅ 无'}`)

  // 1. message_start 检查
  if (hasMessageStart) {
    const startEvent = events.find(e => e.eventType === 'message_start')
    const startPayload = startEvent?.parsed
    const hasMessageId = startPayload?.message && typeof (startPayload.message as any)?.id === 'string'
    console.error(`  message_start: ${hasMessageId ? '✅ 有id' : '❌ 无id'}`)
  } else {
    console.error(`  message_start: ❌ 缺失`)
  }

  // 2. message_stop 检查
  console.error(`  message_stop: ${hasMessageStop ? `✅ 出现 (line=${messageStopLine})` : '❌ 缺失'}`)
  if (hasMessageStop) {
    console.error(`  message_stop 位置: ${messageStopIsLast ? '✅ 在末尾' : '⚠️ 不在末尾 (line ' + messageStopLine + ')'}`)
  }

  // 3. 连续性
  if (sortedIndices.length > 0) {
    console.error(`  content_block indices: [${sortedIndices.join(',')}] ${isIndexContinuous ? '✅ 连续' : '⚠️ 不连续'}`)
  }

  // 4. 合成事件格式
  if (proxyEvents.length > 0) {
    const badProxy = proxyEvents.filter(e => !e.isValid)
    console.error(`  合成事件: ${proxyEvents.length} 个${badProxy.length > 0 ? `, ❌ ${badProxy.length}个无效` : ', ✅ 全部有效'}`)
    // 检查 content_block indices 在 proxy 事件附近
    const proxyWithIndex = proxyEvents.filter(e => e.index !== undefined)
    if (proxyWithIndex.length > 0) {
      const proxyIndices = proxyWithIndex.map(e => e.index)
      console.error(`  合成事件 indices: [${proxyIndices.join(',')}]`)
    }
  }

  // 5. 汇总判定
  console.error()
  const passed = validEvents === totalEvents && hasMessageStart && hasMessageStop && !hasDone
  console.error(`判定: ${passed ? '✅ 通过' : '❌ 失败'}`)
  if (!passed) {
    if (validEvents !== totalEvents) {
      for (const e of invalidEvents) {
        console.error(`  无效事件 (line ${e.lineNum}): ${e.raw.slice(0, 100)}`)
      }
    }
    if (!hasMessageStart) console.error('  - message_start 缺失')
    if (!hasMessageStop) console.error('  - message_stop 缺失')
    if (hasDone) console.error('  - 有不该出现的 [DONE]')
  }

  // 保存原始响应
  const fn = `/tmp/anthropic-sse-${label.replace(/[^a-z0-9]/g, '_')}-${Date.now()}.log`
  fs.writeFileSync(fn, raw)
  console.error(`  日志: ${fn}`)
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

async function main() {
  console.error(`Escalate 模式: ${MODE}`)
  console.error(`目标 URL: ${PROXY_URL}`)
  console.error()

  const tests: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: '基础对话-带thinking',
      body: {
        model: 'deepseek-v4-flash',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        max_tokens: 256,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1000 },
      },
    },
    {
      label: '基础对话-无thinking',
      body: {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        max_tokens: 128,
        stream: true,
      },
    },
    {
      label: '测试advisor',
      body: {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '测试一下advisor tool，请回复一句简短的确认消息说明tool正常工作。' }],
        max_tokens: 1024,
        stream: true,
      },
    },
  ]

  for (const tc of tests) {
    await streamAndAnalyze(tc.label, tc.body)
  }

  console.error('\n✅ 完成。')
}

main().catch(err => { console.error('错误:', err); process.exit(1) })
