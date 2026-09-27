import { RuntimeError } from '../errors.js'
import { MAX_TIMER_MS } from '../internal/timeouts.js'
import { InteractionErrorCode } from './codes.js'
import type { CliRequest } from './types.js'

export function invalidWaitError(request: CliRequest): RuntimeError | undefined {
  if (request.wait.mode === 'indefinite') return undefined
  const { timeoutMs } = request.wait
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS) return undefined
  return new RuntimeError(InteractionErrorCode.invalidWait, `CLI request ${request.id} needs a finite wait between 1 and ${MAX_TIMER_MS} ms, or 'indefinite'; got ${timeoutMs}`)
}

// A re-sent request may join the original wait only when it asks the same person the same thing.
export function sameEnvelope(a: CliRequest, b: CliRequest): boolean {
  return a.kind === b.kind
    && a.correlationId === b.correlationId
    && a.actor === b.actor
    && a.sessionId === b.sessionId
    && a.target === b.target
    && a.action.summary === b.action.summary
    && sameDetails(a.action.details, b.action.details)
}

function sameDetails(a: CliRequest['action']['details'], b: CliRequest['action']['details']): boolean {
  const left = Object.entries(a ?? {})
  return left.length === Object.keys(b ?? {}).length && left.every(([key, value]) => b !== undefined && Object.hasOwn(b, key) && b[key] === value)
}
