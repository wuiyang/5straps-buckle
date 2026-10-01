import type { ApprovalNotice, ApprovalRequest, ApprovalSkipReason, GrantScope } from '@5straps/protocol'
import type { ApprovalRegistry } from './approval-registry.js'
import { logger } from '../../runtime/log.js'

export interface ApprovalNotices {
  answered(input: { token: string; approved: boolean; scope: GrantScope; consumeNotAfter?: string }): void
  expired(requests: ApprovalRequest[]): void
  cancelled(tokens: string[]): void
  skipped(tokens: string[], reason: ApprovalSkipReason): void
  flush(): Promise<void>
  settle(): Promise<void>
}

export function createApprovalNotices(send?: (notices: ApprovalNotice[]) => Promise<void>, options: {
  registry?: Pick<ApprovalRegistry, 'pendingDeliveries' | 'acknowledgeDeliveries' | 'enqueueSkippedNotices'>
  retryMs?: number
} = {}): ApprovalNotices {
  if (send && options.registry) return createDurableNotices({ send, registry: options.registry, retryMs: options.retryMs ?? 5_000 })
  const inFlight = new Set<Promise<void>>()
  const deliver = (notices: ApprovalNotice[]) => {
    if (!send || notices.length === 0) return
    const delivery = send(notices).catch((error: unknown) => {
      // A notice that does not arrive changes nothing on the node: the durable queue still holds the truth.
      logger.warn('Could not send an approval lifecycle notice', { message: error instanceof Error ? error.message : 'Unknown error' })
    }).finally(() => { inFlight.delete(delivery) })
    inFlight.add(delivery)
  }
  const now = () => new Date().toISOString()
  return {
    answered: input => deliver([{ token: input.token, event: input.approved ? 'answered' : 'denied', at: now(), scope: input.scope, ...(input.consumeNotAfter === undefined ? {} : { consumeNotAfter: input.consumeNotAfter }) }]),
    expired: requests => deliver(requests.map(request => ({ token: request.token, event: 'expired', at: now() }))),
    cancelled: tokens => deliver(tokens.map(token => ({ token, event: 'cancelled', at: now() }))),
    skipped: (tokens, reason) => deliver(tokens.map(token => ({ token, event: 'skipped', at: now(), reason }))),
    flush: async () => { await Promise.allSettled([...inFlight]) },
    settle: async () => { while (inFlight.size > 0) await Promise.allSettled([...inFlight]) },
  }
}

function createDurableNotices(input: {
  send: (notices: ApprovalNotice[]) => Promise<void>
  registry: Pick<ApprovalRegistry, 'pendingDeliveries' | 'acknowledgeDeliveries' | 'enqueueSkippedNotices'>
  retryMs: number
}): ApprovalNotices {
  let active: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let closing: Promise<void> | null = null
  let requested = false
  // After a failed attempt the retry timer owns the next one (review L6 of the continuation review): a notice queued
  // meanwhile waits for it, rather than sending again to a receiver that just refused.
  let backingOff = false
  const enqueues = new Set<Promise<void>>()

  function flush(): Promise<void> {
    if (closed) return active ?? Promise.resolve()
    requested = true
    if (active) return active
    if (backingOff) return Promise.resolve()
    if (timer) clearTimeout(timer)
    timer = undefined
    active = drain().finally(() => {
      active = null
      if (!closed) {
        timer = setTimeout(() => { timer = undefined; backingOff = false; void flush() }, requested ? 0 : input.retryMs)
        timer.unref()
      }
    })
    return active
  }

  async function drain(): Promise<void> {
    try {
      // An enqueue may arrive while the last acknowledgement is being written.
      do {
        requested = false
        const entries = input.registry.pendingDeliveries().slice(0, 100)
        if (entries.length === 0) continue
        await input.send(entries.map(entry => entry.notice))
        await input.registry.acknowledgeDeliveries(entries.map(entry => entry.id))
        requested = !closed
      } while (requested)
    } catch (error: unknown) {
      requested = false
      backingOff = true
      logger.warn('Approval lifecycle delivery will be retried', { message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  function skipped(tokens: string[], reason: ApprovalSkipReason): void {
    if (closed || tokens.length === 0) return
    const at = new Date().toISOString()
    const enqueue = input.registry.enqueueSkippedNotices(tokens.map(token => ({ token, event: 'skipped', at, reason })))
      .then(() => flush())
      .catch((error: unknown) => {
        logger.warn('Could not record an approval wait notice', { message: error instanceof Error ? error.message : 'Unknown error' })
      }).finally(() => { enqueues.delete(enqueue) })
    enqueues.add(enqueue)
  }

  function settle(): Promise<void> {
    if (closing) return closing
    closed = true
    if (timer) clearTimeout(timer)
    timer = undefined
    closing = (async () => {
      await Promise.allSettled([...enqueues])
      if (active) await active
      else await drain()
    })()
    return closing
  }

  void flush()
  return {
    answered: () => { void flush() },
    expired: () => { void flush() },
    cancelled: () => { void flush() },
    skipped,
    flush,
    settle,
  }
}
