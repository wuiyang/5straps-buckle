import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderQuickJudge } from '../common/adapters/judge/quick-providers.js'
import { createTypeSafeQuickJudge, QUICK_INSTRUCTIONS } from '../common/adapters/judge/typesafe.js'
import { LEVEL_DEFINITIONS } from '../common/adapters/judge/verdict.js'
import type { JudgeInput } from '../common/types/ports/judge.js'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// Jev, the decision AI's optional quick stage (D91, addendum 2 B): TypeSafe AI's System One model through its official
// SDK, one choice question named safety over the call as the state, the node's key as a bearer and its base URL, and
// nothing from the environment. Every failure is an unavailable rating, so the call goes on as the routing says.

const KEY = 'ts_quick-judge-fixture-0123456789'
const MODEL = 'jev-latest'
const INPUT: JudgeInput = {
  command: 'node job.js', argv: ['node', 'job.js'], interpreters: ['node'], inline: null, env: [],
  files: [{ path: '/workspace/job.js', sha256: 'a'.repeat(64), bytes: 21, content: 'console.log("hello")\n' }],
  packages: [], packagesTruncated: false, truncated: false, standardScript: false,
  policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] },
  cwd: '/workspace', mounts: [{ target: '/workspace', access: 'read-write' }], description: null, reason: null,
}
const CHOICE = { type: 'choice', choice: 'safe', confidence: 0.93, probabilities: { safe: 0.93, warning: 0.05, danger: 0.02 } }

interface Sent { url: string; headers: Headers; text: string }

function fakeFetch(...answers: Array<(init: RequestInit | undefined) => Response | Promise<Response>>) {
  const sent: Sent[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), text: String(init?.body ?? '') })
    return answers[Math.min(sent.length, answers.length) - 1]!(init)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: () => fetch.mock.calls.length }
}

const answer = (safety: unknown) => () => Response.json({ model: 'jev-1.13.0', answers: safety === undefined ? {} : { safety }, usage: { input_tokens: 120, output_tokens: 1 } })
const rate = (fetch: typeof globalThis.fetch, options: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal } = {}) => createTypeSafeQuickJudge({ apiKey: KEY, fetch, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }).quick(INPUT, { model: MODEL, ...(options.signal ? { signal: options.signal } : {}) })

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the request Jev is asked with', () => {
  it('posts one System One request: the call as the state, and one choice question, safety, in the thorough stage\'s words', async () => {
    const { fetch, sent } = fakeFetch(answer(CHOICE))
    expect(await rate(fetch)).toEqual({ kind: 'verdict', level: 'safe', confidence: 0.93, probabilities: CHOICE.probabilities, model: 'jev-1.13.0', latencyMs: expect.any(Number) })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.parse(sent[0]!.text)).toEqual({ model: MODEL, state: INPUT, questions: { safety: { type: 'choice', instructions: QUICK_INSTRUCTIONS, criteria: LEVEL_DEFINITIONS } } })
    expect(sent[0]!.headers.get('content-encoding')).toBeNull()
  })

  it('sends the key as a bearer alone, and asks the base URL the node names', async () => {
    const { fetch, sent } = fakeFetch(answer(CHOICE))
    await rate(fetch, { baseUrl: 'http://127.0.0.1:9/typesafe/' })
    expect(sent[0]!.url).toBe('http://127.0.0.1:9/typesafe/v1/systemone')
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.text).not.toContain(KEY)
  })

  it('takes nothing from the environment: no key, base URL, or model, and prints nothing at a debug log level', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-environment-key')
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://proxy.invalid')
    vi.stubEnv('TYPESAFE_DEFAULT_MODEL', 'jev-environment')
    vi.stubEnv('TYPESAFE_LOG_LEVEL', 'debug')
    const printed = (['debug', 'info', 'log', 'warn', 'error'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => undefined))
    const { fetch, sent } = fakeFetch(answer(CHOICE))
    expect(await rate(fetch)).toMatchObject({ kind: 'verdict' })
    expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.text).not.toContain('jev-environment')
    for (const spy of printed) expect(spy).not.toHaveBeenCalled()
  })
})

describe('an answer Jev cannot give', () => {
  const hang = (init: RequestInit | undefined) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason)
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
  const unavailable = async (fetch: typeof globalThis.fetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
    const result = await rate(fetch, options)
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).not.toContain(KEY)
    return result
  }

  it.each([
    ['no answer to the question', undefined],
    ['a choice outside the three levels', { ...CHOICE, choice: 'fine' }],
    ['a confidence above 1', { ...CHOICE, confidence: 1.4 }],
    ['an answer of another type', { type: 'noul', noul: 0.9 }],
  ])('is unavailable when the answer holds %s', async (_, safety) => {
    const { fetch } = fakeFetch(answer(safety))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer held no verdict' })
  })

  it.each([
    ['an empty object', () => Response.json({})],
    ['answers that are null', () => Response.json({ model: 'jev-1.13.0', answers: null })],
    ['an HTML page', () => new Response('<!doctype html><html><body>Bad gateway</body></html>', { headers: { 'content-type': 'text/html' } })],
    ['a JSON string', () => Response.json('a plain string')],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('is unavailable, and throws nothing, when a 200 holds %s', async (_, body) => {
    const { fetch } = fakeFetch(body)
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer held no verdict' })
  })

  it('is unavailable at a 400, without trying again', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ detail: `too long for ${KEY}` }, { status: 400 }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the API answered HTTP 400' })
    expect(calls()).toBe(1)
  })

  it.each([429, 529])('is unavailable at a %i, after one retry', async (status) => {
    const { fetch, calls } = fakeFetch(() => Response.json({ detail: 'busy' }, { status }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: `the API answered HTTP ${status}` })
    expect(calls()).toBe(2)
  })

  it('is unavailable when the request outlives its time', async () => {
    const { fetch } = fakeFetch(hang)
    expect(await unavailable(fetch, { timeoutMs: 30 })).toEqual({ kind: 'unavailable', reason: 'the request timed out' })
  })

  it('is unavailable when the call it rates is cancelled', async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch((init) => { controller.abort(); return hang(init) })
    expect(await unavailable(fetch, { signal: controller.signal })).toEqual({ kind: 'unavailable', reason: 'the call was cancelled while the judge rated it' })
  })
})

describe('the quick judge a provider names', () => {
  it('builds the typesafe provider from the node\'s key and base URL', async () => {
    const { fetch, sent } = fakeFetch(answer(CHOICE))
    expect(await createProviderQuickJudge({ provider: 'typesafe', apiKey: KEY, baseUrl: 'https://typesafe.test', fetch }).quick(INPUT, { model: MODEL })).toMatchObject({ kind: 'verdict' })
    expect(sent[0]!.url).toBe('https://typesafe.test/v1/systemone')
  })

  it('imports the TypeSafe SDK from its adapter alone', () => {
    const importers = sourceFiles('main.ts', 'cli', 'common', 'mcp', 'server', 'layers')
      .filter(file => /from '@typesafe-ai\/sdk[^']*'|import\('@typesafe-ai\/sdk/.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(importers).toEqual(['common/adapters/judge/typesafe.ts'])
  })
})
