import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCliConsumerSlot, createCliRequester, createHookRequestCli, createOperationScope, InteractionErrorCode, isRuntimeError, runInScope,
  runInTransactionMarker, RuntimeErrorCode, useScopeSafe, type CliConsumer, type CliConsumerResult, type CliOutcome, type CliRequest, type CliRespond,
} from '../../src/index.js'

function request(id: string, wait: CliRequest['wait'] = { mode: 'finite', timeoutMs: 1_000 }): CliRequest {
  return { id, kind: 'approval', correlationId: `corr-${id}`, action: { summary: `run ${id}` }, wait }
}

function answeringConsumer(log: string[] = []): CliConsumer & { maxConcurrent: number } {
  let running = 0
  const consumer = {
    maxConcurrent: 0,
    async prompt(item: CliRequest, { signal }: { signal: AbortSignal }) {
      running += 1
      consumer.maxConcurrent = Math.max(consumer.maxConcurrent, running)
      log.push(`${item.id}:${useScopeSafe()?.context.correlationId ?? 'none'}`)
      await delay(5, undefined, { signal })
      running -= 1
      return { status: 'answered' as const, answer: { choice: `answer-for-${item.id}` } }
    },
  }
  return consumer
}

afterEach(() => { vi.useRealTimers() })

describe('hook completion (createHookRequestCli)', () => {
  it('F07 returns the answered outcome through respond with the same request id', async () => {
    const requestCli = createHookRequestCli({ hasListener: () => true, dispatch: async (item, respond) => {
      respond({ status: 'answered', requestId: item.id, answer: { choice: 'yes' } })
    } })
    await expect(requestCli(request('a'))).resolves.toEqual({ status: 'answered', requestId: 'a', answer: { choice: 'yes' } })
  })

  it('F08 ignores a second respond, rejects a listener that never responds and drops a late response', async () => {
    const twice = createHookRequestCli({ hasListener: () => true, dispatch: async (item, respond) => {
      respond({ status: 'denied', requestId: item.id })
      respond({ status: 'answered', requestId: item.id, answer: { choice: 'yes' } })
    } })
    await expect(twice(request('a'))).resolves.toEqual({ status: 'denied', requestId: 'a' })

    const silent = createHookRequestCli({ hasListener: () => true, dispatch: async () => {} })
    const error = await silent(request('b')).catch((failure: unknown) => failure)
    expect(isRuntimeError(error, InteractionErrorCode.noCompletion)).toBe(true)

    vi.useFakeTimers()
    let late: CliRespond | undefined
    const slow = createHookRequestCli({ hasListener: () => true, dispatch: (_, respond) => { late = respond; return new Promise(() => {}) } })
    const controller = new AbortController()
    const waiting = slow(request('c', { mode: 'finite', timeoutMs: 50 }), { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(50)
    await expect(waiting).resolves.toMatchObject({ status: 'timed_out', requestId: 'c' })
    late!({ status: 'answered', requestId: 'c', answer: { choice: 'too late' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('F09 propagates a listener rejection promptly as a typed error', async () => {
    const requestCli = createHookRequestCli({ hasListener: () => true, dispatch: async () => { throw new Error('terminal crashed') } })
    const started = Date.now()
    const error = await requestCli(request('a')).catch((failure: unknown) => failure)
    // Well before the request's own 1 s timeout could settle it instead (loose bound, review L14).
    expect(Date.now() - started).toBeLessThan(500)
    expect(isRuntimeError(error, InteractionErrorCode.listenerFailed)).toBe(true)
    expect((error as Error).cause).toEqual(new Error('terminal crashed'))
  })

  it('F10 returns unavailable, never an approval, when no listener is registered', async () => {
    const dispatch = vi.fn()
    const requestCli = createHookRequestCli({ hasListener: () => false, dispatch })
    await expect(requestCli(request('a'))).resolves.toEqual({ status: 'unavailable', requestId: 'a', reason: 'no_listener' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('F16 settles cancelled on abort and removes its listener', async () => {
    const requestCli = createHookRequestCli({ hasListener: () => true, dispatch: () => new Promise(() => {}) })
    const controller = new AbortController()
    const waiting = requestCli(request('a', { mode: 'indefinite' }), { signal: controller.signal })
    controller.abort(new Error('client disconnected'))
    await expect(waiting).resolves.toEqual({ status: 'cancelled', requestId: 'a', reason: 'client disconnected' })
  })
})

describe('CLI requester queue', () => {
  it('F11 allows exactly one interactive consumer', () => {
    const slot = createCliConsumerSlot()
    const detach = slot.attach(answeringConsumer())
    expect(() => slot.attach(answeringConsumer())).toThrow(expect.objectContaining({ code: InteractionErrorCode.consumerAttached }))
    detach()
    expect(() => slot.attach(answeringConsumer())).not.toThrow()
  })

  it('F13 prompts one at a time, in order, inside each caller scope, with answers bound to their requests', async () => {
    const slot = createCliConsumerSlot()
    const log: string[] = []
    const consumer = answeringConsumer(log)
    slot.attach(consumer)
    const { requestCli } = createCliRequester({ slot })
    const outcomes = await Promise.all(['a', 'b', 'c'].map(id => runInScope(createOperationScope({ owner: Symbol('t'), context: { correlationId: `scope-${id}` } }), () => requestCli(request(id)))))
    expect(consumer.maxConcurrent).toBe(1)
    expect(log).toEqual(['a:scope-a', 'b:scope-b', 'c:scope-c'])
    expect(outcomes.map(outcome => outcome.status === 'answered' && outcome.answer.choice)).toEqual(['answer-for-a', 'answer-for-b', 'answer-for-c'])
  })

  it('F14 times out a finite wait, including while queued, and leaves no timers', async () => {
    vi.useFakeTimers()
    const slot = createCliConsumerSlot()
    slot.attach({ prompt: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) })
    const requester = createCliRequester({ slot })
    const first = requester.requestCli(request('a', { mode: 'finite', timeoutMs: 100 }))
    const queued = requester.requestCli(request('b', { mode: 'finite', timeoutMs: 50 }))
    await vi.advanceTimersByTimeAsync(100)
    await expect(queued).resolves.toMatchObject({ status: 'timed_out', requestId: 'b', waitedMs: 50 })
    await expect(first).resolves.toMatchObject({ status: 'timed_out', requestId: 'a', waitedMs: 100 })
    expect(requester.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('F15 keeps an indefinite wait open for 24 hours until the owner answers', async () => {
    vi.useFakeTimers()
    const slot = createCliConsumerSlot()
    const answer = Promise.withResolvers<{ status: 'answered'; answer: { choice: string } }>()
    slot.attach({ prompt: () => answer.promise })
    const { requestCli } = createCliRequester({ slot })
    let outcome: CliOutcome | undefined
    void requestCli(request('a', { mode: 'indefinite' })).then(value => { outcome = value })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
    expect(outcome).toBeUndefined()
    answer.resolve({ status: 'answered', answer: { choice: 'approve' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toEqual({ status: 'answered', requestId: 'a', answer: { choice: 'approve' } })
  })

  it('F16 cancels queued and active prompts and aborts the consumer', async () => {
    const slot = createCliConsumerSlot()
    let consumerSignal: AbortSignal | undefined
    slot.attach({ prompt: (_, { signal }) => { consumerSignal = signal; return new Promise(() => {}) } })
    const { requestCli } = createCliRequester({ slot })
    const activeController = new AbortController()
    const queuedController = new AbortController()
    const active = requestCli(request('a', { mode: 'indefinite' }), { signal: activeController.signal })
    const queued = requestCli(request('b', { mode: 'indefinite' }), { signal: queuedController.signal })
    queuedController.abort('caller left')
    await expect(queued).resolves.toEqual({ status: 'cancelled', requestId: 'b', reason: 'caller left' })
    activeController.abort('mcp notifications/cancelled')
    await expect(active).resolves.toEqual({ status: 'cancelled', requestId: 'a', reason: 'mcp notifications/cancelled' })
    expect(consumerSignal?.aborted).toBe(true)
  })

  it('F17 persists a durable pending id when headless and approves nothing', async () => {
    const persisted: string[] = []
    const { requestCli } = createCliRequester({ slot: createCliConsumerSlot(), onUnavailable: async (item, reason) => {
      persisted.push(`${item.id}:${reason}`)
      return { id: 'pending-1', instructions: 'Approve with: buckle approvals approve pending-1' }
    } })
    await expect(requestCli(request('a'))).resolves.toEqual({ status: 'unavailable', requestId: 'a', reason: 'no_consumer', pending: { id: 'pending-1', instructions: 'Approve with: buckle approvals approve pending-1' } })
    expect(persisted).toEqual(['a:no_consumer'])
  })

  it('marks waiting prompts unavailable when the consumer detaches, and cancels them on close', async () => {
    const slot = createCliConsumerSlot()
    const detach = slot.attach({ prompt: () => new Promise(() => {}) })
    const requester = createCliRequester({ slot })
    const active = requester.requestCli(request('a', { mode: 'indefinite' }))
    const queued = requester.requestCli(request('b', { mode: 'indefinite' }))
    detach()
    await expect(active).resolves.toMatchObject({ status: 'unavailable', reason: 'consumer_detached' })
    await expect(queued).resolves.toMatchObject({ status: 'unavailable', reason: 'consumer_detached' })

    slot.attach({ prompt: () => new Promise(() => {}) })
    const waiting = requester.requestCli(request('c', { mode: 'indefinite' }))
    requester.close()
    await expect(waiting).resolves.toEqual({ status: 'cancelled', requestId: 'c', reason: 'runtime shutting down' })
    await expect(requester.requestCli(request('d'))).resolves.toMatchObject({ status: 'unavailable', reason: 'closed' })
  })

  it('joins a re-sent request instead of prompting twice', async () => {
    const slot = createCliConsumerSlot()
    const prompt = vi.fn(async () => ({ status: 'answered' as const, answer: { choice: 'ok' } }))
    slot.attach({ prompt })
    const { requestCli } = createCliRequester({ slot })
    const [first, second] = await Promise.all([requestCli(request('a')), requestCli(request('a'))])
    expect(first).toBe(second)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('propagates a consumer failure as a typed error and keeps serving the queue', async () => {
    const slot = createCliConsumerSlot()
    let calls = 0
    slot.attach({ prompt: async () => { calls += 1; if (calls === 1) throw new Error('tty lost'); return { status: 'denied', reason: 'no' } } })
    const { requestCli } = createCliRequester({ slot })
    const [failed, denied] = await Promise.allSettled([requestCli(request('a')), requestCli(request('b'))])
    expect(failed.status === 'rejected' && isRuntimeError(failed.reason, InteractionErrorCode.consumerFailed)).toBe(true)
    expect(denied).toEqual({ status: 'fulfilled', value: { status: 'denied', requestId: 'b', reason: 'no' } })
  })

  it('refuses to wait for a human inside a database transaction', () => {
    const slot = createCliConsumerSlot()
    const { requestCli } = createCliRequester({ slot })
    const hookRequest = createHookRequestCli({ hasListener: () => true, dispatch: async () => {} })
    for (const ask of [requestCli, hookRequest]) {
      expect(() => runInTransactionMarker('tx-1', () => ask(request('a')))).toThrow(expect.objectContaining({ code: RuntimeErrorCode.waitInsideTransaction }))
    }
  })
})

describe('review fixes: request identity, cancellation and queue progress', () => {
  function envelope(id: string, actor: string, target: string): CliRequest {
    return { ...request(id, { mode: 'indefinite' }), correlationId: 'shared', actor, target }
  }

  it('H2 refuses to join a request with the same id but a different envelope', async () => {
    const slot = createCliConsumerSlot()
    const answer = Promise.withResolvers<{ status: 'answered'; answer: { choice: string } }>()
    const prompt = vi.fn(() => answer.promise)
    slot.attach({ prompt })
    const { requestCli } = createCliRequester({ slot })
    const alice = requestCli(envelope('confirm-delete', 'alice', 'a.txt'))
    const mallory = await requestCli(envelope('confirm-delete', 'mallory', 'b.txt')).catch((error: unknown) => error)
    expect(isRuntimeError(mallory, InteractionErrorCode.requestConflict)).toBe(true)
    answer.resolve({ status: 'answered', answer: { choice: 'approve' } })
    await expect(alice).resolves.toMatchObject({ status: 'answered' })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('H2 honours each joiner signal without cancelling the shared prompt', async () => {
    const slot = createCliConsumerSlot()
    const answer = Promise.withResolvers<{ status: 'answered'; answer: { choice: string } }>()
    let consumerSignal: AbortSignal | undefined
    slot.attach({ prompt: (_, { signal }) => { consumerSignal = signal; return answer.promise } })
    const { requestCli } = createCliRequester({ slot })
    const originalController = new AbortController()
    const joinerController = new AbortController()
    const original = requestCli(envelope('r1', 'alice', 'a.txt'), { signal: originalController.signal })
    const joiner = requestCli(envelope('r1', 'alice', 'a.txt'), { signal: joinerController.signal })
    const patient = requestCli(envelope('r1', 'alice', 'a.txt'))
    originalController.abort('original left')
    await expect(original).resolves.toEqual({ status: 'cancelled', requestId: 'r1', reason: 'original left' })
    joinerController.abort('joiner left')
    await expect(joiner).resolves.toEqual({ status: 'cancelled', requestId: 'r1', reason: 'joiner left' })
    expect(consumerSignal?.aborted).toBe(false)
    answer.resolve({ status: 'answered', answer: { choice: 'approve' } })
    await expect(patient).resolves.toMatchObject({ status: 'answered', answer: { choice: 'approve' } })
  })

  it('H2 cancels the shared prompt once every joined caller has left', async () => {
    const slot = createCliConsumerSlot()
    let consumerSignal: AbortSignal | undefined
    slot.attach({ prompt: (_, { signal }) => { consumerSignal = signal; return new Promise(() => {}) } })
    const { requestCli, pending } = createCliRequester({ slot })
    const first = new AbortController()
    const second = new AbortController()
    const waits = [requestCli(envelope('r1', 'alice', 'a.txt'), { signal: first.signal }), requestCli(envelope('r1', 'alice', 'a.txt'), { signal: second.signal })]
    first.abort('gone')
    second.abort('gone')
    await Promise.all(waits)
    expect(consumerSignal?.aborted).toBe(true)
    expect(pending()).toBe(0)
  })

  it('M1 gives the hook listener a signal that aborts when the caller settles', async () => {
    let listenerSignal: AbortSignal | undefined
    const requestCli = createHookRequestCli({ hasListener: () => true, dispatch: (_, __, options) => { listenerSignal = options?.signal; return new Promise(() => {}) } })
    const controller = new AbortController()
    const waiting = requestCli(request('a', { mode: 'indefinite' }), { signal: controller.signal })
    await delay(1)
    expect(listenerSignal?.aborted).toBe(false)
    controller.abort('caller left')
    await waiting
    expect(listenerSignal?.aborted).toBe(true)
  })

  it('M2 moves on to the next request when the consumer ignores abort', async () => {
    const slot = createCliConsumerSlot()
    const prompted: string[] = []
    slot.attach({ prompt: (item) => { prompted.push(item.id); return new Promise(() => {}) } })
    const requester = createCliRequester({ slot })
    const first = requester.requestCli(request('a', { mode: 'finite', timeoutMs: 20 }))
    void requester.requestCli(request('b', { mode: 'indefinite' }))
    await expect(first).resolves.toMatchObject({ status: 'timed_out' })
    await delay(1)
    expect(prompted).toEqual(['a', 'b'])
    expect(requester.pending()).toBe(1)
    requester.close()
  })

  it('L2 rejects waits that are not finite, positive and within the timer range', async () => {
    const slot = createCliConsumerSlot()
    slot.attach(answeringConsumer())
    const { requestCli } = createCliRequester({ slot })
    const hookRequest = createHookRequestCli({ hasListener: () => true, dispatch: async () => {} })
    for (const timeoutMs of [30 * 24 * 60 * 60 * 1_000, Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      for (const ask of [requestCli, hookRequest]) {
        const error = await ask(request(`t-${timeoutMs}`, { mode: 'finite', timeoutMs })).catch((failure: unknown) => failure)
        expect(isRuntimeError(error, InteractionErrorCode.invalidWait), `timeoutMs ${timeoutMs}`).toBe(true)
      }
    }
    await expect(requestCli(request('ok', { mode: 'finite', timeoutMs: 2 ** 31 - 1 }))).resolves.toMatchObject({ status: 'answered' })
  })

  it('L11 routes pending requests through onUnavailable on close', async () => {
    const slot = createCliConsumerSlot()
    slot.attach({ prompt: () => new Promise(() => {}) })
    const persisted: string[] = []
    const requester = createCliRequester({ slot, onUnavailable: async (item, reason) => {
      persisted.push(`${item.id}:${reason}`)
      return { id: `pending-${item.id}`, instructions: 'approve later' }
    } })
    const active = requester.requestCli(request('a', { mode: 'indefinite' }))
    const queued = requester.requestCli(request('b', { mode: 'indefinite' }))
    requester.close()
    await expect(active).resolves.toMatchObject({ status: 'unavailable', reason: 'closed', pending: { id: 'pending-a' } })
    await expect(queued).resolves.toMatchObject({ status: 'unavailable', reason: 'closed', pending: { id: 'pending-b' } })
    expect(persisted).toEqual(['a:closed', 'b:closed'])
  })
})

describe('requester close and consumer guards (coordination-2, coordination-5)', () => {
  it('coordination-2 close() resolves only after every durable write it started, detached ones included', async () => {
    const slot = createCliConsumerSlot()
    const detach = slot.attach({ prompt: () => new Promise(() => {}) })
    const recorded: string[] = []
    const requester = createCliRequester({ slot, onUnavailable: async (item, reason) => {
      await delay(50)
      recorded.push(`${item.id}:${reason}`)
      return { id: `pending-${item.id}`, instructions: 'approve later' }
    } })
    const detached = requester.requestCli(request('a', { mode: 'indefinite' }))
    await delay(1)
    detach()
    slot.attach({ prompt: () => new Promise(() => {}) })
    const closedOut = requester.requestCli(request('b', { mode: 'indefinite' }))
    await delay(1)
    await requester.close()
    expect(recorded.sort()).toEqual(['a:consumer_detached', 'b:closed'])
    await expect(detached).resolves.toMatchObject({ status: 'unavailable', pending: { id: 'pending-a' } })
    await expect(closedOut).resolves.toMatchObject({ status: 'unavailable', pending: { id: 'pending-b' } })
  })

  it('coordination-5 settles a prompt that throws synchronously or answers malformed, and keeps serving', async () => {
    const slot = createCliConsumerSlot()
    let calls = 0
    const gate = Promise.withResolvers<CliConsumerResult>()
    slot.attach({ prompt: () => {
      calls += 1
      if (calls === 1) return gate.promise
      if (calls === 2) throw new Error('tty closed')
      if (calls === 3) return Promise.resolve({ status: 'maybe' } as unknown as CliConsumerResult)
      return Promise.resolve({ status: 'answered', answer: { choice: 'ok' } })
    } })
    const requester = createCliRequester({ slot })
    const first = requester.requestCli(request('a', { mode: 'indefinite' }))
    const second = requester.requestCli(request('b', { mode: 'indefinite' })).catch((error: unknown) => error)
    const third = requester.requestCli(request('c', { mode: 'indefinite' })).catch((error: unknown) => error)
    const fourth = requester.requestCli(request('d', { mode: 'indefinite' }))
    gate.resolve({ status: 'denied', reason: 'no' })
    await expect(first).resolves.toEqual({ status: 'denied', requestId: 'a', reason: 'no' })
    expect(isRuntimeError(await second, InteractionErrorCode.consumerFailed)).toBe(true)
    expect(isRuntimeError(await third, InteractionErrorCode.consumerFailed)).toBe(true)
    await expect(fourth).resolves.toEqual({ status: 'answered', requestId: 'd', answer: { choice: 'ok' } })
    expect(requester.pending()).toBe(0)
  })

  it('coordination-5 turns a synchronous throw on the first prompt into a rejection', async () => {
    const slot = createCliConsumerSlot()
    slot.attach({ prompt: () => { throw new Error('tty closed') } })
    const requester = createCliRequester({ slot })
    const failed = await Promise.resolve().then(() => requester.requestCli(request('a'))).catch((error: unknown) => error)
    expect(isRuntimeError(failed, InteractionErrorCode.consumerFailed)).toBe(true)
    expect(requester.pending()).toBe(0)
  })
})
