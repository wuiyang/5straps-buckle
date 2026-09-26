import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createServiceRegistry, defineScoped, defineSingleton, defineTransient, isRuntimeError, runInScope, RuntimeErrorCode, type AnyServiceDefinition } from '../../src/index.js'

function expectCode(error: unknown, code: string): void {
  expect(isRuntimeError(error, code), `expected ${code}, got ${String(error)}`).toBe(true)
}

describe('service registry lifetimes', () => {
  it('F41 creates a singleton once under concurrent getters and does not cache a rejection', async () => {
    let calls = 0
    const flaky = defineSingleton({ name: 'Flaky', async create() {
      calls += 1
      await delay(5)
      if (calls === 1) throw new Error('first attempt fails')
      return { attempt: calls }
    } })
    const registry = createServiceRegistry({ services: [flaky] })
    const first = await Promise.allSettled(Array.from({ length: 10 }, () => registry.useSingleton(flaky)))
    expect(calls).toBe(1)
    expect(first.every(result => result.status === 'rejected')).toBe(true)
    const second = await Promise.all(Array.from({ length: 10 }, () => registry.useSingleton(flaky)))
    expect(calls).toBe(2)
    expect(new Set(second).size).toBe(1)
  })

  it('F42 reuses a scoped service within one scope', async () => {
    let calls = 0
    const operation = defineScoped({ name: 'Operation', create: () => ({ id: ++calls }) })
    const registry = createServiceRegistry({ services: [operation] })
    const scope = registry.createScope({ context: { correlationId: 'c-1' } })
    const [a, b] = await Promise.all([registry.useScoped(operation, scope), runInScope(scope, () => registry.useScoped(operation))])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  it('F43 isolates scoped services across 20 concurrent scopes', async () => {
    const operation = defineScoped({ name: 'Operation', create: ({ scope }) => ({ correlationId: scope!.context.correlationId }) })
    const registry = createServiceRegistry({ services: [operation] })
    const results = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const scope = registry.createScope({ context: { correlationId: `c-${index}` } })
      return runInScope(scope, async () => {
        await delay(20 - index)
        const service = await registry.useScoped(operation)
        return service.correlationId === `c-${index}` ? service : undefined
      })
    }))
    expect(results.every(Boolean)).toBe(true)
    expect(new Set(results).size).toBe(20)
  })

  it('F44 creates a fresh transient per call and disposes it with its scope', async () => {
    const disposed: number[] = []
    let calls = 0
    const probe = defineTransient({ name: 'Probe', create: () => ({ id: ++calls }), dispose: value => { disposed.push(value.id) } })
    const registry = createServiceRegistry({ services: [probe] })
    const scope = registry.createScope({ context: {} })
    const a = await registry.createTransient(probe, scope)
    const b = await registry.createTransient(probe, scope)
    expect(a).not.toBe(b)
    await scope.dispose()
    expect(disposed).toEqual([2, 1])
  })

  it('F45 fails clearly when a scoped getter runs outside any scope', async () => {
    const operation = defineScoped({ name: 'Operation', create: () => ({}) })
    const registry = createServiceRegistry({ services: [operation] })
    await registry.useScoped(operation).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.missingScope))
  })

  it('F46 rejects disposed scopes and scopes from another runtime', async () => {
    const operation = defineScoped({ name: 'Operation', create: () => ({}) })
    const registry = createServiceRegistry({ services: [operation] })
    const other = createServiceRegistry({ services: [operation] })
    const disposed = registry.createScope({ context: {} })
    await disposed.dispose()
    await registry.useScoped(operation, disposed).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.disposedScope))
    await registry.useScoped(operation, other.createScope({ context: {} })).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.foreignScope))
    expect(() => runInScope(disposed, () => 1)).toThrow(/is disposed/)
  })

  it('F47 rejects circular dependencies at registration', () => {
    const dependencies: AnyServiceDefinition[] = []
    const a = defineSingleton({ name: 'A', dependencies, create: () => 'a' })
    const b = defineSingleton({ name: 'B', dependencies: [a], create: () => 'b' })
    dependencies.push(b)
    try {
      createServiceRegistry({ services: [a, b] })
      expect.fail('registered a cycle')
    } catch (error) {
      expectCode(error, RuntimeErrorCode.circularDependency)
      expect((error as Error).message).toContain('A -> B -> A')
    }
  })

  it('F48 rejects singletons that capture scoped services, directly or through a transient', () => {
    const scoped = defineScoped({ name: 'Scoped', create: () => ({}) })
    const bridge = defineTransient({ name: 'Bridge', dependencies: [scoped], create: () => ({}) })
    const direct = defineSingleton({ name: 'Direct', dependencies: [scoped], create: () => ({}) })
    const indirect = defineSingleton({ name: 'Indirect', dependencies: [bridge], create: () => ({}) })
    expect(() => createServiceRegistry({ services: [scoped, direct] })).toThrow(/Singleton Direct cannot depend on scope-bound Scoped/)
    expect(() => createServiceRegistry({ services: [scoped, bridge, indirect] })).toThrow(/Singleton Indirect cannot depend on scope-bound Bridge/)
  })

  it('resolves only declared and registered dependencies', async () => {
    const config = defineSingleton({ name: 'Config', create: () => ({ port: 1 }) })
    const sneaky = defineSingleton({ name: 'Sneaky', create: ({ get }) => get(config) })
    const unregistered = defineSingleton({ name: 'Unregistered', create: () => 1 })
    const registry = createServiceRegistry({ services: [config, sneaky] })
    await registry.useSingleton(sneaky).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.undeclaredDependency))
    await registry.useSingleton(unregistered).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.unregisteredService))
    expect(() => createServiceRegistry({ services: [defineSingleton({ name: 'Needs', dependencies: [config], create: () => 1 })] })).toThrow(/not registered/)
  })

  it('disposes singletons in reverse creation order, once, then refuses resolution', async () => {
    const order: string[] = []
    const db = defineSingleton({ name: 'Db', create: () => 'db', dispose: () => { order.push('db') } })
    const repo = defineSingleton({ name: 'Repo', dependencies: [db], create: async ({ get }) => `${await get(db)}-repo`, dispose: () => { order.push('repo') } })
    const registry = createServiceRegistry({ services: [db, repo] })
    expect(await registry.useSingleton(repo)).toBe('db-repo')
    await Promise.all([registry.dispose(), registry.dispose()])
    expect(order).toEqual(['repo', 'db'])
    await registry.useSingleton(db).then(() => expect.fail('resolved'), error => expectCode(error, RuntimeErrorCode.disposedRuntime))
  })
})
