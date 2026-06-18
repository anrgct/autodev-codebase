/**
 * Unit tests for the ESCALATION_CONTRACT generator + system-prompt injector.
 */
import { describe, it, expect } from 'vitest'
import { escalationContract, injectContract } from '../contract'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'

describe('escalationContract()', () => {
  it('returns the full ladder contract for the flash model', () => {
    const out = escalationContract(FLASH, PRO)
    expect(out).toContain('Cost-aware tier switching instruction')
    expect(out).toContain('cheap tier')
    expect(out).toContain('`deepseek-v4-flash`')
    expect(out).toContain('`deepseek-v4-pro`')
    // The full contract must mention both forms of the marker.
    expect(out).toContain('`<<<NEEDS_PRO>>>`')
    expect(out).toContain('`<<<NEEDS_PRO: <one-sentence reason>>>>`')
    // The flash contract must explicitly call out that NEEDS_FLASH is a no-op.
    expect(out).toMatch(/`<<<NEEDS_FLASH>>>.*NO-OP/i)
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

  it('mentions auto-escalation after 3+ repair failures (failure-threshold hint)', () => {
    const out = escalationContract(FLASH, PRO)
    expect(out).toMatch(/3\+\s*repair/i)
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
    expect(sys.content as string).toContain('Cost-aware tier switching instruction')
  })

  it('prepends a new system message when none exists', () => {
    const out = injectContract(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      FLASH, PRO
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages![0].role).toBe('system')
    expect(out.messages![0].content as string).toContain('Cost-aware tier switching instruction')
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
    const count = (sys.content as string).match(/Cost-aware tier switching instruction/g)?.length ?? 0
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
