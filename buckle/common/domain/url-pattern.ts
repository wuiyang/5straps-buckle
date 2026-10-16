import { isIP, isIPv6 } from 'node:net'

/**
 * The owner's approved list, compiled once. Two forms are accepted:
 *
 * - a host: `example.com`, `example.com:8443`, `*.example.com` (the apex and every subdomain),
 *   `localhost:3000`, `127.0.0.1`
 * - an http(s) URL prefix: `https://app.example.com` (that origin) or
 *   `https://app.example.com/admin` (that origin, that path and what is under it)
 *
 * Anything else is rejected at compile time, so a typo cannot silently approve nothing.
 *
 * The host form is the one grammar for every host Buckle is told about, per `BUCKLE-D18: A host
 * wildcard covers the apex and every subdomain, in lists and grants alike`: an approved list's
 * host entries, `BUCKLE_ALLOWED_HOSTS`, and an approval widened to a pattern all compile through
 * `compileHostPattern`. There is no public-suffix list: `*.com` is a pattern like any other.
 */
export interface UrlMatcher {
  readonly patterns: string[]
  matches(url: URL): boolean
  /**
   * Whether an entry naming the URL's host exactly (a host entry with no wildcard, or a URL prefix) covers it: such an
   * entry clears a private address, as the owner named that host, where a wildcard never does (Phase 2 item 5).
   */
  namesExactly(url: URL): boolean
}

export class UrlPatternError extends Error {}

type Compiled = (url: URL) => boolean

// A label may hold `_`, as the URL parser allows and compose service names use (`my_db`).
const HOST_PATTERN = /^(\*\.)?([a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i

export function compileUrlPatterns(patterns: string[]): UrlMatcher {
  const compiled = patterns.map(compileOne)
  return {
    patterns,
    matches: url => compiled.some(entry => entry.test(url)),
    namesExactly: url => compiled.some(entry => entry.exact && entry.test(url)),
  }
}

function compileOne(pattern: string): { test: Compiled; exact: boolean } {
  const trimmed = pattern.trim()
  if (/^https?:\/\//i.test(trimmed)) return { test: compilePrefix(trimmed), exact: true }
  const host = compileHostPattern(trimmed)
  return { test: host.matches, exact: !host.wildcard }
}

/** One host entry, compiled: `example.com`, `example.com:8443`, `*.example.com`, `[::1]:3000`. */
export interface HostPattern {
  /** As entered, trimmed. */
  readonly pattern: string
  readonly wildcard: boolean
  /** Lowercased, an IPv6 literal without its brackets. */
  readonly host: string
  /** Null when the pattern names no port, which then matches any. */
  readonly port: string | null
  matches(url: URL): boolean
}

/**
 * A host with an optional port, or `*.` and a domain for the apex and every subdomain at any
 * depth. A port is matched only when written, against the scheme default when the URL has none,
 * and only an http or https URL ever matches. A bare IPv6 literal is read as its bracketed form.
 */
export function compileHostPattern(pattern: string): HostPattern {
  const trimmed = pattern.trim()
  const entry = isIPv6(trimmed) ? `[${trimmed}]` : trimmed
  const match = HOST_PATTERN.exec(entry)
  if (!match) throw new UrlPatternError(describeMalformed(trimmed))
  const [, wildcard, host, port] = match
  if (wildcard && coversAnAddress(host ?? '')) throw new UrlPatternError(`A wildcard covers a domain, not an address: ${pattern}`)
  // A port is compared as the URL parser writes it, so `0443` would silently match nothing.
  if (port !== undefined && (!/^[1-9]\d*$/.test(port) || Number(port) > 65_535)) throw new UrlPatternError(`Not a port: ${port} in ${pattern}. Write 1 to 65535 without leading zeros`)
  const bare = (host ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return {
    pattern: trimmed,
    wildcard: Boolean(wildcard),
    host: bare,
    port: port ?? null,
    matches: url => {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      if (starredHostRefusal(url)) return false
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      // A wildcard names domains; an address never falls under one, whatever its digits end in.
      if (wildcard && isIP(hostname)) return false
      const hostMatches = wildcard ? hostname === bare || hostname.endsWith(`.${bare}`) : hostname === bare
      if (!hostMatches) return false
      return port === undefined || effectivePort(url) === port
    },
  }
}

/**
 * The URL parser keeps a `*` in a host (`http://*.localhost/`), so an agent could ask for one by
 * name and have it recorded, spelled like a pattern. No real host has one, so it is refused
 * wherever a URL becomes a network subject, before any list is read or question asked.
 */
export function starredHostRefusal(url: URL): string | null {
  return url.hostname.includes('*') ? `A host cannot contain *: ${url.hostname}. A host pattern is the owner's to grant, with buckle approve --host` : null
}

/**
 * The first entry of a host list, `BUCKLE_ALLOWED_HOSTS` or a set of grant subjects, that covers
 * the URL. An entry that does not compile covers nothing here; each is checked where it is
 * entered or loaded, so one that reaches this far was written around that check.
 */
export function matchingHostEntry(entries: string[], url: URL): string | null {
  return entries.find(entry => {
    try {
      return compileHostPattern(entry).matches(url)
    } catch {
      return false
    }
  }) ?? null
}

/**
 * A wildcard suffix that could only ever end an address: a bracketed IPv6 literal, or one whose
 * last label is a number, which the URL parser reads as IPv4 (`*.0.0.1`, `*.1`, `*.254.169.254`).
 */
function coversAnAddress(suffix: string): boolean {
  if (suffix.startsWith('[')) return true
  const last = suffix.split('.').at(-1) ?? ''
  return /^(\d+|0x[0-9a-f]*)$/i.test(last)
}

/** Says what is wrong with a host entry, so the owner can fix it where it was typed. */
function describeMalformed(pattern: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) return `A host pattern names no scheme: ${pattern}. Write the host alone, as in *.example.com`
  if (pattern.includes('/')) return `A host pattern names no path: ${pattern}. Write the host alone, as in *.example.com`
  if (pattern === '*') return 'A lone * would match every host. Name a domain, as in *.example.com'
  if (pattern === '*.') return 'A wildcard needs a domain after it, as in *.example.com'
  if (pattern.includes('*')) return `A wildcard stands only as the whole leftmost label, as in *.example.com: ${pattern}`
  return `Not a host or an http(s) URL prefix: ${pattern}`
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

/** The port a URL reaches: the one written, or its scheme default. */
export function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' ? '443' : '80'
}
