import { lookup } from 'node:dns/promises'
import { reservedRangeOf } from '../../domain/ip.js'
import { ToolExecutionError } from '../../domain/tool.js'

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
  allowedHosts: string[]
}): Promise<Response> {
  let current = input.url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current, input.allowedHosts)
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

async function assertPublicHost(url: URL, allowedHosts: string[]): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const subject = url.port ? `${host}:${url.port}` : host
  if (allowedHosts.includes(subject) || allowedHosts.includes(host)) return

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
