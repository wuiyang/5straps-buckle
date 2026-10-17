import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiClient, createOpenAiJudge } from '../common/adapters/judge/openai.js'
import { createProviderJudge } from '../common/adapters/judge/providers.js'
import { JUDGE_SYSTEM_PROMPT } from '../common/adapters/judge/verdict.js'
import type { JudgeInput } from '../common/types/ports/judge.js'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// The decision AI's OpenAI adapter (D91, addendum A): the official openai SDK, chat completions with a strict JSON
// schema answer, the node's own key as a bearer, and the node's base URL where it names one, so an OpenAI-compatible
// endpoint or a local model answers; the same prompt, schema, timeout, and retry as the Anthropic adapter.

const KEY = 'sk-judge-openai-fixture-0123456789'
const MODEL = 'GPT-6-luna'
const INPUT: JudgeInput = {
  command: 'node job.js',
  argv: ['node', 'job.js'],
  interpreters: ['node'],
  inline: null,
  files: [{ path: '/workspace/job.js', sha256: 'a'.repeat(64), bytes: 21, content: 'console.log("hello")\n' }],
  packages: [],
  truncated: false,
  standardScript: false,
  policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] },
  cwd: '/workspace',
  mounts: [{ target: '/workspace', access: 'read-write' }],
  description: null,
}

interface Sent { url: string; headers: Headers; body: Record<string, unknown>; text: string }

function fakeFetch(...answers: Array<() => Response>) {
  const sent: Sent[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body ?? '')
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(text) as Record<string, unknown>, text })
    return answers[Math.min(sent.length, answers.length) - 1]!()
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: () => fetch.mock.calls.length }
}

function completion(message: Record<string, unknown>, finish = 'stop'): Response {
  return Response.json({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', refusal: null, ...message }, finish_reason: finish, logprobs: null }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
}

const SAFE = { command_echo: INPUT.command, level: 'safe', confidence: 0.91, reasoning: 'Prints a greeting.' }
const answer = (verdict: Record<string, unknown>) => completion({ content: JSON.stringify(verdict) })
const rate = (fetch: typeof globalThis.fetch, baseUrl?: string) => createOpenAiJudge({ apiKey: KEY, fetch, ...(baseUrl ? { baseUrl } : {}) }).judge(INPUT, { model: MODEL })

afterEach(() => { vi.unstubAllEnvs() })

describe('the request the OpenAI judge is asked with', () => {
  it('posts one chat completion with the fixed system prompt, the call as one JSON document, and a strict verdict schema', async () => {
    const { fetch, sent } = fakeFetch(() => answer(SAFE))

    expect(await rate(fetch)).toEqual({ kind: 'verdict', level: 'safe', confidence: 0.91, reasoning: SAFE.reasoning, model: MODEL, latencyMs: expect.any(Number), promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent[0]!.body).toMatchObject({
      model: MODEL,
      max_completion_tokens: 4096,
      messages: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(INPUT) }],
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true } },
    })
    expect(Object.keys(sent[0]!.body).sort()).toEqual(['max_completion_tokens', 'messages', 'model', 'response_format'])
  })

  it('sends the key as a bearer alone, never in the body', async () => {
    const { fetch, sent } = fakeFetch(() => answer(SAFE))
    await rate(fetch)
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.text).not.toContain(KEY)
  })

  it('asks the base URL the node names, for an OpenAI-compatible endpoint or a local model', async () => {
    const { fetch, sent } = fakeFetch(() => answer(SAFE))
    expect(await rate(fetch, 'http://127.0.0.1:11434/v1')).toMatchObject({ kind: 'verdict' })
    expect(sent[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('takes nothing from the environment: not its keys, base URL, organization, project, custom headers, or log level', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-environment-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.invalid/v1')
    vi.stubEnv('OPENAI_ORG_ID', 'org-environment')
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-environment')
    vi.stubEnv('OPENAI_LOG', 'debug')
    vi.stubEnv('OPENAI_ADMIN_KEY', 'sk-admin-environment')
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer sk-environment-key\nx-environment: set')
    const logged = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const { fetch, sent } = fakeFetch(() => answer(SAFE))
    try {
      expect(await rate(fetch)).toMatchObject({ kind: 'verdict' })
      expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
      expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
      expect(sent[0]!.headers.get('openai-organization')).toBeNull()
      expect(sent[0]!.headers.get('openai-project')).toBeNull()
      expect(sent[0]!.headers.get('x-environment')).toBeNull()
      expect(logged).not.toHaveBeenCalled()
    } finally { logged.mockRestore() }
  })

  it('builds its client with a 20 second timeout and one retry', () => {
    const client = createOpenAiClient({ apiKey: KEY })
    expect(client.baseURL).toBe('https://api.openai.com/v1')
    expect(client.timeout).toBe(20_000)
    expect(client.maxRetries).toBe(1)
  })
})

describe('a rating the OpenAI judge cannot give', () => {
  const unavailable = async (fetch: typeof globalThis.fetch) => {
    const result = await rate(fetch)
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).not.toContain(KEY)
    return result
  }

  it('is unavailable when the request times out, after one retry', async () => {
    const { fetch, calls } = fakeFetch(() => { throw new DOMException('This operation was aborted', 'AbortError') })
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the request timed out' })
    expect(calls()).toBe(2)
  })

  it.each([429, 500])('is unavailable when the API answers HTTP %i, after one retry', async (status) => {
    const { fetch, calls } = fakeFetch(() => Response.json({ error: { message: `upstream said ${KEY}`, type: 'server_error' } }, { status, headers: { 'retry-after-ms': '1' } }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: `the API answered HTTP ${status}` })
    expect(calls()).toBe(2)
  })

  it('is unavailable when the model refuses', async () => {
    const { fetch } = fakeFetch(() => completion({ content: null, refusal: 'I will not rate this.' }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the model declined to rate the command' })
  })

  it('is unavailable when the answer runs past its length', async () => {
    const { fetch } = fakeFetch(() => completion({ content: '{"command_echo": "node j' }, 'length'))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer ran past its length limit' })
  })

  it.each([
    ['text that is not JSON', 'Looks fine to me.'],
    ['a confidence above 1', JSON.stringify({ ...SAFE, confidence: 1.5 })],
  ])('is unavailable when the answer is %s', async (_, content) => {
    const { fetch } = fakeFetch(() => completion({ content }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer held no verdict' })
  })

  it('is unavailable when the answer echoes another command', async () => {
    const { fetch } = fakeFetch(() => answer({ ...SAFE, command_echo: 'node other.js' }))
    expect(await unavailable(fetch)).toEqual({ kind: 'unavailable', reason: 'the answer named another command than the one asked about' })
  })
})

describe('the judge a provider names', () => {
  it('passes the node\'s base URL to the OpenAI adapter alone; Anthropic keeps its own', async () => {
    const openai = fakeFetch(() => answer(SAFE))
    await createProviderJudge({ provider: 'openai', apiKey: KEY, baseUrl: 'https://gateway.test/v1', fetch: openai.fetch }).judge(INPUT, { model: MODEL })
    expect(openai.sent[0]!.url).toBe('https://gateway.test/v1/chat/completions')

    const anthropic = fakeFetch(() => Response.json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(SAFE) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    expect(await createProviderJudge({ provider: 'anthropic', apiKey: KEY, baseUrl: 'https://gateway.test/v1', fetch: anthropic.fetch }).judge(INPUT, { model: 'claude-opus-5-5' })).toMatchObject({ kind: 'verdict' })
    expect(anthropic.sent[0]!.url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('imports the openai package from its adapter module alone', () => {
    const importers = sourceFiles('main.ts', 'cli', 'common', 'mcp', 'server', 'layers')
      .filter(file => /from 'openai[^']*'|import\('openai/.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(importers).toEqual(['common/adapters/judge/openai.ts'])
  })
})
