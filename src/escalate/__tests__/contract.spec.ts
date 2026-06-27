/**
 * Unit tests for the ESCALATION_CONTRACT generator + system-prompt injector,
 * plus the ADVISOR_TOOL definition and `injectAdvisorTool()` injector.
 */
import { describe, it, expect } from 'vitest'
import type { ChatCompletionRequestBody } from '../contract'
import {
  ADVISOR_TOOL_NAME,
  advisorToolDefinition,
  escalationContract,
  injectAdvisorTool,
  injectContract,
} from '../contract'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'

describe('escalationContract()', () => {
  it('returns the full ladder contract for the flash model', () => {
    const out = escalationContract(FLASH, PRO)
    expect(out).toContain('Tier escalation instruction')
    expect(out).toContain('fast/cheap tier')
    expect(out).toContain('`deepseek-v4-flash`')
    expect(out).toContain('`deepseek-v4-pro`')
    // The full contract must mention both forms of the marker.
    expect(out).toContain('`<<<NEEDS_PRO>>>`')
    expect(out).toContain('`<<<NEEDS_PRO: <one-sentence reason>>>>`')
    // The flash contract must explicitly call out that NEEDS_FLASH is a no-op.
    expect(out).toMatch(/`<<<NEEDS_FLASH>>>`.*NOT ACTIVE/i)
    // Entire-response constraint is mandatory.
    expect(out).toMatch(/ENTIRE response/i)
  })

  it('returns the downgrade contract for the pro model', () => {
    const out = escalationContract(PRO, PRO)
    expect(out).toContain('Cost-aware tier switching instruction')
    expect(out).toContain('strong tier')
    expect(out).toContain('`deepseek-v4-pro`')
    // The pro contract must mention both forms of the downgrade marker.
    expect(out).toContain('`<<<NEEDS_FLASH>>>`')
    expect(out).toContain('`<<<NEEDS_FLASH: <one-sentence reason>>>>`')
    // Entire-response constraint is mandatory for the downgrade marker too.
    expect(out).toMatch(/ENTIRE response/i)
    // The pro contract must explicitly call out that NEEDS_PRO is a no-op.
    expect(out).toMatch(/`<<<NEEDS_PRO>>>`.*no-op/i)
    // The short form must NOT include the full flash-side escalation ladder.
    expect(out).not.toContain('Two accepted forms: `<<<NEEDS_PRO: <one-sentence reason>>>>`')
  })

  it('embeds the model ID verbatim', () => {
    const customFlash = 'my-custom-flash-7b'
    const out = escalationContract(customFlash, PRO)
    expect(out).toContain('`my-custom-flash-7b`')
  })

  it('mentions proactive escalation scenarios (ambiguous, stuck, tool failure)', () => {
    const out = escalationContract(FLASH, PRO)
    expect(out).toMatch(/AMBIGUOUS.*UNCLEAR/i)
    expect(out).toMatch(/STUCK.*spinning/i)
    expect(out).toMatch(/TOOL CALL FAILURE/i)
  })
})

describe('injectContract()', () => {
  it('appends the contract to an existing system message', () => {
    const out = injectContract(
      { model: 'auto', messages: [{ role: 'system', content: 'You are a coding assistant.' }] },
      FLASH, PRO
    )
    expect(out.messages).toHaveLength(1)
    const sys = out.messages![0]
    expect(sys.role).toBe('system')
    expect(typeof sys.content).toBe('string')
    expect(sys.content as string).toContain('You are a coding assistant.')
    expect(sys.content as string).toContain('Tier escalation instruction')
  })

  it('prepends a new system message when none exists', () => {
    const out = injectContract(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      FLASH, PRO
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages![0].role).toBe('system')
    expect(out.messages![0].content as string).toContain('Tier escalation instruction')
    expect(out.messages![1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('forces the model to the flash ID', () => {
    const out = injectContract(
      { model: 'something-else', messages: [] },
      FLASH, PRO
    )
    expect(out.model).toBe(FLASH)
  })

  it('is idempotent (does not double-inject)', () => {
    const once = injectContract(
      { model: FLASH, messages: [{ role: 'system', content: 'Hi' }] },
      FLASH, PRO
    )
    const twice = injectContract(once, FLASH, PRO)
    const sys = twice.messages!.find((m) => m.role === 'system')!
    const count = (sys.content as string).match(/Tier escalation instruction/g)?.length ?? 0
    expect(count).toBe(1)
  })

  it('preserves all other top-level fields on the body', () => {
    const out = injectContract(
      {
        model: 'auto',
        messages: [],
        temperature: 0.7,
        tools: [{ type: 'function', function: { name: 'foo' } }],
        top_p: 0.9,
      },
      FLASH, PRO
    )
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.9)
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'foo' } }])
  })

  it('does not mutate the input', () => {
    const original = {
      model: 'auto',
      messages: [{ role: 'system' as const, content: 'Hi' }],
    }
    const snapshot = JSON.stringify(original)
    injectContract(original, FLASH, PRO)
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})

describe('advisorToolDefinition', () => {
  it('declares the advisor tool with a question parameter', () => {
    expect(advisorToolDefinition.type).toBe('function')
    expect(advisorToolDefinition.function.name).toBe(ADVISOR_TOOL_NAME)
    expect(advisorToolDefinition.function.name).toBe('advisor')
    expect(advisorToolDefinition.function.parameters.required).toContain('question')
    expect(advisorToolDefinition.function.parameters.properties.question.type).toBe('string')
  })
})

describe('advisorToolDefinition', () => {
  it('carries the full usage guidance in its description (no separate system fragment needed)', () => {
    const desc = advisorToolDefinition.function.description
    // When-to-call triggers.
    expect(desc).toMatch(/ambiguous/i)
    expect(desc).toMatch(/non-trivial trade-offs/i)
    expect(desc).toMatch(/tool.*returned.*unexpected/i)
    expect(desc).toMatch(/2\+? attempts/i)
    expect(desc).toMatch(/cross-file/i)
    // How-to-call + post-call behaviour.
    expect(desc).toMatch(/question/)
    expect(desc).toMatch(/integrate it into your final answer/i)
    expect(desc).toMatch(/user does NOT see/i)
    // When NOT to call.
    expect(desc).toMatch(/Do NOT call/i)
    expect(desc).toMatch(/trivial/i)
  })
})

describe('injectAdvisorTool()', () => {
  it('appends the advisor tool definition to the tools array', () => {
      const out = injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'foo' } }],
      } as ChatCompletionRequestBody)
      expect(Array.isArray(out.tools)).toBe(true)
      expect(out.tools).toHaveLength(2)
      expect(out.tools![1]).toEqual(advisorToolDefinition)
      // Client tools are preserved.
      expect(out.tools![0]).toEqual({ type: 'function', function: { name: 'foo' } })
    })

    it('creates a tools array when none exists', () => {
      const out = injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'user', content: 'hi' }],
      } as ChatCompletionRequestBody)
      expect(out.tools).toHaveLength(1)
      expect(out.tools![0]).toEqual(advisorToolDefinition)
    })

    it('does NOT modify the system message (advisor guidance lives in the tool description)', () => {
      const out = injectAdvisorTool({
        model: FLASH,
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: 'q' },
        ],
      } as ChatCompletionRequestBody)
      const sys = out.messages![0]
      expect(sys.role).toBe('system')
      expect(sys.content as string).toBe('You are a coding assistant.')
      expect(sys.content as string).not.toContain('[autodev-escalate-advisor]')
      expect(sys.content as string).not.toContain('Advisor tool instruction')
    })

    it('does NOT add a system message when none exists', () => {
      const out = injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'user', content: 'hi' }],
      } as ChatCompletionRequestBody)
      expect(out.messages).toHaveLength(1)
      expect(out.messages![0]).toEqual({ role: 'user', content: 'hi' })
    })

    it('is idempotent — does not double-inject the tool', () => {
      const once = injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'system', content: 'Hi' }],
      } as ChatCompletionRequestBody)
      const twice = injectAdvisorTool(once)
      const advisorCount = twice.tools!.filter(
        (t) => (t as { function?: { name?: string } }).function?.name === ADVISOR_TOOL_NAME
      ).length
      expect(advisorCount).toBe(1)
      // System message is also untouched on the second call.
      const sys = twice.messages!.find((m) => m.role === 'system')!
      expect(sys.content as string).toBe('Hi')
    })

    it('detects an existing advisor tool by name (idempotent)', () => {
      // A client may have already added an advisor-shaped tool; the injector
      // should still recognise it by name and not duplicate.
      const out = injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [advisorToolDefinition],
      } as ChatCompletionRequestBody)
      expect(out.tools).toHaveLength(1)
      // Messages are untouched: no system message added.
      expect(out.messages).toHaveLength(1)
      expect(out.messages![0]).toEqual({ role: 'user', content: 'hi' })
    })

    it('preserves all other top-level fields on the body', () => {
        const out = injectAdvisorTool({
          model: FLASH,
          messages: [],
          temperature: 0.7,
          top_p: 0.9,
          tool_choice: 'auto',
        } as ChatCompletionRequestBody)
        expect(out['temperature']).toBe(0.7)
        expect(out['top_p']).toBe(0.9)
        expect(out.tool_choice).toBe('auto')
      })

    it('does not mutate the input', () => {
      const original: ChatCompletionRequestBody = {
        model: FLASH,
        messages: [{ role: 'system' as const, content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'foo' } }],
      }
      const snapshot = JSON.stringify(original)
      injectAdvisorTool(original)
      expect(JSON.stringify(original)).toBe(snapshot)
    })

    it('composes cleanly with injectContract() — only the tier contract is injected', () => {
      // Advisor mode does NOT inject any system-prompt fragment, so the system
      // message carries only the tier-switch contract from injectContract.
      // The advisor tool description is the only place advisor guidance lives.
      const out = injectContract(
        injectAdvisorTool({
          model: FLASH,
          messages: [{ role: 'user', content: 'hi' }],
        } as ChatCompletionRequestBody),
        FLASH,
        PRO,
      )
      const sys = out.messages!.find((m) => m.role === 'system')!
      const content = sys.content as string
      // Tier contract is present (injected by injectContract).
      expect(content).toContain('[autodev-escalate-contract]')
      // Advisor fragment is NOT in the system prompt.
      expect(content).not.toContain('[autodev-escalate-advisor]')
      // Advisor tool still present.
      expect(out.tools!.some(
        (t) => (t as { function?: { name?: string } }).function?.name === ADVISOR_TOOL_NAME
      )).toBe(true)
    })
})