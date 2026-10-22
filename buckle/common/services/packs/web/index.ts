import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import type { Pack } from '../../../domain/pack.js'
import { defineTool, ToolExecutionError } from '../../../domain/tool.js'
import type { UrlMatcher } from '../../../domain/url-pattern.js'
import { loadPackSkill } from '../pack-skill.js'
import { guardedFetch } from './egress.js'

const PACK_ID = 'web'
const MAX_RESPONSE_BYTES = 2 * 1_048_576
/** Reads, and time, spent at the cap on learning whether the stream ends there. */
const CAP_PROBE_READS = 8
const CAP_PROBE_MS = 1_000

const fetchInput = z.object({
  url: z.url(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().max(1_048_576).optional(),
})

const searchInput = z.object({
  query: z.string().min(1).max(1_000),
  count: z.number().int().min(1).max(20).default(10),
})

const braveSchema = z.object({
  web: z.object({
    results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().default('') })),
  }).optional(),
})

export interface WebPackOptions {
  braveSearchApiKey?: string
  /** The workspace's URL list (Phase 2 item 5). When set, every hop of every fetch must be on it. */
  approved: UrlMatcher | null
}

export function createWebPack(options: WebPackOptions): Pack {
  const tools = [
    defineTool(PACK_ID, {
      name: 'web_fetch',
      description: 'Fetch an HTTP or HTTPS URL. Redirects are followed one hop at a time and re-checked, with a browser\'s rules: a 303 answer (or a 301 or 302 answer to a POST) is followed with GET and no body, and another origin gets no authorization or cookie.',
      risk: 'network',
      tags: ['web', 'network'],
      input: fetchInput,
      effects: input => [{ kind: 'network', url: input.url }],
      run: async (input, context): Promise<JsonValue> => {
        const response = await guardedFetch({
          url: new URL(input.url),
          method: input.method,
          headers: input.headers,
          body: input.body,
          signal: context.signal,
          approved: options.approved,
          judge: context.judgeNetwork,
        })
        const { body, truncated } = await readBounded(response)
        return {
          url: response.url || input.url,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          truncated,
        }
      },
    }),
  ]

  if (options.braveSearchApiKey) {
    const apiKey = options.braveSearchApiKey
    tools.push(defineTool(PACK_ID, {
      name: 'web_search',
      description: 'Search the web through the configured Brave Search account.',
      risk: 'network',
      tags: ['web', 'search', 'network'],
      input: searchInput,
      effects: () => [{ kind: 'network', url: 'https://api.search.brave.com' }],
      run: async (input, context): Promise<JsonValue> => {
        const url = new URL('https://api.search.brave.com/res/v1/web/search')
        url.searchParams.set('q', input.query)
        url.searchParams.set('count', String(input.count))
        const response = await fetch(url, {
          redirect: 'error',
          headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
          signal: context.signal,
        })
        if (!response.ok) {
          throw new ToolExecutionError(`Brave Search returned HTTP ${response.status}`, {
            code: 'SEARCH_UPSTREAM_ERROR',
            retryable: response.status >= 500,
          })
        }
        const parsed = braveSchema.safeParse(await response.json())
        if (!parsed.success) throw new ToolExecutionError('Brave Search returned an unexpected response', { code: 'SEARCH_UPSTREAM_ERROR' })
        return {
          query: input.query,
          results: parsed.data.web?.results.map(result => ({
            title: result.title,
            url: result.url,
            description: result.description,
          })) ?? [],
        }
      },
    }))
  }

  return { id: PACK_ID, version: '1.0.0', tools, skills: [loadPackSkill(PACK_ID)], unavailableReason: null }
}

/**
 * Reads at most MAX_RESPONSE_BYTES and says whether the response held more. A body that ends exactly at the cap is
 * complete, so at the cap the stream is read on until it ends, or a non-empty chunk shows more.
 */
async function readBounded(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let ended = false
  let truncated = declaredLength(response) > MAX_RESPONSE_BYTES

  while (size < MAX_RESPONSE_BYTES) {
    const next = await reader.read()
    if (next.done) {
      ended = true
      break
    }
    const slice = next.value.subarray(0, MAX_RESPONSE_BYTES - size)
    if (slice.byteLength < next.value.byteLength) truncated = true
    chunks.push(Buffer.from(slice))
    size += slice.byteLength
  }
  if (!ended && !truncated) truncated = await moreFollows(reader)
  await reader.cancel().catch(() => undefined)

  return { body: Buffer.concat(chunks).toString('utf8'), truncated }
}

/**
 * The content-length header as a number, or 0 where it is absent, not a plain count, or the body is content-coded: fetch
 * decodes the body but keeps the coded length, which the cap, counting decoded bytes, cannot be compared with.
 */
function declaredLength(response: Response): number {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding !== undefined && encoding !== '' && encoding !== 'identity') return 0
  const value = response.headers.get('content-length')
  return value !== null && /^\d+$/.test(value) ? Number(value) : 0
}

/**
 * Whether a stream read to the cap holds more: true at the first non-empty chunk, false where it ends. A stream that
 * neither ends nor sends data within a few reads or CAP_PROBE_MS, or fails on a read, is not shown complete, so it
 * counts as more and the cap already read is kept.
 */
async function moreFollows(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<'expired'>(resolve => { timer = setTimeout(resolve, CAP_PROBE_MS, 'expired') })
  try {
    for (let reads = 0; reads < CAP_PROBE_READS; reads += 1) {
      const next = await Promise.race([reader.read(), expired])
      if (next === 'expired') return true
      if (next.done) return false
      if (next.value.byteLength > 0) return true
    }
    return true
  } catch {
    return true
  } finally {
    clearTimeout(timer)
  }
}
