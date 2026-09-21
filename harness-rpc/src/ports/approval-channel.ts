import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'

/**
 * Whose answer a decision carries. `BUCKLE-D14` keeps a persisted approval on the admin
 * credential alone: a face reachable with an agent's token resolves as `agent`, and the
 * registry then admits `once` and nothing durable.
 */
export type ApprovalAuthority = 'admin' | 'agent'

export interface ApprovalChannel {
  readonly id: string
  /**
   * Resolves once the user decides. Returning null means this channel cannot reach a user,
   * so the caller falls back to reporting `approval_required` to its driver.
   *
   * An aborted signal means the decision arrived elsewhere or the grace period ended. A channel
   * holding a resource, a terminal above all, must release it rather than keep asking.
   */
  request(requests: ApprovalRequest[], signal?: AbortSignal): Promise<ApprovalDecision[] | null>
}
