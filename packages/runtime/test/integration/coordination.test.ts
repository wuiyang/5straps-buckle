import { setTimeout as delay } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { bearer, createDataDir, createTokens, expectCleanDiagnostics, fixtureEnv, runFixtureCli, serveFixture, startFixture, stopAll, type FixtureProcess, type ServingFixture } from './support/fixture-process.js'
import { startHuman, type Human, type PromptRequest } from './support/human.js'
import { createChildStdioTransport } from './support/mcp-stdio.js'
import { expectNoLeakedResources, resourceSnapshot } from './support/resources.js'

const build = inject('fixtureBuild')
const tokens = createTokens()
const processes: FixtureProcess[] = []
const humans: Human[] = []
let resourcesBefore: Record<string, number>

beforeAll(() => { resourcesBefore = resourceSnapshot() })
afterAll(async () => {
  await stopAll(processes)
  await Promise.all(humans.map(human => human.close()))
  for (const fixture of processes) expectCleanDiagnostics(fixture)
  await expectNoLeakedResources(resourcesBefore)
})

async function human(): Promise<Human> {
  const created = await startHuman()
  humans.push(created)
  return created
}

async function serve(input: { terminal?: Human; extra?: Record<string, string>; dataDir?: string } = {}): Promise<ServingFixture> {
  const fixture = await serveFixture({ entry: build.full.entry, dataDir: input.dataDir ?? createDataDir(), tokens, extra: { ...(input.terminal ? { FIXTURE_TERMINAL_SOCKET: input.terminal.path } : {}), ...input.extra } })
  processes.push(fixture)
  await fixture.waitFor('common ready')
  await input.terminal?.connected
  return fixture
}

interface AskResult { status: number; body: { outcome?: Record<string, unknown>; correlationId?: string; error?: string } }

async function ask(fixture: ServingFixture, body: { summary: string; timeoutMs?: number }, signal?: AbortSignal): Promise<AskResult> {
  const response = await fetch(fixture.url('/v1/ask'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify(body), signal })
  return { status: response.status, body: await response.json() as AskResult['body'] }
}

async function stopAndReadResources(fixture: FixtureProcess): Promise<string[]> {
  expect(await fixture.stop('SIGTERM')).toBe(0)
  return (fixture.events.find(event => event.message === 'active resources after close')?.fields?.resources ?? []) as string[]
}

describe('F07 server-to-CLI hook', () => {
  it('answers an HTTP request through cli:call and the terminal, keeping the request id and correlation', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'deploy notes' })
    const prompt = await person.waitForPrompt()
    expect(prompt).toMatchObject({ kind: 'approval', actor: 'agent', action: { summary: 'deploy notes' }, wait: { mode: 'indefinite' } })
    person.answer(prompt.id, 'approve')
    const result = await pending
    expect(result.status).toBe(200)
    expect(result.body.outcome).toEqual({ status: 'answered', requestId: prompt.id, answer: { choice: 'approve' } })
    expect(result.body.correlationId).toBe(prompt.correlationId)
  })
})

describe('F07b denied outcome over HTTP (coordination-12)', () => {
  it('returns the typed denied outcome with the owner reason', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'delete everything' })
    const prompt = await person.waitForPrompt()
    person.deny(prompt.id, 'no')
    expect((await pending).body.outcome).toEqual({ status: 'denied', requestId: prompt.id, reason: 'no' })
  })
})

describe('F08 callback completion', () => {
  it('ignores a second respond from the listener', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person, extra: { FIXTURE_CLI_LISTENER: 'double' } })
    const pending = ask(fixture, { summary: 'first' })
    person.answer((await person.waitForPrompt()).id, 'approve')
    expect((await pending).body.outcome).toMatchObject({ status: 'answered', answer: { choice: 'approve' } })
  })

  it('rejects with a typed error when the listener finishes without responding', async () => {
    const fixture = await serve({ extra: { FIXTURE_CLI_LISTENER: 'silent' } })
    const result = await ask(fixture, { summary: 'nobody answers' })
    expect(result).toEqual({ status: 500, body: { error: 'CLI interaction failed: CliNoCompletionError' } })
  })

  it('drops a late answer after a timeout and leaves no timer behind', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'too slow', timeoutMs: 300 })
    const late = await person.waitForPrompt()
    expect((await pending).body.outcome).toMatchObject({ status: 'timed_out', requestId: late.id })
    await person.waitFor(message => message.type === 'withdrawn' && message.requestId === late.id)
    person.answer(late.id, 'approve')

    const next = ask(fixture, { summary: 'next one' })
    const prompt = await person.waitForPrompt(request => request.action.summary === 'next one')
    person.answer(prompt.id, 'deny-this')
    expect((await next).body.outcome).toEqual({ status: 'answered', requestId: prompt.id, answer: { choice: 'deny-this' } })
    expect((await stopAndReadResources(fixture)).filter(kind => kind === 'Timeout')).toEqual([])
  })
})

describe('F09 listener rejection propagates', () => {
  it('turns a failing cli:call listener into a typed 500 promptly', async () => {
    const fixture = await serve({ extra: { FIXTURE_CLI_LISTENER: 'reject' } })
    await ask(fixture, { summary: 'warm the route' })
    const startedAt = performance.now()
    const result = await ask(fixture, { summary: 'listener throws' })
    const elapsed = performance.now() - startedAt
    expect(result).toEqual({ status: 500, body: { error: 'CLI interaction failed: CliListenerFailedError' } })
    // The request waits indefinitely otherwise; the loose bound survives release:check load and ARM64 CI (review L14).
    expect(elapsed).toBeLessThan(1_000)
    expect(fixture.events.some(event => event.message === 'request failed')).toBe(false)
  })
})

describe('F10 no listener', () => {
  it('returns unavailable with a durable pending approval, never an approval', async () => {
    const dataDir = createDataDir()
    const fixture = await serve({ dataDir, extra: { FIXTURE_CLI_LISTENER: 'off' } })
    const result = await ask(fixture, { summary: 'no listener' })
    expect(result.body.outcome).toMatchObject({ status: 'unavailable', reason: 'no_listener', pending: { id: expect.any(String), instructions: expect.stringContaining('approvals list') } })
    const queued = await runFixtureCli({ dataDir, tokens, args: ['approvals', 'list'] })
    expect(queued.output).toEqual({ approvals: [{ id: (result.body.outcome as { requestId: string }).requestId, summary: 'no listener', correlationId: result.body.correlationId, status: 'pending' }] })
    expectCleanDiagnostics(queued.process)
  })
})

describe('F11 single interactive consumer', () => {
  it('refuses a second terminal and prompts only the first', async () => {
    const first = await human()
    const second = await human()
    const fixture = await serve({ terminal: first, extra: { FIXTURE_SECOND_TERMINAL_SOCKET: second.path } })
    expect(await fixture.waitFor('terminal refused')).toMatchObject({ fields: { code: 'CliConsumerAlreadyAttachedError' } })
    const pending = ask(fixture, { summary: 'only the first terminal' })
    first.answer((await first.waitForPrompt()).id, 'approve')
    expect((await pending).body.outcome).toMatchObject({ status: 'answered' })
    expect(second.prompts()).toEqual([])
  })
})

describe('F12 MCP-to-CLI injection', () => {
  it('asks the terminal from an MCP tool over HTTP /mcp through the request context', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const client = new Client({ name: 'fixture-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url('/mcp')), { requestInit: { headers: bearer(tokens.agent) } }))
    try {
      const call = client.callTool({ name: 'ask_owner', arguments: { summary: 'over http mcp' } })
      const prompt = await person.waitForPrompt()
      person.answer(prompt.id, 'approve')
      expect(toolOutcome(await call)).toEqual({ status: 'answered', requestId: prompt.id, answer: { choice: 'approve' } })
    } finally {
      await client.close()
    }
  })

  it('asks the terminal from an MCP tool over stdio through the function main injects', async () => {
    const person = await human()
    const { client, fixture } = await startStdioMcp({ terminal: person })
    try {
      const call = client.callTool({ name: 'ask_owner', arguments: { summary: 'over stdio' } })
      const prompt = await person.waitForPrompt()
      expect(prompt.actor).toBe('mcp-stdio')
      person.answer(prompt.id, 'approve')
      expect(toolOutcome(await call)).toEqual({ status: 'answered', requestId: prompt.id, answer: { choice: 'approve' } })
    } finally {
      await client.close()
      expect(await fixture.exited).toBe(0)
    }
    expectOnlyJsonRpc(fixture)
  })
})

describe('F13 prompt correlation', () => {
  it('shows one prompt at a time and returns each answer to its own caller', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const summaries = ['alpha', 'beta', 'gamma']
    const results = summaries.map(summary => ask(fixture, { summary }))
    const seen: PromptRequest[] = []
    for (let index = 0; index < summaries.length; index += 1) {
      const prompt = await person.waitForPrompt(request => !seen.some(item => item.id === request.id))
      await delay(150)
      expect(person.prompts()).toHaveLength(index + 1)
      seen.push(prompt)
      person.answer(prompt.id, `choice-${prompt.action.summary}`)
    }
    for (const [index, pending] of results.entries()) {
      const { body } = await pending
      const prompt = seen.find(item => item.action.summary === summaries[index])!
      expect(body.outcome).toEqual({ status: 'answered', requestId: prompt.id, answer: { choice: `choice-${summaries[index]}` } })
      expect(body.correlationId).toBe(prompt.correlationId)
    }
  })
})

describe('F14 finite wait', () => {
  it('times out, withdraws the prompt and keeps no timer', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const startedAt = performance.now()
    const result = await ask(fixture, { summary: 'finite', timeoutMs: 300 })
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(290)
    expect(result.body.outcome).toMatchObject({ status: 'timed_out', waitedMs: expect.any(Number) })
    const requestId = (result.body.outcome as { requestId: string }).requestId
    await person.waitFor(message => message.type === 'withdrawn' && message.requestId === requestId)
    expect((await stopAndReadResources(fixture)).filter(kind => kind === 'Timeout')).toEqual([])
  })
})

describe('F14b finite wait answered in time (coordination-7)', () => {
  it('clears the wait timer when the owner answers before it fires', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'answered long before the timeout', timeoutMs: 600_000 })
    person.answer((await person.waitForPrompt()).id, 'approve')
    expect((await pending).body.outcome).toMatchObject({ status: 'answered' })
    expect((await stopAndReadResources(fixture)).filter(kind => kind === 'Timeout')).toEqual([])
  })
})

describe('F15 indefinite wait', () => {
  it('holds an indefinite request open until the owner answers', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'take your time' })
    const prompt = await person.waitForPrompt()
    expect(prompt.wait).toEqual({ mode: 'indefinite' })
    expect(await Promise.race([pending.then(() => 'settled'), delay(1_500).then(() => 'still waiting')])).toBe('still waiting')
    person.answer(prompt.id, 'approve')
    expect((await pending).body.outcome).toMatchObject({ status: 'answered' })
  })
})

describe('F16 cancellation', () => {
  it('withdraws the prompt when the HTTP caller aborts and keeps the queue moving', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const controller = new AbortController()
    const abandoned = ask(fixture, { summary: 'abandoned' }, controller.signal).catch((error: unknown) => error)
    const prompt = await person.waitForPrompt()
    controller.abort()
    expect(await abandoned).toMatchObject({ name: 'AbortError' })
    await person.waitFor(message => message.type === 'withdrawn' && message.requestId === prompt.id)
    const next = ask(fixture, { summary: 'after abort' })
    person.answer((await person.waitForPrompt(request => request.action.summary === 'after abort')).id, 'approve')
    expect((await next).body.outcome).toMatchObject({ status: 'answered' })
  })

  it('withdraws the prompt on MCP notifications/cancelled over stdio', async () => {
    const person = await human()
    const { client, fixture } = await startStdioMcp({ terminal: person })
    try {
      const controller = new AbortController()
      const call = client.callTool({ name: 'ask_owner', arguments: { summary: 'cancel me' } }, { signal: controller.signal }).catch((error: unknown) => error)
      const prompt = await person.waitForPrompt()
      controller.abort('changed my mind')
      await call
      await person.waitFor(message => message.type === 'withdrawn' && message.requestId === prompt.id)
    } finally {
      await client.close()
      expect(await fixture.exited).toBe(0)
    }
    expectOnlyJsonRpc(fixture)
  })
})

describe('F17 unavailable CLI when headless', () => {
  it('persists a pending approval id and approves nothing when no terminal is attached', async () => {
    const dataDir = createDataDir()
    const fixture = await serve({ dataDir })
    const result = await ask(fixture, { summary: 'headless' })
    expect(result.body.outcome).toMatchObject({ status: 'unavailable', reason: 'no_consumer', pending: { id: expect.any(String) } })
    const queued = await runFixtureCli({ dataDir, tokens, args: ['approvals', 'list'] })
    expect(queued.output).toMatchObject({ approvals: [{ summary: 'headless', status: 'pending' }] })
  })

  it('queues the request durably when the terminal disconnects mid-prompt', async () => {
    const person = await human()
    const fixture = await serve({ terminal: person })
    const pending = ask(fixture, { summary: 'terminal goes away' })
    await person.waitForPrompt()
    await person.close()
    expect((await pending).body.outcome).toMatchObject({ status: 'unavailable', reason: 'consumer_detached', pending: { id: expect.any(String) } })
    await fixture.waitFor('terminal detached')
  })
})

describe('F18 MCP stdio separation', () => {
  it('writes only JSON-RPC to stdout and reports unavailable without a terminal', async () => {
    const { client, fixture, transport } = await startStdioMcp({})
    try {
      const outcome = toolOutcome(await client.callTool({ name: 'ask_owner', arguments: { summary: 'stdio headless' } }))
      expect(outcome).toMatchObject({ status: 'unavailable', reason: 'no_consumer', pending: { id: expect.any(String) } })
      expect((toolOutcome(await client.callTool({ name: 'list_notes', arguments: {} })) as unknown[])).toEqual([])
    } finally {
      await client.close()
      expect(await fixture.exited).toBe(0)
    }
    expect(transport.stdoutLines.length).toBeGreaterThan(0)
    expect(transport.stdoutLines.filter(line => (JSON.parse(line) as { jsonrpc?: string }).jsonrpc !== '2.0')).toEqual([])
    expectOnlyJsonRpc(fixture)
    expect(fixture.events.some(event => event.message === 'mcp stdio ready')).toBe(true)
  })
})

async function startStdioMcp(input: { terminal?: Human }) {
  const fixture = startFixture({ args: ['mcp'], env: fixtureEnv({ dataDir: createDataDir(), tokens, extra: input.terminal ? { FIXTURE_TERMINAL_SOCKET: input.terminal.path } : {} }), stdio: ['pipe', 'pipe', 'pipe'] })
  processes.push(fixture)
  await fixture.waitFor('mcp stdio ready')
  const transport = createChildStdioTransport(fixture.child)
  const client = new Client({ name: 'fixture-test', version: '0.0.0' })
  await client.connect(transport)
  return { client, fixture, transport }
}

// coordination-6: stdout carried JSON-RPC frames only, from spawn to exit, including while a terminal prompt was live.
function expectOnlyJsonRpc(fixture: FixtureProcess): void {
  expect(fixture.stdout.filter(line => line.jsonrpc !== '2.0')).toEqual([])
  expect(fixture.malformed).toEqual([])
}

function toolOutcome(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return JSON.parse(content.find(item => item.type === 'text')?.text ?? 'null')
}
