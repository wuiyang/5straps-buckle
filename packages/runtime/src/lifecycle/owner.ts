import { DisposalError, isDisposalError, RuntimeError, RuntimeErrorCode, toError } from '../errors.js'
import { assertTimerMs } from '../internal/timeouts.js'
import type { Logger } from '../logger/types.js'
import { DEFAULT_DRAIN_TIMEOUT_MS } from '../scope/operation-scope.js'
import { createServiceRegistry, type AnyServiceDefinition, type ServiceRegistry } from '../services/registry.js'

// Close runs stage by stage in this order (nitro/runtime.md, Lifecycle).
export const CLOSE_STAGES = ['accept', 'timers', 'waiters', 'jobs', 'streams', 'locks', 'services', 'databases', 'sinks'] as const
export type CloseStage = typeof CLOSE_STAGES[number]
export type RuntimeState = 'created' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed'
// The signal aborts when the step exceeds its time bound, so the step can stop touching resources later stages close.
export type Closer = (signal?: AbortSignal) => void | Promise<void>

export interface RuntimeOwner {
  readonly registry: ServiceRegistry
  readonly state: RuntimeState
  readonly ready: Promise<void>
  readonly signal: AbortSignal
  start(initialize: (owner: RuntimeOwner) => void | Promise<void>): Promise<void>
  requireReady(): void
  onClose(stage: CloseStage, name: string, closer: Closer): void
  close(options?: { reason?: unknown }): Promise<void>
}

export interface RuntimeOwnerOptions {
  name?: string
  services: readonly AnyServiceDefinition[]
  closeStepTimeoutMs?: number
  // Default drain bound for the owner's operation scopes; below closeStepTimeoutMs so the services step can finish.
  drainTimeoutMs?: number
  // Receives a 'close step' line ({ stage, name }) before each step runs, so close order is observable.
  logger?: Logger
}

const DEFAULT_CLOSE_STEP_TIMEOUT_MS = 10_000

export function createRuntimeOwner(options: RuntimeOwnerOptions): RuntimeOwner {
  const { closeStepTimeoutMs, drainTimeoutMs } = closeBounds(options)
  const registry = createServiceRegistry({ services: options.services, name: options.name, drainTimeoutMs })
  const controller = new AbortController()
  const closers = new Map<CloseStage, { name: string; closer: Closer }[]>(CLOSE_STAGES.map(stage => [stage, []]))
  const readiness = Promise.withResolvers<void>()
  // Attached at once so a failed startup never surfaces as an unhandled rejection.
  readiness.promise.catch(() => {})
  let state: RuntimeState = 'created'
  let failure: unknown
  let closing: Promise<void> | undefined

  closers.get('services')!.push({ name: 'service registry', closer: signal => registry.dispose({ signal }) })

  async function start(initialize: (owner: RuntimeOwner) => void | Promise<void>): Promise<void> {
    if (state !== 'created') throw new RuntimeError(RuntimeErrorCode.notReady, `Runtime cannot start from state ${state}`)
    state = 'starting'
    try {
      await initialize(owner)
    } catch (error) {
      failure = error
      readiness.reject(error)
      await close({ reason: error })
      throw error
    }
    if (state !== 'starting') throw new RuntimeError(RuntimeErrorCode.notReady, `Runtime was closed during startup (state ${state})`)
    state = 'ready'
    readiness.resolve()
  }

  function requireReady(): void {
    if (state === 'ready') return
    throw new RuntimeError(RuntimeErrorCode.notReady, readinessMessage(state), failure === undefined ? undefined : { cause: failure })
  }

  function onClose(stage: CloseStage, name: string, closer: Closer): void {
    if (closing) throw new RuntimeError(RuntimeErrorCode.disposedRuntime, `Cannot register close step ${name}: the runtime is ${state}`)
    closers.get(stage)!.push({ name, closer })
  }

  function close(closeOptions: { reason?: unknown } = {}): Promise<void> {
    closing ??= closeRuntime(closeOptions.reason)
    return closing
  }

  async function closeRuntime(reason: unknown): Promise<void> {
    const failedStartup = state === 'starting' || state === 'created'
    state = 'closing'
    // No-op once settled; settles readiness when close interrupts startup.
    readiness.reject(reason ?? new RuntimeError(RuntimeErrorCode.notReady, 'Runtime closed'))
    controller.abort(reason ?? new RuntimeError(RuntimeErrorCode.disposedRuntime, 'Runtime closing'))
    const errors: unknown[] = []
    for (const stage of CLOSE_STAGES) {
      for (const { name, closer } of closers.get(stage)!.splice(0).reverse()) {
        options.logger?.info('close step', { stage, name })
        const error = await runCloseStep({ name, closer, timeoutMs: closeStepTimeoutMs })
        if (error !== undefined) errors.push(...flattenDisposal(error))
      }
    }
    state = failedStartup ? 'failed' : 'closed'
    // Only a startup failure leads the report; an ordinary close reason (SIGTERM) is not a failure.
    if (errors.length > 0) throw new DisposalError(errors, 'Runtime closed with errors', failure)
  }

  const owner: RuntimeOwner = {
    registry,
    get state() { return state },
    ready: readiness.promise,
    signal: controller.signal,
    start,
    requireReady,
    onClose,
    close,
  }
  return owner
}

// Scopes drain concurrently inside the services step, so each drain must end before that step's bound.
function closeBounds(options: RuntimeOwnerOptions): { closeStepTimeoutMs: number; drainTimeoutMs: number } {
  const closeStepTimeoutMs = options.closeStepTimeoutMs ?? DEFAULT_CLOSE_STEP_TIMEOUT_MS
  assertTimerMs('closeStepTimeoutMs', closeStepTimeoutMs)
  const drainTimeoutMs = options.drainTimeoutMs ?? Math.max(1, Math.min(DEFAULT_DRAIN_TIMEOUT_MS, Math.floor(closeStepTimeoutMs / 2)))
  assertTimerMs('drainTimeoutMs', drainTimeoutMs)
  if (drainTimeoutMs >= closeStepTimeoutMs) throw new TypeError(`drainTimeoutMs (${drainTimeoutMs}) must be below closeStepTimeoutMs (${closeStepTimeoutMs}) so scope drains fit in the services close step`)
  return { closeStepTimeoutMs, drainTimeoutMs }
}

// Each close step is bounded so one stuck resource cannot stop later stages from running.
async function runCloseStep(step: { name: string; closer: Closer; timeoutMs: number }): Promise<unknown> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RuntimeError(RuntimeErrorCode.closeStepTimeout, `Close step ${step.name} exceeded ${step.timeoutMs} ms`)
      controller.abort(error)
      reject(error)
    }, step.timeoutMs)
  })
  try {
    await Promise.race([Promise.resolve().then(() => step.closer(controller.signal)), timeout])
    return undefined
  } catch (error) {
    return error
  } finally {
    clearTimeout(timer)
  }
}

function flattenDisposal(error: unknown): unknown[] {
  return isDisposalError(error) ? error.errors : [toError(error)]
}

function readinessMessage(state: RuntimeState): string {
  if (state === 'starting' || state === 'created') return 'Runtime is still starting'
  if (state === 'failed') return 'Runtime failed to start'
  return 'Runtime is shutting down'
}
