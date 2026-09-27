import { DisposalError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import { scopeStorage } from '../internal/async-slots.js'
import { isScopeUsable, openOperationScope } from './operation-scope.js'

export type ScopeAttribute = string | number | boolean
export interface OperationContext {
  readonly correlationId: string
  readonly actor?: string
  readonly sessionId?: string
  readonly projectId?: string
  readonly workspaceId?: string
  // Client-supplied request id (x-request-id), for log correlation with the caller only; never the correlation id.
  readonly clientRequestId?: string
  readonly attributes?: Readonly<Record<string, ScopeAttribute>>
}
export type OperationContextInput = Omit<OperationContext, 'correlationId'> & { correlationId?: string }
// active -> draining (background work settles; signal live, services usable) -> disposing -> disposed
export type ScopeState = 'active' | 'draining' | 'disposing' | 'disposed'
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
  // The caller's signal (for example the request's); it stops cancelling the scope once disposal starts draining.
  signal?: AbortSignal
  maxBackgroundWork?: number
  // Bound on waiting for background work at disposal (runtime.md: drain within a configured bound).
  drainTimeoutMs?: number
}

export { DEFAULT_DRAIN_TIMEOUT_MS } from './operation-scope.js'
const storage = scopeStorage

export function createOperationScope(options: CreateScopeOptions): OperationScope {
  return openOperationScope(options)
}

export function runInScope<T>(scope: OperationScope, fn: () => T): T {
  if (!isScopeUsable(scope)) throw new RuntimeError(RuntimeErrorCode.disposedScope, `Cannot enter operation scope ${scope.context.correlationId}: it is ${scope.state}`)
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
