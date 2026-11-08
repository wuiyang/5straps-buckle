import { lookup } from 'node:dns/promises'
import { portOf, rangeCovering, reachesListener, reservedRangeOf, type AddressRange, type NodeListener } from '../../../domain/ip.js'
import { ToolExecutionError, type NetworkVerdict } from '../../../domain/tool.js'
import { starredHostRefusal, type UrlMatcher } from '../../../domain/url-pattern.js'

const MAX_REDIRECTS = 5
/** Headers that describe a request body, removed with it. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']
/** Headers that carry the caller's credentials, removed on a hop to another origin as browsers and Node's fetch do. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/**
 * Fetch with the redirect chain walked by hand, resolving and re-checking every hop. A
 * hostname that passed the permission rule can still resolve into a reserved range, and a
 * public URL can redirect into one. Each hop follows the fetch standard: a 303 answer to anything
 * but GET or HEAD, and a 301 or 302 answer to POST, becomes GET without the body; 307 and 308
 * repeat the method and body; a hop to another origin drops the credential headers.
 */
export async function guardedFetch(input: {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
  /**
   * The workspace's URL list (Phase 2 item 5). When set, every hop must be on it, and a private address is reached
   * only through an entry naming its host exactly: a host a wildcard covers is still refused where it resolves into a
   * private range.
   */
  approved: UrlMatcher | null
  /** The permission rules on each hop, so a host the owner approved is reached like a listed one. */
  judge?: (url: URL) => Promise<NetworkVerdict>
  /** Headers whose values Buckle filled from secret references (docs/user/how-to/secrets.md): dropped on a hop to another origin too. */
  secretHeaders?: readonly string[]
  /** The owner's CIDR ranges (network.privateRanges): a reserved address one holds is reached on any hop the rules let through. */
  privateRanges: readonly AddressRange[]
  /** The node's own serve listener, which no range clears on any hop. */
  listener?: NodeListener
}): Promise<Response> {
  let current = input.url
  let method = input.method
  let body = input.body
  const headers = new Headers(input.headers)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertReachable({ url: current, approved: input.approved, judge: input.judge, privateRanges: input.privateRanges, listener: input.listener })
    const response = await fetch(current, { method, headers, body, redirect: 'manual', signal: input.signal })

    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) return response
    await response.body?.cancel().catch(() => undefined)

    const next = new URL(location, current)
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new ToolExecutionError(`Redirect to a non-HTTP scheme: ${next.protocol}`, { code: 'EGRESS_BLOCKED' })
    }

    if (dropsBody(response.status, method)) {
      method = 'GET'
      body = undefined
      for (const name of BODY_HEADERS) headers.delete(name)
    }
    if (next.origin !== current.origin) {
      for (const name of [...CREDENTIAL_HEADERS, ...input.secretHeaders ?? []]) headers.delete(name)
    }
    current = next
  }

  throw new ToolExecutionError(`Exceeded ${MAX_REDIRECTS} redirects`, { code: 'TOO_MANY_REDIRECTS' })
}

async function assertReachable(input: { url: URL; approved: UrlMatcher | null; judge?: ((url: URL) => Promise<NetworkVerdict>) | undefined; privateRanges: readonly AddressRange[]; listener: NodeListener | undefined }): Promise<void> {
  const { url, approved, judge } = input
  const starred = starredHostRefusal(url)
  if (starred) throw new ToolExecutionError(starred, { code: 'EGRESS_BLOCKED' })
  if (approved) {
    if (!approved.matches(url)) throw new ToolExecutionError(`${url.origin} is not on the workspace's approved list`, { code: 'EGRESS_BLOCKED' })
    // An entry naming the host clears a private address; one a wildcard covers is checked where it resolves.
    if (approved.namesExactly(url)) return
  } else {
    // Awaited: a dangerously-allowed hop is audited before it is made, and an audit that fails refuses it.
    const verdict = await judge?.(url)
    if (verdict?.kind === 'granted') return
    if (verdict?.kind === 'refused') throw new ToolExecutionError(verdict.reason, { code: 'EGRESS_BLOCKED' })
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  const { listener } = input
  const cleared = (address: string) => rangeCovering(address, input.privateRanges) !== null && !(listener && reachesListener({ address, port: portOf(url), listener }))
  const reserved = (address: string) => (cleared(address) ? null : reservedRangeOf(address))
  const literal = reserved(host)
  if (literal) throw blocked(host, literal)

  for (const address of await resolveAll(host)) {
    const range = reserved(address)
    if (range) throw blocked(`${host} (${address})`, range)
  }
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const results = await lookup(host, { all: true })
    return results.map(result => result.address)
  } catch {
    // Resolution failure is left to fetch, which reports a clearer network error.
    return []
  }
}

function blocked(host: string, range: string): ToolExecutionError {
  return new ToolExecutionError(`${host} is in the ${range} range`, { code: 'EGRESS_BLOCKED' })
}

function dropsBody(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD'
  return (status === 301 || status === 302) && method === 'POST'
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
