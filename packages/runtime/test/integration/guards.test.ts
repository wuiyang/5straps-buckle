import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { bearer, createDataDir, createTokens, expectCleanDiagnostics, serveFixture, stopAll, type ServingFixture } from './support/fixture-process.js'
import { expectNoLeakedResources, resourceSnapshot } from './support/resources.js'

const build = inject('fixtureBuild')
const tokens = createTokens()
const started: ServingFixture[] = []
let resourcesBefore: Record<string, number>

beforeAll(() => { resourcesBefore = resourceSnapshot() })
afterAll(async () => {
  await stopAll(started)
  for (const fixture of started) expectCleanDiagnostics(fixture)
  await expectNoLeakedResources(resourcesBefore)
})

async function serve(faults?: string): Promise<ServingFixture> {
  const fixture = await serveFixture({ entry: build.full.entry, dataDir: createDataDir(), tokens, extra: faults ? { FIXTURE_FAULTS: faults } : {} })
  started.push(fixture)
  await fixture.waitFor('common ready')
  return fixture
}

interface Probe { name: string; path: string; method?: string; headers?: Record<string, string>; body?: string }

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
const MCP_LIST_TOOLS = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

// Every request here must be refused before its handler body runs.
function refusedProbes(): Probe[] {
  return [
    { name: 'business route without a token', path: '/v1/notes' },
    { name: 'business route with the admin token', path: '/v1/notes', headers: bearer(tokens.admin) },
    { name: 'admin route without auth but with MCP headers the MCP middleware labels', path: '/setup/status', headers: { 'mcp-protocol-version': '2025-06-18' } },
    { name: 'admin route with the agent token and MCP headers', path: '/setup/status', headers: bearer(tokens.agent, { 'mcp-protocol-version': '2025-06-18' }) },
    { name: 'admin route with the agent token', path: '/setup/status', headers: bearer(tokens.agent) },
    { name: 'MCP execution route with the admin token', path: '/mcp', method: 'POST', headers: bearer(tokens.admin, MCP_HEADERS), body: MCP_LIST_TOOLS },
    { name: 'MCP execution route without a token', path: '/mcp', method: 'POST', headers: MCP_HEADERS, body: MCP_LIST_TOOLS },
  ]
}

async function send(fixture: ServingFixture, probe: Probe): Promise<{ status: number; body: unknown }> {
  const response = await fetch(fixture.url(probe.path), { method: probe.method ?? 'GET', headers: probe.headers, body: probe.body })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

function operations(fixture: ServingFixture): number {
  return fixture.events.filter(event => event.message === 'operation executed').length
}

function capturedHookErrors(fixture: ServingFixture): number {
  return fixture.events.filter(event => event.message === 'captured hook error' && event.fields?.tags === 'request').length
}

// guards-gate-8: the logger writes in FIFO order, so once a line logged after the probes has arrived, every
// line the probes caused has too. Only then can a count of 'operation executed' prove that none ran.
async function logBarrier(fixture: ServingFixture, expectedHookErrors: number): Promise<void> {
  if (expectedHookErrors > 0) return vi.waitFor(() => expect(capturedHookErrors(fixture)).toBe(expectedHookErrors), { timeout: 5_000, interval: 20 })
  expect((await send(fixture, { name: 'sentinel', path: '/v1/notes', headers: bearer(tokens.agent, { 'x-request-id': 'barrier' }) })).status).toBe(200)
  await fixture.waitFor('request completed', event => event.fields?.clientRequestId === 'barrier')
}

describe('F24 Foundation gate: request-hook failures cannot bypass handler guards', () => {
  const scenarios = [
    { name: 'no hook failure', faults: undefined, refusedWith: 401 },
    { name: 'a request hook throws synchronously on every request, after context is set', faults: 'hook-after-context', refusedWith: 401 },
    { name: 'a request hook rejects asynchronously on every request', faults: 'hook-async', refusedWith: 401 },
    { name: 'a request hook throws before services are set', faults: 'hook-before-context', refusedWith: 503 },
  ] as const

  for (const scenario of scenarios) {
    it(`${scenario.name}: every unauthorised request is refused, no handler runs, /health still answers`, async () => {
      const fixture = await serve(scenario.faults)
      for (const probe of refusedProbes()) {
        const result = await send(fixture, probe)
        expect({ probe: probe.name, ...result }).toEqual({ probe: probe.name, status: scenario.refusedWith, body: { error: expect.any(String) } })
      }
      const health = await send(fixture, { name: 'liveness', path: '/health' })
      expect(health).toEqual({ status: 200, body: { status: 'ok' } })
      await logBarrier(fixture, scenario.faults ? refusedProbes().length + 1 : 0)
      // Without faults the barrier itself is one authorised operation.
      expect(operations(fixture)).toBe(scenario.faults ? 0 : 1)
      expect(capturedHookErrors(fixture)).toBe(scenario.faults ? refusedProbes().length + 1 : 0)
    })
  }

  it('a hook failure after context still lets an authorised request through its guard, exactly once', async () => {
    const fixture = await serve('hook-after-context,hook-async')
    expect((await send(fixture, { name: 'agent', path: '/v1/notes', headers: bearer(tokens.agent) })).status).toBe(200)
    expect((await send(fixture, { name: 'admin', path: '/setup/status', headers: bearer(tokens.admin) })).status).toBe(200)
    expect(operations(fixture)).toBe(2)
  })

  it('a hook failure before context refuses even valid credentials with 503', async () => {
    const fixture = await serve('hook-before-context')
    expect(await send(fixture, { name: 'agent', path: '/v1/notes', headers: bearer(tokens.agent) })).toEqual({ status: 503, body: { error: expect.any(String) } })
    expect(await send(fixture, { name: 'admin', path: '/setup/status', headers: bearer(tokens.admin) })).toEqual({ status: 503, body: { error: expect.any(String) } })
    await logBarrier(fixture, 2)
    expect(operations(fixture)).toBe(0)
  })
})

describe('F25 middleware scoping', () => {
  it('lets MCP requests through the admin middleware untouched and reads the MCP body once', async () => {
    const fixture = await serve()
    const initialize = await fetch(fixture.url('/mcp'), { method: 'POST', headers: bearer(tokens.agent, MCP_HEADERS), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } } }) })
    expect(initialize.status).toBe(200)
    const text = await initialize.text()
    const message = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as { result?: { serverInfo?: { name: string } } }
    expect(message.result?.serverInfo?.name).toBe('runtime-fixture')

    expect((await send(fixture, { name: 'admin', path: '/setup/status', headers: bearer(tokens.admin) })).status).toBe(200)
    await fixture.waitFor('request completed', event => event.fields?.path === '/setup/status')
    expect(fixture.events.filter(event => event.message === 'admin request').map(event => event.fields?.path)).toEqual(['/setup/status'])
  })

  it('guards-gate-12 streams an MCP tool call through the request scope', async () => {
    const fixture = await serve()
    const contentTypes: string[] = []
    const client = new Client({ name: 'probe', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url('/mcp')), {
      requestInit: { headers: bearer(tokens.agent) },
      fetch: (url, init) => fetch(url, init).then((response) => { contentTypes.push(response.headers.get('content-type') ?? ''); return response }),
    }))
    try {
      const listed = await client.callTool({ name: 'list_notes', arguments: {} })
      expect(listed.content).toEqual([{ type: 'text', text: '[]' }])
    } finally {
      await client.close()
    }
    expect(contentTypes.some(type => type.startsWith('text/event-stream'))).toBe(true)
    await fixture.waitFor('request completed', event => event.fields?.path === '/mcp' && event.fields?.outcome === 'streamed 200')
  })
})

describe('sub-actors stay under the verified credential (guards-gate-9)', () => {
  it('names an x-actor sub-actor under the agent credential, never as admin', async () => {
    const fixture = await serve()
    const response = await fetch(fixture.url('/v1/whoami'), { headers: bearer(tokens.agent, { 'x-actor': 'admin' }) })
    expect(await response.json()).toMatchObject({ actor: 'agent:admin', alsActor: 'agent:admin' })
    expect((await send(fixture, { name: 'admin', path: '/setup/status', headers: bearer(tokens.agent, { 'x-actor': 'admin' }) })).status).toBe(401)
  })
})
