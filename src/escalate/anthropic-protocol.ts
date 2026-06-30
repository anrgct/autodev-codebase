/**
 * Anthropic Messages API protocol layer — pure format operations, zero
 * escalation orchestration.
 *
 * Responsibilities:
 *   1. Build upstream request body (system, messages, tools, thinking, max_tokens)
 *   2. Parse non-streaming responses (content blocks → text/thinking/tool_use)
 *   3. Stream event parsing (Anthropic SSE: `event:` + `data:`)
 *   4. Synthetic event construction (advisor begin/end, tier switch, proxy error)
 *   5. Content block index rewriter (monotonic counter across sub-streams)
 *   6. Tool result / assistant tool_use message construction
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anthropic API version header value. */
export const ANTHROPIC_VERSION = '2023-06-01'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a content block in an Anthropic message. */
export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  content?: string | Array<unknown>
  tool_use_id?: string
  /** Anthropic tool_result error flag (set when the tool failed). */
  is_error?: boolean
}

/** An Anthropic message (in the `messages` array). */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/** An Anthropic tool definition. */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** An Anthropic tool_choice. */
export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

/** The upstream Anthropic Messages API request body. */
export interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  max_tokens: number
  stream?: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: Record<string, string>
}

/** Parsed non-streaming response. */
export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  stop_sequence: string | null
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

// ---------------------------------------------------------------------------
// SSE event types (streaming)
// ---------------------------------------------------------------------------

export type AnthropicStreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'

export interface AnthropicStreamEventBase {
  type: AnthropicStreamEventType
}

export interface MessageStartEvent extends AnthropicStreamEventBase {
  type: 'message_start'
  message: AnthropicResponse
}

export interface ContentBlockStartEvent extends AnthropicStreamEventBase {
  type: 'content_block_start'
  index: number
  content_block: {
    type: 'text' | 'thinking' | 'tool_use'
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }
}

export interface ContentBlockDeltaEvent extends AnthropicStreamEventBase {
  type: 'content_block_delta'
  index: number
  delta: {
    type: 'text_delta' | 'thinking_delta' | 'input_json_delta' | 'signature_delta'
    text?: string
    thinking?: string
    partial_json?: string
  }
}

export interface ContentBlockStopEvent extends AnthropicStreamEventBase {
  type: 'content_block_stop'
  index: number
}

export interface MessageDeltaEvent extends AnthropicStreamEventBase {
  type: 'message_delta'
  delta: {
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
    stop_sequence: string | null
  }
  usage: { output_tokens: number }
}

export interface MessageStopEvent extends AnthropicStreamEventBase {
  type: 'message_stop'
}

export interface PingEvent extends AnthropicStreamEventBase {
  type: 'ping'
}

export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent

// ---------------------------------------------------------------------------
// Resolved client body (what the dispatcher works with internally)
// ---------------------------------------------------------------------------

/**
 * Resolved upstream body — the client's incoming Anthropic-format request
 * after applying defaults (max_tokens, thinking) and transforming tools.
 * This is the shape the dispatcher uses when calling `callUpstream`.
 */
export interface ResolvedUpstreamBody {
  model: string
  system?: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream?: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Client request shape (the body coming from the client)
// ---------------------------------------------------------------------------

/**
 * The incoming client request body in Anthropic Messages API format.
 * We only model the fields we touch; extra fields are passed through.
 */
export interface AnthropicClientRequestBody {
  model?: string
  system?: string | AnthropicContentBlock[]
  messages?: AnthropicMessage[]
  max_tokens?: number
  stream?: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: Record<string, string>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Body construction helpers
// ---------------------------------------------------------------------------

/** Extract the system prompt from the client body (top-level `system` field). */
export function extractSystem(body: AnthropicClientRequestBody): string | undefined {
  const system = body.system
  if (!system) return undefined
  if (typeof system === 'string') return system
  // If it's an array of content blocks, extract text from text blocks.
  if (Array.isArray(system)) {
    return system
      .filter((b): b is AnthropicContentBlock & { text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return undefined
}

/**
 * Build the upstream request body from the client's incoming body.
 * Applies defaults and transforms.
 */
export function buildUpstreamBody(
  clientBody: AnthropicClientRequestBody,
  config: { flashModel: string; proModel: string; maxTokens: number; thinkingBudget: number },
  overrides: { model: string },
): ResolvedUpstreamBody {
  const body = clientBody

  // Resolve model
  const model = overrides.model

  // Resolve system prompt (top-level `system` field)
  // Do NOT extract from messages — Anthropic format uses top-level `system`.
  const system = extractSystem(body)

  // Resolve messages (as-is)
  const messages = body.messages ?? []

  // Resolve max_tokens (required by Anthropic; use client's or config default)
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : config.maxTokens

  // Resolve thinking: pass through if client provided, otherwise inject
  const thinking = body.thinking ?? { type: 'enabled', budget_tokens: config.thinkingBudget }

  return {
    model,
    system,
    messages,
    max_tokens: maxTokens,
    stream: body.stream,
    thinking,
    tools: body.tools,
    tool_choice: body.tool_choice,
    metadata: body.metadata,
  }
}

// ---------------------------------------------------------------------------
// Non-streaming response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a non-streaming Anthropic Messages API response.
 * Returns null if the body is not valid JSON or doesn't look like a message.
 */
export function parseNonStreamResponse(body: string): AnthropicResponse | null {
  if (!body || body[0] !== '{') return null
  try {
    const parsed = JSON.parse(body) as AnthropicResponse
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'message' &&
      Array.isArray(parsed.content)
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract the concatenated text from an Anthropic response's content blocks.
 * Returns an empty string if no text blocks are present.
 */
export function extractTextFromBlocks(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/**
 * Extract the concatenated thinking from content blocks.
 */
export function extractThinkingFromBlocks(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking as string)
    .join('')
}

/**
 * Find the first tool_use content block (if any).
 */
export function extractFirstToolUse(blocks: AnthropicContentBlock[]): { id: string; name: string; input: Record<string, unknown> } | null {
  const block = blocks.find((b) => b.type === 'tool_use')
  if (!block || !block.id || !block.name) return null
  return {
    id: block.id,
    name: block.name,
    input: (block.input as Record<string, unknown>) ?? {},
  }
}

// ---------------------------------------------------------------------------
// SSE event parsing
// ---------------------------------------------------------------------------

/**
 * Parse an Anthropic SSE `data:` line into a structured event.
 * Returns `undefined` if the data is not valid JSON or is an empty event.
 */
export function parseStreamEvent(data: string): AnthropicStreamEvent | undefined {
  if (!data) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const event = parsed as Record<string, unknown>
  const type = event['type']
  if (typeof type !== 'string') return undefined
  return parsed as AnthropicStreamEvent
}

/**
 * Check if a data line is a `message_stop` event (marks stream end).
 */
export function isMessageStop(event: AnthropicStreamEvent): boolean {
  return event.type === 'message_stop'
}

/**
 * Check if a data line is a terminal event that signals the stream is done.
 */
export function isStreamEnd(event: AnthropicStreamEvent): boolean {
  return event.type === 'message_stop'
}

/**
 * Get the `stop_reason` from a `message_delta` event.
 */
export function getStopReason(event: AnthropicStreamEvent): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | undefined {
  if (event.type === 'message_delta') {
    return event.delta.stop_reason
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Synthetic event construction
// ---------------------------------------------------------------------------

/**
 * Build a synthetic SSE event chunk for advisor begin — injected as a thinking
 * content block so it appears in the client's thinking panel.
 */
export function buildAdvisorBeginEvent(question: string | undefined, model: string, rewriter: ContentBlockIndexRewriter): Uint8Array {
  const label = question
    ? `[proxy: consulting advisor (pro): ${question} — do not repeat this marker]`
    : '[proxy: consulting advisor (pro) — do not repeat this marker]'
  const thinkingText = `\n\n--- ${label} ---\n\n`
  const idx = rewriter.allocate()
  const event1 = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } })}\n\n`
  const event2 = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinkingText } })}\n\n`
  const event3 = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
  return Buffer.from(event1 + event2 + event3, 'utf-8')
}

/**
 * Build a synthetic SSE event chunk for advisor end — injected as a thinking
 * block marking the end of pro consultation.
 */
export function buildAdvisorEndEvent(model: string, rewriter: ContentBlockIndexRewriter): Uint8Array {
  const thinkingText = `\n\n--- [proxy: back to flash with advisor analysis — do not repeat this marker] ---\n\n`
  const idx = rewriter.allocate()
  const event1 = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } })}\n\n`
  const event2 = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinkingText } })}\n\n`
  const event3 = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
  return Buffer.from(event1 + event2 + event3, 'utf-8')
}

/**
 * Build a synthetic tier switch event — injected as a thinking block.
 */
export function buildTierSwitchEvent(from: 'flash' | 'pro', to: 'flash' | 'pro', reason: string | undefined, model: string, rewriter: ContentBlockIndexRewriter): Uint8Array {
  const detail = reason ? `; ${reason}` : ''
  const thinkingText = `\n\n--- [proxy: now on ${to} (was ${from}${detail})] ---\n\n`
  const idx = rewriter.allocate()
  const event1 = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } })}\n\n`
  const event2 = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinkingText } })}\n\n`
  const event3 = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
  return Buffer.from(event1 + event2 + event3, 'utf-8')
}

/**
 * Build a synthetic proxy error event — injected as a text content block with
 * stop_reason, followed by message_stop (since this is the terminal event).
 */
export function buildProxyErrorEvent(status: number, message: string, model: string, rewriter: ContentBlockIndexRewriter): Uint8Array {
  const trimmed = (message ?? '').slice(0, 200)
  const errorText = `[proxy error: upstream returned ${status}${trimmed ? `: ${trimmed}` : ''}]`
  const idx = rewriter.allocate()
  const event1 = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: errorText } })}\n\n`
  const event2 = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: errorText } })}\n\n`
  const event3 = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
  const event4 = `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`
  const event5 = `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  return Buffer.from(event1 + event2 + event3 + event4 + event5, 'utf-8')
}

/**
 * Build a synthetic `message_start` SSE event. Used by forced-advisor mode
 * when the proxy injects a pro consultation BEFORE the first flash stream —
 * the client stream needs a `message_start` before any `content_block_*`, but
 * there is no flash first-round stream to source it from. The model field is
 * set to the flash model since flash ultimately produces the final answer.
 */
export function buildMessageStartEvent(model: string): Uint8Array {
  const event = `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`
  return Buffer.from(event, 'utf-8')
}

// ---------------------------------------------------------------------------
// Content block index rewriter
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing content block index rewriter.
 *
 * Anthropic streaming uses `index` on each content block to track blocks in
 * order (thinking=0, text=1, ...). When the proxy splices together events from
 * multiple independent sub-streams (flash, advisor separator, pro, flash retry),
 * each sub-stream's indices start from 0, causing index duplication/jumps on
 * the client side. This rewriter assigns a continuous index across all events
 * that pass through the proxy.
 */
export class ContentBlockIndexRewriter {
  private nextIndex = 0
  private checkpoint: number | null = null
  /** Per sub-stream: upstream original index → client-visible rewritten index. */
  private indexMap = new Map<number, number>()
  /** Snapshot of indexMap at saveCheckpoint time (for rollback). */
  private savedMap: Map<number, number> | null = null

  /**
   * Reset the counter. Call at the start of a new request's stream.
   */
  reset(): void {
    this.nextIndex = 0
    this.checkpoint = null
    this.indexMap = new Map()
    this.savedMap = null
  }

  /**
   * Begin reading a new sub-stream. Resets the original→rewritten index map
   * so the new sub-stream's original indices (starting from 0) don't collide
   * with the previous sub-stream's.
   */
  beginSubStream(): void {
    this.indexMap = new Map()
  }

  /**
   * Allocate a fresh index with no mapping (for synthetic blocks that have no
   * upstream original index, e.g. advisor separator markers).
   */
  allocate(): number {
    return this.nextIndex++
  }

  /**
   * Rewrite a content block's original upstream index to the client-visible
   * index. For content_block_start, allocates a new index and records the
   * mapping so subsequent delta/stop events for the same block reuse it.
   * Correct Anthropic streaming requires one index per block (start/delta/stop
   * share the same index).
   */
  rewriteBlockIndex(originalIndex: number, isBlockStart: boolean): number {
    if (isBlockStart) {
      const newIndex = this.allocate()
      this.indexMap.set(originalIndex, newIndex)
      return newIndex
    }
    const existing = this.indexMap.get(originalIndex)
    if (existing !== undefined) return existing
    // No prior content_block_start seen — allocate defensively.
    const newIndex = this.allocate()
    this.indexMap.set(originalIndex, newIndex)
    return newIndex
  }

  /**
   * Save a checkpoint — the counter can be rolled back to this point
   * if the events allocated since are discarded (e.g. tool_use block
   * events that get thrown away when advisor is detected).
   */
  saveCheckpoint(): void {
    this.checkpoint = this.nextIndex
    this.savedMap = new Map(this.indexMap)
  }

  /**
   * Roll back to the last saved checkpoint, discarding all allocations made
   * since (both the counter and the index map). Does nothing if no checkpoint
   * was saved.
   */
  restoreCheckpoint(): void {
    if (this.checkpoint !== null) {
      this.nextIndex = this.checkpoint
      this.checkpoint = null
    }
    if (this.savedMap !== null) {
      this.indexMap = this.savedMap
      this.savedMap = null
    }
  }

  /**
   * Discard the saved checkpoint without rolling back (used when the buffered
   * events are committed, e.g. passthrough).
   */
  discardCheckpoint(): void {
    this.checkpoint = null
    this.savedMap = null
  }
}

// ---------------------------------------------------------------------------
// Message construction for tool results
// ---------------------------------------------------------------------------

/**
 * Build a `tool_result` message block (part of a `user` message content array).
 * Anthropic format: `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}`
 */
export function buildToolResultContent(
  toolUseId: string,
  content: string,
): AnthropicContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
  }
}

/**
 * Build a `user` message containing a tool_result.
 */
export function buildToolResultMessage(
  toolUseId: string,
  content: string,
): AnthropicMessage {
  return {
    role: 'user',
    content: [buildToolResultContent(toolUseId, content)],
  }
}

/**
 * Ensure every assistant message carries a `thinking` content block.
 *
 * Some upstream providers (e.g. DeepSeek's reasoning models) reject requests
 * in thinking mode when an assistant message in the history lacks a
 * reasoning_content block ("The reasoning_content in the thinking mode must
 * be passed back to the API"). Clients often drop the thinking block when
 * replaying prior turns (tool_use rounds, etc.), so the proxy re-adds an
 * empty one at the head of any assistant message that is missing it. The
 * empty thinking content is accepted by these providers as a no-op
 * reasoning step.
 *
 * Only assistant messages are touched; user/system messages pass through.
 * Messages that already contain a thinking block are left unchanged.
 */
export function ensureAssistantThinkingBlocks(messages: AnthropicMessage[]): AnthropicMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    const blocks: AnthropicContentBlock[] = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }]
    if (blocks.some((b) => b.type === 'thinking')) return m
    return {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '' }, ...blocks],
    }
  })
}

/**
 * Build an `assistant` message with a `tool_use` content block.
 */
export function buildAssistantToolUseMessage(
  toolUseId: string,
  name: string,
  input: string,
): AnthropicMessage {
  let parsedInput: unknown
  try {
    parsedInput = JSON.parse(input)
  } catch {
    parsedInput = { raw: input }
  }
  return {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolUseId,
      name,
      input: parsedInput,
    }],
  }
}

/**
 * Build a `user` message from plain text (e.g. for the advisor question).
 */
export function buildUserTextMessage(content: string): AnthropicMessage {
  return {
    role: 'user',
    content,
  }
}

/**
 * Build an `assistant` message with text content.
 */
export function buildAssistantTextMessage(content: string): AnthropicMessage {
  return {
    role: 'assistant',
    content,
  }
}

// ---------------------------------------------------------------------------
// Tool format conversion (OpenAI formulaire → Anthropic)
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI-format tool definition to Anthropic format.
 */
export function openAiToolToAnthropic(tool: Record<string, unknown>): AnthropicTool {
  const fn = (tool['function'] ?? tool) as Record<string, unknown> | undefined
  return {
    name: String(fn?.['name'] ?? tool['name'] ?? ''),
    description: String(fn?.['description'] ?? tool['description'] ?? ''),
    input_schema: (fn?.['parameters'] ?? tool['input_schema'] ?? {}) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// Contract message builder
// ---------------------------------------------------------------------------

/**
 * Build a system message for contract injection.
 * Returns the system string (Anthropic uses top-level `system` field).
 */
export function buildSystemWithContract(
  existingSystem: string | undefined,
  contract: string,
): string {
  if (existingSystem) {
    return `${existingSystem}\n\n${contract}`
  }
  return contract
}

/**
 * Check if a system string already contains the contract sentinel.
 */
export function systemContainsSentinel(system: string | undefined, sentinel: string): boolean {
  if (!system) return false
  return system.includes(sentinel)
}
