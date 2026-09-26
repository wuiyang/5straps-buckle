import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { bearer, createDataDir, createTokens, expectCleanDiagnostics, serveFixture, type ServingFixture } from './support/fixture-process.js'
import { expectNoLeakedResources, resourceSnapshot } from './support/resources.js'

const build = inject('fixtureBuild')
const tokens = createTokens()
const started: ServingFixture[] = []
let resourcesBefore: Record<string, number>

beforeAll(() => { resourcesBefore = resourceSnapshot() })
afterAll(async () => {
  await Promise.all(started.map(fixture => fixture.stop()))
  for (const fixture of started) expectCleanDiagnostics(fixture)
  await expectNoLeakedResources(resourcesBefore)
})

async function serve(extra: Record<string, string> = {}): Promise<ServingFixture> {
  const fixture = await serveFixture({ entry: build.full.entry, dataDir: createDataDir(), tokens, extra })
  started.push(fixture)
  return fixture
}

async function ready(extra: Record<string, string> = {}): Promise<ServingFixture> {
  const fixture = await serve(extra)
  await fixture.waitFor('common ready')
  return fixture
}

interface StreamEvent { sent: number; scopeState: string; correlationId: string }

async function* sseEvents(response: Response): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let buffered = ''
  const reader = response.body!.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffered += decoder.decode(value, { stream: true })
    let boundary = buffered.indexOf('\n\n')
    while (boundary >= 0) {
      yield JSON.parse(buffered.slice(0, boundary).replace(/^data: /, '')) as StreamEvent
      buffered = buffered.slice(boundary + 2)
      boundary = buffered.indexOf('\n\n')
    }
  }
}

async function stopAndReadResources(fixture: ServingFixture): Promise<string[]> {
  expect(await fixture.stop('SIGTERM')).toBe(0)
  return (fixture.events.find(event => event.message === 'active resources after close')?.fields?.resources ?? []) as string[]
}

describe('F23 streamed response ownership', () => {
  it('keeps the request scope active for every event and closes it only after the body ends', async () => {
    const fixture = await ready()
    const response = await fetch(fixture.url('/v1/stream?events=5'), { headers: bearer(tokens.agent) })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const events: StreamEvent[] = []
    for await (const event of sseEvents(response)) {
      if (event.sent === 1) expect(fixture.events.some(item => item.message === 'request completed' && item.fields?.path === '/v1/stream')).toBe(false)
      events.push(event)
    }
    expect(events.map(event => event.sent)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(events.map(event => event.scopeState))).toEqual(new Set(['active']))
    // Matched by path: at 7a63de6 the streamed completion is logged from the body pull, outside the scope, so it has no correlationId.
    const completed = await fixture.waitFor('request completed', event => event.fields?.path === '/v1/stream')
    expect(completed.fields).toMatchObject({ path: '/v1/stream', outcome: 'streamed 200' })
    expect(await fixture.waitFor('stream ended')).toMatchObject({ fields: { reason: 'complete' } })
  })

  it('stops the source and closes the scope when the client disconnects mid-stream', async () => {
    const fixture = await ready()
    const controller = new AbortController()
    const response = await fetch(fixture.url('/v1/stream?events=100'), { headers: bearer(tokens.agent), signal: controller.signal })
    const iterator = sseEvents(response)
    await iterator.next()
    controller.abort()
    await iterator.return(undefined).catch(() => undefined)
    expect(await fixture.waitFor('stream ended')).toMatchObject({ fields: { reason: 'cancelled' } })
    await fixture.waitFor('request completed', event => event.fields?.path === '/v1/stream')
    expect((await stopAndReadResources(fixture)).filter(kind => kind === 'Timeout')).toEqual([])
  })

  it('ends an open stream at shutdown and still exits 0', async () => {
    const fixture = await ready()
    const response = await fetch(fixture.url('/v1/stream?events=100'), { headers: bearer(tokens.agent) })
    const iterator = sseEvents(response)
    await iterator.next()
    const exit = fixture.stop('SIGTERM')
    const rest: StreamEvent[] = []
    for await (const event of iterator) rest.push(event)
    expect(rest.length).toBeLessThan(99)
    expect(await exit).toBe(0)
    expect(fixture.events.find(event => event.message === 'stream ended')).toMatchObject({ fields: { reason: 'shutdown' } })
  })
})

describe('F26 WebSocket through handleUpgrade with first-frame authentication', () => {
  function connect(fixture: ServingFixture) {
    const socket = new WebSocket(fixture.url('/v1/events').replace('http:', 'ws:'))
    const messages: Record<string, unknown>[] = []
    const opened = new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('websocket failed to open')) })
    const closed = new Promise<{ code: number; reason: string; at: number }>(resolve => { socket.onclose = event => resolve({ code: event.code, reason: event.reason, at: performance.now() }) })
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    const next = async (count: number) => {
      while (messages.length < count) await delay(10)
      return messages[count - 1]!
    }
    return { socket, opened, closed, next }
  }

  it('authenticates on the first frame, runs messages in the socket scope and releases it on close', async () => {
    const fixture = await ready()
    const client = connect(fixture)
    await client.opened
    client.socket.send(JSON.stringify({ type: 'auth', token: tokens.agent }))
    expect(await client.next(1)).toEqual({ type: 'ready', actor: 'agent' })
    client.socket.send(JSON.stringify({ type: 'whoami' }))
    client.socket.send(JSON.stringify({ type: 'whoami' }))
    const [first, second] = [await client.next(2), await client.next(3)]
    expect(first).toMatchObject({ type: 'whoami', actor: 'agent', correlationId: expect.any(String) })
    expect(second!.correlationId).toBe(first!.correlationId)
    client.socket.close(1000, 'done')
    await client.closed
    expect(await fixture.waitFor('websocket closed', event => event.correlationId === undefined && event.fields?.correlationId === first!.correlationId)).toBeTruthy()
  })

  it('closes with 4408 when no frame arrives within 2 s and with 4401 on a wrong token', async () => {
    const fixture = await ready()
    const silent = connect(fixture)
    await silent.opened
    const openedAt = performance.now()
    const timedOut = await silent.closed
    expect(timedOut.code).toBe(4408)
    expect(timedOut.at - openedAt).toBeGreaterThanOrEqual(1_900)
    expect(timedOut.at - openedAt).toBeLessThan(3_000)

    const wrong = connect(fixture)
    await wrong.opened
    wrong.socket.send(JSON.stringify({ type: 'auth', token: tokens.admin }))
    expect((await wrong.closed).code).toBe(4401)
    expect(fixture.events.filter(event => event.message === 'operation executed')).toEqual([])
  })

  it('refuses the upgrade while starting and never upgrades a route without WebSocket hooks', async () => {
    const starting = await serve({ FIXTURE_STARTUP_DELAY_MS: '1500' })
    expect(await upgradeStatus(starting, '/v1/events')).toBe(503)
    const fixture = await ready()
    expect(await upgradeStatus(fixture, '/health')).toBe(200)
    expect(await upgradeStatus(fixture, '/does-not-exist')).toBe(404)
    expect(await upgradeStatus(fixture, '/v1/events')).toBe(101)
  })

  it('closes open sockets with 1001 at shutdown and exits 0', async () => {
    const fixture = await ready()
    const client = connect(fixture)
    await client.opened
    client.socket.send(JSON.stringify({ type: 'auth', token: tokens.agent }))
    await client.next(1)
    const exit = fixture.stop('SIGTERM')
    expect((await client.closed).code).toBe(1001)
    expect(await exit).toBe(0)
  })
})

// Raw upgrade request: the status line shows whether the server switched protocols or refused.
function upgradeStatus(fixture: ServingFixture, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(fixture.url(path), { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0) })
    request.on('response', (response) => { response.resume(); resolve(response.statusCode ?? 0) })
    request.on('error', reject)
    request.end()
  })
}
