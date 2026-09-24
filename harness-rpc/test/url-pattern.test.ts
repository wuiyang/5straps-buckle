import { describe, expect, it } from 'vitest'
import type { ResolvedEffect } from '../src/domain/effect.js'
import { createPermissionEngine } from '../src/domain/permission/engine.js'
import { createNetworkEgressRule } from '../src/domain/permission/rules/network-egress-rule.js'
import { coveringGrant } from '../src/domain/permission/rules/network-egress-rule.js'
import { compileHostPattern, compileUrlPatterns, intersectUrlMatchers, matchingHostEntry, UrlPatternError } from '../src/domain/url-pattern.js'

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

describe('host patterns, one grammar for lists, BUCKLE_ALLOWED_HOSTS and grants (BUCKLE-D18)', () => {
  const covers = (pattern: string, url: string) => compileHostPattern(pattern).matches(new URL(url))

  it('cover the apex, one level and many levels below it, and nothing beside it', () => {
    expect(covers('*.example.com', 'https://example.com/')).toBe(true)
    expect(covers('*.example.com', 'https://api.example.com/')).toBe(true)
    expect(covers('*.example.com', 'https://a.b.c.example.com/')).toBe(true)
    expect(covers('*.example.com', 'https://notexample.com/')).toBe(false)
    expect(covers('*.example.com', 'https://example.com.evil.test/')).toBe(false)
  })

  it('match any port unless the pattern names one, and a named one against the scheme default too', () => {
    expect(covers('*.localhost', 'http://app.localhost:5173/')).toBe(true)
    expect(covers('*.localhost', 'http://app.localhost/')).toBe(true)
    expect(covers('*.localhost:3000', 'http://app.localhost:3000/')).toBe(true)
    expect(covers('*.localhost:3000', 'http://app.localhost:3001/')).toBe(false)
    expect(covers('*.example.com:443', 'https://api.example.com/')).toBe(true)
    expect(covers('*.example.com:443', 'http://api.example.com/')).toBe(false)
  })

  it('match http and https alike, and never another scheme', () => {
    expect(covers('*.example.com', 'http://api.example.com/')).toBe(true)
    expect(covers('*.example.com', 'https://api.example.com/')).toBe(true)
    expect(covers('*.example.com', 'ws://api.example.com/')).toBe(false)
    expect(covers('*.example.com', 'ftp://api.example.com/')).toBe(false)
  })

  it('accept an underscore in a label, as the URL parser and the matcher before patterns did', () => {
    expect(covers('my_db', 'http://my_db:5432/')).toBe(true)
    expect(covers('my_db:5432', 'http://my_db:5432/')).toBe(true)
    expect(covers('*.compose_net', 'http://api.compose_net/')).toBe(true)
  })

  it('keep an exact host exact, and read a bare IPv6 literal as its bracketed form', () => {
    expect(covers('example.com', 'https://api.example.com/')).toBe(false)
    expect(covers('::1', 'http://[::1]:8080/')).toBe(true)
    expect(compileHostPattern(' *.Example.com ').pattern).toBe('*.Example.com')
    expect(compileHostPattern('*.example.com').wildcard).toBe(true)
  })

  it.each([
    ['*', /lone \* would match every host/],
    ['*.', /needs a domain after it/],
    ['*.*.com', /whole leftmost label/],
    ['api.*.example.com', /whole leftmost label/],
    ['foo*.example.com', /whole leftmost label/],
    ['https://example.com', /names no scheme/],
    ['*.example.com/admin', /names no path/],
    ['*.127.0.0.1', /covers a domain, not an address/],
    ['*.[::1]', /covers a domain, not an address/],
    ['*.0.0.1', /covers a domain, not an address/],
    ['*.1', /covers a domain, not an address/],
    ['*.254.169.254', /covers a domain, not an address/],
    ['*.internal.0x7f', /covers a domain, not an address/],
    ['example.com:70000', /Not a port/],
  ])('refuse %s with a reason that says what is wrong', (pattern, reason) => {
    expect(() => compileHostPattern(pattern)).toThrow(UrlPatternError)
    expect(() => compileHostPattern(pattern)).toThrow(reason)
  })

  it('refuse the same malformed forms in an approved list', () => {
    expect(() => compileUrlPatterns(['*.*.com'])).toThrow(/whole leftmost label/)
    expect(() => compileUrlPatterns(['example.com', '*.0.0.1'])).toThrow(/covers a domain, not an address/)
  })

  it('name the first entry of a list that covers a URL', () => {
    expect(matchingHostEntry(['other.test', '*.internal.test'], new URL('http://db.internal.test/'))).toBe('*.internal.test')
    expect(matchingHostEntry(['other.test'], new URL('http://db.internal.test/'))).toBeNull()
  })
})

describe('network grants read with the pattern grammar', () => {
  const exact = (subjects: string[]) => ({ exact: subjects, patterns: [] })

  it('prefer an exact grant, then a pattern, and never read an exact grant as a pattern', () => {
    expect(coveringGrant({ exact: ['app.localhost:3000'], patterns: ['*.localhost'] }, new URL('http://app.localhost:3000/'))).toBe('app.localhost:3000')
    expect(coveringGrant({ exact: [], patterns: ['*.localhost'] }, new URL('http://deep.app.localhost:3000/'))).toBe('*.localhost')
    expect(coveringGrant(exact(['localhost']), new URL('http://localhost:5432/'))).toBeNull()
    expect(coveringGrant(exact(['localhost:3000']), new URL('http://localhost:3000/'))).toBe('localhost:3000')
    expect(coveringGrant({ exact: [], patterns: ['*.localhost:3000'] }, new URL('http://app.localhost:3001/'))).toBeNull()
  })

  it('let no pattern grant over an address suffix cover an address', () => {
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/']) {
      expect(coveringGrant({ exact: [], patterns: ['*.0.0.1', '*.1', '*.254.169.254'] }, new URL(url))).toBeNull()
    }
  })

  it('read a grant spelled like a pattern but not recorded as one as its literal string alone', () => {
    for (const url of ['http://app.localhost:3000/', 'http://localhost:3000/', 'http://x.y.localhost:3000/']) {
      expect(coveringGrant(exact(['*.localhost:3000']), new URL(url))).toBeNull()
    }
  })

  const judge = (approved: ReturnType<typeof compileUrlPatterns> | null, patterns: string[], url: string) => {
    const engine = createPermissionEngine([createNetworkEgressRule({ approved })])
    return engine.evaluate({ tool: 'web_fetch', effects: [{ kind: 'network', url: new URL(url) }], grants: { subjectsFor: () => [], patternsFor: () => patterns } })
  }

  it('refuse a URL whose host holds a *, before any question is asked or grant read', () => {
    for (const url of ['http://*.localhost:3000/', 'http://%2a.localhost:3000/', 'https://*.example.com/']) {
      const outcome = judge(null, ['*.localhost'], url)
      expect(outcome).toMatchObject({ kind: 'deny', denial: { rule: 'network_egress', reason: expect.stringContaining('A host cannot contain *') } })
    }
    expect(judge(compileUrlPatterns(['*.localhost']), [], 'http://*.localhost/').kind).toBe('deny')
    expect(compileHostPattern('*.localhost').matches(new URL('http://*.localhost/'))).toBe(false)
  })

  it('let a pattern grant answer the question a private host asks, naming the pattern', () => {
    expect(judge(null, ['*.localhost'], 'http://app.localhost:3000/')).toEqual({ kind: 'allow', allowedBy: ['network_egress:*.localhost'] })
    expect(judge(null, ['*.localhost'], 'http://127.0.0.1:3000/').kind).toBe('ask')
  })

  it('never get a pattern grant past an approved list, the workspace\'s own or the node\'s limit over it', () => {
    expect(judge(compileUrlPatterns(['example.com']), ['*.localhost'], 'http://app.localhost:3000/').kind).toBe('deny')
    const nodeLimit = intersectUrlMatchers(compileUrlPatterns(['example.com']), null)
    expect(judge(nodeLimit, ['*.localhost'], 'http://app.localhost:3000/').kind).toBe('deny')
  })
})
