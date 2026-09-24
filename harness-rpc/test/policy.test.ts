import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { compilePolicy, isRestrictive, mergePolicies, PolicyError } from '../src/domain/policy.js'

function policy(overrides: Partial<{ allow: string[]; deny: string[]; network: string[]; mount: string | null; updatedAt: string | null }>): WorkspacePolicy {
  const base = emptyWorkspacePolicy()
  base.commands.allow = overrides.allow ?? []
  base.commands.deny = overrides.deny ?? []
  base.network.allow = overrides.network ?? []
  base.mount = overrides.mount ?? null
  base.updatedAt = overrides.updatedAt ?? null
  return base
}

describe('merging the environment share with the stored share', () => {
  it('unions every list, so neither source can loosen the other', () => {
    const merged = mergePolicies(policy({ deny: ['curl'], allow: ['pnpm *'] }), policy({ deny: ['wget', 'curl'], network: ['example.com'] }))
    expect(merged.commands.deny).toEqual(['curl', 'wget'])
    expect(merged.commands.allow).toEqual(['pnpm *'])
    expect(merged.network.allow).toEqual(['example.com'])
  })

  it('takes the last mount named and the newest timestamp', () => {
    const merged = mergePolicies(policy({ mount: '/workspace', updatedAt: '2026-01-01T00:00:00.000Z' }), policy({ mount: '/app', updatedAt: '2026-02-01T00:00:00.000Z' }), null)
    expect(merged.mount).toBe('/app')
    expect(merged.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('compiling', () => {
  it('refuses a pattern that is a regular expression, naming it and the migration', () => {
    expect(() => compilePolicy(policy({ allow: ['^pnpm (build|test)'] }))).toThrow(PolicyError)
    expect(() => compilePolicy(policy({ allow: ['^pnpm (build|test)'] }))).toThrow('^pnpm (build|test)')
    expect(() => compilePolicy(policy({ deny: ['^curl\\b'] }))).toThrow('buckle policy migrate')
  })

  it('compiles a glob into a matcher the rules can run', () => {
    const compiled = compilePolicy(policy({ allow: ['pnpm {build,test} *'] }))
    expect(compiled.commands.allow[0]?.matchesLine(['pnpm', 'build'])).toBe(true)
  })

  it('refuses a network entry that is neither a host nor a URL prefix', () => {
    expect(() => compilePolicy(policy({ network: ['not a host'] }))).toThrow(PolicyError)
  })

  it.each(['/usr', '/etc/work', '/home', '/tmp'])('refuses mounting over %s, which the sandbox needs', mount => {
    expect(() => compilePolicy(policy({ mount }))).toThrow(PolicyError)
  })

  it.each(['/workspace', '/mnt/work', '/srv/app'])('accepts %s as a mount', mount => {
    expect(compilePolicy(policy({ mount })).mount).toBe(mount)
  })

  it('skips a network entry the grammar refuses only when it was already in force, and a list left empty reaches nothing', () => {
    const inForce = () => true
    const compiled = compilePolicy(policy({ network: ['example.com', '*.127.0.0.1'] }), { tolerated: inForce })
    expect(compiled.skipped).toEqual([{ entry: '*.127.0.0.1', reason: expect.stringContaining('covers a domain, not an address') }])
    expect(compiled.network?.matches(new URL('https://example.com/'))).toBe(true)
    expect(compiled.network?.matches(new URL('http://127.0.0.1/'))).toBe(false)
    expect(compilePolicy(policy({ network: ['*.127.0.0.1'] }), { tolerated: inForce }).network?.matches(new URL('https://example.com/'))).toBe(false)
    expect(() => compilePolicy(policy({ network: ['*.127.0.0.1'] }))).toThrow(PolicyError)
  })

  it('leaves the network rule to its defaults when no list is set', () => {
    expect(compilePolicy(policy({})).network).toBeNull()
  })
})

describe('what counts as restrictive', () => {
  it('is any list or a mount', () => {
    expect(isRestrictive(policy({}))).toBe(false)
    expect(isRestrictive(policy({ deny: ['curl'] }))).toBe(true)
    expect(isRestrictive(policy({ mount: '/workspace' }))).toBe(true)
  })
})
