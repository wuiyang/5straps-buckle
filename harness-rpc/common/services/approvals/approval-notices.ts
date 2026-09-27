import type { ApprovalNotice, ApprovalRequest, ApprovalSkipReason, GrantScope } from '@5straps/protocol'
import { logger } from '../../runtime/log.js'

/**
 * Lifecycle notices for announced asks (plan section C: how Rings and Visual show unresolved asks),
 * sent on the approval webhook's sealed path. Delivery never holds a call: each notice is sent in
 * the background, and `settle` waits for those still in flight, so a one-shot command or a closing
 * node sends what it owes before it exits.
 */
export interface ApprovalNotices {
  answered(input: { token: string; approved: boolean; scope: GrantScope }): void
  expired(requests: ApprovalRequest[]): void
  cancelled(tokens: string[]): void
  skipped(tokens: string[], reason: ApprovalSkipReason): void
  settle(): Promise<void>
}

export function createApprovalNotices(send?: (notices: ApprovalNotice[]) => Promise<void>): ApprovalNotices {
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
    answered: input => deliver([{ token: input.token, event: input.approved ? 'answered' : 'denied', at: now(), scope: input.scope }]),
    expired: requests => deliver(requests.map(request => ({ token: request.token, event: 'expired', at: now() }))),
    cancelled: tokens => deliver(tokens.map(token => ({ token, event: 'cancelled', at: now() }))),
    skipped: (tokens, reason) => deliver(tokens.map(token => ({ token, event: 'skipped', at: now(), reason }))),
    settle: async () => { await Promise.allSettled([...inFlight]) },
  }
}
