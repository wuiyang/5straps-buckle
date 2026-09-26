import { randomUUID } from 'node:crypto'
import { DisposalError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import { createOperationScope, useScope, type CreateScopeOptions, type OperationScope } from '../scope/als.js'

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
  dispose(): Promise<void>
}

interface Created { definition: AnyServiceDefinition; value: unknown }
interface ScopeCache { inFlight: Map<AnyServiceDefinition, Promise<unknown>> }
type Owner = { kind: 'runtime' } | { kind: 'scope'; scope: OperationScope }

export function createServiceRegistry(options: { services: readonly AnyServiceDefinition[]; name?: string }): ServiceRegistry {
  const registered = new Set(options.services)
  validateServiceGraph(registered)
  const owner = Symbol(options.name ?? `runtime-${randomUUID()}`)
  const singletons = new Map<AnyServiceDefinition, Promise<unknown>>()
  const runtimeCreated: Created[] = []
  const scopeCaches = new WeakMap<OperationScope, ScopeCache>()
  const activeScopes = new Set<OperationScope>()
  let disposal: Promise<void> | undefined

  function assertUsable(definition: AnyServiceDefinition): void {
    if (disposal) throw new RuntimeError(RuntimeErrorCode.disposedRuntime, `Cannot resolve ${definition.name}: the runtime is disposed`)
    if (!registered.has(definition)) throw new RuntimeError(RuntimeErrorCode.unregisteredService, `Service ${definition.name} is not registered with this runtime`)
  }

  function cacheFor(scope: OperationScope): ScopeCache {
    if (scope.owner !== owner) throw new RuntimeError(RuntimeErrorCode.foreignScope, `Operation scope ${scope.context.correlationId} belongs to another runtime`)
    if (scope.state !== 'active') throw new RuntimeError(RuntimeErrorCode.disposedScope, `Operation scope ${scope.context.correlationId} is ${scope.state}`)
    const cache = scopeCaches.get(scope)
    if (!cache) throw new RuntimeError(RuntimeErrorCode.foreignScope, `Operation scope ${scope.context.correlationId} was not created by this runtime`)
    return cache
  }

  function construct<T>(definition: ServiceDefinition<T>, holder: Owner): Promise<T> {
    const scope = holder.kind === 'scope' ? holder.scope : undefined
    const context: ResolveContext = {
      scope,
      get(dependency) {
        if (!definition.dependencies.includes(dependency)) {
          return Promise.reject(new RuntimeError(RuntimeErrorCode.undeclaredDependency, `${definition.name} resolved ${dependency.name} without declaring it as a dependency`))
        }
        return resolve(dependency, holder)
      },
    }
    return Promise.resolve().then(() => definition.create(context)).then((value) => {
      if (definition.dispose) track(holder, { definition, value })
      return value
    })
  }

  function track(holder: Owner, created: Created): void {
    if (holder.kind === 'runtime') {
      runtimeCreated.push(created)
      return
    }
    holder.scope.onDispose(() => created.definition.dispose?.(created.value))
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
    const creating = construct(definition, { kind: 'runtime' })
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

  async function disposeRuntime(): Promise<void> {
    const errors: unknown[] = []
    for (const scope of [...activeScopes].reverse()) {
      try { await scope.dispose() } catch (error) { errors.push(error) }
    }
    await Promise.allSettled([...singletons.values()])
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
      const scope = createOperationScope({ ...scopeOptions, owner })
      scopeCaches.set(scope, { inFlight: new Map() })
      activeScopes.add(scope)
      scope.onDispose(() => { activeScopes.delete(scope) })
      return scope
    },
    dispose() {
      disposal ??= disposeRuntime()
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
