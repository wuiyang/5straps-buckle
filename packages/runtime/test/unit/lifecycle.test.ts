import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { CLOSE_STAGES, createRuntimeOwner, defineSingleton, DisposalError, isRuntimeError, RuntimeErrorCode } from '../../src/index.js'

describe('runtime owner lifecycle', () => {
  it('F21 refuses business work while starting and after failed readiness', async () => {
    const owner = createRuntimeOwner({ services: [] })
    const gate = Promise.withResolvers<void>()
    const starting = owner.start(() => gate.promise)
    expect(() => owner.requireReady()).toThrow(expect.objectContaining({ code: RuntimeErrorCode.notReady, message: 'Runtime is still starting' }))
    gate.resolve()
    await starting
    expect(() => owner.requireReady()).not.toThrow()
    await expect(owner.ready).resolves.toBeUndefined()

    const failing = createRuntimeOwner({ services: [] })
    await expect(failing.start(() => { throw new Error('database missing') })).rejects.toThrow('database missing')
    expect(failing.state).toBe('failed')
    await expect(failing.ready).rejects.toThrow('database missing')
    expect(() => failing.requireReady()).toThrow(expect.objectContaining({ message: 'Runtime failed to start' }))
  })

  it('F22 closes stage by stage in the documented order, reverse registration within a stage', async () => {
    const order: string[] = []
    const owner = createRuntimeOwner({ services: [] })
    await owner.start((runtime) => {
      for (const stage of [...CLOSE_STAGES].reverse()) runtime.onClose(stage, stage, () => { order.push(stage) })
      runtime.onClose('locks', 'second lock', () => { order.push('second lock') })
    })
    await owner.close()
    expect(order).toEqual(['accept', 'timers', 'waiters', 'jobs', 'streams', 'second lock', 'locks', 'services', 'databases', 'sinks'])
    expect(owner.state).toBe('closed')
    expect(owner.signal.aborted).toBe(true)
  })

  it('F49 disposes services in reverse order and aggregates every failure', async () => {
    const order: string[] = []
    const first = defineSingleton({ name: 'First', create: () => 1, dispose: () => { order.push('first'); throw new Error('first failed') } })
    const second = defineSingleton({ name: 'Second', dependencies: [first], create: async ({ get }) => (await get(first)) + 1, dispose: () => { order.push('second') } })
    const owner = createRuntimeOwner({ services: [first, second] })
    await owner.start(async (runtime) => { await runtime.registry.useSingleton(second) })
    owner.onClose('sinks', 'flush', () => { order.push('flush'); throw new Error('flush failed') })
    const error = await owner.close().then(() => undefined, (failure: unknown) => failure)
    expect(order).toEqual(['second', 'first', 'flush'])
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).errors.map(item => (item as Error).message)).toEqual(['first failed', 'flush failed'])
  })

  it('F50 cleans up after a failed startup and keeps the original error', async () => {
    const closed: string[] = []
    const database = defineSingleton({ name: 'Database', create: () => 'db', dispose: () => { closed.push('database') } })
    const owner = createRuntimeOwner({ services: [database] })
    const original = new Error('migration failed')
    const error = await owner.start(async (runtime) => {
      await runtime.registry.useSingleton(database)
      runtime.onClose('locks', 'lock', () => { closed.push('lock'); throw new Error('lock release failed') })
      throw original
    }).then(() => undefined, (failure: unknown) => failure)
    expect(closed).toEqual(['lock', 'database'])
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).cause).toBe(original)
    expect((error as DisposalError).errors[0]).toBe(original)
    expect(owner.state).toBe('failed')
  })

  it('F51 closes idempotently and refuses new close steps and resolutions afterwards', async () => {
    let closes = 0
    const owner = createRuntimeOwner({ services: [] })
    await owner.start((runtime) => { runtime.onClose('databases', 'db', () => { closes += 1 }) })
    await Promise.all([owner.close(), owner.close(), owner.close()])
    await owner.close()
    expect(closes).toBe(1)
    expect(() => owner.onClose('sinks', 'late', () => {})).toThrow(expect.objectContaining({ code: RuntimeErrorCode.disposedRuntime }))
    expect(() => owner.requireReady()).toThrow(expect.objectContaining({ message: 'Runtime is shutting down' }))
  })

  it('bounds a stuck close step and still runs later stages', async () => {
    const order: string[] = []
    const owner = createRuntimeOwner({ services: [], closeStepTimeoutMs: 20 })
    await owner.start((runtime) => {
      runtime.onClose('jobs', 'stuck job', () => delay(1_000))
      runtime.onClose('sinks', 'flush', () => { order.push('flush') })
    })
    const error = await owner.close().then(() => undefined, (failure: unknown) => failure)
    expect(order).toEqual(['flush'])
    expect((error as DisposalError).errors.map(item => (item as Error).message)).toEqual(['Close step stuck job exceeded 20 ms'])
  })

  it('settles readiness when close interrupts startup', async () => {
    const owner = createRuntimeOwner({ services: [] })
    const gate = Promise.withResolvers<void>()
    const starting = owner.start(() => gate.promise)
    await owner.close({ reason: new Error('SIGTERM') })
    await expect(owner.ready).rejects.toThrow('SIGTERM')
    gate.resolve()
    const error = await starting.then(() => undefined, (failure: unknown) => failure)
    expect(isRuntimeError(error, RuntimeErrorCode.notReady)).toBe(true)
  })
})
