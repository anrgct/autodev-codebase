/**
 * ESCALATION_CONTRACT — system-prompt fragment that teaches the model when
 * to request a tier switch via `<<<NEEDS_PRO>>>` / `<<<NEEDS_FLASH>>>` markers.
 *
 * The contract is the same one Reasonix uses (see DeepSeek-Reasonix
 * `src/prompt-fragments.ts`); only the *injection point* is different —
 * here it is injected by the proxy into the `system` field of every
 * outbound chat-completion request, on a per-model basis.
 *
 * Two directions are supported:
 *   - **flash → pro**: flash model emits `<<<NEEDS_PRO>>>` to escalate.
 *   - **pro → flash**: pro model emits `<<<NEEDS_FLASH>>>` to downgrade
 *     when it judges the task to be trivial.
 *
 * The marker MUST appear as the FIRST line of the response (no leading
 * whitespace, no preceding content) so the proxy can detect it in a tiny
 * first-chunk peek buffer.
 *
 * Each contract includes a unique sentinel `[autodev-escalate-contract]`
 * used for idempotency: if the system message already contains it, the
 * injector returns the body unchanged.
 */

/** Unique sentinel marking that the system message already carries a contract. */
export const CONTRACT_SENTINEL = '[autodev-escalate-contract]'

/**
 * Build the contract text for a given model ID.
 *
 * @param modelId     the model ID the *current* call is using, e.g. `deepseek-v4-flash`.
 *                    When the model ID matches the pro model ID, the returned
 *                    contract is the "downgrade to flash" variant.
 * @param proModelId  the pro model ID, used to disambiguate the contract variant
 *                    and to embed the "no higher tier" note.
 */
export function escalationContract(modelId: string, proModelId: string): string {
  if (modelId === proModelId) {
    // ---- Pro model contract: describes the downgrade path. ----
    return [
      `${CONTRACT_SENTINEL} Cost-aware downgrade note (you are running on \`${modelId}\` — the strong tier):`,
      ``,
      `The marker \`<<<NEEDS_PRO>>>\` is a no-op for you; you are already the top tier, so emitting it`,
      `will not change anything — just deliver the strongest answer you can directly.`,
      ``,
      `However, if a task CLEARLY fits in the cheap tier — single-line edits, typo fixes, trivial lookups,`,
      `read-only file inspections where the answer is obvious — output the marker \`<<<NEEDS_FLASH>>>\` as`,
      `the FIRST line of your response (nothing before it, not even whitespace on a separate line). This`,
      `aborts the current call and retries this turn on the cheaper flash model, saving cost and latency.`,
      ``,
      `Two accepted forms:`,
      `- \`<<<NEEDS_FLASH>>>\` — bare marker, no rationale.`,
      `- \`<<<NEEDS_FLASH: <one-sentence reason>>>>\` — preferred. The reason text appears in the`,
      `  user-visible notice ("⇩ pro requested downgrade — <your reason>"), so they understand WHY a`,
      `  cheaper call is happening. Keep it under ~150 chars, no newlines, no nested \`>\` characters.`,
      `  Examples: \`<<<NEEDS_FLASH: trivial typo fix, no reasoning needed>>>\` or`,
      `  \`<<<NEEDS_FLASH: simple file lookup; pro would over-engineer this>>>\`.`,
      ``,
      `Do NOT emit any other content in the same response when downgrading. Use sparingly: tasks that`,
      `involve careful reasoning, multi-step planning, subtle correctness, or where you are not 100%`,
      `sure of the triviality should stay on this tier. When in doubt, deliver the answer here. If`,
      `asked which model you are, answer \`${modelId}\`.`
    ].join('\n')
  }
  // ---- Flash model contract: describes the escalation path. ----
  return [
    `${CONTRACT_SENTINEL} Cost-aware escalation (you are running on \`${modelId}\`):`,
    ``,
    `If a task CLEARLY exceeds what this tier can do well — complex cross-file architecture refactors,`,
    `subtle concurrency / security / correctness invariants you can't resolve with confidence, or a`,
    `design trade-off you'd be guessing at — output the marker as the FIRST line of your response`,
    `(nothing before it, not even whitespace on a separate line). This aborts the current call and`,
    `retries this turn on \`${proModelId}\`, one shot.`,
    ``,
    `Two accepted forms:`,
    `- \`<<<NEEDS_PRO>>>\` — bare marker, no rationale.`,
    `- \`<<<NEEDS_PRO: <one-sentence reason>>>>\` — preferred. The reason text appears in the`,
    `  user-visible warning ("⇧ flash requested escalation — <your reason>"), so they understand`,
    `  WHY a more expensive call is happening. Keep it under ~150 chars, no newlines, no nested \`>\``,
    `  characters. Examples: \`<<<NEEDS_PRO: cross-file refactor across 6 modules with circular imports>>>\``,
    `  or \`<<<NEEDS_PRO: subtle session-token race; flash would likely miss the locking invariant>>>\`.`,
    ``,
    `Do NOT emit any other content in the same response when you request escalation. Use this`,
    `sparingly: normal tasks — reading files, small edits, clear bug fixes, straightforward feature`,
    `additions — stay on this tier. Request escalation ONLY when you would otherwise produce a guess`,
    `or a visibly-mediocre answer. If in doubt, attempt the task here first; the system also`,
    `escalates automatically if you hit 3+ repair / SEARCH-mismatch errors in a single turn (the user`,
    `sees a typed breakdown). If asked which model you are, answer \`${modelId}\`.`
  ].join('\n')
}

/**
 * OpenAI chat-completion request body (just the bits we touch).
 * Kept structural-typing to avoid pulling in OpenAI SDK types.
 */
export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function'
  content: string | null | Array<{ type: string; [k: string]: unknown }>
  name?: string
  [k: string]: unknown
}

export interface ChatCompletionRequestBody {
  model?: string
  messages?: ChatCompletionMessage[]
  stream?: boolean
  [k: string]: unknown
}

/**
 * Inject the tier contract into the request's `system` message.
 *
 * The first parameter identifies the model this request is targeting
 * (which determines the contract text). The second parameter is the
 * pro model ID — needed by the contract generator to know which tier
 * counts as "pro" and to embed the right "no higher tier" / "downgrade
 * to flash" notes.
 *
 * Strategy:
 *   1. If a system message already contains the contract sentinel, return
 *      the body unchanged (idempotency).
 *   2. Otherwise, append the contract to an existing system message, or
 *      prepend a new one if no system message exists.
 *   3. Force the `model` field to the target model so the contract is
 *      consistent with the request.
 *
 * The function is pure — it returns a new body, never mutating the input.
 */
export function injectContract<T extends ChatCompletionRequestBody>(
  body: T,
  targetModelId: string,
  proModelId: string
): T {
  const contract = escalationContract(targetModelId, proModelId)
  const messages = body.messages ?? []
  // Idempotency: don't double-inject if a contract is already present.
  if (messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(CONTRACT_SENTINEL))) {
    return body
  }

  const sysIdx = messages.findIndex((m) => m.role === 'system')
  let nextMessages: ChatCompletionMessage[]
  if (sysIdx === -1) {
    nextMessages = [{ role: 'system', content: contract }, ...messages]
  } else {
    const existing = messages[sysIdx]
    const existingContent = typeof existing.content === 'string' ? existing.content : ''
    nextMessages = messages.slice()
    nextMessages[sysIdx] = {
      ...existing,
      content: existingContent ? `${existingContent}\n\n${contract}` : contract
    }
  }

  return { ...body, messages: nextMessages, model: targetModelId }
}
