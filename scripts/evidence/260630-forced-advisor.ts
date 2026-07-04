/**
 * 验证：forced advisor 模式（`escalateForceAdvisor: true`）的四条触发规则。
 *
 * ## 背景
 *
 * advisor 模式默认依赖 flash 自愿调用 `advisor` tool，实测 flash 极少调用。
 * forced advisor 让 proxy 在 flash 循环之前**主动伪造**一次 advisor 调用，
 * 用预设 question 咨询 pro，再把结果注入 messages。pro 必被咨询，question 确定。
 *
 * 四条触发规则（基于 `messages` 末尾状态，stateless）：
 *
 * | 规则       | 触发条件                                          | 预设 question          |
 * |------------|---------------------------------------------------|------------------------|
 * | user-turn  | 末尾 user 且 content 不含 `tool_result`           | 「用户指令的核心需求？是否有歧义？」 |
 * | tool-error | 末尾 user 含 `tool_result` 且该 result 为 error   | 「工具报错的原因？修复建议？」     |
 * | tool-count | 末尾 user 含 `tool_result` 且真实 tool_use %5==0  | 「当前方向是否正确？是否有错漏？下一步建议？」 |
 * | task-done  | 末尾 assistant 且 content 不含 `tool_use`          | 「任务完成了吗？」 |
 *
 * ## 验证点（每个用例）
 *
 * - SSE think 面板出现 `<proxy-advisor-consult question="<预设question>">` 标签
 *   → 证明 forced 触发成功，且 question 是预设值（不是 flash 自编的）
 * - think 面板含 pro 的分析内容（pro 被咨询）
 * - `message_start` 仅 1 次（forced 合成的，flash 第一轮的 message_start 被吞）
 * - `message_stop` 仅 1 次（flash 的，pro 的终止事件不泄漏）
 * - 无 `[DONE]`（Anthropic 格式无此概念）
 * - content 是 flash 综合后的最终答案（pro 原文不泄漏到 content）
 *
 * ## 用法
 *
 *   # 1. 开启 advisor + forced（写入项目配置）
 *   codebase config --set escalateMode=advisor
 *   codebase config --set escalateForceAdvisor=true
 *
 *   # 2. 单独启动服务（保持前台运行）
 *   npx tsx src/cli.ts escalate
 *
 *   # 3. 另开终端运行本脚本
 *   npx tsx scripts/evidence/260630-forced-advisor.ts
 *
 * ## 判定标准
 *
 *   每条用例按时间顺序期望一组规则（pre-response 在前，post-response 在后）。
 *   think 面板中 `<proxy-advisor-consult question="...">` 的顺序和精确集合完全匹配期望 → ✅
 *   多了/少了/顺序错误/未知 question                     → ❌ 该用例不通过
 *
 * ## 关联
 *
 *   设计文档: docs/plans/260630-force-advisor.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as jsoncParser from 'jsonc-parser'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  proxyUrl: string
  apiKey: string
  mode: string
  forceAdvisor: boolean
  flashModel: string
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
  const mode = String(cfg.escalateMode ?? 'self-report')
  const forceAdvisor = cfg.escalateForceAdvisor === true
  const flashModel = String(cfg.escalateFlashModel ?? 'deepseek-v4-flash')
  const proxyUrl = `http://${host}:${port}/v1/messages`

  console.error(`配置: host=${host}, port=${port}, mode=${mode}, forceAdvisor=${forceAdvisor}, key=${apiKey ? apiKey.slice(0, 8) + '...' : '(空)'}`)
  return { proxyUrl, apiKey, mode, forceAdvisor, flashModel }
}

const { proxyUrl: PROXY_URL, apiKey: API_KEY, mode: MODE, forceAdvisor: FORCE_ADVISOR, flashModel: FLASH_MODEL } = loadConfig()

// ---------------------------------------------------------------------------
// 预设 question（必须与 src/escalate/dispatcher.ts 中的常量一致）
// ---------------------------------------------------------------------------

const PRESET_QUESTIONS = {
  'user-turn': '用户指令的核心需求？是否有歧义？',
  'tool-error': '工具报错的原因？修复建议？',
  'tool-count': '当前方向是否正确？是否有错漏？下一步建议？',
  'task-done': '任务完成了吗？',
} as const

type RuleType = keyof typeof PRESET_QUESTIONS

// 反向映射：question 文本 → 规则名
const QUESTION_TO_RULE = Object.fromEntries(
  Object.entries(PRESET_QUESTIONS).map(([rule, q]) => [q, rule as RuleType]),
) as Record<string, RuleType>

// 规则触发阶段
const RULE_PHASE: Record<RuleType, 'pre-response' | 'post-response'> = {
  'user-turn': 'pre-response',
  'tool-error': 'pre-response',
  'tool-count': 'pre-response',
  'task-done': 'post-response',
}

// ---------------------------------------------------------------------------
// SSE 分析
// ---------------------------------------------------------------------------

interface Analysis {
  raw: string
  messageStartCount: number
  messageStopCount: number
  messageStopIsLast: boolean
  hasDone: boolean
  thinking: string
  content: string
  /** 从 advisor begin 分隔符里提取的 question 文本（可能多个）。 */
  advisorQuestions: string[]
  /** content_block index 集合（检查连续性）。 */
  indices: number[]
}

function analyzeSse(raw: string): Analysis {
  const lines = raw.split('\n')

  let messageStartCount = 0
  let messageStopCount = 0
  let messageStopLine = -1
  let hasDone = false
  let thinking = ''
  let content = ''
  const advisorQuestions: string[] = []
  const indices = new Set<number>()

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.includes('[DONE]')) hasDone = true
    if (!l.startsWith('data:')) continue

    const payload = l.slice(5).trim()
    if (!payload) continue

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    const type = parsed.type as string | undefined
    if (type === 'message_start') messageStartCount++
    if (type === 'message_stop') {
      messageStopCount++
      messageStopLine = i
    }
    if (typeof parsed.index === 'number') indices.add(parsed.index as number)

    const delta = (parsed as { delta?: Record<string, unknown> }).delta
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      thinking += delta.thinking as string
    } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      content += delta.text as string
    }
  }

  // 提取 advisor XML 标签里的 question：<proxy-advisor-consult question="<question>">
  const questionRe = /<proxy-advisor-consult\s+question="([^"]*)">/g
  let m: RegExpExecArray | null
  while ((m = questionRe.exec(thinking)) !== null) {
    advisorQuestions.push(m[1].trim())
  }

  // message_stop 是否在末尾（允许尾部最多 3 行空白）
  const messageStopIsLast = messageStopLine >= 0 && messageStopLine >= lines.length - 4

  return {
    raw,
    messageStartCount,
    messageStopCount,
    messageStopIsLast,
    hasDone,
    thinking,
    content,
    advisorQuestions,
    indices: Array.from(indices).sort((a, b) => a - b),
  }
}

// ---------------------------------------------------------------------------
// 单条测试用例
// ---------------------------------------------------------------------------

interface TestCase {
  label: string
  /** 期望触发的规则，按出现顺序（pre-response 在前，post-response 在后） */
  expectedQuestions: RuleType[]
  body: Record<string, unknown>
}

async function runTest(tc: TestCase): Promise<boolean> {
  console.error(`\n=== ${tc.label} ===`)
  console.error(`期望规则: ${tc.expectedQuestions.join(', ')} → 「${tc.expectedQuestions.map(r => PRESET_QUESTIONS[r]).join('」+「')}」`)

  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY || 'sk-not-set',
      'anthropic-version': '2023-06-01',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(tc.body),
  })

  if (!resp.ok) {
    console.error(`  ❌ HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
    return false
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

  const a = analyzeSse(raw)
  const expectedQs = tc.expectedQuestions.map(r => PRESET_QUESTIONS[r])
  const actualQs = a.advisorQuestions

  // ---- 核心判定：精确集合 + 顺序 ----
  const orderMatched =
    expectedQs.length === actualQs.length &&
    expectedQs.every((q, i) => q === actualQs[i])

  const missing = expectedQs.filter(q => !actualQs.includes(q))
  const unexpected = actualQs.filter(q => {
    const rule = QUESTION_TO_RULE[q]
    return !rule || !tc.expectedQuestions.includes(rule)
  })

  console.error(`  期望: [${tc.expectedQuestions.map(r => `${r}(${RULE_PHASE[r]})`).join(', ')}]`)
  console.error(`  实际触发 ${actualQs.length} 个:`)
  actualQs.forEach((q, i) => {
    const rule = QUESTION_TO_RULE[q] ?? '(未知)'
    const phase = QUESTION_TO_RULE[q] ? RULE_PHASE[QUESTION_TO_RULE[q]] : '?'
    const ok = rule !== '(未知)' && tc.expectedQuestions.includes(rule as RuleType)
    console.error(`    [${i}] ${phase.padEnd(13)} ${rule.padEnd(11)} ${ok ? '✅' : '⚠️未预期'} 「${q}」`)
  })
  if (missing.length) console.error(`  ⚠️ 该触发未触发: ${missing.join(', ')}`)
  if (unexpected.length) console.error(`  ⚠️ 出现未预期: ${unexpected.length} 个`)
  console.error(`  顺序/集合匹配: ${orderMatched ? '✅' : '❌'} (期望 ${expectedQs.length}, 实际 ${actualQs.length})`)

  // ---- 格式合规性 ----
  console.error(`  message_start: ${a.messageStartCount === 1 ? '✅' : '❌'} (${a.messageStartCount} 次, 期望 1)`)
  console.error(`  message_stop : ${a.messageStopCount === 1 ? '✅' : '❌'} (${a.messageStopCount} 次, 期望 1)`)
  if (a.messageStopCount === 1) {
    console.error(`  message_stop 位置: ${a.messageStopIsLast ? '✅ 末尾' : '⚠️ 非末尾'}`)
  }
  console.error(`  [DONE]       : ${a.hasDone ? '❌ 出现' : '✅ 无'}`)
  if (a.indices.length > 0) {
    const continuous = a.indices.every((v, idx) => idx === 0 || v === a.indices[idx - 1] + 1)
    console.error(`  block indices: [${a.indices.join(',')}] ${continuous ? '✅ 连续' : '⚠️ 不连续'}`)
  }

  // ---- 内容摘要 ----
  console.error(`  think 摘要 : ${a.thinking.slice(0, 120).replace(/\n/g, ' ')}${a.thinking.length > 120 ? '...' : ''}`)
  console.error(`  content 摘要: ${a.content.slice(0, 120).replace(/\n/g, ' ')}${a.content.length > 120 ? '...' : ''}`)
  // pro 原文不应泄漏到 content（应只出现在 think）
  const proLeak = a.content.includes('proxy-advisor-consult')
  if (proLeak) console.error(`  ⚠️ content 含 proxy 分隔符（可能泄漏）`)

  // 保存日志
  const fn = `/tmp/forced-advisor-${tc.label.replace(/[^a-z0-9]/g, '_')}-${Date.now()}.log`
  fs.writeFileSync(fn, raw)
  console.error(`  日志: ${fn}`)

  const passed = orderMatched
    && a.messageStartCount === 1 && a.messageStopCount === 1 && !a.hasDone
  console.error(`  判定: ${passed ? '✅ 通过' : '❌ 失败'}`)
  return passed
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

function buildMessages5Tools() {
  // 构造 5 轮真实 tool_use + tool_result，末尾是 tool_result。
  // detectForcedAdvisor 计数真实 tool_use=5（排除 advisor），触发 tool-count。
  const msgs: unknown[] = [{ role: 'user', content: '依次读取 a.txt b.txt c.txt d.txt e.txt' }]
  for (let i = 0; i < 5; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'read_file', input: { path: `${'abcde'[i]}.txt` } }],
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `content of ${'abcde'[i]}.txt` }],
    })
  }
  return msgs
}

async function main() {
  console.error(`Escalate 模式: ${MODE}`)
  console.error(`Force advisor : ${FORCE_ADVISOR}`)
  console.error(`目标 URL      : ${PROXY_URL}`)

  // ---- 前置检查 ----
  if (MODE !== 'advisor') {
    console.error(`\n⚠️ 当前 mode=${MODE}，forced advisor 仅在 advisor 模式生效。`)
    console.error(`   请先: codebase config --set escalateMode=advisor`)
  }
  if (!FORCE_ADVISOR) {
    console.error(`\n⚠️ escalateForceAdvisor 未开启 —— forced 触发不会发生，下面的用例大概率失败。`)
    console.error(`   请先: codebase config --set escalateForceAdvisor=true`)
  }
  console.error()

  const tests: TestCase[] = [
    {
      // 规则 1：末尾 user 纯文本 → user-turn（+ post-response task-done）
      label: 'rule1-user-turn',
      expectedQuestions: ['user-turn', 'task-done'],
      body: {
        model: FLASH_MODEL,
        system: 'You are a helpful assistant. Answer concisely.',
        messages: [{ role: 'user', content: '法国的首都是哪里？只回答城市名。' }],
        max_tokens: 256,
        stream: true,
      },
    },
    {
      // 规则 3：末尾 tool_result 含 error → tool-error（+ post-response task-done）
      label: 'rule3-tool-error',
      expectedQuestions: ['tool-error', 'task-done'],
      body: {
        model: FLASH_MODEL,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: '读取 config.json' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_err', name: 'read_file', input: { path: 'config.json' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: 'Error: ENOENT: no such file or directory', is_error: true }] },
        ],
        max_tokens: 256,
        stream: true,
      },
    },
    {
      // 规则 2：5 个真实 tool_use，末尾 tool_result，无 error → tool-count（+ post-response task-done）
      label: 'rule2-tool-count',
      expectedQuestions: ['tool-count', 'task-done'],
      body: {
        model: FLASH_MODEL,
        system: 'You are a helpful assistant.',
        messages: buildMessages5Tools(),
        max_tokens: 256,
        stream: true,
      },
    },
    {
      // 规则 4：末尾 assistant 无 tool_use → task-done（仅 post-response 触发）
      // 与 user-turn 的区别：末尾是 assistant 而非纯 user。
      // detectForcedAdvisor 不会触发（只看 user trailing），
      // 由 flash loop 中 flash 答完后检测无 tool_use 触发。
      label: 'rule4-task-done',
      expectedQuestions: ['task-done'],
      body: {
        model: FLASH_MODEL,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: '2+2=？只回答数字。' },
          { role: 'assistant', content: [{ type: 'text', text: '4' }] },
        ],
        max_tokens: 256,
        stream: true,
      },
    },
  ]

  const results: Array<{ label: string; passed: boolean }> = []
  for (const tc of tests) {
    const ok = await runTest(tc)
    results.push({ label: tc.label, passed: ok })
  }

  // ---- 汇总 ----
  console.error('\n========== 汇总 ==========')
  for (const r of results) {
    console.error(`  ${r.label}: ${r.passed ? '✅ 通过' : '❌ 失败'}`)
  }
  const allPassed = results.every(r => r.passed)
  console.error(`\n总体: ${allPassed ? '✅ 四条 forced 规则全部按预期触发（含 pre+post 组合，顺序正确）' : '❌ 存在未通过项'}`)
  if (!allPassed) process.exitCode = 1
}

main().catch(err => { console.error('错误:', err); process.exit(1) })
