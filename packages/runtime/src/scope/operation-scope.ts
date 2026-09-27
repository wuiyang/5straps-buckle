import { randomUUID } from 'node:crypto'
import { DisposalError, RuntimeError, RuntimeErrorCode } from '../errors.js'
import { assertTimerMs, settleWithin } from '../internal/timeouts.js'
import type { CreateScopeOptions, OperationContext, OperationContextInput, OperationScope, ScopeCleanup, ScopeState } from './als.js'

const DEFAULT_MAX_BACKGROUND_WORK = 64
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000

// Hooks only the service registry supplies; not part of the public scope API.
interface ScopeControl {
  // Aborts the scope signal even while it drains (runtime close); never detached.
  closeSignal?: AbortSignal
  // Runs once background work has settled or timed out, before cleanups; returns failures to report.
  beforeCleanups?: (deadline: number) => Promise<unknown[]>
}

// A draining scope still serves the background work it waits for.
export function isScopeUsable(scope: OperationScope): boolean {
  return scope.state === 'active' || scope.state === 'draining'
}

// Disposal: draining (signal live, background work settles within drainTimeoutMs), then disposing
// (signal aborted, registry hook, cleanups in reverse), then disposed.
export function openOperationScope(options: CreateScopeOptions, control: ScopeControl = {}): OperationScope {
  const context = freezeContext(options.context)
  const maxBackgroundWork = options.maxBackgroundWork ?? DEFAULT_MAX_BACKGROUND_WORK
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  assertTimerMs('drainTimeoutMs', drainTimeoutMs)
  const controller = new AbortController()
  const detachCaller = linkSignal(options.signal, controller)
  const detachClose = linkSignal(control.closeSignal, controller)
  const pending = new Set<Promise<unknown>>()
  const workErrors: unknown[] = []
  const cleanups: ScopeCleanup[] = []
  let state: ScopeState = 'active'
  let disposal: Promise<void> | undefined

  function assertUsable(action: string): void {
    if (state !== 'active' && state !== 'draining') throw new RuntimeError(RuntimeErrorCode.disposedScope, `Cannot ${action}: operation scope ${context.correlationId} is ${state}`)
  }

  async function disposeScope(): Promise<void> {
    state = 'draining'
    // The caller leaving (response sent, client gone) no longer cancels the work being drained.
    detachCaller()
    const deadline = performance.now() + drainTimeoutMs
    const drained = await drainUntil(deadline)
    state = 'disposing'
    controller.abort(new RuntimeError(RuntimeErrorCode.disposedScope, `Operation scope ${context.correlationId} closed`))
    detachClose()
    const errors = drained ? [...workErrors] : [new RuntimeError(RuntimeErrorCode.drainTimeout, `Operation scope ${context.correlationId} left ${pending.size} background tasks running after ${drainTimeoutMs} ms`), ...workErrors]
    if (control.beforeCleanups) errors.push(...await control.beforeCleanups(deadline))
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { errors.push(error) }
    }
    state = 'disposed'
    if (errors.length > 0) throw new DisposalError(errors, `Operation scope ${context.correlationId} failed to close cleanly`)
  }

  // Work registered while draining is waited for too, within the same deadline.
  async function drainUntil(deadline: number): Promise<boolean> {
    while (pending.size > 0) {
      const remaining = deadline - performance.now()
      if (remaining <= 0 || !(await settleWithin([...pending], remaining))) return false
    }
    return true
  }

  return {
    id: randomUUID(),
    owner: options.owner,
    context,
    signal: controller.signal,
    get state() { return state },
    registerBackgroundWork(work) {
      assertUsable('register background work')
      if (pending.size >= maxBackgroundWork) throw new RuntimeError(RuntimeErrorCode.backgroundWorkLimit, `Operation scope ${context.correlationId} already has ${maxBackgroundWork} pending background tasks`)
      const tracked = work.then(() => undefined, (error: unknown) => { workErrors.push(error) }).finally(() => pending.delete(tracked))
      pending.add(tracked)
    },
    onDispose(cleanup) {
      assertUsable('register cleanup')
      cleanups.push(cleanup)
    },
    dispose() {
      disposal ??= disposeScope()
      return disposal
    },
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
