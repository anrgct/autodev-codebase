/**
 * Unit tests for the ESCALATION_CONTRACT generator + system-prompt injector,
 * plus the ADVISOR_TOOL definition and `injectAdvisorTool()` injector.
 *
 * Updated for Anthropic Messages API format.
 */
import { describe, it, expect } from 'vitest'
import type { AnthropicTool } from '../anthropic-protocol'
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
    expect(out).toContain('`<<<NEEDS_PRO>>>`')
    expect(out).toContain('`<<<NEEDS_PRO: <one-sentence reason>>>>`')
    expect(out).toMatch(/`<<<NEEDS_FLASH>>>`.*NOT ACTIVE/i)
    expect(out).toMatch(/ENTIRE response/i)
  })

  it('returns the downgrade contract for the pro model', () => {
    const out = escalationContract(PRO, PRO)
    expect(out).toContain('Cost-aware tier switching instruction')
    expect(out).toContain('strong tier')
    expect(out).toContain('`deepseek-v4-pro`')
    expect(out).toContain('`<<<NEEDS_FLASH>>>`')
    expect(out).toContain('`<<<NEEDS_FLASH: <one-sentence reason>>>>`')
    expect(out).toMatch(/ENTIRE response/i)
    expect(out).toMatch(/`<<<NEEDS_PRO>>>`.*no-op/i)
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
  it('appends the contract to the system field', () => {
    const out = injectContract(
      { model: 'auto', system: 'You are a coding assistant.', messages: [] } as Record<string, unknown>,
      FLASH, PRO
    )
    expect(typeof out['system']).toBe('string')
    expect(out['system'] as string).toContain('You are a coding assistant.')
    expect(out['system'] as string).toContain('Tier escalation instruction')
    expect(out['model'] as string).toBe(FLASH)
  })

  it('sets system when none exists', () => {
    const out = injectContract(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] } as Record<string, unknown>,
      FLASH, PRO
    )
    expect(typeof out['system']).toBe('string')
    expect(out['system'] as string).toContain('Tier escalation instruction')
  })

  it('forces the model to the flash ID', () => {
    const out = injectContract(
      { model: 'something-else', messages: [] } as Record<string, unknown>,
      FLASH, PRO
    )
    expect(out['model'] as string).toBe(FLASH)
  })

  it('is idempotent (does not double-inject)', () => {
    const once = injectContract(
      { system: 'Hi', messages: [] },
      FLASH, PRO
    )
    const twice = injectContract(once, FLASH, PRO)
    const count = (twice.system as string).match(/Tier escalation instruction/g)?.length ?? 0
    expect(count).toBe(1)
  })

  it('preserves all other top-level fields on the body', () => {
    const out = injectContract(
      {
        model: 'auto',
        messages: [],
        temperature: 0.7,
        tools: [{ name: 'foo', description: '', input_schema: { type: 'object' } }],
        top_p: 0.9,
      } as Record<string, unknown>,
      FLASH, PRO
    )
    expect(out['temperature'] as number).toBe(0.7)
    expect(out['top_p'] as number).toBe(0.9)
    expect(Array.isArray(out['tools'])).toBe(true)
    expect((out['tools'] as Array<Record<string, unknown>>)[0]['name']).toBe('foo')
  })

  it('does not mutate the input', () => {
    const original: Record<string, unknown> = {
      model: 'auto',
      system: 'Hi',
      messages: [],
    }
    const snapshot = JSON.stringify(original)
    injectContract(original, FLASH, PRO)
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})

describe('advisorToolDefinition', () => {
  it('declares the advisor tool with a question parameter', () => {
    expect(advisorToolDefinition.name).toBe(ADVISOR_TOOL_NAME)
    expect(advisorToolDefinition.name).toBe('advisor')
    expect(advisorToolDefinition.input_schema['required']).toContain('question')
    const props = advisorToolDefinition.input_schema['properties'] as Record<string, { type: string }>
    expect(props['question'].type).toBe('string')
  })

  it('carries the full usage guidance in its description (no separate system fragment needed)', () => {
    const desc = advisorToolDefinition.description
    expect(desc).toMatch(/ambiguous/i)
    expect(desc).toMatch(/non-trivial trade-offs/i)
    expect(desc).toMatch(/tool.*returned.*unexpected/i)
    expect(desc).toMatch(/2\+ failed attempts/i)
    expect(desc).toMatch(/cross-file/i)
    expect(desc).toMatch(/question/)
    expect(desc).toMatch(/synthesize pro/i)
    expect(desc).toMatch(/user sees only/i)
    expect(desc).toMatch(/when NOT/i)
    expect(desc).toMatch(/trivial/i)
  })
})

describe('injectAdvisorTool()', () => {
  it('appends the advisor tool definition to the tools array', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'foo', description: '', input_schema: { type: 'object' } }],
    } as Record<string, unknown>)
    expect(Array.isArray(out['tools'])).toBe(true)
    expect(out['tools']).toHaveLength(2)
    const advisorAdded = (out['tools'] as Array<Record<string, unknown>>).some(
      (t) => t['name'] === ADVISOR_TOOL_NAME
    )
    expect(advisorAdded).toBe(true)
    expect((out['tools'] as Array<Record<string, unknown>>)[0]['name']).toBe('foo')
  })

  it('creates a tools array when none exists', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
    } as Record<string, unknown>)
    expect(out['tools']).toHaveLength(1)
    expect((out['tools'] as Array<Record<string, unknown>>)[0]['name']).toBe(ADVISOR_TOOL_NAME)
  })

  it('does NOT modify the system field', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      system: 'You are a coding assistant.',
      messages: [{ role: 'user', content: 'q' }],
    } as Record<string, unknown>)
    expect(out['system'] as string).toBe('You are a coding assistant.')
  })

  it('does NOT add a system field when none exists', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
    } as Record<string, unknown>)
    expect(out['messages']).toHaveLength(1)
    expect((out['messages'] as Array<Record<string, unknown>>)[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('is idempotent — does not double-inject the tool', () => {
    const once = injectAdvisorTool({
      model: FLASH,
      messages: [{ role: 'system', content: 'Hi' }],
    } as Record<string, unknown>)
    const twice = injectAdvisorTool(once)
    const advisorCount = (twice['tools'] as Array<Record<string, unknown>>).filter(
      (t) => t['name'] === ADVISOR_TOOL_NAME
    ).length
    expect(advisorCount).toBe(1)
    const sys = (twice['messages'] as Array<Record<string, unknown>>).find((m: Record<string, unknown>) => m['role'] === 'system')
    expect(sys?.['content']).toBe('Hi')
  })

  it('detects an existing advisor tool by name (idempotent)', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [advisorToolDefinition],
    } as Record<string, unknown>)
    expect(out['tools']).toHaveLength(1)
    expect(out['messages']).toHaveLength(1)
    expect((out['messages'] as Array<Record<string, unknown>>)[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('preserves all other top-level fields on the body', () => {
    const out = injectAdvisorTool({
      model: FLASH,
      messages: [],
      temperature: 0.7,
      top_p: 0.9,
      tool_choice: { type: 'auto' },
    } as Record<string, unknown>)
    expect(out['temperature'] as number).toBe(0.7)
    expect(out['top_p'] as number).toBe(0.9)
    expect(out['tool_choice']).toEqual({ type: 'auto' })
  })

  it('does not mutate the input', () => {
    const original: Record<string, unknown> = {
      model: FLASH,
      messages: [{ role: 'system' as const, content: 'Hi' }],
      tools: [{ name: 'foo', description: '', input_schema: { type: 'object' } }],
    }
    const snapshot = JSON.stringify(original)
    injectAdvisorTool(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('composes cleanly with injectContract()', () => {
    const out = injectContract(
      injectAdvisorTool({
        model: FLASH,
        messages: [{ role: 'user', content: 'hi' }],
      } as Record<string, unknown>),
      FLASH,
      PRO,
    )
    expect(out['system'] as string).toContain('[autodev-escalate-contract]')
    expect(Array.isArray(out['tools'])).toBe(true)
    const hasAdvisor = (out['tools'] as Array<Record<string, unknown>>).some(
      (t) => t['name'] === ADVISOR_TOOL_NAME
    )
    expect(hasAdvisor).toBe(true)
  })
})
