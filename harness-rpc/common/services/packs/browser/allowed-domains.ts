import { isIPv6 } from 'node:net'
import { compileHostPattern, effectivePort } from '../../../domain/url-pattern.js'

/**
 * agent-browser's `--allowed-domains` value, or why the browser is not started, as
 * `BUCKLE-D21: Browser navigations are held to the approved hosts at the browser now, and by a
 * Buckle proxy later` rules.
 *
 * agent-browser matches a request's hostname alone: `example.com` and an address as the literal
 * hostname, `*.example.com` as the apex and every subdomain (`BUCKLE-D18` read the same way). So
 * the lists are intersected with their ports still on, and only then does each survivor pass as
 * its host. Inside the page a passed host is reachable on any port and path; the page a command
 * names is still judged by Buckle's own rule, port and path included.
 */
export type BrowserAllowedDomains = { value: string | null; loosened: LoosenedEntry[] } | { refusal: string }

/** One approved list, named so a refusal tells the owner which one to change. */
export interface ApprovedList {
  name: 'node' | 'workspace'
  entries: string[]
}

/** An entry whose port or path the browser does not hold, and the host passed for it. */
export interface LoosenedEntry {
  entry: string
  list: ApprovedList['name']
  host: string
}

interface Source {
  entry: string
  list: ApprovedList['name']
  /** It names a port, or is a URL prefix with a scheme and path. */
  precise: boolean
}

/** What an entry allows before the port is dropped. A null port covers every port. */
interface Scope {
  host: string
  wildcard: boolean
  port: string | null
  sources: Source[]
}

const URL_PREFIX = /^https?:\/\//i
const EMPTY_FLAG = 'an empty --allowed-domains would allow every host'

/**
 * One list per configured approved list, the node's ceiling first. No list passes no flag: the
 * egress rule then allows every public host, which agent-browser cannot express. Grants are never
 * passed, because they only answer questions the rule asks with no list, and a list decides
 * without them.
 */
export function browserAllowedDomains(lists: ApprovedList[]): BrowserAllowedDomains {
  if (lists.length === 0) return { value: null, loosened: [] }
  const empty = lists.find(list => list.entries.length === 0)
  if (empty) return { refusal: `Buckle does not start the browser: the ${empty.name} approved list has no usable entry, and ${EMPTY_FLAG}. The owner can add the hosts the browser needs to the ${empty.name} approved list` }

  let allowed = scopesOf(lists[0]!)
  for (let index = 1; index < lists.length; index++) {
    const list = lists[index]!
    allowed = intersectScopes(allowed, scopesOf(list))
    if (allowed.length === 0) return { refusal: disjointRefusal(list, lists.slice(0, index)) }
  }
  return { value: [...new Set(allowed.map(spell))].join(','), loosened: loosenedEntries(allowed) }
}

function disjointRefusal(list: ApprovedList, bounds: ApprovedList[]): string {
  const bound = bounds.map(item => `the ${item.name} approved list (${item.entries.join(', ')})`).join(' and ')
  return `Buckle does not start the browser: no entry in the ${list.name} approved list (${list.entries.join(', ')}) is allowed by ${bound} on the same host and port, and ${EMPTY_FLAG}. The owner can add to the ${list.name} approved list a host and port that ${bound} allows`
}

function scopesOf(list: ApprovedList): Scope[] {
  return list.entries.map(entry => toScope(entry.trim(), list.name))
}

function toScope(entry: string, list: ApprovedList['name']): Scope {
  if (URL_PREFIX.test(entry)) {
    const url = new URL(entry)
    return { host: url.hostname.replace(/^\[|\]$/g, ''), wildcard: false, port: effectivePort(url), sources: [{ entry, list, precise: true }] }
  }
  const pattern = compileHostPattern(entry)
  return { host: pattern.host, wildcard: pattern.wildcard, port: pattern.port, sources: [{ entry, list, precise: pattern.port !== null }] }
}

/** Both lists must allow a host and port, so each pair keeps the narrower host on the port both allow. */
function intersectScopes(left: Scope[], right: Scope[]): Scope[] {
  return left.flatMap(a => right.flatMap(b => {
    if (a.port !== null && b.port !== null && a.port !== b.port) return []
    const narrower = covers(b, a) ? a : covers(a, b) ? b : null
    return narrower ? [{ ...narrower, port: a.port ?? b.port, sources: [...a.sources, ...b.sources] }] : []
  }))
}

function covers(outer: Scope, inner: Scope): boolean {
  if (!outer.wildcard) return !inner.wildcard && inner.host === outer.host
  return inner.host === outer.host || inner.host.endsWith(`.${outer.host}`)
}

/** An IPv6 literal is written as the page's `URL.hostname` reads it, which agent-browser compares. */
function spell(scope: Scope): string {
  if (scope.wildcard) return `*.${scope.host}`
  return isIPv6(scope.host) ? `[${scope.host}]` : scope.host
}

function loosenedEntries(allowed: Scope[]): LoosenedEntry[] {
  const loosened = allowed.flatMap(scope => scope.sources.filter(source => source.precise).map(source => ({ entry: source.entry, list: source.list, host: spell(scope) })))
  return loosened.filter((item, index) => loosened.findIndex(other => other.entry === item.entry && other.list === item.list && other.host === item.host) === index)
}
