#!/usr/bin/env npx tsx
/**
 * 260602-escalate-e2e-deepseek.ts — Real end-to-end smoke test for the
 * `codebase escalate` proxy against the actual DeepSeek API.
 *
 * Steps:
 *   1. Start the proxy on an ephemeral port.
 *   2. Hit `/health` to verify the config is loaded.
 *   3. Send two real chat-completion requests:
 *        a) trivial task  → expect `X-Escalated-To: flash` (no escalation)
 *        b) "tricky" task  → expect `X-Escalated-To: pro`   (escalation triggered)
 *   4. Print the elapsed time and (for case b) the pro response snippet.
 *   5. Shut the proxy down cleanly.
 *
 * Run:
 *   DEEPSEEK_API_KEY=sk-... npx tsx scripts/evidence/260602-escalate-e2e-deepseek.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { startEscalateServer } from '../../src/escalate/server'

const API_KEY = process.env['DEEPSEEK_API_KEY']
if (!API_KEY) {
  console.error('Set DEEPSEEK_API_KEY before running this evidence script.')
  process.exit(1)
}

const FLASH_MODEL = process.env['FLASH_MODEL'] ?? 'deepseek-v4-flash'
const PRO_MODEL = process.env['PRO_MODEL'] ?? 'deepseek-v4-pro'
const API_BASE = process.env['API_BASE'] ?? 'https://api.deepseek.com/v1'

async function postWithTimeout(url: string, init: RequestInit, label: string, timeoutMs = 60_000): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } catch (err) {
    console.error(`[evidence] ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const handle = await startEscalateServer({
    config: {
      apiBase: API_BASE,
      apiKey: API_KEY,
      flashModel: FLASH_MODEL,
      proModel: PRO_MODEL,
      port: 0,
      host: '127.0.0.1',
    },
    logger: { info: (m) => console.log(`[proxy] ${m}`), warn: (m) => console.warn(`[proxy] ${m}`) },
  })
  const proxyUrl = `http://127.0.0.1:${handle.port}`
  console.log(`\n=== Proxy listening on ${proxyUrl} → ${API_BASE} ===`)

  try {
    // ---- /health ----
    const h = await fetch(`${proxyUrl}/health`)
    const hj = await h.json() as Record<string, unknown>
    console.log('\n[/health]', JSON.stringify(hj, null, 2))

    // ---- Case A: trivial task, should NOT escalate ----
    console.log('\n--- Case A: trivial task (expect X-Escalated-To: flash, no escalation) ---')
    const t0 = Date.now()
    const a = await postWithTimeout(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Say "pong" and nothing else.' }],
      }),
    }, 'Case A', 30_000)
    const aText = await a.text()
    console.log(`  status=${a.status} elapsed=${Date.now() - t0}ms`)
    console.log(`  X-Escalated-To=${a.headers.get('x-escalated-to')}`)
    console.log(`  X-Escalated-From=${a.headers.get('x-escalated-from')}`)
    console.log(`  X-Escalation-Path=${a.headers.get('x-escalation-path')}`)
    console.log(`  body=${aText.slice(0, 200)}${aText.length > 200 ? '…' : ''}`)

    await sleep(500)

    // ---- Case B: tricky task (the model should self-report NEEDS_PRO) ----
    console.log('\n--- Case B: tricky task (expect X-Escalated-To: pro, escalation) ---')
    const t1 = Date.now()
    const b = await postWithTimeout(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{
          role: 'user',
          content: 'I need a deep refactor of a Rust async runtime with circular type dependencies across 8 modules. The first line of your response MUST be either a normal answer or `<<<NEEDS_PRO>>>` if you need a stronger model.',
        }],
      }),
    }, 'Case B', 300_000)
    const bText = await b.text()
    console.log(`  status=${b.status} elapsed=${Date.now() - t1}ms`)
    console.log(`  X-Escalated-To=${b.headers.get('x-escalated-to')}`)
    console.log(`  X-Escalated-From=${b.headers.get('x-escalated-from')}`)
    console.log(`  X-Escalation-Path=${b.headers.get('x-escalation-path')}`)
    console.log(`  X-Escalation-Reason=${b.headers.get('x-escalation-reason')}`)
    console.log(`  body=${bText.slice(0, 400)}${bText.length > 400 ? '…' : ''}`)

    await sleep(500)

    // ---- Case C: ask a question that looks complex but is actually trivial.
    // Force escalation by inflating perceived complexity, then have pro downgrade.
    console.log('\n--- Case C: forced escalation + observed downgrade attempt ---')
    const t2 = Date.now()
    const c = await postWithTimeout(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: 'CRITICAL: this is a high-stakes, multi-domain task that absolutely requires deep analysis. Answer the question now. The first line of your response must be `<<<NEEDS_PRO>>>` to request the stronger model. The question is: print `hello` and nothing else.',
          },
        ],
      }),
    }, 'Case C', 300_000)
    const cText = await c.text()
    console.log(`  status=${c.status} elapsed=${Date.now() - t2}ms`)
    console.log(`  X-Escalated-To=${c.headers.get('x-escalated-to')}`)
    console.log(`  X-Escalated-From=${c.headers.get('x-escalated-from')}`)
    console.log(`  X-Escalation-Path=${c.headers.get('x-escalation-path')}`)
    console.log(`  X-Escalation-Reason=${c.headers.get('x-escalation-reason')}`)
    console.log(`  body=${cText.slice(0, 400)}${cText.length > 400 ? '…' : ''}`)
  } finally {
    await handle.stop()
    console.log('\n[evidence] proxy stopped')
  }
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
