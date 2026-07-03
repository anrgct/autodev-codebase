/**
 * Dispatcher — request forwarding, escalation, downgrade, streaming peek-and-passthrough.
 *
 * Responsibilities:
 *   1. Send the request to the upstream API (with the appropriate tier
 *      contract injected into the system prompt and the `model` field set
 *      to the target tier ID).
 *   2. For non-stream responses: read the whole body, look for the
 *      `<<<NEEDS_PRO>>>` (flash → pro escalation) or `<<<NEEDS_FLASH>>>`
 *      (pro → flash downgrade) marker, and switch tiers accordingly.
 *   3. For stream responses: read a tiny peek buffer (up to PEEK_MAX_CHARS
 *      of accumulated SSE text_delta content), look for the marker, and:
 *        - on match: cancel the current stream, retry against the other
 *          tier, return its stream
 *        - on no match: passthrough the buffered chunk and pipe the rest
 *          of the original stream to the client.
 *
 * The peek-and-passthrough design keeps the latency overhead of the proxy
 * at ~50ms in the common (no-switch) case while still allowing a clean
 * tier switch when the model self-reports.
 *
 * Path tracking:
 *   - `['flash']` — flash response, no switch
 *   - `['flash', 'pro']` — flash escalated to pro
 *   - `['flash', 'pro', 'flash']` — flash escalated, then pro downgraded
 *   - (the pro-downgrade case is rare but supported)
 *
 * NOTE: This file now uses the Anthropic Messages API format exclusively.
 * All format operations are delegated to `./anthropic-protocol`.
 */

import { randomUUID } from 'node:crypto'
import { fetch, Pool, type Dispatcher } from 'undici'
import {
  ADVISOR_TOOL_NAME,
  injectAdvisorTool,
  injectContract,
  proFinishToolDefinition,
  type AnthropicMessage,
  type AnthropicClientRequestBody,
} from './contract'
import type {
  AnthropicStreamEvent,
  AnthropicContentBlock,
  ContentBlockStartEvent,
} from './anthropic-protocol'
import {
  isMessageStop,
  getStopReason,
  buildAdvisorBeginEvent as buildProtoAdvisorBegin,
  buildAdvisorEndEvent as buildProtoAdvisorEnd,
  buildTierSwitchEvent as buildProtoTierSwitch,
  buildProxyErrorEvent as buildProtoProxyError,
  buildMessageStartEvent as buildProtoMessageStart,
  parseNonStreamResponse,
  extractTextFromBlocks,
  extractThinkingFromBlocks,
  extractFirstToolUse,
  buildToolResultMessage,
  buildAssistantToolUseMessage,
  ensureAssistantThinkingBlocks,
  stripAdvisorMarkersFromThinking,
  buildUserTextMessage,
  buildAssistantTextMessage,
  ContentBlockIndexRewriter,
  ANTHROPIC_VERSION,
} from './anthropic-protocol'
import { detectEscalationMarker, detectMarkerPrefix, stripNeedsProMarker } from './detector'
import { SseLineBuffer, type SseLine } from './sse-buffer'
import type { DispatchResult, EscalateConfig } from './types'
import { StickyStore } from './sticky'

/**
 * Default upstream request timeout (5 minutes).
 */
const UPSTREAM_TIMEOUT_MS = 300_000

/**
 * Hard ceiling on how much text we accumulate in the streaming peek loop
 * before forcing a decision. In practice `detectMarkerPrefix` decides
 * within the first 1–2 text chunks, so this is just a safety net.
 */
const PEEK_MAX_CONTENT_CHARS = 1024

/**
 * Extract concatenated assistant text from an Anthropic non-streaming
 * response body. Returns the raw body unchanged if it is not a recognizable
 * Anthropic message response.
 */
function extractChatContent(body: string): string {
  const parsed = parseNonStreamResponse(body)
  if (!parsed) return body
  return extractTextFromBlocks(parsed.content)
}

/**
 * Extract assistant thinking from an Anthropic non-streaming response.
 */
function extractChatThinking(body: string): string {
  const parsed = parseNonStreamResponse(body)
  if (!parsed) return ''
  return parsed.content
    .filter((b): b is AnthropicContentBlock & { thinking: string } => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking as string)
    .join('')
}

/** Internal — never throw across the dispatcher boundary; convert to a structured error result. */
export class DispatcherError extends Error {
  constructor(message: string, public readonly status: number = 502) {
    super(message)
    this.name = 'DispatcherError'
  }
}

export interface DispatcherOptions {
  config: EscalateConfig
  logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void }
  /** Override the underlying fetch (used in tests). */
  fetchImpl?: typeof fetch
  /** Override the undici Pool (used in tests). */
  dispatcher?: Dispatcher
}

/**
 * Build the upstream request headers from the client's headers and our config.
 *
 * Anthropic Messages API headers:
 *   - `x-api-key` (instead of `Authorization: Bearer`)
 *   - `anthropic-version: 2023-06-01`
 *
 * Authorization priority:
 *   1. If `config.apiKey` is set, use it as `x-api-key`.
 *   2. Otherwise forward the client's `x-api-key` header verbatim.
 *   3. If neither is set, send no `x-api-key` header.
 *
 * Hop-by-hop headers are dropped.
 */
function buildUpstreamHeaders(clientHeaders: Record<string, string | string[] | undefined>, config: EscalateConfig): Record<string, string> {
  const out: Record<string, string> = {}
  const DROP = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length'
  ])
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (DROP.has(lk)) continue
    // Skip both old-style Authorization and client x-api-key when we have a configured key
    if ((lk === 'authorization' || lk === 'x-api-key') && config.apiKey) continue
    out[lk] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  if (config.apiKey) {
    out['x-api-key'] = config.apiKey
  }
  out['anthropic-version'] = ANTHROPIC_VERSION
  if (!out['content-type']) {
    out['content-type'] = 'application/json'
  }
  if (!out['accept']) {
    out['accept'] = 'application/json'
  }
  return out
}

/** Build upstream response headers — same drop rules + inject our annotation headers. */
function buildResponseHeaders(upstreamHeaders: Headers | Record<string, string | string[] | undefined>, extras: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const DROP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
  ])
  const iter = upstreamHeaders instanceof Headers
    ? Array.from(upstreamHeaders.entries())
    : Object.entries(upstreamHeaders)
  for (const [k, v] of iter) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (DROP.has(lk)) continue
    if (lk === 'content-length') continue
    out[lk] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  for (const [k, v] of Object.entries(extras)) {
    out[k.toLowerCase()] = v
  }
  return out
}

/** Convert undici Headers-like to a plain Record. */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers.entries()) {
    out[k] = v
  }
  return out
}

/**
 * Extract messages from a parsed body, returning null on missing/invalid data.
 */
function extractMessages(rawBody: unknown): AnthropicMessage[] | null {
  if (!rawBody || typeof rawBody !== 'object') return null
  const body = rawBody as Record<string, unknown>
  const msgs = body['messages']
  if (!Array.isArray(msgs)) return null
  return msgs as AnthropicMessage[]
}

// ---------------------------------------------------------------------------
// Advisor tool call helpers (Anthropic format)
// ---------------------------------------------------------------------------

/**
 * Shape of an advisor tool call extracted from content blocks.
 */
interface NormalizedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Extract the `question` string from a normalized tool call's input.
 */
function extractAdvisorQuestion(toolCall: NormalizedToolCall): string | undefined {
  if (typeof toolCall.input === 'object' && toolCall.input !== null) {
    const q = (toolCall.input as Record<string, unknown>)['question']
    if (typeof q === 'string' && q.length > 0) return q
  }
  return undefined
}

/**
 * Find the first `advisor` tool_use content block in an assistant message.
 * Returns null if no advisor call is present.
 */
export function extractAdvisorToolCall(
  message: AnthropicMessage | undefined | null
): NormalizedToolCall | null {
  if (!message || message.role !== 'assistant') return null
  if (!Array.isArray(message.content)) return null
  const block = message.content.find(
    (b): b is AnthropicContentBlock & { id: string; name: string } =>
      b.type === 'tool_use' && b.name === ADVISOR_TOOL_NAME && typeof b.id === 'string'
  )
  if (!block) return null
  return {
    id: block.id,
    name: block.name,
    input: (block.input as Record<string, unknown>) ?? {},
  }
}

/**
 * Extract ALL `advisor` tool_use content blocks from an assistant message.
 * Returns an empty array if none found.
 */
export function extractAllAdvisorToolCalls(
  message: AnthropicMessage | undefined | null
): NormalizedToolCall[] {
  if (!message || message.role !== 'assistant') return []
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((b): b is AnthropicContentBlock & { id: string; name: string } => {
      if (b.type !== 'tool_use') return false
      if (b.name !== ADVISOR_TOOL_NAME) return false
      return typeof b.id === 'string'
    })
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: (b.input as Record<string, unknown>) ?? {},
    }))
}

// ---------------------------------------------------------------------------
// Forced-advisor trigger detection (stateless, based on messages shape)
// ---------------------------------------------------------------------------

/**
 * Preset questions for forced-advisor triggers. Hardcoded per spec — the
 * whole point of forced mode is a deterministic question, not one the model
 * composes. See docs/plans/260630-force-advisor.md.
 */
const FORCE_ADVISOR_USER_TURN_QUESTION = '用户指令的核心需求？是否有歧义？'
const FORCE_ADVISOR_TOOL_ERROR_QUESTION = '工具报错的原因？修复建议？'
const FORCE_ADVISOR_TOOL_COUNT_QUESTION = '当前方向是否正确？是否有错漏？下一步建议？'
const FORCE_ADVISOR_TOOL_COUNT_INTERVAL = 5

/**
 * Prefix of the user message the proxy fakes when consulting pro as a forced
 * advisor. It primes pro to act as a guide for the flash model (not answer
 * the user directly) and to refrain from tool calls. The dynamic preset
 * question (one of the FORCE_ADVISOR_*_QUESTION constants above) is appended
 * by `buildForcedAdvisorPrompt`.
 */
const FORCED_ADVISOR_PROMPT_PREFIX =
  'Forced advisor — You are pro model in advisor mode, the flash model is about to answer the user. ' +
  'Based on the conversation above, give flash concise actionable guidance; ' +
  'you have 0 tool so DO NOT CALL ANY TOOLS. Task:'

/** Build the user message that consults pro as a forced advisor (pro side). */
function buildForcedAdvisorPrompt(question: string): AnthropicMessage {
  return { role: 'user', content: `[${FORCED_ADVISOR_PROMPT_PREFIX} ${question}]` }
}

/**
 * Prefix of the user message the proxy sends to pro when FLASH voluntarily
 * calls the advisor tool (the non-forced path). Contrast with
 * FORCED_ADVISOR_PROMPT_PREFIX, which is used when the proxy fakes the call.
 */
const ADVISOR_CONSULT_PROMPT_PREFIX =
  'Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix'

/** Build the user message that consults pro for a voluntary (flash-initiated) advisor call. */
function buildAdvisorConsultPrompt(question: string): AnthropicMessage {
  return { role: 'user', content: `[${ADVISOR_CONSULT_PROMPT_PREFIX}] ${question}` }
}

export type ForcedAdvisorTrigger =
  | { type: 'user-turn'; question: string }
  | { type: 'tool-error'; question: string }
  | { type: 'tool-count'; question: string }

/**
 * Count real (non-advisor) `tool_use` blocks across all messages. Advisor
 * tool_use blocks (forced or voluntary) are excluded so they don't pollute
 * the "every N real tools" cadence.
 */
export function countRealToolUses(messages: AnthropicMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name !== ADVISOR_TOOL_NAME) n++
    }
  }
  return n
}

/**
 * Heuristic: does this `tool_result` block represent an error? Anthropic
 * defines an `is_error` flag, but most clients only put error text in the
 * content. Conservative pattern match on the content string. Tunable.
 */
export function isToolResultError(block: AnthropicContentBlock): boolean {
  if (block.is_error === true) return true
  const c = block.content
  if (typeof c === 'string') {
    if (/^\s*(error|err):\s/i.test(c)) return true
    if (c.includes('<error>')) return true
  }
  return false
}

/**
 * Detect whether the proxy should force an advisor consultation BEFORE
 * entering the flash loop. Purely a function of the messages shape —
 * stateless (see docs/plans/260630-force-advisor.md decision 2 for why the
 * trailing-message shape is sufficient for de-duplication).
 *
 * Priority: tool-error > tool-count; user-turn is mutually exclusive with the
 * tool-* rules (they key off different trailing shapes). At most one trigger.
 */
export function detectForcedAdvisor(messages: AnthropicMessage[]): ForcedAdvisorTrigger | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return null

  const blocks = Array.isArray(last.content) ? last.content : []
  const toolResults = blocks.filter((b) => b.type === 'tool_result')

  if (toolResults.length === 0) {
    // Trailing user message without tool_result → a fresh user turn (rule 1).
    return { type: 'user-turn', question: FORCE_ADVISOR_USER_TURN_QUESTION }
  }

  // Trailing user message carries tool_result(s) → we're inside a tool loop.
  // Rule 3 (error) takes priority over rule 2 (count).
  if (toolResults.some((b) => isToolResultError(b))) {
    return { type: 'tool-error', question: FORCE_ADVISOR_TOOL_ERROR_QUESTION }
  }

  const n = countRealToolUses(messages)
  if (n > 0 && n % FORCE_ADVISOR_TOOL_COUNT_INTERVAL === 0) {
    return { type: 'tool-count', question: FORCE_ADVISOR_TOOL_COUNT_QUESTION }
  }
  return null
}

// ---------------------------------------------------------------------------
// Event-type helpers
// ---------------------------------------------------------------------------

/** Check if an SSE line is a content_block_start for text. */
function isTextBlockStart(line: SseLine): boolean {
  const ev = line.anthropicEvent
  return ev?.type === 'content_block_start' && ev.content_block.type === 'text'
}

/** Check if an SSE line is a content_block_start for thinking. */
function isThinkingBlockStart(line: SseLine): boolean {
  const ev = line.anthropicEvent
  return ev?.type === 'content_block_start' && ev.content_block.type === 'thinking'
}

/** Check if an SSE line is a text_delta. */
function isTextDelta(line: SseLine): string | undefined {
  const ev = line.anthropicEvent
  if (ev?.type !== 'content_block_delta') return undefined
  if (ev.delta.type !== 'text_delta') return undefined
  return ev.delta.text
}

/** Check if an SSE line is a thinking_delta. */
function isThinkingDelta(line: SseLine): string | undefined {
  const ev = line.anthropicEvent
  if (ev?.type !== 'content_block_delta') return undefined
  if (ev.delta.type !== 'thinking_delta') return undefined
  return ev.delta.thinking
}

/** Check if an SSE line is a content_block_stop. */
function isContentBlockStop(line: SseLine): boolean {
  return line.anthropicEvent?.type === 'content_block_stop'
}

/** Check if an SSE line is a message_delta (carries stop_reason). */
function isMessageDeltaEvent(line: SseLine): boolean {
  return line.anthropicEvent?.type === 'message_delta'
}

// ---------------------------------------------------------------------------
// Annotation helpers
// ---------------------------------------------------------------------------

/** Normalize `apiBase` to remove trailing slash. */
function normalizeBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '')
}

/**
 * Build the annotation headers we attach to the upstream response so
 * clients (and their UIs) can see what the proxy actually did.
 */
function annotationHeaders(opts: {
  finalModel: 'flash' | 'pro'
  switchedFrom?: 'flash' | 'pro'
  path: Array<'flash' | 'pro'>
  reason?: string
}): Record<string, string> {
  const switchedFrom = opts.switchedFrom ?? opts.finalModel
  const out: Record<string, string> = {
    'X-Escalated-To': opts.finalModel,
    'X-Escalated-From': switchedFrom,
    'X-Escalation-Path': opts.path.join('->'),
  }
  if (opts.reason) {
    out['X-Escalation-Reason'] = sanitizeHeaderValue(opts.reason)
  }
  return out
}

/**
 * Sanitize a value for use in an HTTP header — URL-encode any character
 * outside the printable ASCII range (0x20–0x7E).
 */
function sanitizeHeaderValue(raw: string): string {
  if (!raw) return raw
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  let out = ''
  for (let i = 0; i < collapsed.length; i++) {
    const cp = collapsed.charCodeAt(i)
    if (cp >= 0x20 && cp <= 0x7e) {
      out += collapsed[i]
    } else {
      out += encodeURIComponent(collapsed[i])
    }
  }
  return out
}

/** Concatenate two Uint8Arrays (null-safe). */
function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (a === null) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Check if an event: line at index `li` is orphaned (no following data: line). */
function isOrphanedContentBlockEvent(lines: SseLine[], li: number): boolean {
  const line = lines[li]
  if (!line.isEvent) return false
  if (line.eventType !== 'content_block_start' &&
      line.eventType !== 'content_block_delta' &&
      line.eventType !== 'content_block_stop') return false
  const nextLine = li + 1 < lines.length ? lines[li + 1] : null
  return !nextLine || !nextLine.isData
}

/**
 * Drain a reader into a WritableStreamDefaultController until the reader is
 * done. Used after a tier switch to forward the final tier's response with
 * no further marker inspection.
 *
 * In passthrough mode, we still go through SseLineBuffer for each chunk
 * so that content_block indices can be rewritten via ContentBlockIndexRewriter
 * (needed when synthetic events have been injected between sub-streams).
 */
async function pumpReaderToController(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  rewriter?: ContentBlockIndexRewriter
): Promise<void> {
  if (!rewriter) {
    // Fast path: no index rewriting needed.
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      if (value) controller.enqueue(value)
    }
  }

  // Slow path: rewrite content_block indices.
  rewriter.beginSubStream()
  const sseBuf = new SseLineBuffer()
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    if (!value || value.length === 0) continue
    const { lines } = sseBuf.feed(value)
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      // Drop orphaned content_block event: lines (no following data:).
      if (isOrphanedContentBlockEvent(lines, li)) continue
      if (line.anthropicEvent) {
        const event = line.anthropicEvent
        if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }
      }
      controller.enqueue(line.bytes)
    }
  }
}

/**
 * Rewrite the index in a content_block event line using the rewriter.
 */
function rewriteIndexInLine(line: SseLine, rewriter: ContentBlockIndexRewriter): Uint8Array {
  // The line bytes are the raw text. We need to rewrite the `index` field
  // in the data payload. For Anthropic SSE, the data is on the `data:` line.
  // The previous lines (event:) and subsequent blank lines are not modified.
  // We reconstruct the entire event bytes.
  if (!line.isData || !line.anthropicEvent) {
    return line.bytes
  }
  const event = line.anthropicEvent
  if (event.type !== 'content_block_start' && event.type !== 'content_block_delta' && event.type !== 'content_block_stop') {
    return line.bytes
  }
  const isBlockStart = event.type === 'content_block_start'
  const newIndex = rewriter.rewriteBlockIndex(event.index, isBlockStart)
  const newPayload = JSON.stringify({ ...event, index: newIndex })
  return Buffer.from(`data: ${newPayload}\n`, 'utf-8')
}

/**
 * Build a synthetic thinking content block from accumulated text. Used in
 * advisor mode to rewrite flash's pre-advisor text (transition words like
 * "好的，我来测试一下") into a thinking block, so it shows up in the client's
 * thinking panel rather than as final answer text.
 *
 * The block uses a single index for start/delta/stop (one index per block).
 */
function buildThinkingBlockBytes(thinkingText: string, rewriter: ContentBlockIndexRewriter): Uint8Array {
  const idx = rewriter.allocate()
  const start = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } })}\n\n`
  const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinkingText } })}\n\n`
  const stop = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
  return Buffer.from(start + delta + stop, 'utf-8')
}

/**
 * Flush remaining lines from `lines[startIdx]` onward into the controller,
 * with optional index rewriting.
 */
function flushRemainingLines(
  controller: ReadableStreamDefaultController<Uint8Array>,
  lines: SseLine[],
  startIdx: number,
  rewriter?: ContentBlockIndexRewriter
): void {
  for (let i = startIdx; i < lines.length; i++) {
    try {
      if (rewriter && lines[i].anthropicEvent) {
        controller.enqueue(rewriteIndexInLine(lines[i], rewriter))
      } else {
        controller.enqueue(lines[i].bytes)
      }
    } catch { /* noop */ }
  }
}

// ===========================================================================
// EscalateDispatcher class
// ===========================================================================

export class EscalateDispatcher {
  private readonly config: EscalateConfig
  private readonly logger: NonNullable<DispatcherOptions['logger']>
  private readonly fetchImpl: typeof fetch
  private readonly pool: Dispatcher | undefined
  /** Sticky pro session store (null when disabled). */
  private readonly stickyStore: StickyStore | null

  constructor(opts: DispatcherOptions) {
    this.config = opts.config
    this.logger = opts.logger ?? {}
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch)
    this.pool = opts.dispatcher
    this.stickyStore = this.config.stickyProTtlMs > 0
      ? new StickyStore({ ttlMs: this.config.stickyProTtlMs })
      : null
    if (this.stickyStore) {
      this.stickyStore.startCleanup()
    }
  }

  // ----------------------------------------------------------------------
  // Body builders (Anthropic Messages API format)
  // ----------------------------------------------------------------------

  /**
   * Build a flash request body — inject the flash-side contract, force model.
   */
  private buildFlashBody(rawBody: unknown): Record<string, unknown> {
    const body = (rawBody ?? {}) as Record<string, unknown>
    return injectContract(body, this.config.flashModel, this.config.proModel)
  }

  /**
   * Build a pro request body — inject the pro-side contract, force model.
   */
  private buildProBody(rawBody: unknown): Record<string, unknown> {
    const body = (rawBody ?? {}) as Record<string, unknown>
    return injectContract(body, this.config.proModel, this.config.proModel)
  }

  /**
   * Build a body targeted at a specific tier (used by downgrade retry to flash).
   */
  private buildFlashRetryBody(rawBody: unknown): Record<string, unknown> {
    return this.buildFlashBody(rawBody)
  }

  // ----------------------------------------------------------------------
  // Advisor mode body builders (Anthropic format)
  // ----------------------------------------------------------------------

  /**
   * Build a flash body for advisor mode: append the `advisor` tool definition.
   * Note: intentionally does NOT call `injectContract()` — advisor mode uses
   * the `advisor` tool exclusively, not the self-report markers.
   */
  private buildFlashAdvisorBody(
    rawBody: unknown,
    messages?: AnthropicMessage[]
  ): Record<string, unknown> {
    const base = (rawBody ?? {}) as Record<string, unknown>
    const bodyWithMessages: Record<string, unknown> = messages
      ? { ...base, messages }
      : base
    const withModel: Record<string, unknown> = { ...bodyWithMessages, model: this.config.flashModel }
    return injectAdvisorTool(withModel)
  }

  /**
   * Build a pro body for advisor mode: target the pro model, strip all client
   * tools, and inject ONE no-op `finish` tool. Pro is a passive advisor — it
   * must NOT have access to the `advisor` tool or any client tools. The dummy
   * `finish` tool exists only so agentic models have a tool to call instead
   * of spinning in their reasoning; see `proFinishToolDefinition`.
   */
  private buildProAdvisorBody(
    rawBody: unknown,
    messages: AnthropicMessage[]
  ): Record<string, unknown> {
    const base = (rawBody ?? {}) as Record<string, unknown>
    const {
      tools: _tools,
      tool_choice: _tc,
      ...rest
    } = {
      ...base,
      messages,
      model: this.config.proModel,
    } as Record<string, unknown> & { tools?: unknown; tool_choice?: unknown }
    void _tools
    void _tc
    // Ensure max_tokens is set (Anthropic required field)
    if (typeof rest['max_tokens'] !== 'number') {
      rest['max_tokens'] = this.config.maxTokens
    }
    // Give pro ONE no-op `finish` tool. Pro must NOT receive client tools or
    // the advisor tool, but agentic models spin in their reasoning ("let me
    // search the code...") when they have no tools at all. A single dummy
    // tool they can call to signal "done" satisfies that impulse. Any
    // `finish` tool_call is IGNORED — pro's advice is taken from its
    // text/thinking content (extractTextFromBlocks skips tool_use blocks).
    rest['tools'] = [proFinishToolDefinition]
    return rest
  }

  // ----------------------------------------------------------------------
  // Upstream call
  // ----------------------------------------------------------------------

  /**
   * Make a single upstream call using Anthropic Messages API.
   * The URL is `${apiBase}/v1/messages`.
   */
  private async callUpstream(
    body: Record<string, unknown>,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<Response> {
    const url = `${normalizeBase(this.config.apiBase)}/v1/messages`
    const headers = buildUpstreamHeaders(clientHeaders, this.config)

    // Combine the internal timeout with the client-disconnect signal.
    const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    const effectiveSignal = clientSignal
      ? AbortSignal.any([timeoutSignal, clientSignal])
      : timeoutSignal

    // Ensure required max_tokens field is present
    const safeBody = { ...body }
    // Normalize history so reasoning models (e.g. DeepSeek) accept it: every
    // assistant message must carry a thinking block in thinking mode. Clients
    // frequently drop the thinking block when replaying prior tool turns.
    if (Array.isArray(safeBody['messages'])) {
      const msgs = safeBody['messages'] as AnthropicMessage[]
      // First ensure every assistant message carries a thinking block
      // (DeepSeek rejects history lacking reasoning_content), then strip any
      // advisor sentinel blocks a client replayed back so models never see the
      // fabricated consultation in their own reasoning history.
      safeBody['messages'] = stripAdvisorMarkersFromThinking(ensureAssistantThinkingBlocks(msgs))
    }
    if (typeof safeBody['max_tokens'] !== 'number') {
      safeBody['max_tokens'] = this.config.maxTokens
    }
    // Ensure thinking field for models that need explicit enablement
    if (safeBody['thinking'] === undefined) {
      safeBody['thinking'] = { type: 'enabled', budget_tokens: this.config.thinkingBudget }
    }

    const init: Record<string, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify(safeBody),
      signal: effectiveSignal,
    }
    if (this.pool) {
      init['dispatcher'] = this.pool
    }
    return (await this.fetchImpl(url, init as never)) as unknown as Response
  }

  // ----------------------------------------------------------------------
  // Advisor history helpers — rewrite orphaned advisor tool_use calls
  // ----------------------------------------------------------------------

  /**
   * Walk the inbound `messages` and rewrite any assistant message whose
   * content blocks include an `advisor` tool_use with no matching tool_result
   * message after it.
   *
   * The orphaned advisor tool_use is replaced with a `user` message that
   * surfaces the question and asks the model to answer directly.
   */
  private rewriteOrphanedAdvisorCalls(
    messages: AnthropicMessage[]
  ): AnthropicMessage[] {
    const result: AnthropicMessage[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]

      // Quick path: not an assistant message with content blocks.
      if (m.role !== 'assistant' || !Array.isArray(m.content)) {
        result.push(m)
        continue
      }

      // Look forward for any matching tool_result.
      const laterToolResultIds = new Set<string>()
      for (let j = i + 1; j < messages.length; j++) {
        const lm = messages[j]
        if (lm.role === 'user' && Array.isArray(lm.content)) {
          for (const block of lm.content) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              laterToolResultIds.add(block.tool_use_id)
            }
          }
        }
      }

      const advisorBlocks = m.content.filter(
        (b) => b.type === 'tool_use' && b.name === ADVISOR_TOOL_NAME
      )
      const nonAdvisorBlocks = m.content.filter(
        (b) => !(b.type === 'tool_use' && b.name === ADVISOR_TOOL_NAME)
      )

      const orphanedAdvisorBlocks = advisorBlocks.filter(
        (b) => typeof b.id !== 'string' || !laterToolResultIds.has(b.id)
      )

      if (orphanedAdvisorBlocks.length === 0) {
        result.push(m)
        continue
      }

      // Build the user prompt that surfaces each orphaned advisor question.
      const questions = orphanedAdvisorBlocks.map((b) => {
        if (b.input && typeof b.input === 'object') {
          const q = (b.input as Record<string, unknown>)['question']
          if (typeof q === 'string' && q.length > 0) return q
        }
        return b.name
      })
      const plural = questions.length > 1 ? 's' : ''
      const list = questions.map((q) => `- ${q}`).join('\n')
      const userPrompt =
        `[Earlier you attempted to call the advisor tool with the following question${plural}]:\n${list}\n\n` +
        `Please proceed with your best answer based on your own analysis.`

      result.push({ role: 'user', content: userPrompt })

      // If the assistant message had non-advisor content blocks, preserve them.
      if (nonAdvisorBlocks.length > 0) {
        result.push({
          role: 'assistant',
          content: nonAdvisorBlocks,
        })
      }
    }
    return result
  }

  // ----------------------------------------------------------------------
  // Main dispatch entry
  // ----------------------------------------------------------------------

  /**
   * Dispatch a chat-completion request, applying flash ↔ pro switching
   * (escalation + downgrade) as needed.
   */
  async dispatch(
    rawBody: unknown,
    isStream: boolean,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    if (this.config.mode === 'advisor') {
      if (isStream) {
        return this.dispatchAdvisorStream(rawBody, clientHeaders, clientSignal)
      }
      return this.dispatchAdvisorNonStream(rawBody, clientHeaders, clientSignal)
    }

    // Sticky pro: if this conversation prefix was recently escalated, skip flash.
    if (this.stickyStore) {
      const msgs = extractMessages(rawBody)
      if (msgs) {
        const sticky = this.stickyStore.lookup(msgs)
        if (sticky === 'pro') {
          this.logger.info?.(`[escalate] sticky pro HIT — dispatching directly to pro`)
          return this.dispatchDirectPro(rawBody, isStream, clientHeaders, clientSignal)
        }
      }
    }

    if (isStream) {
      return this.dispatchStream(rawBody, clientHeaders, clientSignal)
    }
    return this.dispatchNonStream(rawBody, clientHeaders, clientSignal)
  }

  // ----------------------------------------------------------------------
  // Direct pro dispatch (sticky pro hit)
  // ----------------------------------------------------------------------

  private async dispatchDirectPro(
    rawBody: unknown,
    isStream: boolean,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    if (isStream) {
      return this.dispatchDirectProStream(rawBody, clientHeaders, clientSignal)
    }
    return this.dispatchDirectProNonStream(rawBody, clientHeaders, clientSignal)
  }

  private async dispatchDirectProNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders, clientSignal)
    const path: Array<'flash' | 'pro'> = ['pro']

    if (!proResp.ok) {
      const errBuf = Buffer.from(await proResp.arrayBuffer())
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      return {
        finalModel: 'pro',
        reason: 'error',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path })),
        body: errBuf,
        isStream: false,
      }
    }

    const proText = await proResp.text()
    const proContent = extractChatContent(proText)
    const proDetect = detectEscalationMarker(proContent)

    if (proDetect.matched && proDetect.direction === 'flash') {
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      this.logger.info?.(`[escalate] sticky pro: pro downgraded (${proDetect.reason ?? 'bare'}) — retrying on flash`)
      const flashBody = this.buildFlashRetryBody(rawBody)
      const flashResp = await this.callUpstream(flashBody, clientHeaders, clientSignal)
      path.push('flash')

      if (!flashResp.ok) {
        const errBuf = Buffer.from(await flashResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'downgrade',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
            finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
          })),
          body: errBuf,
          isStream: false,
        }
      }
      const flashBuf = Buffer.from(await flashResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'downgrade',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({
          finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
        })),
        body: flashBuf,
        isStream: false,
      }
    }

    return {
      finalModel: 'pro',
      reason: 'passthrough',
      path,
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path })),
      body: Buffer.from(stripNeedsProMarker(proText), 'utf-8'),
      isStream: false,
    }
  }

  private async dispatchDirectProStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders, clientSignal)

    if (!proResp.ok || !proResp.body) {
      const errBuf = proResp.body ? Buffer.from(await proResp.arrayBuffer()) : Buffer.from('')
      const msgs = extractMessages(rawBody)
      if (msgs) this.stickyStore?.clear(msgs)
      return {
        finalModel: 'pro',
        reason: 'error',
        path: ['pro'],
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'pro', path: ['pro'] })),
        body: errBuf,
        isStream: false,
      }
    }

    const dispatcher = this
    const proReader = proResp.body.getReader()
    const msgs = extractMessages(rawBody)
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = proReader

    const localAbort = new AbortController()
    const localSignal = localAbort.signal
    const onLocalAbort = () => {
      if (!localSignal.aborted) localAbort.abort(clientSignal?.reason)
    }
    if (clientSignal) {
      if (clientSignal.aborted) {
        localAbort.abort(clientSignal.reason)
      } else {
        clientSignal.addEventListener('abort', onLocalAbort, { once: true })
      }
    }

    const rewriter = new ContentBlockIndexRewriter()
    rewriter.reset()

    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const proResult = await dispatcher.peekTierStream(controller, proReader, 'flash', rewriter)
          if (proResult.outcome === 'done') {
            currentReader = null
            controller.close()
            return
          }

          if (msgs) dispatcher.stickyStore?.clear(msgs)
          dispatcher.logger.info?.(`[escalate] sticky pro: <<<NEEDS_FLASH>>> detected — downgrading to flash`)

          controller.enqueue(buildProtoTierSwitch('pro', 'flash', proResult.reason, dispatcher.config.flashModel, rewriter))
          currentReader = null

          const flashBody = dispatcher.buildFlashRetryBody(rawBody)
          const flashResp = await dispatcher.callUpstream(flashBody, clientHeaders, localSignal)
          if (!flashResp.ok || !flashResp.body) {
            const errText = flashResp.body ? await flashResp.text().catch(() => '') : ''
            controller.enqueue(buildProtoProxyError(flashResp.status, errText, dispatcher.config.flashModel, rewriter))
            controller.close()
            return
          }

          const flashReader = flashResp.body.getReader()
          currentReader = flashReader
          await pumpReaderToController(flashReader, controller, rewriter)
          currentReader = null
          controller.close()
        } catch (err) {
          try {
            controller.enqueue(buildProtoProxyError(500, err instanceof Error ? err.message : String(err), dispatcher.config.flashModel, rewriter))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
      async cancel(reason) {
        if (!localSignal.aborted) localAbort.abort(reason)
        try { await currentReader?.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'pro',
      reason: 'passthrough',
      path: ['pro'],
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, {}),
      body: passthrough,
      isStream: true,
    }
  }

  // ----------------------------------------------------------------------
  // Non-streaming path (self-report)
  // ----------------------------------------------------------------------

  private async dispatchNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const flashBody = this.buildFlashBody(rawBody)
    const flashResp = await this.callUpstream(flashBody, clientHeaders, clientSignal)
    const path: Array<'flash' | 'pro'> = ['flash']

    if (!flashResp.ok) {
      const errBuf = Buffer.from(await flashResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'error',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: errBuf,
        isStream: false,
      }
    }

    const flashText = await flashResp.text()
    const flashContent = extractChatContent(flashText)
    const flashDetect = detectEscalationMarker(flashContent)

    if (!flashDetect.matched) {
      return {
        finalModel: 'flash',
        reason: 'non-stream',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: Buffer.from(stripNeedsProMarker(flashText), 'utf-8'),
        isStream: false,
      }
    }

    if (flashDetect.direction !== 'pro') {
      this.logger.warn?.(`[escalate] flash model emitted unexpected <<<NEEDS_FLASH>>> — treating as passthrough`)
      return {
        finalModel: 'flash',
        reason: 'non-stream',
        path,
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
        body: Buffer.from(stripNeedsProMarker(flashText), 'utf-8'),
        isStream: false,
      }
    }

    this.logger.info?.(`[escalate] <<<NEEDS_PRO>>> detected (${flashDetect.reason ?? 'bare'}) — retrying on pro`)

    const proBody = this.buildProBody(rawBody)
    const proResp = await this.callUpstream(proBody, clientHeaders, clientSignal)
    path.push('pro')

    if (!proResp.ok) {
      const errBuf = Buffer.from(await proResp.arrayBuffer())
      return {
        finalModel: 'pro',
        reason: 'self-report',
        path,
        status: proResp.status,
        headers: buildResponseHeaders(proResp.headers, annotationHeaders({
          finalModel: 'pro', switchedFrom: 'flash', path, reason: flashDetect.reason ?? 'self-report',
        })),
        body: errBuf,
        isStream: false,
      }
    }

    const proText = await proResp.text()
    const proContent = extractChatContent(proText)
    const proDetect = detectEscalationMarker(proContent)

    const msgs = extractMessages(rawBody)
    if (msgs) this.stickyStore?.storeUpgrade(msgs)

    if (proDetect.matched && proDetect.direction === 'flash') {
      this.logger.info?.(`[escalate] <<<NEEDS_FLASH>>> detected on pro (${proDetect.reason ?? 'bare'}) — downgrading to flash`)
      if (msgs) this.stickyStore?.clear(msgs)

      const flashRetryBody = this.buildFlashRetryBody(rawBody)
      const flashRetryResp = await this.callUpstream(flashRetryBody, clientHeaders, clientSignal)
      path.push('flash')

      if (!flashRetryResp.ok) {
        const errBuf = Buffer.from(await flashRetryResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'downgrade',
          path,
          status: flashRetryResp.status,
          headers: buildResponseHeaders(flashRetryResp.headers, annotationHeaders({
            finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
          })),
          body: errBuf,
          isStream: false,
        }
      }
      const flashRetryBuf = Buffer.from(await flashRetryResp.arrayBuffer())
      return {
        finalModel: 'flash',
        reason: 'downgrade',
        path,
        status: flashRetryResp.status,
        headers: buildResponseHeaders(flashRetryResp.headers, annotationHeaders({
          finalModel: 'flash', switchedFrom: 'pro', path, reason: proDetect.reason ?? 'downgrade',
        })),
        body: flashRetryBuf,
        isStream: false,
      }
    }

    return {
      finalModel: 'pro',
      reason: 'self-report',
      path,
      status: proResp.status,
      headers: buildResponseHeaders(proResp.headers, annotationHeaders({
        finalModel: 'pro', switchedFrom: 'flash', path, reason: flashDetect.reason ?? 'self-report',
      })),
      body: Buffer.from(stripNeedsProMarker(proText), 'utf-8'),
      isStream: false,
    }
  }

  // ----------------------------------------------------------------------
  // Streaming path (self-report)
  // ----------------------------------------------------------------------

  private async dispatchStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const flashBody = this.buildFlashBody(rawBody)
    const flashResp = await this.callUpstream(flashBody, clientHeaders, clientSignal)

    if (!flashResp.ok || !flashResp.body) {
      const errBuf = flashResp.body
        ? Buffer.from(await flashResp.arrayBuffer())
        : Buffer.from('')
      return {
        finalModel: 'flash',
        reason: 'error',
        path: ['flash'],
        status: flashResp.status,
        headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path: ['flash'] })),
        body: errBuf,
        isStream: false,
      }
    }

    const dispatcher = this
    const flashReader = flashResp.body.getReader()
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = flashReader

    const localAbort = new AbortController()
    const localSignal = localAbort.signal
    const onLocalAbort = () => {
      if (!localSignal.aborted) localAbort.abort(clientSignal?.reason)
    }
    if (clientSignal) {
      if (clientSignal.aborted) {
        localAbort.abort(clientSignal.reason)
      } else {
        clientSignal.addEventListener('abort', onLocalAbort, { once: true })
      }
    }

    // Content block index rewriter — starts at 0 for the flash stream.
    // Each sub-stream's content_block indices are rewritten through this
    // rewriter to produce continuous indices across the entire client stream.
    const rewriter = new ContentBlockIndexRewriter()
    rewriter.reset()

    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // ---- Flash peek: forward thinking immediately, inspect text. ----
          const flashResult = await dispatcher.peekTierStream(controller, flashReader, 'pro', rewriter)
          if (flashResult.outcome === 'done') {
            controller.close()
            return
          }

          // ---- Switched: flash → pro. ----
          const msgs = extractMessages(rawBody)
          if (msgs) dispatcher.stickyStore?.storeUpgrade(msgs)
          dispatcher.logger.info?.(`[escalate] <<<NEEDS_PRO>>> detected in stream — switching to pro`)

          controller.enqueue(buildProtoTierSwitch('flash', 'pro', flashResult.reason, dispatcher.config.proModel, rewriter))

          const proBody = dispatcher.buildProBody(rawBody)
          const proResp = await dispatcher.callUpstream(proBody, clientHeaders, localSignal)
          if (!proResp.ok || !proResp.body) {
            const errText = proResp.body ? await proResp.text().catch(() => '') : ''
            controller.enqueue(buildProtoProxyError(proResp.status, errText, dispatcher.config.proModel, rewriter))
            controller.close()
            return
          }

          // ---- Pro peek: forward thinking, watch for NEEDS_FLASH downgrade. ----
          const proReader = proResp.body.getReader()
          currentReader = proReader
          const proResult = await dispatcher.peekTierStream(controller, proReader, 'flash', rewriter)
          if (proResult.outcome === 'done') {
            currentReader = null
            controller.close()
            return
          }

          // ---- Switched: pro → flash (downgrade). ----
          if (msgs) dispatcher.stickyStore?.clear(msgs)
          dispatcher.logger.info?.(`[escalate] <<<NEEDS_FLASH>>> detected in pro stream — downgrading to flash`)

          controller.enqueue(buildProtoTierSwitch('pro', 'flash', proResult.reason, dispatcher.config.flashModel, rewriter))
          currentReader = null

          const flashRetryBody = dispatcher.buildFlashRetryBody(rawBody)
          const flashRetryResp = await dispatcher.callUpstream(flashRetryBody, clientHeaders, localSignal)
          if (!flashRetryResp.ok || !flashRetryResp.body) {
            const errText = flashRetryResp.body ? await flashRetryResp.text().catch(() => '') : ''
            controller.enqueue(buildProtoProxyError(flashRetryResp.status, errText, dispatcher.config.flashModel, rewriter))
            controller.close()
            return
          }

          // Pump flash retry directly — no further peeking.
          const flashRetryReader = flashRetryResp.body.getReader()
          currentReader = flashRetryReader
          await pumpReaderToController(flashRetryReader, controller, rewriter)
          currentReader = null
          controller.close()
        } catch (err) {
          try {
            controller.enqueue(buildProtoProxyError(500, err instanceof Error ? err.message : String(err), dispatcher.config.flashModel, rewriter))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
      async cancel(reason) {
        if (!localSignal.aborted) localAbort.abort(reason)
        try { await currentReader?.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'flash',
      reason: 'passthrough',
      path: ['flash'],
      status: flashResp.status,
      headers: buildResponseHeaders(flashResp.headers, {}),
      body: passthrough,
      isStream: true,
    }
  }

  // ----------------------------------------------------------------------
  // Peek one tier's SSE stream — Anthropic format
  // ----------------------------------------------------------------------

  /**
   * Peek one tier's Anthropic SSE stream and forward bytes to `controller`:
   *   - `thinking_delta` events → forwarded immediately (TTFB).
   *   - `text_delta` events → buffered and run through `detectMarkerPrefix`:
   *       * `matched-<expectedDirection>` → cancel reader, return 'switched'.
   *       * `no-marker` → flush the text block buffer, switch to passthrough.
   *       * `need-more` → keep buffering (partial marker prefix).
   *   - Content block start/stop events for text blocks → buffered alongside
   *     the deltas so the event sequence stays consistent.
   *   - Content block start/stop for thinking → forwarded immediately.
   *   - `message_delta` / `message_stop` → NOT forwarded (intermediate
   *     sub-stream termination is invisible to the client).
   *
   * All forwarded content_block_* events have their `index` field rewritten
   * through the `rewriter` to ensure continuous indices across sub-streams.
   */
  private async peekTierStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    expectedDirection: 'pro' | 'flash',
    rewriter: ContentBlockIndexRewriter
  ): Promise<{ outcome: 'done' } | { outcome: 'switched'; reason?: string }> {
    rewriter.beginSubStream()
    const sseBuf = new SseLineBuffer()
    let textBlockAcc = ''          // Accumulated text_delta.text for marker detection
    let textBlockBufferedBytes: Uint8Array | null = null  // Buffered bytes for the current text block
    let bufferingTextBlock = false // True when we're inside a text block (start seen, not yet stopped)
    let mode: 'peeking' | 'passthrough' = 'peeking'

    /**
     * Flush the buffered text block to the controller, rewriting indices.
     */
    const flushTextBlock = () => {
      if (textBlockBufferedBytes !== null) {
        controller.enqueue(textBlockBufferedBytes)
        textBlockBufferedBytes = null
      }
      textBlockAcc = ''
      bufferingTextBlock = false
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        flushTextBlock()
        return { outcome: 'done' }
      }
      if (!value || value.length === 0) continue

      if (mode === 'passthrough') {
        // In passthrough, we still need to go through the SSE buffer for
        // index rewriting (since synthetic events may have been injected).
        const { lines } = sseBuf.feed(value)
        for (const line of lines) {
          if (rewriter && line.anthropicEvent) {
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          } else {
            controller.enqueue(line.bytes)
          }
        }
        continue
      }

      const { lines, leftover } = sseBuf.feed(value)

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]

        // Non-data lines — forward thinking events, buffer text events.
        if (!line.isData) {
          if (bufferingTextBlock) {
            textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, line.bytes)
          } else {
            controller.enqueue(line.bytes)
          }
          continue
        }

        if (!line.anthropicEvent) {
          // Non-parseable data line — forward if not buffering text.
          if (bufferingTextBlock) {
            textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, line.bytes)
          } else {
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        const event = line.anthropicEvent

        // --- thinking_delta: forward immediately ---
        const thinkText = isThinkingDelta(line)
        if (thinkText !== undefined) {
          // If we were buffering a text block, something is wrong (thinking
          // shouldn't appear during a text block). Flush defensively.
          if (bufferingTextBlock) {
            flushTextBlock()
          }
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // --- text_delta: buffer for marker detection ---
        const txt = isTextDelta(line)
        if (txt !== undefined) {
          textBlockAcc += txt
          textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, rewriteIndexInLine(line, rewriter))

          const decision = detectMarkerPrefix(textBlockAcc)
          if ((decision === 'matched-pro' && expectedDirection === 'pro') ||
              (decision === 'matched-flash' && expectedDirection === 'flash')) {
            const det = detectEscalationMarker(textBlockAcc)
            try { await reader.cancel() } catch { /* noop */ }
            return { outcome: 'switched', reason: det.reason }
          }
          if (decision === 'no-marker') {
            // Definitively no marker — flush the text block and switch to passthrough.
            flushTextBlock()
            mode = 'passthrough'
            flushRemainingLines(controller, lines, li + 1, rewriter)
            if (leftover !== null) controller.enqueue(leftover)
            break
          }
          // 'need-more' — keep buffering.
          if (textBlockAcc.length >= PEEK_MAX_CONTENT_CHARS) {
            flushTextBlock()
            mode = 'passthrough'
            flushRemainingLines(controller, lines, li + 1, rewriter)
            if (leftover !== null) controller.enqueue(leftover)
            break
          }
          continue
        }

        // --- content_block_start: track whether we're in a text block ---
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking') {
            // Thinking block — forward immediately.
            if (bufferingTextBlock) {
              flushTextBlock()
            }
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          } else if (event.content_block.type === 'text') {
            // Text block — start buffering.
            if (bufferingTextBlock) {
              // Unexpected: two consecutive text blocks. Flush first.
              flushTextBlock()
            }
            bufferingTextBlock = true
            textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, rewriteIndexInLine(line, rewriter))
          } else {
            // tool_use or other — forward.
            if (bufferingTextBlock) {
              textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, rewriteIndexInLine(line, rewriter))
            } else {
              controller.enqueue(rewriteIndexInLine(line, rewriter))
            }
          }
          continue
        }

        // --- content_block_stop: end of a block ---
        if (event.type === 'content_block_stop') {
          if (bufferingTextBlock) {
            // End of the text block. We've accumulated the full content,
            // but haven't flushed (no marker detected yet). Keep buffering
            // the stop event as well — it will be flushed when no-marker
            // is decided, OR discarded on marker match.
            textBlockBufferedBytes = concatBytes(textBlockBufferedBytes, rewriteIndexInLine(line, rewriter))
            bufferingTextBlock = false
          } else {
            // Thinking block or other non-text block — forward immediately.
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        // --- message_delta: forward (only arrives when stream ends naturally;
        //     marker detection cancels the reader before these can arrive) ---
        if (event.type === 'message_delta') {
          if (bufferingTextBlock) {
            flushTextBlock()
          }
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // --- message_stop: forward (terminal event for the final sub-stream) ---
        if (event.type === 'message_stop') {
          if (bufferingTextBlock) {
            flushTextBlock()
          }
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // --- message_start: forward ---
        if (event.type === 'message_start') {
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // --- ping: forward ---
        controller.enqueue(rewriteIndexInLine(line, rewriter))
      }

      // If mode flipped to 'passthrough', continue reading in passthrough.
    }
  }

  // ----------------------------------------------------------------------
  // Advisor mode — non-streaming
  // ----------------------------------------------------------------------

  private async dispatchAdvisorNonStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const initialMessages = extractMessages(rawBody) ?? []
    let workingMessages: AnthropicMessage[] = this.rewriteOrphanedAdvisorCalls(initialMessages)
    const path: Array<'flash' | 'pro'> = []
    let sawAdvisorCall = false

    // ---- Forced advisor: optional deterministic pre-consultation ----
    // When enabled, the proxy fakes an advisor tool_call with a preset question
    // and consults pro BEFORE the flash loop, so flash starts its first round
    // already seeing an advisor result in history. pro is guaranteed to be
    // consulted and the question is the deterministic preset. See
    // docs/plans/260630-force-advisor.md.
    if (this.config.forceAdvisor) {
      const trigger = detectForcedAdvisor(workingMessages)
      if (trigger) {
        path.push('pro')
        this.logger.info?.(`[escalate] forced advisor (${trigger.type}) — consulting pro: ${trigger.question}`)
        const forcedCall: NormalizedToolCall = {
          id: `forced_${randomUUID()}`,
          name: ADVISOR_TOOL_NAME,
          input: { question: trigger.question },
        }
        const advisorUserMsg = buildForcedAdvisorPrompt(trigger.question)
        const proMessages: AnthropicMessage[] = [...workingMessages, advisorUserMsg]
        const proBody = this.buildProAdvisorBody(rawBody, proMessages)
        const proResp = await this.callUpstream(proBody, clientHeaders, clientSignal)
        if (!proResp.ok) {
          const errBuf = Buffer.from(await proResp.arrayBuffer())
          return {
            finalModel: 'flash',
            reason: 'advisor',
            path,
            status: proResp.status,
            headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'flash', path })),
            body: errBuf,
            isStream: false,
          }
        }
        const proText = await proResp.text()
        const proParsed = parseNonStreamResponse(proText)
        const proThinking = proParsed ? extractThinkingFromBlocks(proParsed.content) : ''
        const proContentRaw = proParsed ? extractTextFromBlocks(proParsed.content) : ''
        const proFullContent = proThinking ? `${proThinking}\n\n${proContentRaw}` : proContentRaw
        this.logger.info?.(`[escalate] forced advisor pro response (${proFullContent.length} chars): ${proFullContent.slice(0, 200)}${proFullContent.length > 200 ? '...' : ''}`)

        const toolResult = buildToolResultMessage(forcedCall.id, proFullContent)
        const assistantToolUse = buildAssistantToolUseMessage(forcedCall.id, forcedCall.name, JSON.stringify(forcedCall.input))
        // DeepSeek (and other reasoning models) reject an assistant message in
        // thinking mode that lacks a thinking block ("reasoning_content must be
        // passed back"). The forced tool_use is fabricated by the proxy — flash
        // hasn't produced a turn yet — so attach an EMPTY thinking block to
        // satisfy the constraint. Pro's analysis travels exclusively via the
        // tool_result below; echoing it into reasoning_content would place the
        // large model's (third-person, "guide flash") framing into flash's own
        // reasoning slot, confusing its role identity.
        const forcedThinking = ''
        const toolUseMsg: AnthropicMessage = {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: forcedThinking },
            ...(Array.isArray(assistantToolUse.content) ? assistantToolUse.content : []),
          ],
        }
        workingMessages = [...workingMessages, toolUseMsg, toolResult]
        sawAdvisorCall = true
      }
    }

    while (true) {
      path.push('flash')

      const flashBody = this.buildFlashAdvisorBody(rawBody, workingMessages)
      const flashResp = await this.callUpstream(flashBody, clientHeaders, clientSignal)
      if (!flashResp.ok) {
        const errBuf = Buffer.from(await flashResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'error',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: errBuf,
          isStream: false,
        }
      }

      const flashText = await flashResp.text()
      const flashParsed = parseNonStreamResponse(flashText)
      const assistantMsg: AnthropicMessage | undefined = flashParsed
        ? { role: 'assistant', content: flashParsed.content }
        : undefined
      const stopReason = flashParsed?.stop_reason

      const advisorCall = assistantMsg ? extractAdvisorToolCall(assistantMsg) : null
      if (!advisorCall || stopReason !== 'tool_use') {
        return {
          finalModel: 'flash',
          reason: sawAdvisorCall ? 'advisor' : 'non-stream',
          path,
          status: flashResp.status,
          headers: buildResponseHeaders(flashResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: Buffer.from(flashText, 'utf-8'),
          isStream: false,
        }
      }

      sawAdvisorCall = true
      path.push('pro')
      this.logger.info?.(`[escalate] advisor tool call detected (input: ${JSON.stringify(advisorCall.input).length} chars) — consulting pro`)

      const advisorQuestion = extractAdvisorQuestion(advisorCall)
      this.logger.info?.(`[escalate] advisor question: ${advisorQuestion ?? '(empty)'}`)

      const advisorUserMsg: AnthropicMessage | null = advisorQuestion
        ? buildAdvisorConsultPrompt(advisorQuestion)
        : null

      // Strip tool_use blocks from the assistant message before sending to pro.
      const textBlocks = Array.isArray(assistantMsg?.content)
        ? assistantMsg!.content.filter((b) => b.type !== 'tool_use')
        : []
      const hasContent = textBlocks.length > 0 &&
        textBlocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
      const assistantForPro: AnthropicMessage | null = hasContent
        ? { role: 'assistant', content: textBlocks }
        : null

      const proMessages: AnthropicMessage[] = [
        ...workingMessages,
        ...(assistantForPro ? [assistantForPro] : []),
        ...(advisorUserMsg ? [advisorUserMsg] : []),
      ]

      const proBody = this.buildProAdvisorBody(rawBody, proMessages)
      const proResp = await this.callUpstream(proBody, clientHeaders, clientSignal)
      if (!proResp.ok) {
        const errBuf = Buffer.from(await proResp.arrayBuffer())
        return {
          finalModel: 'flash',
          reason: 'advisor',
          path,
          status: proResp.status,
          headers: buildResponseHeaders(proResp.headers, annotationHeaders({ finalModel: 'flash', path })),
          body: errBuf,
          isStream: false,
        }
      }

      const proText = await proResp.text()
      const proParsed = parseNonStreamResponse(proText)
      const proThinking = proParsed ? extractTextFromBlocks(proParsed.content.filter((b) => b.type === 'thinking')) : ''
      const proContentRaw = proParsed ? extractTextFromBlocks(proParsed.content) : ''
      const proFullContent = proThinking
        ? `${proThinking}\n\n${proContentRaw}`
        : proContentRaw
      this.logger.info?.(`[escalate] pro response (${proFullContent.length} chars): ${proFullContent.slice(0, 200)}${proFullContent.length > 200 ? '...' : ''}`)

      const toolResult: AnthropicMessage = buildToolResultMessage(advisorCall.id, proFullContent)

      // Build assistant tool_use message for the advisor call.
      const assistantToolUse = buildAssistantToolUseMessage(
        advisorCall.id,
        advisorCall.name,
        JSON.stringify(advisorCall.input),
      )

      // Preserve non-advisor content blocks from the assistant message.
      const allBlocks = Array.isArray(assistantMsg?.content) ? assistantMsg!.content : []
      const nonAdvisorBlocks = allBlocks.filter(
        (b) => !(b.type === 'tool_use' && b.name === ADVISOR_TOOL_NAME)
      )
      const toolUseMsg: AnthropicMessage = {
        role: 'assistant',
        content: [
          ...nonAdvisorBlocks,
          ...(Array.isArray(assistantToolUse.content) ? assistantToolUse.content : []),
        ],
      }

      workingMessages = [...workingMessages, toolUseMsg, toolResult]
    }
  }

  // ----------------------------------------------------------------------
  // Advisor mode — streaming
  // ----------------------------------------------------------------------

  private async dispatchAdvisorStream(
    rawBody: unknown,
    clientHeaders: Record<string, string | string[] | undefined>,
    clientSignal?: AbortSignal
  ): Promise<DispatchResult> {
    const initialMessages = extractMessages(rawBody) ?? []
    let workingMessages: AnthropicMessage[] = this.rewriteOrphanedAdvisorCalls(initialMessages)
    const path: Array<'flash' | 'pro'> = []
    const initialStatus = { value: 200 as number }
    const initialHeaders = { value: {} as Record<string, string> }

    const dispatcher = this

    const localAbort = new AbortController()
    const localSignal = localAbort.signal
    const onLocalAbort = () => {
      if (!localSignal.aborted) localAbort.abort(clientSignal?.reason)
    }
    if (clientSignal) {
      if (clientSignal.aborted) {
        localAbort.abort(clientSignal.reason)
      } else {
        clientSignal.addEventListener('abort', onLocalAbort, { once: true })
      }
    }

    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null

    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Use a shared index rewriter for the entire stream (all flash turns,
        // advisor separators, pro streams, etc.) — defined outside try so
        // the catch block can also use it.
        const rewriter = new ContentBlockIndexRewriter()
        rewriter.reset()
        try {
          let messageStartSent = false
          // ---- Forced advisor: pre-consultation (streaming) ----
          // Mirror of the non-stream path: fake an advisor tool_call, consult
          // pro, splice the result into history before the flash loop. The
          // streaming wrinkle: we must synthesize the client stream's
          // message_start ourselves (no flash first round has run yet), and
          // tell the first flash peek to swallow its own message_start.
          if (dispatcher.config.forceAdvisor) {
            const trigger = detectForcedAdvisor(workingMessages)
            if (trigger) {
              path.push('pro')
              dispatcher.logger.info?.(`[escalate] forced advisor (${trigger.type}) — consulting pro: ${trigger.question}`)
              const forcedCall: NormalizedToolCall = {
                id: `forced_${randomUUID()}`,
                name: ADVISOR_TOOL_NAME,
                input: { question: trigger.question },
              }
              const advisorUserMsg = buildForcedAdvisorPrompt(trigger.question)
              const proMessages: AnthropicMessage[] = [...workingMessages, advisorUserMsg]
              const proBody = dispatcher.buildProAdvisorBody(rawBody, proMessages)
              const proResp = await dispatcher.callUpstream(proBody, clientHeaders, localSignal)
              if (!proResp.ok || !proResp.body) {
                const errText = proResp.body ? await proResp.text().catch(() => '') : ''
                controller.enqueue(buildProtoMessageStart(dispatcher.config.flashModel))
                controller.enqueue(buildProtoProxyError(proResp.status, errText, dispatcher.config.proModel, rewriter))
                controller.close()
                return
              }
              controller.enqueue(buildProtoMessageStart(dispatcher.config.flashModel))
              messageStartSent = true
              controller.enqueue(buildProtoAdvisorBegin(trigger.question, dispatcher.config.proModel, rewriter))
              const proReader = proResp.body.getReader()
              currentReader = proReader
              const proResult = await dispatcher.streamProAsReasoning(proReader, controller, rewriter)
              currentReader = null
              const proContent = proResult.thinking ? `${proResult.thinking}\n\n${proResult.text}` : proResult.text
              dispatcher.logger.info?.(`[escalate] forced advisor pro response (${proContent.length} chars): ${proContent.slice(0, 200)}${proContent.length > 200 ? '...' : ''}`)
              controller.enqueue(buildProtoAdvisorEnd(dispatcher.config.proModel, rewriter))

              const toolResult = buildToolResultMessage(forcedCall.id, proContent)
              const assistantToolUse = buildAssistantToolUseMessage(forcedCall.id, forcedCall.name, JSON.stringify(forcedCall.input))
              // See non-stream path: an EMPTY thinking block satisfies the
              // DeepSeek reasoning_content constraint. Pro's analysis travels
              // only via the tool_result; putting it into flash's own reasoning
              // slot would leak the large model's framing and confuse identity.
              const forcedThinking = ''
              const toolUseMsg: AnthropicMessage = {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: forcedThinking },
                  ...(Array.isArray(assistantToolUse.content) ? assistantToolUse.content : []),
                ],
              }
              workingMessages = [...workingMessages, toolUseMsg, toolResult]
            }
          }
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const isFirstFlashCall = path.length === 0
            path.push('flash')
            const flashBody = dispatcher.buildFlashAdvisorBody(rawBody, workingMessages)
            const flashResp = await dispatcher.callUpstream(flashBody, clientHeaders, localSignal)
            if (!flashResp.ok || !flashResp.body) {
              const errText = flashResp.body ? await flashResp.text().catch(() => '') : ''
              controller.enqueue(buildProtoProxyError(flashResp.status, errText, dispatcher.config.flashModel, rewriter))
              controller.close()
              return
            }
            initialStatus.value = flashResp.status
            initialHeaders.value = headersToRecord(flashResp.headers)

            const flashReader = flashResp.body.getReader()
            currentReader = flashReader
            const peekResult = await dispatcher.peekAdvisorStream(controller, flashReader, rewriter, messageStartSent || !isFirstFlashCall)
            if (peekResult.outcome === 'passthrough') {
              currentReader = null
              controller.close()
              return
            }
            if (peekResult.outcome === 'error') {
              currentReader = null
              controller.close()
              return
            }

            const assistantMsg = peekResult.assistantMsg
            const advisorCall = extractAdvisorToolCall(assistantMsg)
            if (!advisorCall) {
              currentReader = null
              controller.close()
              return
            }
            path.push('pro')
            dispatcher.logger.info?.(`[escalate] advisor tool call detected in stream (input: ${JSON.stringify(advisorCall.input).length} chars) — consulting pro`)

            const advisorQuestion = extractAdvisorQuestion(advisorCall)
            dispatcher.logger.info?.(`[escalate] advisor question: ${advisorQuestion ?? '(empty)'}`)

            const advisorUserMsg: AnthropicMessage | null = advisorQuestion
              ? buildAdvisorConsultPrompt(advisorQuestion)
              : null

            // Strip tool_use blocks before sending to pro.
            const textBlocks = Array.isArray(assistantMsg.content)
              ? assistantMsg.content.filter((b) => b.type !== 'tool_use')
              : []
            const hasContent2 = textBlocks.length > 0 &&
              textBlocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
            const assistantForPro2: AnthropicMessage | null = hasContent2
              ? { role: 'assistant', content: textBlocks }
              : null

            const proMessages: AnthropicMessage[] = [
              ...workingMessages,
              ...(assistantForPro2 ? [assistantForPro2] : []),
              ...(advisorUserMsg ? [advisorUserMsg] : []),
            ]

            const proBody = dispatcher.buildProAdvisorBody(rawBody, proMessages)
            const proResp = await dispatcher.callUpstream(proBody, clientHeaders, localSignal)
            if (!proResp.ok || !proResp.body) {
              const errText = proResp.body ? await proResp.text().catch(() => '') : ''
              controller.enqueue(buildProtoProxyError(proResp.status, errText, dispatcher.config.proModel, rewriter))
              controller.close()
              return
            }

            controller.enqueue(buildProtoAdvisorBegin(advisorQuestion ?? undefined, dispatcher.config.proModel, rewriter))
            const proReader = proResp.body.getReader()
            currentReader = proReader
            const proResult = await dispatcher.streamProAsReasoning(proReader, controller, rewriter)
            currentReader = null
            const proContent = proResult.thinking ? `${proResult.thinking}\n\n${proResult.text}` : proResult.text
            dispatcher.logger.info?.(`[escalate] pro response (${proContent.length} chars): ${proContent.slice(0, 200)}${proContent.length > 200 ? '...' : ''}`)
            controller.enqueue(buildProtoAdvisorEnd(dispatcher.config.proModel, rewriter))

            const toolResult: AnthropicMessage = buildToolResultMessage(advisorCall.id, proContent)

            // Build assistant tool_use message for advisor call.
            const assistantToolUse = buildAssistantToolUseMessage(
              advisorCall.id,
              advisorCall.name,
              JSON.stringify(advisorCall.input),
            )

            const allBlocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : []
            const nonAdvisorTCs = allBlocks.filter(
              (b) => !(b.type === 'tool_use' && b.name === ADVISOR_TOOL_NAME),
            )
            const toolUseMsg: AnthropicMessage = {
              role: 'assistant',
              content: [
                ...nonAdvisorTCs,
                ...(Array.isArray(assistantToolUse.content) ? assistantToolUse.content : []),
              ],
            }

            workingMessages = [...workingMessages, toolUseMsg, toolResult]
          }
        } catch (err) {
          try {
            controller.enqueue(buildProtoProxyError(500, err instanceof Error ? err.message : String(err), dispatcher.config.flashModel, rewriter))
          } catch { /* noop */ }
          try { controller.close() } catch { /* noop */ }
        }
      },
      async cancel(reason) {
        if (!localSignal.aborted) localAbort.abort(reason)
        try { await currentReader?.cancel(reason) } catch { /* noop */ }
      },
    })

    return {
      finalModel: 'flash',
      reason: 'passthrough',
      path,
      status: initialStatus.value,
      headers: buildResponseHeaders(new Headers(initialHeaders.value), {}),
      body: passthrough,
      isStream: true,
    }
  }

  // ----------------------------------------------------------------------
  // Peek a flash SSE stream for an advisor tool call (Anthropic format)
  // ----------------------------------------------------------------------

  /**
   * Peek a flash SSE stream for an `advisor` tool call:
   *   - Forward `thinking_delta` immediately.
   *   - Accumulate `input_json_delta` across chunks for tool_use blocks.
   *   - Track `content_block_start` for tool_use blocks.
   *   - Track `message_delta` for `stop_reason === 'tool_use'`.
   *   - Detect advisor when both conditions met.
   *   - On advisor: cancel the reader and return the accumulated assistant message.
   *   - On natural stream end without advisor: return 'passthrough'.
   */
  private async peekAdvisorStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    rewriter: ContentBlockIndexRewriter,
    swallowMessageStart: boolean = false
  ): Promise<
    | { outcome: 'passthrough' }
    | { outcome: 'advisor'; assistantMsg: AnthropicMessage }
    | { outcome: 'error' }
  > {
    rewriter.beginSubStream()
    const sseBuf = new SseLineBuffer()
    // Buffer bytes that haven't been forwarded yet (text_delta blocks,
    // content_block_start/stop for text/tool_use blocks, etc.)
    let passthroughBytes: Uint8Array | null = null
    let stopReason: string | null = null
    // Track tool_use blocks by index for input accumulation
    const toolUseInputs = new Map<number, { id: string; name: string; inputAcc: string }>()
    // Whether we're currently inside a text/tool_use block (buffering its events)
    let inTextBlock = false
    // Whether we're inside a message_delta / message_stop event sequence —
    // these must be fully buffered (event: + data: + blank lines) so they
    // can be discarded when advisor is detected, or forwarded atomically on
    // passthrough.
    let inTerminationEvent = false
    // Deferred event: line — we wait for the corresponding data: line to decide
    // whether to forward (thinking) or buffer (text/tool_use). This keeps
    // event: and data: paired in the output.
    let pendingEventLine: SseLine | null = null
    // Accumulated text from flash's pre-advisor text block. In the advisor
    // scenario (flash emits text THEN calls advisor), this text is a transition
    // phrase and must be rewritten into a thinking block instead of being
    // forwarded as final answer text.
    let pendingTextAcc: string[] = []
    let hasPendingTextBlock = false

    const flushPendingEvent = (buffer: boolean) => {
      if (pendingEventLine !== null) {
        if (buffer) {
          passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(pendingEventLine, rewriter))
        } else {
          controller.enqueue(rewriteIndexInLine(pendingEventLine, rewriter))
        }
        pendingEventLine = null
      }
    }

    const flushPassthrough = () => {
      if (passthroughBytes !== null) {
        controller.enqueue(passthroughBytes)
        passthroughBytes = null
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        // Check for advisor tool_use even when stop_reason is not 'tool_use'
        // (the model may have called advisor but also generated text).
        let hasAdvisorAtEnd = false
        for (const [, entry] of toolUseInputs) {
          if (entry.name === ADVISOR_TOOL_NAME) {
            hasAdvisorAtEnd = true
            break
          }
        }
        if (hasAdvisorAtEnd) {
          rewriter.restoreCheckpoint()
          // Build the assistant message from accumulated data
          const contentBlocks: AnthropicContentBlock[] = []
          const sorted = Array.from(toolUseInputs.entries()).sort(([a], [b]) => a - b)
          for (const [, entry] of sorted) {
            let parsedInput: unknown
            try { parsedInput = JSON.parse(entry.inputAcc) } catch { parsedInput = { raw: entry.inputAcc } }
            contentBlocks.push({ type: 'tool_use', id: entry.id, name: entry.name, input: parsedInput })
          }
          const assistantMsg: AnthropicMessage = { role: 'assistant', content: contentBlocks }
          try { await reader.cancel() } catch { /* noop */ }
          return { outcome: 'advisor', assistantMsg }
        }
        // Discard any saved checkpoint — the buffered events are being
        // committed (forwarded), so the allocated indices are valid.
        rewriter.discardCheckpoint()
        flushPassthrough()
        return { outcome: 'passthrough' }
      }
      if (!value || value.length === 0) continue

      const { lines } = sseBuf.feed(value)
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]

        if (!line.isData) {
          // content_block_* event: lines: only keep if immediately followed by
          // a data: line. Orphaned ones (no data: follows) are dropped entirely.
          if (line.isEvent && (
            line.eventType === 'content_block_start' ||
            line.eventType === 'content_block_delta' ||
            line.eventType === 'content_block_stop'
          )) {
            const nextLine = li + 1 < lines.length ? lines[li + 1] : null
            if (nextLine && nextLine.isData) {
              pendingEventLine = line
            } else {
              // Orphaned — silently drop
            }
            continue
          }

          // Swallow message_start event: line for intermediate sub-streams.
          if (swallowMessageStart && line.eventType === 'message_start') {
            continue
          }
          // Enter termination-event buffering for message_delta / message_stop.
          if (line.eventType === 'message_delta' || line.eventType === 'message_stop') {
            inTerminationEvent = true
          }
          if (inTextBlock || inTerminationEvent) {
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
            // A blank line (neither event nor data) ends the current event sequence
            if (!line.isEvent && !line.eventType) {
              inTerminationEvent = false
            }
          } else {
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        if (!line.anthropicEvent) {
          flushPendingEvent(inTextBlock)
          if (inTextBlock) {
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          } else {
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        const event = line.anthropicEvent

        // thinking_delta → forward immediately
        const thinkText = isThinkingDelta(line)
        if (thinkText !== undefined) {
          // If we were buffering a text block, flush it first.
          if (inTextBlock) {
            flushPassthrough()
            inTextBlock = false
          }
          flushPendingEvent(false)
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // text_delta → buffer
        const txt = isTextDelta(line)
        if (txt !== undefined) {
          flushPendingEvent(true)
          inTextBlock = true
          hasPendingTextBlock = true
          pendingTextAcc.push(txt)
          passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          continue
        }

        // content_block_start
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking') {
            // Thinking block — flush any buffered text and forward immediately.
            if (inTextBlock) {
              flushPassthrough()
              inTextBlock = false
            }
            // Flush pending event: line AFTER flushPassthrough so the event:
            // line stays in the right position relative to buffered content.
            flushPendingEvent(false)
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          } else if (event.content_block.type === 'tool_use') {
            // Tool_use block — start tracking input accumulation.
            // Treat like a text block for the purpose of event buffering
            // so event: lines don't leak when data: lines are buffered.
            if (inTextBlock) {
              if (hasPendingTextBlock) {
                // advisor 场景：flash 先输出 text 再调 advisor —— text 是过渡语，
                // 重写为 thinking block（出现在客户端思考面板，而非最终回答）。
                rewriter.restoreCheckpoint()
                passthroughBytes = null
                const thinkingText = pendingTextAcc.join('')
                if (thinkingText.length > 0) {
                  controller.enqueue(buildThinkingBlockBytes(thinkingText, rewriter))
                }
                pendingTextAcc = []
                hasPendingTextBlock = false
              } else {
                flushPassthrough()
              }
              inTextBlock = false
            }
            // Flush pending event: line AFTER any early flushPassthrough,
            // so it stays in the same buffer as the data: line below.
            flushPendingEvent(true)
            inTextBlock = true
            const idx = event.index
            const block = event.content_block
            // Save a checkpoint before the first tool_use block so we can
            // roll back its indices if advisor is detected and the buffered
            // events are discarded.
            if (toolUseInputs.size === 0) {
              rewriter.saveCheckpoint()
            }
            if (!toolUseInputs.has(idx)) {
              toolUseInputs.set(idx, { id: block.id ?? '', name: block.name ?? '', inputAcc: '' })
            }
            // Buffer this line — it will be flushed on passthrough.
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          } else {
            // text block start — flash 第一轮的 text。在 advisor 场景下这是
            // 过渡语（flash 先说话再调 advisor），需重写为 thinking；在
            // passthrough 场景下是最终答案，原样输出。保存 checkpoint 以便
            // advisor 场景回滚 index 后重写为单个 thinking block。
            rewriter.saveCheckpoint()
            flushPendingEvent(true)
            inTextBlock = true
            hasPendingTextBlock = true
            pendingTextAcc = []
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        // content_block_delta for input_json_delta
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            flushPendingEvent(true)
            const existing = toolUseInputs.get(event.index) ?? { id: '', name: '', inputAcc: '' }
            existing.inputAcc += event.delta.partial_json
            toolUseInputs.set(event.index, existing)
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
            continue
          }
          // Other deltas (text_delta, thinking_delta handled above, signature_delta)
          flushPendingEvent(inTextBlock)
          if (inTextBlock) {
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          } else {
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        // content_block_stop
        if (event.type === 'content_block_stop') {
          flushPendingEvent(inTextBlock)
          if (inTextBlock) {
            // Text block or tool_use block — buffer (keep inTextBlock true
            // so the trailing blank separator is also buffered, not forwarded).
            passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          } else {
            // Thinking block — forward immediately.
            controller.enqueue(rewriteIndexInLine(line, rewriter))
          }
          continue
        }

        // message_delta — capture stop_reason AND buffer bytes (forwarded on passthrough;
        // swallowed when advisor is detected because reader is cancelled). Also enter
        // termination-event mode so the preceding event: line and trailing blank line
        // are buffered too.
        if (event.type === 'message_delta') {
          flushPendingEvent(true)
          inTerminationEvent = true
          stopReason = event.delta.stop_reason
          passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          continue
        }

        // message_stop — buffer bytes; same termination-event handling as above.
        if (event.type === 'message_stop') {
          flushPendingEvent(true)
          inTerminationEvent = true
          passthroughBytes = concatBytes(passthroughBytes, rewriteIndexInLine(line, rewriter))
          continue
        }

        // message_start — forward (or swallow entirely for intermediate sub-streams
        // like the flash retry after advisor consultation)
        if (event.type === 'message_start') {
          if (swallowMessageStart) {
            continue // swallow — don't buffer, don't forward
          }
          controller.enqueue(rewriteIndexInLine(line, rewriter))
          continue
        }

        // ping etc.
        controller.enqueue(rewriteIndexInLine(line, rewriter))
      }

      // Check advisor detection condition
      if (stopReason === 'tool_use') {
        // Re-evaluate: check if ANY accumulated tool_use block is named 'advisor'
        let hasAdvisor = false
        for (const [, entry] of toolUseInputs) {
          if (entry.name === ADVISOR_TOOL_NAME) {
            hasAdvisor = true
            break
          }
        }
        if (hasAdvisor && stopReason === 'tool_use') {
          // Roll back the index counter — the tool_use block events were
          // buffered and will be discarded; their allocated indices should
          // not leave a gap in the client-visible sequence.
          rewriter.restoreCheckpoint()
          // Build the assistant message from accumulated data
          const contentBlocks: AnthropicContentBlock[] = []
          // Sort by index to maintain order
          const sorted = Array.from(toolUseInputs.entries()).sort(([a], [b]) => a - b)
          for (const [, entry] of sorted) {
            let parsedInput: unknown
            try {
              parsedInput = JSON.parse(entry.inputAcc)
            } catch {
              parsedInput = { raw: entry.inputAcc }
            }
            contentBlocks.push({
              type: 'tool_use',
              id: entry.id,
              name: entry.name,
              input: parsedInput,
            })
          }

          const assistantMsg: AnthropicMessage = {
            role: 'assistant',
            content: contentBlocks,
          }
          try { await reader.cancel() } catch { /* noop */ }
          return { outcome: 'advisor', assistantMsg }
        }
      }
    }
  }

  // ----------------------------------------------------------------------
  // Stream pro's response as reasoning (Anthropic format)
  // ----------------------------------------------------------------------

  /**
   * Stream pro's response into the controller's think panel. Pro is consulted
   * as a passive advisor — both thinking_delta AND text_delta are rewritten
   * into the thinking content block stream.
   *
   * Returns pro's thinking and text separately. Callers that need a single
   * concatenated string (for a tool_result) can recombine them; callers that
   * need the thinking verbatim (e.g. to attach a reasoning_content block to a
   * fabricated assistant message for DeepSeek-style reasoning models) can use
   * the `thinking` field directly.
   */
  private async streamProAsReasoning(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array>,
    rewriter: ContentBlockIndexRewriter
  ): Promise<{ text: string; thinking: string }> {
    rewriter.beginSubStream()
    const sseBuf = new SseLineBuffer()
    let thinkingAcc = ''
    let contentAcc = ''
    // When true we swallow all lines (event: + data: + blank) until the blank
    // line separator that terminates the current SSE event. This ensures
    // message_delta / message_stop / message_start from the pro sub-stream
    // are completely invisible to the client.
    let swallowing = false
    // Indices of pro content blocks of type `tool_use` (e.g. the dummy
    // `finish` tool_call). These must NOT leak into the client stream — we
    // swallow their content_block_start/delta/stop events entirely.
    const toolUseIndices = new Set<number>()

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        return { text: contentAcc, thinking: thinkingAcc }
      }
      if (!value || value.length === 0) continue
      const { lines } = sseBuf.feed(value)
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]
        // Drop orphaned content_block event: lines (no following data:).
        if (isOrphanedContentBlockEvent(lines, li)) continue
        // Pro sub-stream's message_stop / message_delta / message_start must NOT
        // be forwarded to the client — they would terminate the client stream
        // prematurely or confuse it with duplicate message_start events.
        if (line.anthropicEvent) {
          const event = line.anthropicEvent

          if (event.type === 'message_stop' || event.type === 'message_delta' || event.type === 'message_start') {
            swallowing = true
            continue // swallow the data: line
          }

          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              thinkingAcc += event.delta.thinking
              controller.enqueue(rewriteIndexInLine(line, rewriter))
              continue
            }
            if (event.delta.type === 'text_delta' && event.delta.text) {
              contentAcc += event.delta.text
              // Rewrite text → thinking (appear in think panel).
              const rewrittenPayload = JSON.stringify({
                type: 'content_block_delta',
                index: rewriter.rewriteBlockIndex(event.index, false),
                delta: { type: 'thinking_delta', thinking: event.delta.text },
              })
              controller.enqueue(Buffer.from(`data: ${rewrittenPayload}\n`, 'utf-8'))
              continue
            }
          }

          // pro 的 text block → 重写为客户端 thinking block（type: text → thinking）
          if (event.type === 'content_block_start' && event.content_block.type === 'text') {
            const rewrittenPayload = JSON.stringify({
              type: 'content_block_start',
              index: rewriter.rewriteBlockIndex(event.index, true),
              content_block: { type: 'thinking', thinking: '' },
            })
            controller.enqueue(Buffer.from(`data: ${rewrittenPayload}\n`, 'utf-8'))
            continue
          }

          // pro's tool_use blocks (e.g. the dummy `finish` tool_call) must
          // NOT leak to the client stream. Swallow the whole block: its
          // content_block_start, content_block_delta (input_json_delta), and
          // content_block_stop.
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            toolUseIndices.add(event.index)
            swallowing = true
            continue
          }
          if (
            (event.type === 'content_block_delta' || event.type === 'content_block_stop') &&
            toolUseIndices.has(event.index)
          ) {
            if (event.type === 'content_block_stop') toolUseIndices.delete(event.index)
            swallowing = true
            continue
          }
        }

        // Swallow event: lines and blank lines that belong to swallowed events.
        if (line.eventType === 'message_delta' || line.eventType === 'message_stop' || line.eventType === 'message_start') {
          swallowing = true
          continue
        }
        if (swallowing) {
          // Blank line (neither data nor event) terminates the swallowed event.
          if (!line.isData && !line.isEvent) {
            swallowing = false
          }
          continue
        }

        // Forward all other lines (event:, blank lines, content_block_start/stop, etc.)
        // but rewrite content_block indices.
        if (rewriter && line.anthropicEvent) {
          controller.enqueue(rewriteIndexInLine(line, rewriter))
        } else {
          controller.enqueue(line.bytes)
        }
      }
    }
  }
}

/** Build the singleton undici Pool for a given config. */
export function buildEscalatePool(apiBase: string, opts?: { connections?: number; keepAliveTimeout?: number }): Pool {
  const base = normalizeBase(apiBase)
  let origin = base
  const schemeEnd = base.indexOf('://')
  if (schemeEnd !== -1) {
    const afterScheme = base.slice(schemeEnd + 3)
    const slashIdx = afterScheme.indexOf('/')
    if (slashIdx !== -1) {
      origin = base.slice(0, schemeEnd + 3 + slashIdx)
    }
  }
  return new Pool(origin, {
    connections: opts?.connections ?? 4,
    pipelining: 1,
    keepAliveTimeout: opts?.keepAliveTimeout ?? 30_000,
  })
}

// Re-export for convenience.
export { normalizeBase, headersToRecord }
