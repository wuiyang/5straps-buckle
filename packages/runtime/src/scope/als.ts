import { randomUUID } from 'node:crypto'
import { DisposalError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import { scopeStorage } from '../internal/async-slots.js'

export type ScopeAttribute = string | number | boolean
export interface OperationContext {
  readonly correlationId: string
  readonly actor?: string
  readonly sessionId?: string
  readonly projectId?: string
  readonly workspaceId?: string
  readonly attributes?: Readonly<Record<string, ScopeAttribute>>
}
export type OperationContextInput = Omit<OperationContext, 'correlationId'> & { correlationId?: string }
export type ScopeState = 'active' | 'disposing' | 'disposed'
export type ScopeCleanup = () => void | Promise<void>

export interface OperationScope {
  readonly id: string
  readonly owner: symbol
  readonly context: OperationContext
  readonly signal: AbortSignal
  readonly state: ScopeState
  registerBackgroundWork(work: Promise<unknown>): void
  onDispose(cleanup: ScopeCleanup): void
  dispose(): Promise<void>
}

export interface CreateScopeOptions {
  owner: symbol
  context: OperationContextInput
  signal?: AbortSignal
  maxBackgroundWork?: number
  // Bound on waiting for background work at disposal (runtime.md: drain within a configured bound).
  drainTimeoutMs?: number
}

const DEFAULT_MAX_BACKGROUND_WORK = 64
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000
const storage = scopeStorage

export function createOperationScope(options: CreateScopeOptions): OperationScope {
  const context = freezeContext(options.context)
  const controller = new AbortController()
  const detachSignal = linkSignal(options.signal, controller)
  const maxBackgroundWork = options.maxBackgroundWork ?? DEFAULT_MAX_BACKGROUND_WORK
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const pending = new Set<Promise<unknown>>()
  const workErrors: unknown[] = []
  const cleanups: ScopeCleanup[] = []
  let state: ScopeState = 'active'
  let disposal: Promise<void> | undefined

  function assertActive(action: string): void {
    if (state !== 'active') throw new RuntimeError(RuntimeErrorCode.disposedScope, `Cannot ${action}: operation scope ${context.correlationId} is ${state}`)
  }

  async function disposeScope(): Promise<void> {
    state = 'disposing'
    controller.abort(new RuntimeError(RuntimeErrorCode.disposedScope, `Operation scope ${context.correlationId} closed`))
    detachSignal()
    // Drain work before cleanups: background work may still use scoped services.
    const drained = await settleWithin([...pending], drainTimeoutMs)
    const errors = drained ? [...workErrors] : [new RuntimeError(RuntimeErrorCode.drainTimeout, `Operation scope ${context.correlationId} left ${pending.size} background tasks running after ${drainTimeoutMs} ms`), ...workErrors]
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { errors.push(error) }
    }
    state = 'disposed'
    if (errors.length > 0) throw new DisposalError(errors, `Operation scope ${context.correlationId} failed to close cleanly`)
  }

  return {
    id: randomUUID(),
    owner: options.owner,
    context,
    signal: controller.signal,
    get state() { return state },
    registerBackgroundWork(work) {
      assertActive('register background work')
      if (pending.size >= maxBackgroundWork) throw new RuntimeError(RuntimeErrorCode.backgroundWorkLimit, `Operation scope ${context.correlationId} already has ${maxBackgroundWork} pending background tasks`)
      const tracked = work.then(() => undefined, (error: unknown) => { workErrors.push(error) }).finally(() => pending.delete(tracked))
      pending.add(tracked)
    },
    onDispose(cleanup) {
      assertActive('register cleanup')
      cleanups.push(cleanup)
    },
    dispose() {
      disposal ??= disposeScope()
      return disposal
    },
  }
}

export function runInScope<T>(scope: OperationScope, fn: () => T): T {
  if (scope.state !== 'active') throw new RuntimeError(RuntimeErrorCode.disposedScope, `Cannot enter operation scope ${scope.context.correlationId}: it is ${scope.state}`)
  return storage.run(scope, fn)
}

export function useScope(): OperationScope {
  const scope = storage.getStore()
  if (!scope) throw new RuntimeError(RuntimeErrorCode.missingScope, 'No operation scope is active; enter one with runInScope or withOperationScope')
  return scope
}

export function useScopeSafe(): OperationScope | undefined {
  return storage.getStore()
}

export function registerBackgroundWork(work: Promise<unknown>, scope: OperationScope = useScope()): void {
  scope.registerBackgroundWork(work)
}

export function captureCorrelation(scope: OperationScope = useScope()): OperationContext {
  return scope.context
}

// Run inside the scope and always dispose it. A body failure stays the primary error; disposal failures join it.
export async function withOperationScope<T>(scope: OperationScope, fn: (scope: OperationScope) => T | Promise<T>): Promise<T> {
  let result: T
  try {
    result = await runInScope(scope, () => fn(scope))
  } catch (error) {
    await scope.dispose().catch((disposalError: unknown) => {
      throw new DisposalError(disposalError instanceof AggregateError ? disposalError.errors : [disposalError], 'Operation failed and its scope failed to close cleanly', error)
    })
    throw error
  }
  await scope.dispose()
  return result
}

async function settleWithin(work: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
  try {
    return await Promise.race([Promise.allSettled(work).then(() => true), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

function freezeContext(input: OperationContextInput): OperationContext {
  const attributes = input.attributes ? Object.freeze({ ...input.attributes }) : undefined
  return Object.freeze({ ...input, correlationId: input.correlationId ?? randomUUID(), ...(attributes ? { attributes } : {}) })
}

function linkSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => {}
  if (parent.aborted) {
    controller.abort(parent.reason)
    return () => {}
  }
  const forward = () => controller.abort(parent.reason)
  parent.addEventListener('abort', forward, { once: true })
  return () => parent.removeEventListener('abort', forward)
}
