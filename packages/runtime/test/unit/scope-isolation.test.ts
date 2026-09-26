import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  activeTransactionLabel, createLogger, createOperationScope, createRuntimeOwner, createServiceRegistry, defineScoped, defineSingleton, DisposalError,
  isRuntimeError, runInScope, runInTransactionMarker, RuntimeError, RuntimeErrorCode, useScopeSafe, type LogEvent,
} from '../../src/index.js'

describe('runtime-held values never capture the caller scope (review H3)', () => {
  it('a singleton factory sees no scope and no transaction, and cannot resolve scoped services', async () => {
    const request = defineScoped({ name: 'Request', create: ({ scope }) => ({ user: scope!.context.actor }) })
    const seen: unknown[] = []
    const singleton = defineSingleton({ name: 'Probe', create: async () => {
      seen.push(useScopeSafe()?.context.actor, activeTransactionLabel())
      return registry.useScoped(request).then(value => value.user, (error: unknown) => (error as RuntimeError).code)
    } })
    const registry = createServiceRegistry({ services: [request, singleton] })
    const alice = registry.createScope({ context: { actor: 'alice' } })
    const value = await runInScope(alice, () => runInTransactionMarker('tx-alice', () => registry.useSingleton(singleton)))
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
    expect(performance.now() - started).toBeLessThan(1_000)
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
