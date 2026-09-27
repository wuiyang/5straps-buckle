import { setTimeout as delay } from 'node:timers/promises'
import { H3, HTTPError, type H3Event } from 'h3'
import { HookableCore } from 'hookable'
import type { NitroApp, NitroAppPlugin, NitroRuntimeHooks } from 'nitro/types'
import { describe, expect, it, vi } from 'vitest'
import { createLogger, createRuntimeOwner, defineScoped, useScope, type LogEvent, type RuntimeOwner } from '../../src/index.js'
import { bindHost, createRequestCli, defineContextPlugin, defineGuardedHandler, NitroErrorCode, registerCliListener, requireReady, runGuards, useHost, type Guard } from '../../src/nitro/index.js'

// Mirrors the createNitroApp template in nitro 3.0.260903-beta (_build/common.mjs): request hook
// failures are captured and the request continues.
function createTestNitroApp(options: { plugins: NitroAppPlugin[]; routes: (app: H3) => void; failingRequestHook?: boolean }) {
  const hooks = new HookableCore<NitroRuntimeHooks>()
  const captured: unknown[] = []
  const h3 = new H3({ silent: true, onRequest: event => hooks.callHook('request', event)?.catch?.((error: unknown) => { captured.push(error) }) })
  const nitroApp = { fetch: (request: Request) => h3.fetch(request), h3, hooks } satisfies NitroApp
  if (options.failingRequestHook) hooks.hook('request', () => { throw new Error('request hook exploded') })
  for (const plugin of options.plugins) plugin(nitroApp)
  options.routes(h3)
  return { nitroApp, captured }
}

async function readyRuntime(): Promise<RuntimeOwner> {
  const owner = createRuntimeOwner({ services: [operation] })
  await owner.start(() => {})
  return owner
}

const operation = defineScoped({ name: 'Operation', create: ({ scope }) => ({ correlationId: scope!.context.correlationId }) })
const events: LogEvent[] = []
const logger = createLogger({ component: 'http', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
const agentToken: Guard = (event) => {
  if (event.req.headers.get('authorization') !== 'Bearer agent') throw HTTPError.status(401, 'Unauthorized')
  return { actor: 'agent' }
}

function notesRoute(counter: { calls: number }) {
  return defineGuardedHandler({
    guards: [agentToken],
    handler: async (event, scope) => {
      counter.calls += 1
      const service = await event.context.runtime!.registry.useScoped(operation)
      return { actor: scope.context.actor, correlationId: useScope().context.correlationId, same: service.correlationId === scope.context.correlationId }
    },
  })
}

describe('Nitro host bridge and context plugin', () => {
  it('binds one host per app and exposes it through a registered symbol slot', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    const host = { owner: await readyRuntime(), services: {}, logger: logger.logger }
    const unbind = bindHost(nitroApp, host)
    expect(useHost(nitroApp)).toBe(host)
    expect(() => bindHost(nitroApp, host)).toThrow(expect.objectContaining({ code: NitroErrorCode.hostBound }))
    unbind()
    expect(useHost(nitroApp)).toBeUndefined()
  })

  it('runs a guarded handler in its own scope with the guard identity and the request id', async () => {
    const counter = { calls: 0 }
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/v1/notes', notesRoute(counter)) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const response = await nitroApp.fetch(new Request('http://local/v1/notes', { headers: { authorization: 'Bearer agent', 'x-request-id': 'req-1' } }))
    expect(response.status).toBe(200)
    const body = await response.json() as { actor: string; correlationId: string; same: boolean }
    expect(body).toEqual({ actor: 'agent', correlationId: expect.any(String), same: true })
    expect(body.correlationId).not.toBe('req-1')
    await logger.flush()
    expect(events.at(-1)).toMatchObject({ message: 'request completed', fields: { outcome: 'ok', path: '/v1/notes' } })
  })

  it('refuses with 503 during the startup window and 401 on a bad token, never running the handler', async () => {
    const counter = { calls: 0 }
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/v1/notes', notesRoute(counter)) })
    const request = () => nitroApp.fetch(new Request('http://local/v1/notes', { headers: { authorization: 'Bearer agent' } }))
    expect((await request()).status).toBe(503)
    const owner = createRuntimeOwner({ services: [operation] })
    bindHost(nitroApp, { owner, services: {}, logger: logger.logger })
    const gate = Promise.withResolvers<void>()
    const starting = owner.start(() => gate.promise)
    expect((await request()).status).toBe(503)
    gate.resolve()
    await starting
    expect((await nitroApp.fetch(new Request('http://local/v1/notes', { headers: { authorization: 'Bearer admin' } }))).status).toBe(401)
    expect(counter.calls).toBe(0)
    expect((await request()).status).toBe(200)
  })

  it('fails closed when a request hook throws before context is set', async () => {
    const counter = { calls: 0 }
    const { nitroApp, captured } = createTestNitroApp({ failingRequestHook: true, plugins: [defineContextPlugin()], routes: app => app.get('/v1/notes', notesRoute(counter)) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const response = await nitroApp.fetch(new Request('http://local/v1/notes', { headers: { authorization: 'Bearer agent' } }))
    expect(response.status).toBe(503)
    expect(counter.calls).toBe(0)
    expect(captured).toEqual([new Error('request hook exploded')])
  })

  it('M8 responds while hung background work is still draining', async () => {
    let requestScope: { state: string } | undefined
    const hung = defineGuardedHandler({ guards: [], handler: (_, scope) => {
      requestScope = scope
      scope.registerBackgroundWork(new Promise(() => {}))
      return { ok: true }
    } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/hung', hung) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    // Loose bound: well under the 10 s default drain the response used to wait for.
    const response = await Promise.race([nitroApp.fetch(new Request('http://local/hung')), delay(5_000).then(() => undefined)])
    expect(response?.status).toBe(200)
    expect(requestScope?.state).toBe('draining')
  })

  it('L8 keeps a client x-request-id as a separate field, never as the correlation id', async () => {
    const seen: { correlationId: string; clientRequestId?: string }[] = []
    const route = defineGuardedHandler({ guards: [], handler: (_, scope) => { seen.push(scope.context); return { ok: true } } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/id', route) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    await Promise.all([1, 2].map(() => nitroApp.fetch(new Request('http://local/id', { headers: { 'x-request-id': 'same-id' } }))))
    await nitroApp.fetch(new Request('http://local/id', { headers: { 'x-request-id': 'bad id with spaces' } }))
    expect(seen.map(context => context.clientRequestId)).toEqual(['same-id', 'same-id', undefined])
    expect(new Set(seen.map(context => context.correlationId)).size).toBe(3)
  })

  it('L9 refuses a later guard that overwrites the actor an earlier guard set', async () => {
    const counter = { calls: 0 }
    const impostor: Guard = () => ({ actor: 'admin' })
    const route = defineGuardedHandler({ guards: [agentToken, impostor], handler: () => { counter.calls += 1; return { ok: true } } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/actor', route) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const response = await nitroApp.fetch(new Request('http://local/actor', { headers: { authorization: 'Bearer agent' } }))
    expect(response.status).toBe(500)
    expect(counter.calls).toBe(0)
    const error = await runGuardsForTest([agentToken, impostor]).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: NitroErrorCode.identityOverwrite })
  })

  it('L10 keeps the scope open for a returned ReadableStream and disposes it when an unread body goes idle', async () => {
    const scopes: { state: string }[] = []
    const chunks = () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('a'))
      controller.enqueue(new TextEncoder().encode('b'))
      controller.close()
    } })
    const plain = defineGuardedHandler({ guards: [], handler: (_, scope) => { scopes.push(scope); return chunks() } })
    const idle = defineGuardedHandler({ guards: [], bodyIdleTimeoutMs: 30, handler: (_, scope) => { scopes.push(scope); return new Response(chunks()) } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: (app) => { app.get('/plain', plain); app.get('/idle', idle) } })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const streamed = await nitroApp.fetch(new Request('http://local/plain'))
    expect(scopes[0]!.state).toBe('active')
    expect(await streamed.text()).toBe('ab')
    await delay(1)
    expect(scopes[0]!.state).toBe('disposed')

    await nitroApp.fetch(new Request('http://local/idle'))
    expect(scopes[1]!.state).toBe('active')
    await vi.waitFor(() => expect(scopes[1]!.state).toBe('disposed'), { timeout: 5_000, interval: 10 })
  })

  it('exposes requireReady as a plain guard for middleware use', async () => {
    const event = { context: {} } as H3Event
    expect(() => requireReady(event)).toThrow(expect.objectContaining({ status: 503 }))
  })

  it('keeps the request scope open until a streamed body finishes or is cancelled', async () => {
    const scopes: { state: () => string }[] = []
    const stream = defineGuardedHandler({
      guards: [],
      handler: (_, scope) => {
        scopes.push({ state: () => scope.state })
        let sent = 0
        return new Response(new ReadableStream({ async pull(controller) {
          await delay(5)
          if (sent++ < 2) controller.enqueue(new TextEncoder().encode(`chunk ${sent}\n`))
          else controller.close()
        } }))
      },
    })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/stream', stream) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const finished = await nitroApp.fetch(new Request('http://local/stream'))
    expect(scopes[0]!.state()).toBe('active')
    expect(await finished.text()).toBe('chunk 1\nchunk 2\n')
    await delay(1)
    expect(scopes[0]!.state()).toBe('disposed')

    const cancelled = await nitroApp.fetch(new Request('http://local/stream'))
    const reader = cancelled.body!.getReader()
    await reader.read()
    expect(scopes[1]!.state()).toBe('active')
    await reader.cancel('client went away')
    await delay(1)
    expect(scopes[1]!.state()).toBe('disposed')
  })
})

describe('streamed body ownership and completion lines (guards-gate-5, -6, -7)', () => {
  it('guards-gate-5 disposes the scope and cancels the source when an idle body is never read', async () => {
    const scopes: { state: string }[] = []
    let cancelled = false
    const idle = defineGuardedHandler({ guards: [], bodyIdleTimeoutMs: 30, handler: (_, scope) => {
      scopes.push(scope)
      return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true } }))
    } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/idle', idle) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    await nitroApp.fetch(new Request('http://local/idle'))
    await vi.waitFor(() => expect({ state: scopes[0]!.state, cancelled }).toEqual({ state: 'disposed', cancelled: true }), { timeout: 1_000, interval: 10 })
  })

  it('guards-gate-6 reads a pull-driven body inside the request scope', async () => {
    const correlation: string[] = []
    const stream = defineGuardedHandler({ guards: [], handler: (event, scope) => {
      correlation.push(scope.context.correlationId)
      async function* chunks() {
        for (let index = 0; index < 3; index += 1) {
          await delay(2)
          const service = await event.context.runtime!.registry.useScoped(operation)
          yield new TextEncoder().encode(`${useScope().context.correlationId}|${service.correlationId}\n`)
        }
      }
      const iterator = chunks()
      // What ReadableStream.from(generator) does: each read drives the generator.
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } }))
    } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: app => app.get('/pull', stream) })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    const response = await nitroApp.fetch(new Request('http://local/pull'))
    const reader = response.body!.getReader()
    let text = ''
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      text += new TextDecoder().decode(part.value)
      await delay(5)
    }
    const expected = `${correlation[0]}|${correlation[0]}`
    expect(text.trim().split('\n')).toEqual([expected, expected, expected])
  })

  it('guards-gate-7 logs the completion line inside the scope with the correlation id and the client request id', async () => {
    const seen: string[] = []
    const ok = defineGuardedHandler({ guards: [], handler: (_, scope) => { seen.push(scope.context.correlationId); return { ok: true } } })
    const failing = defineGuardedHandler({ guards: [], handler: (_, scope) => { seen.push(scope.context.correlationId); throw HTTPError.status(409, 'Conflict') } })
    const streamed = defineGuardedHandler({ guards: [], handler: (_, scope) => { seen.push(scope.context.correlationId); return new Response('chunk') } })
    const { nitroApp } = createTestNitroApp({ plugins: [defineContextPlugin()], routes: (app) => { app.get('/ok', ok); app.get('/fail', failing); app.get('/streamed', streamed) } })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: logger.logger })
    for (const path of ['/ok', '/fail', '/streamed']) await (await nitroApp.fetch(new Request(`http://local${path}`, { headers: { 'x-request-id': `client-${path.slice(1)}` } }))).text()
    await delay(1)
    await logger.flush()
    const completed = ['/ok', '/fail', '/streamed'].map(path => events.findLast(event => event.message === 'request completed' && event.fields?.path === path))
    expect(completed.map(event => [event?.correlationId, event?.fields?.clientRequestId, event?.fields?.outcome])).toEqual([
      [seen[0], 'client-ok', 'ok'],
      [seen[1], 'client-fail', 'error 409'],
      [seen[2], 'client-streamed', 'streamed 200'],
    ])
  })
})

async function runGuardsForTest(guards: Guard[]): Promise<unknown> {
  const event = { req: new Request('http://local/', { headers: { authorization: 'Bearer agent' } }), context: {} } as unknown as H3Event
  return runGuards(event, guards)
}

describe('createRequestCli over Nitro hooks', () => {
  it('F07 answers through the registered cli:call listener', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    const requestCli = createRequestCli(nitroApp)
    const request = { id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'write file' }, wait: { mode: 'finite' as const, timeoutMs: 1_000 } }
    await expect(requestCli(request)).resolves.toEqual({ status: 'unavailable', requestId: 'r1', reason: 'no_listener' })
    const unregister = registerCliListener(nitroApp, async (item, respond) => { respond({ status: 'answered', requestId: item.id, answer: { choice: 'approve' } }) })
    expect(() => registerCliListener(nitroApp, async () => {})).toThrow(expect.objectContaining({ code: NitroErrorCode.cliListenerRegistered }))
    await expect(requestCli(request)).resolves.toEqual({ status: 'answered', requestId: 'r1', answer: { choice: 'approve' } })
    unregister()
    await expect(requestCli(request)).resolves.toMatchObject({ status: 'unavailable', reason: 'no_listener' })
  })

  it('F09 propagates a listener rejection', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    registerCliListener(nitroApp, async () => { throw new Error('cli crashed') })
    const error = await createRequestCli(nitroApp)({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } }).catch((failure: unknown) => failure)
    expect((error as Error & { cause: Error }).cause.message).toBe('cli crashed')
  })

  it('M1 passes the listener a signal that aborts when the caller cancels', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    let listenerSignal: AbortSignal | undefined
    registerCliListener(nitroApp, (_, __, options) => { listenerSignal = options?.signal; return new Promise(() => {}) })
    const controller = new AbortController()
    const waiting = createRequestCli(nitroApp)({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } }, { signal: controller.signal })
    await delay(1)
    expect(listenerSignal?.aborted).toBe(false)
    controller.abort('client went away')
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' })
    expect(listenerSignal?.aborted).toBe(true)
  })

  it('B1 accepts only the registered listener\'s answer; an observer that responds is ignored and logged once', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    const warnings: LogEvent[] = []
    const hostLogger = createLogger({ component: 'http', sinks: [{ name: 'memory', write: (event) => { warnings.push(event) } }] })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: hostLogger.logger })
    const observed: string[] = []
    nitroApp.hooks.hook('cli:call', async (item, respond) => {
      observed.push(item.id)
      respond({ status: 'denied', requestId: item.id, reason: 'observer' })
      respond({ status: 'denied', requestId: item.id, reason: 'observer again' })
    })
    const request = { id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' as const } }
    await expect(createRequestCli(nitroApp)(request)).resolves.toMatchObject({ status: 'unavailable', reason: 'no_listener' })
    registerCliListener(nitroApp, async (item, respond) => {
      await delay(5)
      respond({ status: 'answered', requestId: item.id, answer: { choice: 'approve' } })
    })
    await expect(createRequestCli(nitroApp)(request)).resolves.toEqual({ status: 'answered', requestId: 'r1', answer: { choice: 'approve' } })
    await hostLogger.flush()
    expect(observed).toEqual(['r1'])
    expect(warnings.filter(event => event.message === 'cli:call observer response ignored')).toEqual([
      expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ requestId: 'r1' }) }),
    ])
  })

  it('B1 keeps an observer failure out of the outcome and logs it', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    const warnings: LogEvent[] = []
    const hostLogger = createLogger({ component: 'http', sinks: [{ name: 'memory', write: (event) => { warnings.push(event) } }] })
    bindHost(nitroApp, { owner: await readyRuntime(), services: {}, logger: hostLogger.logger })
    nitroApp.hooks.hook('cli:call', async () => { throw new Error('observer crashed') })
    registerCliListener(nitroApp, async (item, respond) => {
      await delay(5)
      respond({ status: 'denied', requestId: item.id, reason: 'owner said no' })
    })
    await expect(createRequestCli(nitroApp)({ id: 'r2', kind: 'approval', correlationId: 'c2', action: { summary: 'x' }, wait: { mode: 'indefinite' } }))
      .resolves.toEqual({ status: 'denied', requestId: 'r2', reason: 'owner said no' })
    await hostLogger.flush()
    expect(warnings.filter(event => event.message === 'cli:call observer failed')).toEqual([
      expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ requestId: 'r2' }) }),
    ])
  })

  it('treats an app without hooks as having no listener', async () => {
    const bare: NitroApp = { fetch: () => new Response() }
    await expect(createRequestCli(bare)({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } })).resolves.toMatchObject({ status: 'unavailable' })
    expect(() => registerCliListener(bare, async () => {})).toThrow(expect.objectContaining({ code: NitroErrorCode.hooksUnavailable }))
  })
})
