import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import type { Pack } from '../../domain/pack.js'
import { defineTool, ToolExecutionError } from '../../domain/tool.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import { loadPackSkill } from '../pack-skill.js'
import { guardedFetch } from './egress.js'

const PACK_ID = 'web'
const MAX_RESPONSE_BYTES = 2 * 1_048_576

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
  /** Hosts an operator pre-approved, so a private address can be reached on purpose. */
  allowedHosts: string[]
  /** The owner's approved list. When set, every hop of every fetch must be on it. */
  approved: UrlMatcher | null
}

export function createWebPack(options: WebPackOptions): Pack {
  const tools = [
    defineTool(PACK_ID, {
      name: 'web_fetch',
      description: 'Fetch an HTTP or HTTPS URL. Redirects are followed one hop at a time and re-checked.',
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
          allowedHosts: options.allowedHosts,
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

async function readBounded(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false

  while (size < MAX_RESPONSE_BYTES) {
    const next = await reader.read()
    if (next.done) break
    const slice = next.value.subarray(0, MAX_RESPONSE_BYTES - size)
    if (slice.byteLength < next.value.byteLength) truncated = true
    chunks.push(Buffer.from(slice))
    size += slice.byteLength
  }
  await reader.cancel().catch(() => undefined)

  return { body: Buffer.concat(chunks).toString('utf8'), truncated }
}
