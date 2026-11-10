import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { compilePolicy, isRestrictive, PolicyError } from '../common/domain/policy.js'

function policy(overrides: Partial<{ allow: string[]; deny: string[]; network: string[]; mount: string | null }>): WorkspacePolicy {
  const base = emptyWorkspacePolicy()
  base.commands.allow = overrides.allow ?? []
  base.commands.deny = overrides.deny ?? []
  base.network.allow = overrides.network ?? []
  base.mount = overrides.mount ?? null
  return base
}

describe('compiling', () => {
  it('refuses a pattern that is a regular expression, naming it and the migration', () => {
    expect(() => compilePolicy(policy({ allow: ['^pnpm (build|test)'] }))).toThrow(PolicyError)
    expect(() => compilePolicy(policy({ allow: ['^pnpm (build|test)'] }))).toThrow('^pnpm (build|test)')
    expect(() => compilePolicy(policy({ deny: ['^curl\\b'] }))).toThrow('regular-expression syntax')
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

  it('refuses a network entry the host grammar refuses, next to valid ones too', () => {
    expect(() => compilePolicy(policy({ network: ['*.127.0.0.1'] }))).toThrow(PolicyError)
    expect(() => compilePolicy(policy({ network: ['example.com', '*.127.0.0.1'] }))).toThrow('A wildcard covers a domain, not an address')
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
