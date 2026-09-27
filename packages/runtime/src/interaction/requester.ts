import { RuntimeError } from '../errors.js'
import { runInScope, useScopeSafe, type OperationScope } from '../scope/als.js'
import { isScopeUsable } from '../scope/operation-scope.js'
import { assertNoActiveTransaction } from '../transaction/guard.js'
import { InteractionErrorCode } from './codes.js'
import { invalidWaitError, sameEnvelope } from './envelope.js'
import type { CliConsumer, CliConsumerResult, CliOutcome, CliRequest, PendingInteraction, RequestCli, UnavailableReason } from './types.js'

export { InteractionErrorCode } from './codes.js'

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
  // Persists the request in the durable owner queue when nobody can answer now (including on close); never approves.
  onUnavailable?: (request: CliRequest, reason: UnavailableReason) => Promise<PendingInteraction | undefined>
}

export interface CliRequester {
  requestCli: RequestCli
  pending(): number
  // Resolves once every durable write it started (onUnavailable, detach included) has settled, so a close step can wait for them.
  close(reason?: string): Promise<void>
}

interface Entry {
  request: CliRequest
  scope: OperationScope | undefined
  enqueuedAt: number
  controller: AbortController
  outcome: Promise<CliOutcome>
  // Callers waiting on this prompt; the prompt is cancelled when the last one with a signal leaves.
  participants: number
  settle(outcome: CliOutcome | Error | Promise<CliOutcome>): void
  settled: boolean
}

export function createCliRequester(options: CliRequesterOptions): CliRequester {
  const queue: Entry[] = []
  const inFlight = new Map<string, Entry>()
  const persisting = new Set<Promise<unknown>>()
  let active: Entry | undefined
  let closed = false

  options.slot.onChange(() => {
    if (options.slot.current()) return pump()
    for (const entry of [active, ...queue.splice(0)]) if (entry) settleUnavailable(entry, 'consumer_detached')
  })

  function requestCli(request: CliRequest, requestOptions: { signal?: AbortSignal } = {}): Promise<CliOutcome> {
    assertNoActiveTransaction(`wait for CLI interaction ${request.id}`)
    const invalid = invalidWaitError(request)
    if (invalid) return Promise.reject(invalid)
    const existing = inFlight.get(request.id)
    // A reconnecting caller re-sending the same request joins the original wait instead of prompting twice.
    if (existing && !sameEnvelope(existing.request, request)) {
      return Promise.reject(new RuntimeError(InteractionErrorCode.requestConflict, `CLI request ${request.id} is already waiting with a different envelope`))
    }
    const { signal } = requestOptions
    if (signal?.aborted) return Promise.resolve(cancelledOutcome(request, signal.reason))
    return join(existing ?? enqueue(request), signal)
  }

  function join(entry: Entry, signal: AbortSignal | undefined): Promise<CliOutcome> {
    entry.participants += 1
    if (!signal) return entry.outcome
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        resolve(cancelledOutcome(entry.request, signal.reason))
        leave(entry, signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.outcome.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  function leave(entry: Entry, reason: unknown): void {
    entry.participants -= 1
    if (entry.participants === 0) entry.settle(cancelledOutcome(entry.request, reason))
  }

  function enqueue(request: CliRequest): Entry {
    const { promise, resolve, reject } = Promise.withResolvers<CliOutcome>()
    const controller = new AbortController()
    let clearTimer = () => {}
    const forget = () => { if (inFlight.get(request.id) === entry) inFlight.delete(request.id) }
    const entry: Entry = {
      request,
      scope: useScopeSafe(),
      enqueuedAt: Date.now(),
      controller,
      outcome: promise,
      participants: 0,
      settled: false,
      settle(outcome) {
        if (entry.settled) return
        entry.settled = true
        clearTimer()
        controller.abort()
        removeFromQueue(entry)
        // Free the queue now: a consumer that ignores abort must not stall the requests behind it.
        if (active === entry) {
          active = undefined
          queueMicrotask(pump)
        }
        // A settled request stops accepting joiners now, so a re-send in the same tick prompts again;
        // an unavailable one stays joinable while its durable write runs (the same pending id comes back).
        if (!(outcome instanceof Promise)) forget()
        if (outcome instanceof Error) reject(outcome)
        else Promise.resolve(outcome).then(resolve, reject)
      },
    }
    inFlight.set(request.id, entry)
    promise.then(forget, forget)
    if (closed) settleUnavailable(entry, 'closed')
    else if (!options.slot.current()) settleUnavailable(entry, 'no_consumer')
    else {
      clearTimer = startTimeout(entry)
      queue.push(entry)
      pump()
    }
    return entry
  }

  function startTimeout(entry: Entry): () => void {
    if (entry.request.wait.mode !== 'finite') return () => {}
    const timer = setTimeout(() => entry.settle({ status: 'timed_out', requestId: entry.request.id, waitedMs: Date.now() - entry.enqueuedAt }), entry.request.wait.timeoutMs)
    return () => clearTimeout(timer)
  }

  function pump(): void {
    const consumer = options.slot.current()
    if (active || !consumer) return
    const entry = queue.shift()
    if (!entry) return
    active = entry
    const prompt = () => consumer.prompt(entry.request, { signal: entry.controller.signal })
    // A consumer that throws synchronously or returns a plain value must settle its entry, never stall the queue.
    const running = new Promise<unknown>((resolve) => { resolve(entry.scope && isScopeUsable(entry.scope) ? runInScope(entry.scope, prompt) : prompt()) })
    running.then(
      result => entry.settle(consumerOutcome(entry.request, result)),
      error => entry.settle(entry.controller.signal.aborted ? cancelledOutcome(entry.request, 'prompt aborted') : new RuntimeError(InteractionErrorCode.consumerFailed, `CLI consumer failed for request ${entry.request.id}`, { cause: error })),
    )
  }

  function removeFromQueue(entry: Entry): void {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
  }

  function settleUnavailable(entry: Entry, reason: UnavailableReason): void {
    if (entry.settled) return
    const persist = options.onUnavailable ?? (() => Promise.resolve(undefined))
    const outcome: Promise<CliOutcome> = Promise.resolve().then(() => persist(entry.request, reason)).then(pending => ({ status: 'unavailable', requestId: entry.request.id, reason, ...(pending ? { pending } : {}) }))
    persisting.add(outcome)
    const done = () => { persisting.delete(outcome) }
    outcome.then(done, done)
    entry.settle(outcome)
  }

  return {
    requestCli,
    pending: () => queue.length + (active ? 1 : 0),
    // With a durable queue, waiting requests are persisted rather than lost; without one they are cancelled.
    close(reason = 'runtime shutting down') {
      closed = true
      for (const entry of [active, ...queue.splice(0)]) {
        if (!entry) continue
        if (options.onUnavailable) settleUnavailable(entry, 'closed')
        else entry.settle(cancelledOutcome(entry.request, reason))
      }
      return Promise.allSettled([...persisting]).then(() => undefined)
    },
  }
}

function consumerOutcome(request: CliRequest, result: unknown): CliOutcome | RuntimeError {
  if (isAnswered(result)) return { status: 'answered', requestId: request.id, answer: result.answer }
  if (isDenied(result)) return { status: 'denied', requestId: request.id, reason: result.reason }
  return new RuntimeError(InteractionErrorCode.consumerFailed, `CLI consumer returned an invalid result for request ${request.id}`)
}

function isAnswered(result: unknown): result is Extract<CliConsumerResult, { status: 'answered' }> {
  const candidate = result as { status?: unknown; answer?: { choice?: unknown; note?: unknown } } | null
  return candidate?.status === 'answered' && typeof candidate.answer?.choice === 'string' && (candidate.answer.note === undefined || typeof candidate.answer.note === 'string')
}

function isDenied(result: unknown): result is Extract<CliConsumerResult, { status: 'denied' }> {
  const candidate = result as { status?: unknown; reason?: unknown } | null
  return candidate?.status === 'denied' && (candidate.reason === undefined || typeof candidate.reason === 'string')
}

export function cancelledOutcome(request: CliRequest, reason: unknown): CliOutcome {
  return { status: 'cancelled', requestId: request.id, reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled') }
}
