import { randomUUID } from 'node:crypto'
import { DisposalError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import { runDetached, scopeStorage } from '../internal/async-slots.js'
import { assertTimerMs, settleWithin } from '../internal/timeouts.js'
import { useScope, type CreateScopeOptions, type OperationScope } from '../scope/als.js'
import { DEFAULT_DRAIN_TIMEOUT_MS, isScopeUsable, openOperationScope } from '../scope/operation-scope.js'
import { activeTransactionLabel } from '../transaction/guard.js'

export type Lifetime = 'singleton' | 'scoped' | 'transient'

export interface ResolveContext {
  get<D>(dependency: ServiceDefinition<D>): Promise<D>
  readonly scope: OperationScope | undefined
}

export interface ServiceDefinition<T, L extends Lifetime = Lifetime> {
  readonly name: string
  readonly lifetime: L
  readonly dependencies: readonly AnyServiceDefinition[]
  readonly create: (context: ResolveContext) => T | Promise<T>
  // Method syntax keeps definitions assignable to AnyServiceDefinition (parameter bivariance).
  dispose?(value: T): void | Promise<void>
}
export type AnyServiceDefinition = ServiceDefinition<unknown>
export type SingletonDefinition<T> = ServiceDefinition<T, 'singleton'>
export type ScopedDefinition<T> = ServiceDefinition<T, 'scoped'>
export type TransientDefinition<T> = ServiceDefinition<T, 'transient'>

type DefinitionInput<T> = Omit<ServiceDefinition<T>, 'lifetime' | 'dependencies'> & { dependencies?: readonly AnyServiceDefinition[] }

export function defineSingleton<T>(input: DefinitionInput<T>): SingletonDefinition<T> {
  return Object.freeze({ ...input, lifetime: 'singleton', dependencies: input.dependencies ?? [] })
}

export function defineScoped<T>(input: DefinitionInput<T>): ScopedDefinition<T> {
  return Object.freeze({ ...input, lifetime: 'scoped', dependencies: input.dependencies ?? [] })
}

export function defineTransient<T>(input: DefinitionInput<T>): TransientDefinition<T> {
  return Object.freeze({ ...input, lifetime: 'transient', dependencies: input.dependencies ?? [] })
}

export interface ServiceRegistry {
  readonly owner: symbol
  readonly disposed: boolean
  useSingleton<T>(definition: SingletonDefinition<T>): Promise<T>
  useScoped<T>(definition: ScopedDefinition<T>, scope?: OperationScope): Promise<T>
  createTransient<T>(definition: TransientDefinition<T>, scope?: OperationScope): Promise<T>
  createScope(options: Omit<CreateScopeOptions, 'owner'>): OperationScope
  // The signal is the close step's: once it aborts (the step timed out), singleton disposal is skipped.
  dispose(options?: { signal?: AbortSignal }): Promise<void>
}

export interface ServiceRegistryOptions {
  services: readonly AnyServiceDefinition[]
  name?: string
  // Default drain bound for scopes this registry creates (DEFAULT_DRAIN_TIMEOUT_MS when omitted).
  drainTimeoutMs?: number
}

interface Created { definition: AnyServiceDefinition; value: unknown }
interface ScopeCache {
  inFlight: Map<AnyServiceDefinition, Promise<unknown>>
  // Every scoped or transient construction still running, by service name; scope disposal waits for them.
  constructing: Map<Promise<unknown>, string>
  // Dispose failures of values that finished after their scope stopped serving; reported by the scope.
  lateDisposeErrors: unknown[]
}
type Owner = { kind: 'runtime' } | { kind: 'scope'; scope: OperationScope }

export function createServiceRegistry(options: ServiceRegistryOptions): ServiceRegistry {
  const registered = new Set(options.services)
  validateServiceGraph(registered)
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  assertTimerMs('drainTimeoutMs', drainTimeoutMs)
  const owner = Symbol(options.name ?? `runtime-${randomUUID()}`)
  const singletons = new Map<AnyServiceDefinition, Promise<unknown>>()
  const runtimeCreated: Created[] = []
  const scopeCaches = new WeakMap<OperationScope, ScopeCache>()
  const activeScopes = new Set<OperationScope>()
  // Aborted when the runtime closes; cancels every scope, draining ones included.
  const closing = new AbortController()
  let disposal: Promise<void> | undefined

  function assertUsable(definition: AnyServiceDefinition): void {
    if (disposal) throw new RuntimeError(RuntimeErrorCode.disposedRuntime, `Cannot resolve ${definition.name}: the runtime is disposed`)
    if (!registered.has(definition)) throw new RuntimeError(RuntimeErrorCode.unregisteredService, `Service ${definition.name} is not registered with this runtime`)
  }

  function cacheFor(scope: OperationScope): ScopeCache {
    if (scope.owner !== owner) throw new RuntimeError(RuntimeErrorCode.foreignScope, `Operation scope ${scope.context.correlationId} belongs to another runtime`)
    if (!isScopeUsable(scope)) throw new RuntimeError(RuntimeErrorCode.disposedScope, `Operation scope ${scope.context.correlationId} is ${scope.state}`)
    const cache = scopeCaches.get(scope)
    if (!cache) throw new RuntimeError(RuntimeErrorCode.foreignScope, `Operation scope ${scope.context.correlationId} was not created by this runtime`)
    return cache
  }

  // Scoped and transient factories run inside their owning scope, whatever scope the caller is in.
  function construct<T>(definition: ServiceDefinition<T>, holder: Owner): Promise<T> {
    const context: ResolveContext = {
      scope: holder.kind === 'scope' ? holder.scope : undefined,
      get(dependency) {
        if (!definition.dependencies.includes(dependency)) {
          return Promise.reject(new RuntimeError(RuntimeErrorCode.undeclaredDependency, `${definition.name} resolved ${dependency.name} without declaring it as a dependency`))
        }
        return resolve(dependency, holder)
      },
    }
    const start = () => Promise.resolve().then(() => definition.create(context)).then(async (value) => {
      await adopt(holder, { definition, value })
      return value
    })
    if (holder.kind === 'runtime') return start()
    const creating = scopeStorage.run(holder.scope, start)
    trackConstruction({ scope: holder.scope, creating, name: definition.name })
    return creating
  }

  function trackConstruction({ scope, creating, name }: { scope: OperationScope; creating: Promise<unknown>; name: string }): void {
    const constructing = scopeCaches.get(scope)?.constructing
    if (!constructing) return
    constructing.set(creating, name)
    const done = () => { constructing.delete(creating) }
    creating.then(done, done)
  }

  async function adopt(holder: Owner, created: Created): Promise<void> {
    if (holder.kind === 'runtime') {
      if (created.definition.dispose) runtimeCreated.push(created)
      return
    }
    if (isScopeUsable(holder.scope)) {
      if (created.definition.dispose) holder.scope.onDispose(() => created.definition.dispose?.(created.value))
      return
    }
    await disposeLate(holder.scope, created)
  }

  // Finished after its scope stopped serving: dispose now (dependencies are still open) and refuse to hand it out.
  async function disposeLate(scope: OperationScope, created: Created): Promise<never> {
    let failure: unknown
    try {
      await created.definition.dispose?.(created.value)
    } catch (error) {
      failure = error
      scopeCaches.get(scope)?.lateDisposeErrors.push(error)
    }
    throw new RuntimeError(RuntimeErrorCode.disposedScope, `${created.definition.name} finished after operation scope ${scope.context.correlationId} closed`, failure === undefined ? undefined : { cause: failure })
  }

  // Runs after the scope's background drain and before its cleanups, within the same deadline.
  async function settleConstructions({ scope, cache, deadline }: { scope: OperationScope; cache: ScopeCache; deadline: number }): Promise<unknown[]> {
    const settled = await settleWithin([...cache.constructing.keys()], deadline - performance.now())
    const errors: unknown[] = settled ? [] : [new RuntimeError(RuntimeErrorCode.drainTimeout, `Operation scope ${scope.context.correlationId} left ${[...new Set(cache.constructing.values())].join(', ')} under construction past its drain bound`)]
    return [...errors, ...cache.lateDisposeErrors.splice(0)]
  }

  function resolve<T>(definition: ServiceDefinition<T>, holder: Owner): Promise<T> {
    if (definition.lifetime === 'singleton') return resolveSingleton(definition)
    if (definition.lifetime === 'scoped') {
      if (holder.kind !== 'scope') throw new RuntimeError(RuntimeErrorCode.captiveDependency, `${definition.name} is scoped and cannot be resolved without an operation scope`)
      return resolveScoped(definition, holder.scope)
    }
    return construct(definition, holder)
  }

  function resolveSingleton<T>(definition: ServiceDefinition<T>): Promise<T> {
    const existing = singletons.get(definition)
    if (existing) return existing as Promise<T>
    // Its setup would join the caller's transaction and vanish on rollback while the registry kept it cached.
    const transaction = activeTransactionLabel()
    if (transaction !== undefined) return Promise.reject(new RuntimeError(RuntimeErrorCode.singletonInsideTransaction, `Singleton ${definition.name} cannot be first created inside transaction ${transaction}; resolve it before the transaction or at startup`))
    const creating = runDetached(() => construct(definition, { kind: 'runtime' }))
    singletons.set(definition, creating)
    // A failed factory is retried by the next getter rather than cached.
    creating.catch(() => { if (singletons.get(definition) === creating) singletons.delete(definition) })
    return creating
  }

  function resolveScoped<T>(definition: ServiceDefinition<T>, scope: OperationScope): Promise<T> {
    const cache = cacheFor(scope)
    const existing = cache.inFlight.get(definition)
    if (existing) return existing as Promise<T>
    const creating = construct(definition, { kind: 'scope', scope })
    cache.inFlight.set(definition, creating)
    creating.catch(() => { if (cache.inFlight.get(definition) === creating) cache.inFlight.delete(definition) })
    return creating
  }

  // Scopes drain concurrently, each within its own bound; singletons go last, unless the close step was abandoned.
  async function disposeRuntime(signal: AbortSignal | undefined): Promise<void> {
    closing.abort(new RuntimeError(RuntimeErrorCode.disposedRuntime, 'Runtime closing'))
    const scopes = await Promise.allSettled([...activeScopes].map(scope => scope.dispose()))
    const errors: unknown[] = scopes.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    await Promise.allSettled([...singletons.values()])
    if (signal?.aborted) {
      const skipped = runtimeCreated.splice(0).map(created => created.definition.name)
      errors.push(new RuntimeError(RuntimeErrorCode.closeStepTimeout, `Singleton disposal skipped because its close step was abandoned: ${skipped.join(', ') || 'none'}`))
    }
    for (const created of runtimeCreated.splice(0).reverse()) {
      try { await created.definition.dispose?.(created.value) } catch (error) { errors.push(error) }
    }
    singletons.clear()
    if (errors.length > 0) throw new DisposalError(errors, 'Runtime services failed to dispose cleanly')
  }

  return {
    owner,
    get disposed() { return disposal !== undefined },
    useSingleton(definition) {
      return guarded(() => { assertUsable(definition); return resolveSingleton(definition) })
    },
    useScoped(definition, scope) {
      return guarded(() => { assertUsable(definition); return resolveScoped(definition, scope ?? useScope()) })
    },
    createTransient(definition, scope) {
      return guarded(() => {
        assertUsable(definition)
        const owning = scope ?? useScope()
        cacheFor(owning)
        return construct(definition, { kind: 'scope', scope: owning })
      })
    },
    createScope(scopeOptions) {
      if (disposal) throw new RuntimeError(RuntimeErrorCode.disposedRuntime, 'Cannot open an operation scope: the runtime is disposed')
      const cache: ScopeCache = { inFlight: new Map(), constructing: new Map(), lateDisposeErrors: [] }
      const scope: OperationScope = openOperationScope({ drainTimeoutMs, ...scopeOptions, owner }, {
        closeSignal: closing.signal,
        beforeCleanups: deadline => settleConstructions({ scope, cache, deadline }),
      })
      scopeCaches.set(scope, cache)
      activeScopes.add(scope)
      // Registered first, so it runs last: the scope counts as active for runtime close until every cleanup ran.
      scope.onDispose(() => { activeScopes.delete(scope) })
      return scope
    },
    dispose(disposeOptions = {}) {
      disposal ??= disposeRuntime(disposeOptions.signal)
      return disposal
    },
  }
}

function guarded<T>(resolve: () => Promise<T>): Promise<T> {
  try { return resolve() } catch (error) { return Promise.reject(error) }
}

// Rejects cycles and singletons that would capture scope-bound services, before anything runs.
export function validateServiceGraph(registered: ReadonlySet<AnyServiceDefinition>): void {
  const scopeBound = new Map<AnyServiceDefinition, boolean>()
  const visiting: AnyServiceDefinition[] = []

  function visit(definition: AnyServiceDefinition): boolean {
    const known = scopeBound.get(definition)
    if (known !== undefined) return known
    const cycleStart = visiting.indexOf(definition)
    if (cycleStart >= 0) {
      const path = [...visiting.slice(cycleStart), definition].map(item => item.name).join(' -> ')
      throw new RuntimeError(RuntimeErrorCode.circularDependency, `Circular service dependency: ${path}`)
    }
    if (!registered.has(definition)) throw new RuntimeError(RuntimeErrorCode.unregisteredService, `Service ${definition.name} is a dependency but is not registered`)
    visiting.push(definition)
    const boundDependencies = definition.dependencies.filter(visit)
    visiting.pop()
    if (definition.lifetime === 'singleton' && boundDependencies.length > 0) {
      throw new RuntimeError(RuntimeErrorCode.captiveDependency, `Singleton ${definition.name} cannot depend on scope-bound ${boundDependencies.map(item => item.name).join(', ')}`)
    }
    const bound = definition.lifetime === 'scoped' || (definition.lifetime === 'transient' && boundDependencies.length > 0)
    scopeBound.set(definition, bound)
    return bound
  }

  for (const definition of registered) visit(definition)
}
