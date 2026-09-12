/**
 * The owner's approved list, compiled once. Two forms are accepted:
 *
 * - a host: `example.com`, `example.com:8443`, `*.example.com` (the apex and every subdomain),
 *   `localhost:3000`, `127.0.0.1`
 * - an http(s) URL prefix: `https://app.example.com` (that origin) or
 *   `https://app.example.com/admin` (that origin, that path and what is under it)
 *
 * Anything else is rejected at compile time, so a typo cannot silently approve nothing.
 */
export interface UrlMatcher {
  readonly patterns: string[]
  matches(url: URL): boolean
}

export class UrlPatternError extends Error {}

type Compiled = (url: URL) => boolean

const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i

export function compileUrlPatterns(patterns: string[]): UrlMatcher {
  const compiled = patterns.map(compileOne)
  return {
    patterns,
    matches: url => compiled.some(test => test(url)),
  }
}

function compileOne(pattern: string): Compiled {
  const trimmed = pattern.trim()
  if (/^https?:\/\//i.test(trimmed)) return compilePrefix(trimmed)

  const match = HOST_PATTERN.exec(trimmed)
  if (!match) throw new UrlPatternError(`Not a host or an http(s) URL prefix: ${pattern}`)
  const [, wildcard, host, port] = match
  const bare = (host ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return url => {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const hostMatches = wildcard ? hostname === bare || hostname.endsWith(`.${bare}`) : hostname === bare
    if (!hostMatches) return false
    return port === undefined || effectivePort(url) === port
  }
}

function compilePrefix(prefix: string): Compiled {
  let parsed: URL
  try {
    parsed = new URL(prefix)
  } catch {
    throw new UrlPatternError(`Not a valid URL prefix: ${prefix}`)
  }
  if (parsed.search || parsed.hash) throw new UrlPatternError(`A URL prefix cannot carry a query or fragment: ${prefix}`)

  const origin = parsed.origin
  const path = parsed.pathname
  const originOnly = path === '/' && !prefix.endsWith('/')
  return url => {
    if (url.origin !== origin) return false
    if (originOnly || path === '/') return true
    if (url.pathname === path) return true
    return url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`)
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/** A request must satisfy every configured boundary, including on each redirect hop. */
export function intersectUrlMatchers(...matchers: Array<UrlMatcher | null | undefined>): UrlMatcher | null {
  const configured = matchers.filter((matcher): matcher is UrlMatcher => matcher != null)
  if (configured.length === 0) return null
  if (configured.length === 1) return configured[0]!
  return {
    patterns: [configured.map(matcher => `(${matcher.patterns.join(' OR ')})`).join(' AND ')],
    matches: url => configured.every(matcher => matcher.matches(url)),
  }
}
