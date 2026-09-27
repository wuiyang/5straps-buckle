import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  activeTransactionLabel, createLogger, createOperationScope, createRuntimeOwner, createServiceRegistry, defineScoped, defineSingleton, defineTransient, DisposalError,
  isRuntimeError, runInScope, runInTransactionMarker, RuntimeError, RuntimeErrorCode, useScope, useScopeSafe, type LogEvent,
} from '../../src/index.js'

describe('runtime-held values never capture the caller scope (review H3)', () => {
  it('a singleton factory sees no scope, and cannot resolve scoped services', async () => {
    const request = defineScoped({ name: 'Request', create: ({ scope }) => ({ user: scope!.context.actor }) })
    const seen: unknown[] = []
    const singleton = defineSingleton({ name: 'Probe', create: async () => {
      seen.push(useScopeSafe()?.context.actor, activeTransactionLabel())
      return registry.useScoped(request).then(value => value.user, (error: unknown) => (error as RuntimeError).code)
    } })
    const registry = createServiceRegistry({ services: [request, singleton] })
    const alice = registry.createScope({ context: { actor: 'alice' } })
    const value = await runInScope(alice, () => registry.useSingleton(singleton))
    expect(seen).toEqual([undefined, undefined])
    expect(value).toBe(RuntimeErrorCode.missingScope)
    await registry.dispose()
  })

  it('timers and listeners created inside a singleton factory do not carry the first caller correlation id', async () => {
    const events: LogEvent[] = []
    const logs = createLogger({ component: 'svc', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
    const ticker = defineSingleton({ name: 'Ticker', create: () => {
      const timer = setTimeout(() => logs.logger.info('tick'), 5)
      return { timer }
    } })
    const registry = createServiceRegistry({ services: [ticker] })
    const alice = registry.createScope({ context: { correlationId: 'alice-request' } })
    await runInScope(alice, () => registry.useSingleton(ticker))
    await delay(20)
    await logs.flush()
    expect(events).toEqual([expect.not.objectContaining({ correlationId: 'alice-request' })])
    await registry.dispose()
  })
})

describe('late scoped construction (review M3)', () => {
  it('disposes a scoped value that finishes after its scope began closing, and the scope waits for it', async () => {
    const disposed: string[] = []
    const gate = Promise.withResolvers<void>()
    const slow = defineScoped({ name: 'Slow', create: async () => { await gate.promise; return 'slow value' }, dispose: (value) => { disposed.push(value) } })
    const registry = createServiceRegistry({ services: [slow] })
    const scope = registry.createScope({ context: {} })
    const getting = registry.useScoped(slow, scope).catch((error: unknown) => error)
    const closing = scope.dispose()
    gate.resolve()
    await closing
    expect(disposed).toEqual(['slow value'])
    expect(isRuntimeError(await getting, RuntimeErrorCode.disposedScope)).toBe(true)
  })
})

describe('bounded scope drain (review M8)', () => {
  it('stops waiting for hung background work after drainTimeoutMs and still runs cleanups', async () => {
    const cleaned: string[] = []
    const scope = createOperationScope({ owner: Symbol('t'), context: {}, drainTimeoutMs: 20 })
    scope.registerBackgroundWork(new Promise(() => {}))
    scope.onDispose(() => { cleaned.push('cleanup') })
    const started = performance.now()
    const error = await scope.dispose().catch((failure: unknown) => failure)
    // Loose bound: well under the 10 s default drain it replaces.
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(cleaned).toEqual(['cleanup'])
    expect(error).toBeInstanceOf(DisposalError)
    expect(isRuntimeError((error as DisposalError).errors[0], RuntimeErrorCode.drainTimeout)).toBe(true)
  })
})

describe('one state across package copies (review M9)', () => {
  it('shares scopes, the transaction marker and error identity between two loaded copies', async () => {
    const first = await import('../../src/index.js')
    vi.resetModules()
    const second = await import('../../src/index.js')
    expect(second).not.toBe(first)
    const scope = first.createOperationScope({ owner: Symbol('t'), context: { correlationId: 'shared' } })
    expect(first.runInScope(scope, () => second.useScopeSafe())).toBe(scope)
    expect(first.runInTransactionMarker('tx', () => second.activeTransactionLabel())).toBe('tx')
    const notReady = new first.RuntimeError(first.RuntimeErrorCode.notReady, 'not ready')
    expect(second.isRuntimeError(notReady, second.RuntimeErrorCode.notReady)).toBe(true)
    expect(second.isRuntimeError(Object.assign(new Error('fs'), { code: 'ENOENT' }))).toBe(false)
  })
})

describe('close step bounds and the original error (review L4)', () => {
  it('records a timed-out step with a typed error, aborts its signal and still runs later stages', async () => {
    const order: string[] = []
    let stepSignal: AbortSignal | undefined
    const owner = createRuntimeOwner({ services: [], closeStepTimeoutMs: 20 })
    await owner.start((runtime) => {
      runtime.onClose('jobs', 'hung job', (signal) => { stepSignal = signal; return new Promise(() => {}) })
      runtime.onClose('databases', 'database', () => { order.push('database') })
    })
    const error = await owner.close().catch((failure: unknown) => failure)
    expect(order).toEqual(['database'])
    expect(stepSignal?.aborted).toBe(true)
    expect(isRuntimeError((error as DisposalError).errors[0], RuntimeErrorCode.closeStepTimeout)).toBe(true)
  })

  it('names the original startup failure at the top of the DisposalError', async () => {
    const owner = createRuntimeOwner({ services: [] })
    const error = await owner.start((runtime) => {
      runtime.onClose('databases', 'database', () => { throw new Error('close failed') })
      throw new Error('database missing')
    }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).message).toContain('database missing')
    expect((error as DisposalError).errors[0]).toEqual(new Error('database missing'))
  })
})

describe('scoped construction runs in its owning scope (registry-scope-fixes-1)', () => {
  it('a scoped or transient factory sees the scope it belongs to, not the caller scope', async () => {
    const events: LogEvent[] = []
    const logs = createLogger({ component: 'svc', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
    const session = defineScoped({ name: 'Session', create: ({ scope }) => {
      logs.logger.info('session created')
      return { boundActor: useScope().context.actor, ownerActor: scope!.context.actor }
    } })
    const probe = defineTransient({ name: 'Probe', create: () => ({ actor: useScope().context.actor }) })
    const registry = createServiceRegistry({ services: [session, probe] })
    const alice = registry.createScope({ context: { actor: 'alice', correlationId: 'alice-req' } })
    const bob = registry.createScope({ context: { actor: 'bob', correlationId: 'bob-req' } })
    expect(await runInScope(alice, () => registry.useScoped(session, bob))).toEqual({ boundActor: 'bob', ownerActor: 'bob' })
    expect(await runInScope(alice, () => registry.createTransient(probe, bob))).toEqual({ actor: 'bob' })
    const carol = registry.createScope({ context: { actor: 'carol' } })
    expect(await registry.useScoped(session, carol)).toEqual({ boundActor: 'carol', ownerActor: 'carol' })
    await logs.flush()
    expect(events.map(event => event.correlationId)).toEqual(['bob-req', carol.context.correlationId])
    await registry.dispose()
  })
})

describe('scope disposal order and bounds (registry-scope-fixes-2, -3)', () => {
  it('bounds the wait for a hung scoped factory and still disposes singletons', async () => {
    const disposed: string[] = []
    const hung = defineScoped({ name: 'Hung', create: () => new Promise<never>(() => {}) })
    const config = defineSingleton({ name: 'Config', create: () => 'config', dispose: () => { disposed.push('config') } })
    const registry = createServiceRegistry({ services: [hung, config] })
    await registry.useSingleton(config)
    const scope = registry.createScope({ context: {}, drainTimeoutMs: 20 })
    void registry.useScoped(hung, scope).catch(() => undefined)
    const error = await Promise.race([scope.dispose().then(() => 'resolved', (failure: unknown) => failure), delay(5_000).then(() => 'still pending')])
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).errors.map(item => (item as RuntimeError).code)).toEqual([RuntimeErrorCode.drainTimeout])
    expect(((error as DisposalError).errors[0] as Error).message).toContain('Hung')
    expect(await Promise.race([registry.dispose().then(() => 'disposed'), delay(5_000).then(() => 'still pending')])).toBe('disposed')
    expect(disposed).toEqual(['config'])
  })

  it('disposes a late construction while its dependencies are still open, in reverse dependency order', async () => {
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    const b = defineScoped({ name: 'B', create: () => ({ open: true }), dispose: (value) => { value.open = false; order.push('dispose B') } })
    const a = defineScoped({ name: 'A', dependencies: [b], create: async ({ get }) => {
      const dependency = await get(b)
      await gate.promise
      order.push(`A finished; B open ${dependency.open}`)
      return { dependency }
    }, dispose: () => { order.push('dispose A') } })
    const registry = createServiceRegistry({ services: [a, b] })
    const scope = registry.createScope({ context: {} })
    const getting = registry.useScoped(a, scope).catch((error: unknown) => error)
    await delay(1)
    const closing = scope.dispose()
    setTimeout(() => gate.resolve(), 20)
    await closing
    expect(order).toEqual(['A finished; B open true', 'dispose A', 'dispose B'])
    expect(isRuntimeError(await getting, RuntimeErrorCode.disposedScope)).toBe(true)
  })
})

describe('late constructions (registry-scope-fixes-7, -8)', () => {
  it('refuses a late value without a dispose function and reports a failing late dispose', async () => {
    const gate = Promise.withResolvers<void>()
    const plain = defineScoped({ name: 'Plain', create: async () => { await gate.promise; return 'plain' } })
    const failing = defineScoped({ name: 'Failing', create: async () => { await gate.promise; return 'failing' }, dispose: () => { throw new Error('late dispose failed') } })
    const registry = createServiceRegistry({ services: [plain, failing] })
    const scope = registry.createScope({ context: {} })
    const gettingPlain = registry.useScoped(plain, scope).catch((error: unknown) => error)
    const gettingFailing = registry.useScoped(failing, scope).catch((error: unknown) => error)
    const closing = scope.dispose().then(() => undefined, (error: unknown) => error)
    setTimeout(() => gate.resolve(), 20)
    expect(isRuntimeError(await gettingPlain, RuntimeErrorCode.disposedScope)).toBe(true)
    const refused = await gettingFailing
    expect(isRuntimeError(refused, RuntimeErrorCode.disposedScope)).toBe(true)
    expect((refused as Error).cause).toEqual(new Error('late dispose failed'))
    const closed = await closing
    expect(closed).toBeInstanceOf(DisposalError)
    expect((closed as DisposalError).errors).toEqual([new Error('late dispose failed')])
  })
})

describe('runtime close fits scope drains inside the services step (registry-scope-fixes-4)', () => {
  it('drains active scopes concurrently within a default bound below the close step bound', async () => {
    const order: string[] = []
    const store = defineSingleton({ name: 'Store', create: () => 'store', dispose: () => { order.push('singleton disposed') } })
    const owner = createRuntimeOwner({ services: [store], closeStepTimeoutMs: 400 })
    await owner.start(async (runtime) => {
      await runtime.registry.useSingleton(store)
      runtime.onClose('databases', 'database', () => { order.push('database closed') })
    })
    for (const actor of ['first', 'second']) owner.registry.createScope({ context: { actor } }).registerBackgroundWork(new Promise(() => {}))
    const error = await owner.close().then(() => undefined, (failure: unknown) => failure)
    expect(order).toEqual(['singleton disposed', 'database closed'])
    const codes = (error as DisposalError).errors.flatMap(item => (item instanceof AggregateError ? item.errors : [item])).map(item => (item as RuntimeError).code)
    expect(codes).toEqual([RuntimeErrorCode.drainTimeout, RuntimeErrorCode.drainTimeout])
  })

  it('refuses a drain bound that does not fit inside the close step bound', () => {
    expect(() => createRuntimeOwner({ services: [], closeStepTimeoutMs: 100, drainTimeoutMs: 100 })).toThrow(TypeError)
  })

  it('stops before singleton disposal once the services step is abandoned', async () => {
    const order: string[] = []
    const store = defineSingleton({ name: 'Store', create: () => 'store', dispose: () => { order.push('singleton disposed') } })
    const owner = createRuntimeOwner({ services: [store], closeStepTimeoutMs: 100 })
    await owner.start(async (runtime) => {
      await runtime.registry.useSingleton(store)
      runtime.onClose('databases', 'database', () => { order.push('database closed') })
    })
    owner.registry.createScope({ context: {}, drainTimeoutMs: 300 }).registerBackgroundWork(new Promise(() => {}))
    await owner.close().catch(() => undefined)
    await delay(400)
    expect(order).toEqual(['database closed'])
  })
})

describe('singletons are never first built inside a transaction (registry-scope-fixes-5)', () => {
  it('refuses the first construction inside a transaction and serves an already built singleton', async () => {
    let runs = 0
    const audit = defineSingleton({ name: 'Audit', create: () => ({ runs: ++runs }) })
    const registry = createServiceRegistry({ services: [audit] })
    const refused = await runInTransactionMarker('notes:tx', () => registry.useSingleton(audit)).catch((error: unknown) => error)
    expect(isRuntimeError(refused, RuntimeErrorCode.singletonInsideTransaction)).toBe(true)
    expect(runs).toBe(0)
    const built = await registry.useSingleton(audit)
    expect(await runInTransactionMarker('notes:tx', () => registry.useSingleton(audit))).toBe(built)
  })
})

describe('background work drains with a live scope (registry-scope-fixes-6)', () => {
  it('keeps the signal live and cached scoped services usable while draining, then aborts at the drain bound', async () => {
    const operation = defineScoped({ name: 'Operation', create: () => ({ id: 'op' }) })
    const registry = createServiceRegistry({ services: [operation] })
    const scope = registry.createScope({ context: {}, drainTimeoutMs: 100 })
    const cached = await registry.useScoped(operation, scope)
    const seen: unknown[] = []
    scope.registerBackgroundWork((async () => {
      await delay(5)
      seen.push(scope.signal.aborted, (await runInScope(scope, () => registry.useScoped(operation))) === cached)
    })())
    let hungSignal: AbortSignal | undefined
    const second = registry.createScope({ context: {}, drainTimeoutMs: 30 })
    second.registerBackgroundWork(new Promise((resolve) => { hungSignal = second.signal; second.signal.addEventListener('abort', resolve) }))
    await scope.dispose()
    expect(seen).toEqual([false, true])
    const drained = await second.dispose().then(() => 'clean', (error: unknown) => error)
    expect(hungSignal?.aborted).toBe(true)
    expect(drained).toBeInstanceOf(DisposalError)
  })
})

describe('disposal errors and close reasons (registry-scope-fixes-10, -13)', () => {
  it('-10 recognises a DisposalError by code, and flattens one thrown by another loaded copy', async () => {
    expect(isRuntimeError(new DisposalError([], 'x'), RuntimeErrorCode.disposal)).toBe(true)
    vi.resetModules()
    const other = await import('../../src/index.js')
    const owner = createRuntimeOwner({ services: [] })
    await owner.start((runtime) => {
      runtime.onClose('databases', 'foreign copy', () => { throw new other.DisposalError([new Error('first'), new Error('second')], 'nested') })
    })
    const error = await owner.close().catch((failure: unknown) => failure)
    expect((error as DisposalError).errors).toEqual([new Error('first'), new Error('second')])
  })

  it('-13 keeps an ordinary close reason out of the reported failures', async () => {
    const owner = createRuntimeOwner({ services: [] })
    await owner.start((runtime) => { runtime.onClose('databases', 'database', () => { throw new Error('close failed') }) })
    const error = await owner.close({ reason: new Error('SIGTERM') }).catch((failure: unknown) => failure)
    expect((error as DisposalError).errors).toEqual([new Error('close failed')])
    expect((error as DisposalError).message).not.toContain('SIGTERM')
  })
})
