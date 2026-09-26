import { RuntimeError } from '../errors.js'
import { assertNoActiveTransaction } from '../transaction/guard.js'
import { cancelledOutcome, InteractionErrorCode } from './requester.js'
import type { CliOutcome, CliRequest, RequestCli } from './types.js'

export type CliRespond = (outcome: CliOutcome) => void
export type CliHookDispatch = (request: CliRequest, respond: CliRespond) => Promise<unknown>

export interface HookRequestCliOptions {
  dispatch: CliHookDispatch
  hasListener: () => boolean
}

// Emits a request through a hook and waits for explicit completion through `respond`.
// Exactly one settlement: the first of respond, listener failure, missing completion, abort or timeout wins.
export function createHookRequestCli(options: HookRequestCliOptions): RequestCli {
  return (request, requestOptions = {}) => {
    assertNoActiveTransaction(`wait for CLI interaction ${request.id}`)
    const { signal } = requestOptions
    if (!options.hasListener()) return Promise.resolve({ status: 'unavailable', requestId: request.id, reason: 'no_listener' })
    if (signal?.aborted) return Promise.resolve(cancelledOutcome(request, signal.reason))
    return awaitCompletion({ request, signal, dispatch: options.dispatch })
  }
}

function awaitCompletion(input: { request: CliRequest; signal: AbortSignal | undefined; dispatch: CliHookDispatch }): Promise<CliOutcome> {
  const { request, signal } = input
  const { promise, resolve, reject } = Promise.withResolvers<CliOutcome>()
  const startedAt = Date.now()
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const onAbort = () => settle(cancelledOutcome(request, signal?.reason))

  function settle(outcome: CliOutcome | Error): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (outcome instanceof Error) reject(outcome)
    else resolve(outcome)
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (request.wait.mode === 'finite') timer = setTimeout(() => settle({ status: 'timed_out', requestId: request.id, waitedMs: Date.now() - startedAt }), request.wait.timeoutMs)
  const respond: CliRespond = outcome => settle(outcome.requestId === request.id ? outcome : new RuntimeError(InteractionErrorCode.noCompletion, `CLI listener answered ${outcome.requestId} for request ${request.id}`))
  Promise.resolve().then(() => input.dispatch(request, respond)).then(
    () => settle(new RuntimeError(InteractionErrorCode.noCompletion, `CLI listener finished without responding to request ${request.id}`)),
    error => settle(new RuntimeError(InteractionErrorCode.listenerFailed, `CLI listener failed for request ${request.id}`, { cause: error })),
  )
  return promise
}
