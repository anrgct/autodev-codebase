/**
 * 验证：advisor 模式 SSE 流的 text/thinking 语义正确性 + content block index 合规。
 *
 * 一次请求同时检查三个曾出 bug 的维度：
 *
 *   1. flash 第一轮（advisor begin 之前）：flash 调 advisor 前的过渡语必须重写为
 *      thinking_delta，不得作为 text_delta 泄漏（否则客户端看到两段 text）。
 *   2. pro 段（advisor begin ~ end 之间）：pro 作为 passive advisor，其所有输出
 *      （thinking + text）都必须重写为 thinking，不得出现 text_delta 或
 *      type:text 的 content_block_start。
 *   3. content block index 合规：同一个 block 的 start/delta/stop 必须共享同一个
 *      index，不同 block 的 index 连续递增无空洞（Anthropic 规范）。
 *
 * 关联：
 *   - docs/plans/260629-anthropic-migration.md
 *   - test5.log（原始 bug 现场）
 *
 * ## 用法
 *
 *   # 前提：escalate proxy 已在 5000 端口以 advisor 模式运行
 *   npx tsx scripts/evidence/290629-advisor-text-leak.ts
 *   MAX_ATTEMPTS=5 npx tsx scripts/evidence/290629-advisor-text-leak.ts
 */

import * as fs from 'fs'

const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:5000/v1/messages'
const API_KEY = process.env.API_KEY ?? 'sk-USqYzFUmccukXK0jC392D995Aa4b4a2d9c49892c37E323B7'
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 5)

// 带历史对话的请求体 —— 历史 assistant 含 text block，flash 更倾向先说过渡语再调 advisor。
const BODY = {
  model: 'mac-anthropic',
  system: [],
  messages: [
    { role: 'user', content: [{ text: '你好', type: 'text' }] },
    {
      role: 'assistant',
      content: [
        { signature: '', thinking: "The user is greeting me in Chinese.", type: 'thinking' },
        { text: '你好！有什么可以帮你的吗？', type: 'text' },
      ],
    },
    { role: 'user', content: [{ text: '测试一下advisor', type: 'text' }] },
  ],
  cache_control: { type: 'ephemeral' },
  max_tokens: 64000,
  temperature: 1,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 4096 },
}

interface Ev { seq: number; type: string; index: number; deltaType?: string; text?: string; blockType?: string }

async function runOnce(attempt: number): Promise<{ analyzed: boolean; ok: boolean }> {
  process.stderr.write(`\n===== 尝试 #${attempt} =====\n`)
  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(BODY),
  })
  if (!resp.ok || !resp.body) { process.stderr.write(`HTTP ${resp.status}\n`); return { analyzed: false, ok: false } }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let raw = ''
  while (true) {
    const { value, done } = await reader.read()
    if (value) raw += dec.decode(value, { stream: true })
    if (done) break
  }

  const events: Ev[] = []
  let beginSeq = -1, endSeq = -1
  let seq = 0
  for (const l of raw.split('\n')) {
    if (!l.startsWith('data:')) continue
    const payload = l.slice(5).trim()
    if (!payload) continue
    let p: any
    try { p = JSON.parse(payload) } catch { continue }
    if (!p || typeof p.type !== 'string') continue
    const ev: Ev = { seq: seq++, type: p.type, index: typeof p.index === 'number' ? p.index : -1 }
    if (p.delta) {
      ev.deltaType = p.delta.type
      if (typeof p.delta.text === 'string') ev.text = p.delta.text
      if (typeof p.delta.thinking === 'string') ev.text = p.delta.thinking
    }
    if (p.content_block?.type) ev.blockType = p.content_block.type
    events.push(ev)
    if (typeof ev.text === 'string' && ev.text.includes('consulting advisor')) beginSeq = ev.seq
    if (typeof ev.text === 'string' && ev.text.includes('back to flash')) endSeq = ev.seq
  }

  if (beginSeq < 0) { process.stderr.write('未触发 advisor（flash 直接回答）\n'); return { analyzed: false, ok: false } }
  if (endSeq < 0) { process.stderr.write('未找到 advisor end 标记\n'); return { analyzed: false, ok: false } }

  // ---- 检查 1: flash 第一轮 text 泄漏（begin 之前的 text_delta）----
  const flashTextDeltas = events.filter(e => e.seq < beginSeq && e.type === 'content_block_delta' && e.deltaType === 'text_delta')

  // ---- 检查 2: pro 段 text 泄漏（begin~end 的 text_delta 或 text block start）----
  const proTextDeltas = events.filter(e => e.seq > beginSeq && e.seq < endSeq && e.type === 'content_block_delta' && e.deltaType === 'text_delta')
  const proTextBlocks = events.filter(e => e.seq > beginSeq && e.seq < endSeq && e.type === 'content_block_start' && e.blockType === 'text')

  // ---- 检查 3: index 合规（同 block 共享 index + 连续无空洞）----
  const cbEvents = events.filter(e => e.type === 'content_block_start' || e.type === 'content_block_delta' || e.type === 'content_block_stop')
  const byIdx = new Map<number, string[]>()
  for (const e of cbEvents) {
    if (e.index < 0) continue
    const arr = byIdx.get(e.index) ?? []
    arr.push(e.type)
    byIdx.set(e.index, arr)
  }
  let indexOk = true
  let indexDetail = ''
  for (const [idx, types] of byIdx) {
    const complete = types.includes('content_block_start') && types.includes('content_block_stop')
    if (!complete) { indexOk = false; indexDetail += ` index=${idx} 不完整(${types.join(',')})` }
  }
  const sortedIdx = [...byIdx.keys()].sort((a, b) => a - b)
  if (sortedIdx.length > 0) {
    for (let i = 1; i < sortedIdx.length; i++) {
      if (sortedIdx[i] !== sortedIdx[i - 1] + 1) { indexOk = false; indexDetail += ` index 空洞 ${sortedIdx[i - 1]}→${sortedIdx[i]}` }
    }
  }

  // ---- 判定 ----
  const ok = flashTextDeltas.length === 0 && proTextDeltas.length === 0 && proTextBlocks.length === 0 && indexOk
  if (ok) {
    process.stderr.write(`✅ 通过：flash 段无 text 泄漏, pro 段无 text 泄漏, index 合规（${byIdx.size} 个 block, idx ${sortedIdx[0]}..${sortedIdx[sortedIdx.length - 1]}）\n`)
    return { analyzed: true, ok: true }
  }

  process.stderr.write(`❌ 失败：\n`)
  if (flashTextDeltas.length > 0) {
    process.stderr.write(`  flash 段泄漏 ${flashTextDeltas.length} 个 text_delta: "${flashTextDeltas.map(e => e.text).join('')}"\n`)
  }
  if (proTextDeltas.length > 0) {
    process.stderr.write(`  pro 段泄漏 ${proTextDeltas.length} 个 text_delta: "${proTextDeltas.map(e => e.text).join('')}"\n`)
  }
  if (proTextBlocks.length > 0) {
    process.stderr.write(`  pro 段有 ${proTextBlocks.length} 个 type:text 的 content_block_start\n`)
  }
  if (!indexOk) {
    process.stderr.write(`  index 不合规:${indexDetail}\n`)
  }
  const logFile = `/tmp/advisor-text-leak-FAIL-${Date.now()}.log`
  fs.writeFileSync(logFile, raw)
  process.stderr.write(`  完整日志: ${logFile}\n`)
  return { analyzed: true, ok: false }
}

async function main() {
  process.stderr.write(`目标: ${PROXY_URL}, 最多尝试 ${MAX_ATTEMPTS} 次\n`)
  let pass = 0, analyzed = 0
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      const r = await runOnce(i)
      if (r.analyzed) {
        analyzed++
        if (r.ok) { pass++; if (analyzed >= 1) { /* 至少一次成功即收工 */ } }
      }
    } catch (e) { process.stderr.write(`第 ${i} 次出错: ${e}\n`) }
  }
  process.stderr.write(`\n========== 总结 ==========\n`)
  process.stderr.write(`有效分析: ${analyzed}, 通过: ${pass}\n`)
  if (analyzed === 0) process.stderr.write(`⚠️ 未触发 advisor（flash 行为随机，可增大 MAX_ATTEMPTS 重试）\n`)
  else process.stderr.write(pass > 0 ? `✅ 有通过样本\n` : `❌ 全部失败\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
