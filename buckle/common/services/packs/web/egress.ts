import { lookup } from 'node:dns/promises'
import { reservedRangeOf } from '../../../domain/ip.js'
import { ToolExecutionError, type NetworkVerdict } from '../../../domain/tool.js'
import { starredHostRefusal, type UrlMatcher } from '../../../domain/url-pattern.js'

const MAX_REDIRECTS = 5

/**
 * Fetch with the redirect chain walked by hand, resolving and re-checking every hop. A
 * hostname that passed the permission rule can still resolve into a reserved range, and a
 * public URL can redirect into one.
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
}): Promise<Response> {
  let current = input.url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertReachable(current, input.approved, input.judge)
    const response = await fetch(current, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: 'manual',
      signal: input.signal,
    })

    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) return response

    current = new URL(location, current)
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new ToolExecutionError(`Redirect to a non-HTTP scheme: ${current.protocol}`, { code: 'EGRESS_BLOCKED' })
    }
  }

  throw new ToolExecutionError(`Exceeded ${MAX_REDIRECTS} redirects`, { code: 'TOO_MANY_REDIRECTS' })
}

async function assertReachable(url: URL, approved: UrlMatcher | null, judge?: (url: URL) => Promise<NetworkVerdict>): Promise<void> {
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
  const literal = reservedRangeOf(host)
  if (literal) throw blocked(host, literal)

  for (const address of await resolveAll(host)) {
    const range = reservedRangeOf(address)
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

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
