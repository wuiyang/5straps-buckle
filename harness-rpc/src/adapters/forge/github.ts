import { z } from 'zod'
import { logger } from '../../logger.js'
import type { ForgeClient, ForgePullRequest, ForgeRepository, ForgeRequest } from '../../domain/forge.js'
import { stripSecret } from '../../domain/redact.js'
import { ToolExecutionError } from '../../domain/tool.js'
import { BUCKLE_VERSION } from '../../version.js'

const API_VERSION = '2022-11-28'
const JSON_MEDIA_TYPE = 'application/vnd.github+json'
const DIFF_MEDIA_TYPE = 'application/vnd.github.v3.diff'
const PAGE_SIZE = 100

const refSchema = z.object({ ref: z.string(), sha: z.string() })
const pullRequestSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
  state: z.string(),
  title: z.string(),
  head: refSchema,
  base: refSchema,
})
const filesSchema = z.array(z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
}))
const commentsSchema = z.array(z.object({
  user: z.object({ login: z.string() }).nullish(),
  created_at: z.string(),
  body: z.string(),
}))

export interface GitHubForgeOptions {
  token: string
  /** The API origin, so a test server or an Enterprise install takes the same code path. */
  apiUrl: string
}

export function createGitHubForgeClient(options: GitHubForgeOptions): ForgeClient {
  const apiUrl = ensureTrailingSlash(new URL(options.apiUrl))

  const call = async (input: {
    path: string
    method: 'GET' | 'POST'
    accept: string
    body?: unknown
    signal: AbortSignal
  }): Promise<Response> => {
    const response = await fetch(new URL(input.path, apiUrl), {
      method: input.method,
      redirect: 'error',
      signal: input.signal,
      headers: {
        Accept: input.accept,
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': `buckle/${BUCKLE_VERSION}`,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
    if (!response.ok) throw await upstreamError({ response, token: options.token, path: input.path })
    return response
  }

  /** Upstream JSON is untrusted: it is parsed against a schema rather than cast into shape. */
  const readJson = async <T>(input: { schema: z.ZodType<T>; path: string; method?: 'GET' | 'POST'; body?: unknown; signal: AbortSignal }): Promise<T> => {
    const response = await call({ path: input.path, method: input.method ?? 'GET', accept: JSON_MEDIA_TYPE, body: input.body, signal: input.signal })
    const parsed = input.schema.safeParse(await response.json())
    if (!parsed.success) throw new ToolExecutionError(`The forge returned an unexpected response for ${input.path}`, { code: 'FORGE_UPSTREAM_ERROR' })
    return parsed.data
  }

  return {
    async openPullRequest(input) {
      return toPullRequest(await readJson({
        schema: pullRequestSchema,
        path: pullsPath(input.repository),
        method: 'POST',
        body: { title: input.title, head: input.head, base: input.base, body: input.body },
        signal: input.signal,
      }))
    },

    async readPullRequest(input) {
      return toPullRequest(await readJson({ schema: pullRequestSchema, path: pullPath(input), signal: input.signal }))
    },

    async readPullRequestDiff(input) {
      const response = await call({ path: pullPath(input), method: 'GET', accept: DIFF_MEDIA_TYPE, signal: input.signal })
      const bytes = Buffer.from(await response.text(), 'utf8')
      if (bytes.byteLength <= input.maxBytes) return { diff: bytes.toString('utf8'), truncated: false }
      return { diff: bytes.subarray(0, input.maxBytes).toString('utf8'), truncated: true }
    },

    async readPullRequestFiles(input) {
      const files = await readJson({ schema: filesSchema, path: `${pullPath(input)}/files?per_page=${PAGE_SIZE}`, signal: input.signal })
      return files.map(file => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions }))
    },

    async readPullRequestComments(input) {
      const comments = await readJson({
        schema: commentsSchema,
        path: `repos/${input.repository.owner}/${input.repository.name}/issues/${input.number}/comments?per_page=${PAGE_SIZE}`,
        signal: input.signal,
      })
      return comments.map(comment => ({ author: comment.user?.login ?? 'unknown', at: comment.created_at, body: comment.body }))
    },
  }
}

function pullsPath(repository: ForgeRepository): string {
  return `repos/${repository.owner}/${repository.name}/pulls`
}

function pullPath(input: ForgeRequest): string {
  return `${pullsPath(input.repository)}/${input.number}`
}

function ensureTrailingSlash(url: URL): URL {
  return url.pathname.endsWith('/') ? url : new URL(`${url.pathname}/`, url)
}

/**
 * The upstream body explains a refusal far better than the status alone, and it is written by
 * the forge rather than by Buckle, so the credential is stripped from it before it goes anywhere.
 */
async function upstreamError(input: { response: Response; token: string; path: string }): Promise<ToolExecutionError> {
  const body = await input.response.text().catch(() => '')
  const detail = stripSecret(body.trim().slice(0, 1_000), input.token)
  logger.error('The forge refused a request', { status: input.response.status, path: input.path })
  return new ToolExecutionError(`The forge returned HTTP ${input.response.status}${detail ? `: ${detail}` : ''}`, {
    code: 'FORGE_UPSTREAM_ERROR',
    retryable: input.response.status >= 500,
  })
}

function toPullRequest(payload: z.infer<typeof pullRequestSchema>): ForgePullRequest {
  return {
    number: payload.number,
    url: payload.html_url,
    state: payload.state,
    title: payload.title,
    head: { ref: payload.head.ref, sha: payload.head.sha },
    base: { ref: payload.base.ref, sha: payload.base.sha },
  }
}
