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
 *
 * This file also defines the **advisor** tool injection — a different
 * escalation strategy where the model calls a virtual `advisor` function
 * tool and the proxy routes the call to the pro model. See
 * `injectAdvisorTool()` below for details.
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
      `${CONTRACT_SENTINEL} Cost-aware tier switching instruction (you are running on \`${modelId}\` — the strong tier):`,
      ``,
      `Two markers are available across the system — \`<<<NEEDS_PRO>>>\` and \`<<<NEEDS_FLASH>>>\`.`,
      `Here is how they apply to YOU:`,
      ``,
      `### \`<<<NEEDS_FLASH>>>\` — downgrade request (ACTIVE for you)`,
      `If a task CLEARLY fits in the cheap tier — single-line edits, typo fixes, trivial lookups,`,
      `read-only file inspections where the answer is obvious — output this marker as the`,
      `ENTIRE response — no greeting, no "let me show you", no prose explanation, not even a`,
      `leading blank line. The marker IS the response; any text before it makes detection fail.`,
      `This aborts the current call and retries this turn on the cheaper flash model, saving cost`,
      `and latency.`,
      ``,
      `Two accepted forms:`,
      `- \`<<<NEEDS_FLASH>>>\` — bare marker, no rationale.`,
      `- \`<<<NEEDS_FLASH: <one-sentence reason>>>>\` — preferred. The reason text appears in the`,
      `  user-visible notice ("⇩ pro requested downgrade — <your reason>"), so they understand WHY a`,
      `  cheaper call is happening. Keep it under ~150 chars, no newlines, no nested \`>\` characters.`,
      `  Examples: \`<<<NEEDS_FLASH: trivial typo fix, no reasoning needed>>>\` or`,
      `  \`<<<NEEDS_FLASH: simple file lookup; pro would over-engineer this>>>\`.`,
      ``,
      `### \`<<<NEEDS_PRO>>>\` — escalation request (NO-OP for you)`,
      `You are already the pro (strong) tier. There is no higher tier to escalate to.`,
      `If you see this marker in the conversation history or consider emitting it yourself,`,
      `ignore it — it does not apply to you. Simply deliver the strongest answer you can directly.`,
      ``,
      `Do NOT emit any other content in the same response when downgrading. Use sparingly: tasks that`,
      `involve careful reasoning, multi-step planning, subtle correctness, or where you are not 100%`,
      `sure of the triviality should stay on this tier. When in doubt, deliver the answer here. If`,
      `asked which model you are, answer \`${modelId}\`.`,
    ].join('\n')
  }

  // ---- Flash model contract: describes the escalation path. ----
  return [
    `${CONTRACT_SENTINEL} Tier escalation instruction (you are running on \`${modelId}\` — the fast/cheap tier):`,
    ``,
    `You have the ability to hand off to a stronger model (\`${proModelId}\`) when the situation`,
    `calls for it. Do this by outputting the \`<<<NEEDS_PRO>>>\` marker as your ENTIRE response.`,
    ``,
    `### When to escalate — escalate proactively in ANY of these situations:`,
    ``,
    `1. **AMBIGUOUS / UNCLEAR requirements** — The user's request is vague, underspecified, or`,
    `   could be interpreted in multiple conflicting ways. Example: user says "make this better"`,
    `   or "fix the performance" without specifics.`,
    ``,
    `2. **MULTIPLE OPTIONS / decision needed** — The task involves choosing between several`,
    `   approaches and the trade-offs are non-trivial (architectural choices, API design patterns,`,
    `   data model decisions). The stronger model is better equipped to reason through trade-offs.`,
    `   Examples: choosing between microservices vs monolith, SQL vs NoSQL, sync vs async design.`,
    ``,
    `3. **TOOL CALL FAILURE** — You called a tool (grep, read file, edit code, etc.) and it`,
    `   returned an unexpected error, empty result, or clearly wrong output, and you're not sure`,
    `   why or how to recover. The stronger model has better debugging instincts. Examples: grep`,
    `   returned nothing for a symbol you expect to exist, edit_file failed mysteriously, build`,
    `   errors that don't make sense.`,
    ``,
    `4. **STUCK / spinning** — You've made 2+ attempts at the same sub-problem without making`,
    `   progress (same error persists, reasoning goes in circles, can't figure out the right next`,
    `   step). The stronger model can break the deadlock.`,
    ``,
    `5. **COMPLEX reasoning** — Cross-file refactors with subtle dependencies, concurrency or`,
    `   security invariants, correctness proofs, design trade-offs you'd be guessing at.`,
    ``,
    `### How to escalate:`,
    ``,
    `Output the marker as the FIRST AND ONLY content of your response — no greeting, no`,
    `"let me think about this", no prose explanation, not even a leading blank line.`,
    `The marker IS the response; any text before it makes detection fail. Proper forms:`,
    ``,
    `- \`<<<NEEDS_PRO>>>\` — bare marker, no rationale.`,
    `- \`<<<NEEDS_PRO: <one-sentence reason>>>>\` — preferred. The reason appears in the UI so the`,
    `  user understands WHY escalation happened. Keep it under ~150 chars, no newlines.`,
    `  Examples:`,
    `    \`<<<NEEDS_PRO: user request is ambiguous needs clarification and design reasoning>>>>\``,
    `    \`<<<NEEDS_PRO: grep returned nothing for exported class need to investigate module system>>>\``,
    `    \`<<<NEEDS_PRO: two failed edit attempts on the same function something deeper is going on>>>\``,
    `    \`<<<NEEDS_PRO: need to choose between three caching strategies with different trade-offs>>>\``,
    ``,
    `### Escalate EARLY, not as a last resort:`,
    `- If you feel uncertain at ANY point → escalate.`,
    `- If the request seems ambiguous → escalate (the pro model can ask clarifying questions).`,
    `- If a tool returns something unexpected → escalate after 1 retry, not 3+.`,
    `- If you're about to guess → escalate instead.`,
    `- Normal tasks (clear bug fixes, simple edits, straightforward features) stay here — but`,
    `  when in doubt, escalate. It's better to escalate unnecessarily than to produce a wrong`,
    `  or mediocre answer.`,
    ``,
    `The marker \`<<<NEEDS_FLASH>>>\` (downgrade request) is NOT ACTIVE for you — you are already`,
    `the flash tier. If you see it in conversation history, ignore it.`,
    `If asked which model you are, answer \`${modelId}\`.`,
  ].join('\n')
}

/**
 * The advisor tool definition — a virtual tool that flash models call to
 * request a stronger-model consultation. The proxy intercepts the call,
 * forwards the question to the pro model, and returns pro's analysis as a
 * `tool` message back to flash.
 *
 * The tool accepts a single `question` parameter; flash is expected to write
 * a specific, context-rich question (the contract prompt fragment explains
 * when and how to use the tool).
 */
export const ADVISOR_TOOL_NAME = 'advisor'

/** Unique sentinel marking that the request already carries the advisor wiring.
 *  Kept for backward compatibility but no longer used by `injectAdvisorTool`
 *  — the system prompt is now untouched and the advisor guidance lives in
 *  the tool's description. */
export const ADVISOR_TOOL_SENTINEL = '[autodev-escalate-advisor]'

/** Shape of the `advisor` tool as it appears in the OpenAI `tools` array.
 *  The description carries the full "when/how/when-not" guidance so the model
 *  can learn the tool's usage from the schema alone — no separate system-prompt
 *  fragment is needed. This keeps the system prompt untouched (just whatever
 *  the client supplied) and avoids polluting it with proxy internals. */
export const advisorToolDefinition = {
  type: 'function',
  function: {
    name: ADVISOR_TOOL_NAME,
    description:
      `When to call ${ADVISOR_TOOL_NAME}: (1) the user's request is ambiguous ` +
      `or could be interpreted in multiple conflicting ways; (2) the task ` +
      `involves choosing between several approaches with non-trivial trade-offs ` +
      `(architectural choices, API design, data model decisions); (3) a tool ` +
      `you called returned an unexpected error, empty result, or clearly wrong ` +
      `output and you're not sure how to recover; (4) you've made 2+ attempts ` +
      `at the same sub-problem without making progress; (5) cross-file ` +
      `refactors with subtle dependencies, concurrency or security invariants, ` +
      `correctness proofs, or design trade-offs you'd be guessing at. ` +
      `How to call: pass a \`question\` string that is specific and includes ` +
      `the relevant context — pro sees the full conversation, so just highlight ` +
      `what you want pro to weigh in on. After pro's analysis comes back as a ` +
      `tool message, integrate it into your final answer; the user does NOT see ` +
      `the tool call or pro's raw response — only your synthesized answer. ` +
      `You may call ${ADVISOR_TOOL_NAME} multiple times per turn for ` +
      `independent questions. ` +
      `Do NOT call ${ADVISOR_TOOL_NAME} for trivial lookups, single-line edits, ` +
      `typo fixes, or when you already know the answer with high confidence.`,
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The specific question for the pro advisor. Include the relevant context; pro sees the full conversation but you should still surface what you want pro to weigh in on.',
        },
      },
      required: ['question'],
    },
  },
}

/**
 * System prompt fragment that teaches the flash model when and how to use the
 * `advisor` tool. Inserted once per request; subsequent injections are skipped
 * via the sentinel so retries that carry `messages` forward from earlier turns
 * do not re-append the fragment.
 */
export function advisorSystemPromptFragment(): string {
  return [
    `${ADVISOR_TOOL_SENTINEL} Advisor tool instruction (you are running on the fast/cheap tier):`,
    ``,
    `You have access to a virtual \`${ADVISOR_TOOL_NAME}\` tool that consults a stronger model (\`pro\`).`,
    `When you call this tool, the proxy intercepts the call, forwards your question to pro,`,
    `and returns pro's analysis to you as a \`tool\` message. You then synthesize the final answer`,
    `for the user.`,
    ``,
    `### When to call ${ADVISOR_TOOL_NAME}:`,
    ``,
    `1. **AMBIGUOUS / UNCLEAR requirements** — The user's request is vague, underspecified, or`,
    `   could be interpreted in multiple conflicting ways.`,
    `2. **MULTIPLE OPTIONS / decision needed** — The task involves choosing between several`,
    `   approaches with non-trivial trade-offs (architectural choices, API design patterns,`,
    `   data model decisions).`,
    `3. **TOOL CALL FAILURE** — You called a tool and it returned an unexpected error, empty`,
    `   result, or clearly wrong output, and you're not sure how to recover.`,
    `4. **STUCK / spinning** — You've made 2+ attempts at the same sub-problem without`,
    `   making progress.`,
    `5. **COMPLEX reasoning** — Cross-file refactors with subtle dependencies, concurrency or`,
    `   security invariants, correctness proofs, design trade-offs you'd be guessing at.`,
    ``,
    `### How to call ${ADVISOR_TOOL_NAME}:`,
    ``,
    `- Call the tool with a \`question\` parameter that is specific and includes relevant context.`,
    `- Keep the question focused — pro will see the full conversation, so you don't need to`,
    `  restate everything; highlight what you want pro to weigh in on.`,
    `- After receiving pro's analysis, integrate it into your final answer. The user does NOT`,
    `  see the tool call or pro's raw response — only your synthesized answer.`,
    `- You may call ${ADVISOR_TOOL_NAME} multiple times in one turn if you have multiple`,
    `  independent questions for pro.`,
    ``,
    `### When NOT to call ${ADVISOR_TOOL_NAME}:`,
    ``,
    `- Trivial lookups, single-line edits, typo fixes — handle directly.`,
    `- When you already know the answer with high confidence.`,
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
  /**
   * Tool calls attached to an assistant message. Present when the model emitted
   * one or more `function` tool calls; used by the advisor dispatcher to detect
   * `advisor` calls and replay them as `tool` messages on the next flash turn.
   */
  tool_calls?: Array<{
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }>
  /** Required for `role: 'tool'` messages; references the originating `tool_calls[i].id`. */
  tool_call_id?: string
  [k: string]: unknown
}

export interface ChatCompletionRequestBody {
  model?: string
  messages?: ChatCompletionMessage[]
  stream?: boolean
  /** OpenAI `tools` array; the advisor injection appends to this list. */
  tools?: Array<Record<string, unknown>>
  /** OpenAI `tool_choice`; the advisor dispatcher removes this when calling pro. */
  tool_choice?: unknown
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

/**
 * Inject the advisor wiring into the request body:
 *   - Append the `advisor` tool definition to `body.tools` (idempotent — skipped
 *     if a tool with the same `name` is already present).
 *
 * The function does NOT modify the system prompt: the advisor tool's
 * description (see `advisorToolDefinition`) carries the full usage guidance
 * and the model can learn the tool from the schema alone. This keeps the
 * client's system message untouched.
 */
export function injectAdvisorTool<T extends ChatCompletionRequestBody>(body: T): T {
  const existingTools = Array.isArray(body.tools) ? body.tools : []
  const toolAlreadyPresent = existingTools.some((t) => {
    if (!t || typeof t !== 'object') return false
    const fn = (t as { function?: { name?: unknown } }).function
    return fn?.name === ADVISOR_TOOL_NAME
  })

  if (toolAlreadyPresent) {
    // Nothing to change.
    return body
  }

  const nextTools: Array<Record<string, unknown>> = [...existingTools, advisorToolDefinition]
  return { ...body, tools: nextTools }
}