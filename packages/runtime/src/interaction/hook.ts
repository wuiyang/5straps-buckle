import { RuntimeError } from '../errors.js'
import { assertNoActiveTransaction } from '../transaction/guard.js'
import { InteractionErrorCode } from './codes.js'
import { cancelledOutcome, invalidWaitError } from './envelope.js'
import type { CliOutcome, CliRequest, PendingInteraction, RequestCli, UnavailableReason } from './types.js'

export type CliRespond = (outcome: CliOutcome) => void
// The signal aborts once the request settles (answer, timeout, cancel or failure) so the listener can close its prompt.
export interface CliCallOptions { signal: AbortSignal }
export type CliHookDispatch = (request: CliRequest, respond: CliRespond, options?: CliCallOptions) => Promise<unknown>

export interface HookRequestCliOptions {
  dispatch: CliHookDispatch
  hasListener: () => boolean
  // Persists the request in the durable owner queue when no listener is registered; never approves.
  onUnavailable?: (request: CliRequest, reason: UnavailableReason) => Promise<PendingInteraction | undefined>
}

// Emits a request through a hook and waits for explicit completion through `respond`.
// Exactly one settlement: the first of respond, listener failure, missing completion, abort or timeout wins.
export function createHookRequestCli(options: HookRequestCliOptions): RequestCli {
  return (request, requestOptions = {}) => {
    assertNoActiveTransaction(`wait for CLI interaction ${request.id}`)
    const invalid = invalidWaitError(request)
    if (invalid) return Promise.reject(invalid)
    const { signal } = requestOptions
    if (!options.hasListener()) return unavailable({ request, onUnavailable: options.onUnavailable })
    if (signal?.aborted) return Promise.resolve(cancelledOutcome(request, signal.reason))
    return awaitCompletion({ request, signal, dispatch: options.dispatch })
  }
}

async function unavailable(input: { request: CliRequest; onUnavailable: HookRequestCliOptions['onUnavailable'] }): Promise<CliOutcome> {
  const pending = await input.onUnavailable?.(input.request, 'no_listener')
  return { status: 'unavailable', requestId: input.request.id, reason: 'no_listener', ...(pending ? { pending } : {}) }
}

function awaitCompletion(input: { request: CliRequest; signal: AbortSignal | undefined; dispatch: CliHookDispatch }): Promise<CliOutcome> {
  const { request, signal } = input
  const { promise, resolve, reject } = Promise.withResolvers<CliOutcome>()
  const startedAt = Date.now()
  const listenerController = new AbortController()
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const onAbort = () => settle(cancelledOutcome(request, signal?.reason))

  function settle(outcome: CliOutcome | Error): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    listenerController.abort()
    if (outcome instanceof Error) reject(outcome)
    else resolve(outcome)
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (request.wait.mode === 'finite') timer = setTimeout(() => settle({ status: 'timed_out', requestId: request.id, waitedMs: Date.now() - startedAt }), request.wait.timeoutMs)
  const respond: CliRespond = outcome => settle(outcome.requestId === request.id ? outcome : new RuntimeError(InteractionErrorCode.noCompletion, `CLI listener answered ${outcome.requestId} for request ${request.id}`))
  Promise.resolve().then(() => input.dispatch(request, respond, { signal: listenerController.signal })).then(
    () => settle(new RuntimeError(InteractionErrorCode.noCompletion, `CLI listener finished without responding to request ${request.id}`)),
    error => settle(new RuntimeError(InteractionErrorCode.listenerFailed, `CLI listener failed for request ${request.id}`, { cause: error })),
  )
  return promise
}
