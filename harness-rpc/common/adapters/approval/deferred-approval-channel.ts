import type { ApprovalChannel } from '../../types/ports/approval-channel.js'

/**
 * The universal fallback: no user is reachable from here, so the invoker reports
 * `approval_required` and whichever harness is driving relays the question.
 */
export function createDeferredApprovalChannel(): ApprovalChannel {
  return {
    id: 'deferred',
    request: async () => null,
  }
}
