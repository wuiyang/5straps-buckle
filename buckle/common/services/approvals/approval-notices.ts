import type { ApprovalNotice, ApprovalSkipReason, GrantScope } from '@5straps/protocol'
import type { ApprovalRegistry } from './approval-registry.js'
import type { ApprovalDelivery } from '../../domain/approval/ledger-state.js'
import { NoticeRefusedError } from './approval-errors.js'
import { alreadyReported } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'

/** How long a notice the receiver refuses alone is held before it is sent again, while the notices behind it go on. */
const REFUSED_PAUSE_MS = 5 * 60_000

/** Why a call stopped waiting while its ask stays pending; `no_response`, which ends an ask, is the ledger's alone. */
export type WaitSkipReason = Exclude<ApprovalSkipReason, 'no_response'>

export interface ApprovalNotices {
  answered(input: { token: string; approved: boolean; scope: GrantScope; consumeNotAfter?: string }): void
  /** The asks nobody answered before they ran out: each skipped with the reason no_response (APPROVAL-36). */
  noResponse(tokens: string[]): void
  cancelled(tokens: string[]): void
  skipped(tokens: string[], reason: WaitSkipReason): void
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
    noResponse: tokens => deliver(tokens.map(token => ({ token, event: 'skipped', at: now(), reason: 'no_response' }))),
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
  // Notices the receiver refused alone, by outbox id, and until when each is held: the receiver may be on an older protocol
  // that cannot read one kind of notice (APPROVAL-36's no_response), and it must not stall the rest. Held in memory, so a
  // restart tries each once more; the outbox keeps the notice until it is taken or its retention passes.
  const held = new Map<string, number>()

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
        const entries = readyDeliveries()
        if (entries.length === 0) continue
        await deliver(entries)
        requested = !closed
      } while (requested)
    } catch (error: unknown) {
      requested = false
      backingOff = true
      // A damaged index the store already reported is retried quietly, not warned about at every retry (slice 7c
      // review R7C-TL-3).
      if (!alreadyReported(error)) logger.warn('Approval lifecycle delivery will be retried', { message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  function readyDeliveries(): ApprovalDelivery[] {
    const pending = input.registry.pendingDeliveries()
    const ids = new Set(pending.map(entry => entry.id))
    for (const id of held.keys()) if (!ids.has(id)) held.delete(id)
    const now = Date.now()
    return pending.filter(entry => (held.get(entry.id) ?? 0) <= now).slice(0, 100)
  }

  /**
   * One batch, sent whole, or in halves where the receiver refuses it, until the notice it refuses is alone and held. A
   * refused batch was taken in no part, so each half is sent once. Any other failure ends the attempt for the retry.
   */
  async function deliver(entries: ApprovalDelivery[]): Promise<void> {
    try {
      await input.send(entries.map(entry => entry.notice))
    } catch (error: unknown) {
      if (!(error instanceof NoticeRefusedError)) throw error
      if (entries.length === 1) return hold(entries[0]!)
      const half = Math.ceil(entries.length / 2)
      await deliver(entries.slice(0, half))
      return deliver(entries.slice(half))
    }
    await input.registry.acknowledgeDeliveries(entries.map(entry => entry.id))
  }

  function hold(entry: ApprovalDelivery): void {
    if (!held.has(entry.id)) logger.warn('Approval webhook refuses a lifecycle notice that the others do not; it is held and sent again every few minutes', { event: entry.notice.event, ...(entry.notice.reason === undefined ? {} : { reason: entry.notice.reason }) })
    held.set(entry.id, Date.now() + REFUSED_PAUSE_MS)
  }

  function skipped(tokens: string[], reason: WaitSkipReason): void {
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
    noResponse: () => { void flush() },
    cancelled: () => { void flush() },
    skipped,
    flush,
    settle,
  }
}
