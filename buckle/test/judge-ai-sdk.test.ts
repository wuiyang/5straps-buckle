import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiSdkJudge } from '../common/adapters/judge/ai-sdk.js'
import { createProviderJudge } from '../common/adapters/judge/providers.js'
import { openAiCompatibleModels } from '../common/adapters/judge/providers/openai-compatible.js'
import { JUDGE_SYSTEM_PROMPT } from '../common/adapters/judge/verdict.js'
import type { JudgeInput } from '../common/types/ports/judge.js'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// The decision AI through the AI SDK (D91, addendum 2 A): one adapter on `ai`'s generateText with a structured output,
// behind Buckle's own port, and one provider, openai-compatible, built from the node's key and base URL alone. Every
// request goes to that base URL with the node's key as a bearer; nothing comes from the environment.

const KEY = 'sk-judge-ai-sdk-fixture-0123456789'
const MODEL = 'gpt-6-luna'
const INPUT: JudgeInput = {
  command: 'node job.js',
  argv: ['node', 'job.js'],
  interpreters: ['node'],
  inline: null,
  files: [{ path: '/workspace/job.js', sha256: 'a'.repeat(64), bytes: 21, content: 'console.log("hello")\n' }],
  packages: [],
  packagesTruncated: false,
  truncated: false,
  standardScript: false,
  policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] },
  cwd: '/workspace',
  mounts: [{ target: '/workspace', access: 'read-write' }],
  description: null,
  reason: null,
}

interface Sent { url: string; headers: Headers; body: Record<string, unknown>; text: string }

function fakeFetch(...answers: Array<(init: RequestInit | undefined) => Response | Promise<Response>>) {
  const sent: Sent[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body ?? '')
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(text) as Record<string, unknown>, text })
    return answers[Math.min(sent.length, answers.length) - 1]!(init)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: () => fetch.mock.calls.length }
}

function completion(message: Record<string, unknown>, finish = 'stop'): Response {
  return Response.json({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
}

const SAFE = { command_echo: INPUT.command, level: 'safe', confidence: 0.91, reasoning: 'Prints a greeting.' }
const answer = (verdict: Record<string, unknown>) => () => completion({ content: JSON.stringify(verdict) })
const judgeOf = (fetch: typeof globalThis.fetch, options: { baseUrl?: string; timeoutMs?: number } = {}) => createAiSdkJudge({
  model: openAiCompatibleModels({ apiKey: KEY, fetch, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) }),
  ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
})
const rate = (fetch: typeof globalThis.fetch, options: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal } = {}) => judgeOf(fetch, options).judge(INPUT, { model: MODEL, ...(options.signal ? { signal: options.signal } : {}) })

afterEach(() => { vi.unstubAllEnvs() })

describe('the request the AI SDK judge is asked with', () => {
  it('posts one chat completion with the fixed instructions, the call as one JSON document, and a strict verdict schema', async () => {
    const { fetch, sent } = fakeFetch(answer(SAFE))

    expect(await rate(fetch)).toEqual({ kind: 'verdict', level: 'safe', confidence: 0.91, reasoning: SAFE.reasoning, model: MODEL, latencyMs: expect.any(Number), promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent[0]!.body).toMatchObject({
      model: MODEL,
      messages: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(INPUT) }],
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object', additionalProperties: false, required: ['command_echo', 'level', 'confidence', 'reasoning'] } } },
    })
    expect(sent[0]!.body).not.toHaveProperty('tools')
    expect(sent[0]!.body).not.toHaveProperty('max_tokens')
  })

  it('sends the key as a bearer alone, never in the body', async () => {
    const { fetch, sent } = fakeFetch(answer(SAFE))
    await rate(fetch)
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.text).not.toContain(KEY)
  })

  it('asks the base URL the node names, such as an AI gateway, and no other address', async () => {
    const { fetch, sent } = fakeFetch(() => Response.json({ error: { message: 'busy' } }, { status: 503, headers: { 'retry-after-ms': '1' } }), answer(SAFE))
    expect(await rate(fetch, { baseUrl: 'https://gateway.test/v1/' })).toMatchObject({ kind: 'verdict' })
    expect(sent.map(item => item.url)).toEqual(['https://gateway.test/v1/chat/completions', 'https://gateway.test/v1/chat/completions'])
  })

  it('takes nothing from the environment: no OpenAI key or base URL, and no gateway key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-environment-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.invalid/v1')
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-environment-key')
    vi.stubEnv('VERCEL_OIDC_TOKEN', 'oidc-environment-token')
    const { fetch, sent } = fakeFetch(answer(SAFE))
    expect(await rate(fetch)).toMatchObject({ kind: 'verdict' })
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    for (const value of ['sk-environment-key', 'proxy.invalid', 'gateway-environment-key', 'oidc-environment-token']) {
      expect(sent[0]!.text).not.toContain(value)
      expect([...sent[0]!.headers.values()].join('\n')).not.toContain(value)
    }
  })
})

describe('a rating the AI SDK judge cannot give', () => {
  const unavailable = async (fetch: typeof globalThis.fetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
    const result = await rate(fetch, options)
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).not.toContain(KEY)
    return result
  }
  const hang = (init: RequestInit | undefined) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason)
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })

  it('is unavailable when the request outlives its time', async () => {
    const { fetch } = fakeFetch(hang)
    expect(await unavailable(fetch, { timeoutMs: 50 })).toEqual({ kind: 'unavailable', reason: 'the request timed out' })
  })

  it('is unavailable when the call it rates is cancelled', async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch((init) => { controller.abort(); return hang(init) })
    expect(await unavailable(fetch, { signal: controller.signal })).toEqual({ kind: 'unavailable', reason: 'the call was cancelled while the judge rated it' })
  })

  it.each([429, 500])('is unavailable when the API answers HTTP %i, after one retry', async (status) => {
    const { fetch, calls } = fakeFetch(() => Response.json({ error: { message: `upstream said ${KEY}` } }, { status, headers: { 'retry-after-ms': '1' } }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: `the API answered HTTP ${status}` })
    expect(calls()).toBe(2)
  })

  it('is unavailable when the model refuses', async () => {
    const { fetch } = fakeFetch(() => completion({ content: null, refusal: 'I will not rate this.' }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer held no verdict' })
  })

  it('is unavailable when a content filter stops the answer', async () => {
    const { fetch } = fakeFetch(() => completion({ content: null }, 'content_filter'))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the model declined to rate the command' })
  })

  it('is unavailable when the answer runs past its length', async () => {
    const { fetch } = fakeFetch(() => completion({ content: '{"command_echo": "node j' }, 'length'))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer ran past its length limit' })
  })

  it.each([
    ['text that is not JSON', 'Looks fine to me.'],
    ['a confidence above 1', JSON.stringify({ ...SAFE, confidence: 1.5 })],
    ['a level outside the three', JSON.stringify({ ...SAFE, level: 'fine' })],
  ])('is unavailable when the answer is %s', async (_, content) => {
    const { fetch } = fakeFetch(() => completion({ content }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer held no verdict' })
  })

  it('is unavailable when the answer echoes another command', async () => {
    const { fetch } = fakeFetch(answer({ ...SAFE, command_echo: 'node other.js' }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer named another command than the one asked about' })
  })
})

describe('the judge a provider names', () => {
  it('builds the openai-compatible provider from the node\'s key and base URL', async () => {
    const { fetch, sent } = fakeFetch(answer(SAFE))
    expect(await createProviderJudge({ provider: 'openai-compatible', apiKey: KEY, baseUrl: 'https://gateway.test/v1', fetch }).judge(INPUT, { model: MODEL })).toMatchObject({ kind: 'verdict' })
    expect(sent[0]!.url).toBe('https://gateway.test/v1/chat/completions')
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('imports the AI SDK from its adapter alone, and each provider package from its provider file alone', () => {
    const importers = (pattern: RegExp) => sourceFiles('main.ts', 'cli', 'common', 'mcp', 'server', 'layers')
      .filter(file => pattern.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(importers(/from 'ai'|import\('ai'\)/)).toEqual(['common/adapters/judge/ai-sdk.ts'])
    expect(importers(/from '@ai-sdk\/[^']*'|import\('@ai-sdk\//)).toEqual(['common/adapters/judge/providers/openai-compatible.ts'])
    expect(importers(/from '(?:@anthropic-ai\/sdk|openai)[^']*'/)).toEqual([])
  })
})

describe('the fixed instructions', () => {
  it('are pinned, so a change to what every rating is asked under is a reviewed one', () => {
    expect(createHash('sha256').update(JUDGE_SYSTEM_PROMPT).digest('hex')).toBe('769b231552ad1c8dd6489edb869efd61306ee3f245b1eda40a827a053f3e35aa')
  })
})
