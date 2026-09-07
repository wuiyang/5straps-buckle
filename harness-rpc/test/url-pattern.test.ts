import { describe, expect, it } from 'vitest'
import type { ResolvedEffect } from '../src/domain/effect.js'
import { createPermissionEngine } from '../src/domain/permission/engine.js'
import { createNetworkEgressRule } from '../src/domain/permission/rules/network-egress-rule.js'
import { compileUrlPatterns, UrlPatternError } from '../src/domain/url-pattern.js'

function matches(patterns: string[], url: string): boolean {
  return compileUrlPatterns(patterns).matches(new URL(url))
}

describe('host entries', () => {
  it('match that host alone', () => {
    expect(matches(['example.com'], 'https://example.com/anything')).toBe(true)
    expect(matches(['example.com'], 'https://sub.example.com/')).toBe(false)
    expect(matches(['example.com'], 'https://example.com.evil.test/')).toBe(false)
  })

  it('cover the apex and every subdomain with a leading *.', () => {
    expect(matches(['*.example.com'], 'https://example.com/')).toBe(true)
    expect(matches(['*.example.com'], 'https://deep.sub.example.com/')).toBe(true)
    expect(matches(['*.example.com'], 'https://notexample.com/')).toBe(false)
  })

  it('pin a port when one is written, and take the scheme default otherwise', () => {
    expect(matches(['localhost:3000'], 'http://localhost:3000/app')).toBe(true)
    expect(matches(['localhost:3000'], 'http://localhost:3001/app')).toBe(false)
    expect(matches(['example.com:443'], 'https://example.com/')).toBe(true)
    expect(matches(['example.com'], 'https://example.com:8443/')).toBe(true)
  })

  it('compare case-insensitively', () => {
    expect(matches(['Example.COM'], 'https://example.com/')).toBe(true)
  })
})

describe('URL prefix entries', () => {
  it('cover a whole origin when no path is given', () => {
    expect(matches(['https://app.example.com'], 'https://app.example.com/any/where')).toBe(true)
    expect(matches(['https://app.example.com'], 'http://app.example.com/')).toBe(false)
  })

  it('cover a path and what sits under it, at a segment boundary', () => {
    expect(matches(['https://app.example.com/admin'], 'https://app.example.com/admin')).toBe(true)
    expect(matches(['https://app.example.com/admin'], 'https://app.example.com/admin/users')).toBe(true)
    expect(matches(['https://app.example.com/admin'], 'https://app.example.com/administrator')).toBe(false)
    expect(matches(['https://app.example.com/admin/'], 'https://app.example.com/admin/users')).toBe(true)
  })
})

describe('entries that cannot be meant', () => {
  it.each(['not a host', 'ftp://files.example.com', 'https://example.com/?q=1', 'example.com/path'])('refuse %s at compile time', pattern => {
    expect(() => compileUrlPatterns([pattern])).toThrow(UrlPatternError)
  })
})

describe('the egress rule under an approved list', () => {
  const evaluate = (patterns: string[], url: string) => {
    const engine = createPermissionEngine([createNetworkEgressRule({ approved: compileUrlPatterns(patterns) })])
    const effect: ResolvedEffect = { kind: 'network', url: new URL(url) }
    return engine.evaluate({ tool: 'web_fetch', effects: [effect], grants: { subjectsFor: () => [] } })
  }

  it('denies a public URL that is not listed, naming the list', () => {
    const outcome = evaluate(['example.com'], 'https://other.test/')
    expect(outcome.kind).toBe('deny')
    if (outcome.kind !== 'deny') return
    expect(outcome.denial.reason).toContain('approved list')
    expect(outcome.denial.reason).toContain('example.com')
  })

  it('reaches a listed private address without asking, because the owner listed it', () => {
    expect(evaluate(['localhost:3000'], 'http://localhost:3000/').kind).toBe('allow')
  })

  it('still refuses a non-HTTP scheme whatever the list says', () => {
    expect(evaluate(['*'].filter(() => false).concat(['example.com']), 'file:///etc/passwd').kind).toBe('deny')
  })
})
