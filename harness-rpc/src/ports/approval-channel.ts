import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'

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
