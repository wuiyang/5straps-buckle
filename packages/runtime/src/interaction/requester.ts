import { RuntimeError } from '../errors.js'
import { runInScope, useScopeSafe, type OperationScope } from '../scope/als.js'
import { assertNoActiveTransaction } from '../transaction/guard.js'
import type { CliConsumer, CliOutcome, CliRequest, PendingInteraction, RequestCli, UnavailableReason } from './types.js'

export const InteractionErrorCode = Object.freeze({
  consumerAttached: 'CliConsumerAlreadyAttachedError',
  consumerFailed: 'CliConsumerFailedError',
  noCompletion: 'CliNoCompletionError',
  listenerFailed: 'CliListenerFailedError',
} as const)

export interface CliConsumerSlot {
  attach(consumer: CliConsumer): () => void
  current(): CliConsumer | undefined
  onChange(listener: () => void): void
}

// Exactly one interactive consumer; a second attach is refused rather than racing for answers.
export function createCliConsumerSlot(): CliConsumerSlot {
  let consumer: CliConsumer | undefined
  const listeners: (() => void)[] = []
  return {
    attach(next) {
      if (consumer) throw new RuntimeError(InteractionErrorCode.consumerAttached, 'An interactive CLI consumer is already attached')
      consumer = next
      listeners.forEach(listener => listener())
      return () => {
        if (consumer !== next) return
        consumer = undefined
        listeners.forEach(listener => listener())
      }
    },
    current: () => consumer,
    onChange: (listener) => { listeners.push(listener) },
  }
}

export interface CliRequesterOptions {
  slot: CliConsumerSlot
  // Persists the request in the durable owner queue when nobody can answer now; never approves.
  onUnavailable?: (request: CliRequest, reason: UnavailableReason) => Promise<PendingInteraction | undefined>
}

export interface CliRequester {
  requestCli: RequestCli
  pending(): number
  close(reason?: string): void
}

interface Entry {
  request: CliRequest
  scope: OperationScope | undefined
  enqueuedAt: number
  controller: AbortController
  settle(outcome: CliOutcome | Error | Promise<CliOutcome>): void
  settled: boolean
}

export function createCliRequester(options: CliRequesterOptions): CliRequester {
  const queue: Entry[] = []
  const inFlight = new Map<string, Promise<CliOutcome>>()
  let active: Entry | undefined
  let closed = false

  options.slot.onChange(() => {
    if (options.slot.current()) return pump()
    for (const entry of [active, ...queue.splice(0)]) if (entry) settleUnavailable(entry, 'consumer_detached')
  })

  function requestCli(request: CliRequest, requestOptions: { signal?: AbortSignal } = {}): Promise<CliOutcome> {
    assertNoActiveTransaction(`wait for CLI interaction ${request.id}`)
    // A reconnecting caller re-sending the same request joins the original wait instead of prompting twice.
    const existing = inFlight.get(request.id)
    if (existing) return existing
    const outcome = enqueue(request, requestOptions.signal)
    inFlight.set(request.id, outcome)
    const forget = () => { inFlight.delete(request.id) }
    outcome.then(forget, forget)
    return outcome
  }

  function enqueue(request: CliRequest, signal: AbortSignal | undefined): Promise<CliOutcome> {
    const { promise, resolve, reject } = Promise.withResolvers<CliOutcome>()
    const controller = new AbortController()
    const cleanups: (() => void)[] = []
    const entry: Entry = {
      request,
      scope: useScopeSafe(),
      enqueuedAt: Date.now(),
      controller,
      settled: false,
      settle(outcome) {
        if (entry.settled) return
        entry.settled = true
        cleanups.forEach(cleanup => cleanup())
        controller.abort()
        removeFromQueue(entry)
        if (outcome instanceof Error) reject(outcome)
        else Promise.resolve(outcome).then(resolve, reject)
      },
    }
    if (closed) settleUnavailable(entry, 'closed')
    else if (!options.slot.current()) settleUnavailable(entry, 'no_consumer')
    else if (signal?.aborted) entry.settle(cancelledOutcome(request, signal.reason))
    else {
      watchEntry(entry, signal, cleanups)
      queue.push(entry)
      pump()
    }
    return promise
  }

  function watchEntry(entry: Entry, signal: AbortSignal | undefined, cleanups: (() => void)[]): void {
    if (signal) {
      const onAbort = () => entry.settle(cancelledOutcome(entry.request, signal.reason))
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    }
    if (entry.request.wait.mode === 'finite') {
      const timer = setTimeout(() => entry.settle({ status: 'timed_out', requestId: entry.request.id, waitedMs: Date.now() - entry.enqueuedAt }), entry.request.wait.timeoutMs)
      cleanups.push(() => clearTimeout(timer))
    }
  }

  function pump(): void {
    const consumer = options.slot.current()
    if (active || !consumer) return
    const entry = queue.shift()
    if (!entry) return
    active = entry
    const prompt = () => consumer.prompt(entry.request, { signal: entry.controller.signal })
    const running = entry.scope?.state === 'active' ? runInScope(entry.scope, prompt) : prompt()
    running.then(
      result => entry.settle(result.status === 'answered' ? { status: 'answered', requestId: entry.request.id, answer: result.answer } : { status: 'denied', requestId: entry.request.id, reason: result.reason }),
      error => entry.settle(entry.controller.signal.aborted ? cancelledOutcome(entry.request, 'prompt aborted') : new RuntimeError(InteractionErrorCode.consumerFailed, `CLI consumer failed for request ${entry.request.id}`, { cause: error })),
    ).finally(() => {
      if (active === entry) active = undefined
      pump()
    })
  }

  function removeFromQueue(entry: Entry): void {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
  }

  function settleUnavailable(entry: Entry, reason: UnavailableReason): void {
    const persist = options.onUnavailable ?? (() => Promise.resolve(undefined))
    entry.settle(Promise.resolve().then(() => persist(entry.request, reason)).then(pending => ({ status: 'unavailable', requestId: entry.request.id, reason, ...(pending ? { pending } : {}) })))
  }

  return {
    requestCli,
    pending: () => queue.length + (active ? 1 : 0),
    close(reason = 'runtime shutting down') {
      closed = true
      for (const entry of [active, ...queue.splice(0)]) entry?.settle(cancelledOutcome(entry.request, reason))
    },
  }
}

export function cancelledOutcome(request: CliRequest, reason: unknown): CliOutcome {
  return { status: 'cancelled', requestId: request.id, reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled') }
}
