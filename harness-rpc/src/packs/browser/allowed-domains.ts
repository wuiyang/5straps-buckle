import { isIP } from 'node:net'
import { compileHostPattern } from '../../domain/url-pattern.js'

/**
 * agent-browser's `--allowed-domains` value, or why the browser is not started.
 *
 * agent-browser matches a request's hostname alone: `example.com` exactly, and `*.example.com`
 * as the apex and every subdomain, which is `BUCKLE-D18` read the same way. It cannot say a
 * port, a scheme or a path, so an entry that needs one is refused by name rather than passed
 * wider or narrower than the owner wrote it.
 */
export type BrowserAllowedDomains = { value: string | null } | { refusal: string }

interface Domain {
  host: string
  wildcard: boolean
}

const NOTHING_APPROVED = 'Buckle does not start the browser: the approved list covers no host agent-browser can be limited to, and an empty --allowed-domains would allow every host'

/**
 * One list per configured approved list (the node's ceiling and the workspace's own). No list
 * passes no flag: the egress rule then allows every public host, which agent-browser cannot
 * express. Grants are never passed, because they only answer questions the rule asks with no
 * list, and a list decides without them.
 */
export function browserAllowedDomains(lists: string[][]): BrowserAllowedDomains {
  if (lists.length === 0) return { value: null }
  const refusal = lists.flat().map(entryRefusal).find(reason => reason !== null)
  if (refusal) return { refusal }
  const allowed = lists.map(list => list.map(toDomain)).reduce(intersectDomains)
  if (allowed.length === 0) return { refusal: NOTHING_APPROVED }
  return { value: [...new Set(allowed.map(spell))].join(',') }
}

function entryRefusal(entry: string): string | null {
  const refused = (why: string) => `Buckle does not start the browser: approved list entry ${entry} ${why}, which agent-browser --allowed-domains cannot express`
  if (/^https?:\/\//i.test(entry.trim())) return refused('is a URL prefix with a scheme and path')
  const pattern = compileHostPattern(entry)
  if (pattern.port !== null) return refused(`names port ${pattern.port}`)
  if (isIP(pattern.host)) return refused('is an address')
  return null
}

function toDomain(entry: string): Domain {
  const pattern = compileHostPattern(entry)
  return { host: pattern.host, wildcard: pattern.wildcard }
}

/** Both lists must allow a host, so each pair keeps the narrower of two nested patterns. */
function intersectDomains(left: Domain[], right: Domain[]): Domain[] {
  return left.flatMap(a => right.flatMap(b => covers(b, a) ? [a] : covers(a, b) ? [b] : []))
}

function covers(outer: Domain, inner: Domain): boolean {
  if (!outer.wildcard) return !inner.wildcard && inner.host === outer.host
  return inner.host === outer.host || inner.host.endsWith(`.${outer.host}`)
}

function spell(domain: Domain): string {
  return domain.wildcard ? `*.${domain.host}` : domain.host
}
