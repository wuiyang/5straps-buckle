import { setTimeout as delay } from 'node:timers/promises'
import { H3, HTTPError, type H3Event } from 'h3'
import { HookableCore } from 'hookable'
import type { NitroApp, NitroAppPlugin, NitroRuntimeHooks } from 'nitro/types'
import { describe, expect, it } from 'vitest'
import { createLogger, createRuntimeOwner, defineScoped, useScope, type LogEvent, type RuntimeOwner } from '../../src/index.js'
import { bindHost, createRequestCli, defineContextPlugin, defineGuardedHandler, NitroErrorCode, registerCliListener, requireReady, useHost, type Guard } from '../../src/nitro/index.js'

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
    expect(await response.json()).toEqual({ actor: 'agent', correlationId: 'req-1', same: true })
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

  it('F09 propagates a listener rejection through callHook', async () => {
    const { nitroApp } = createTestNitroApp({ plugins: [], routes: () => {} })
    registerCliListener(nitroApp, async () => { throw new Error('cli crashed') })
    const error = await createRequestCli(nitroApp)({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } }).catch((failure: unknown) => failure)
    expect((error as Error & { cause: Error }).cause.message).toBe('cli crashed')
  })

  it('treats an app without hooks as having no listener', async () => {
    const bare: NitroApp = { fetch: () => new Response() }
    await expect(createRequestCli(bare)({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } })).resolves.toMatchObject({ status: 'unavailable' })
    expect(() => registerCliListener(bare, async () => {})).toThrow(expect.objectContaining({ code: NitroErrorCode.hooksUnavailable }))
  })
})
