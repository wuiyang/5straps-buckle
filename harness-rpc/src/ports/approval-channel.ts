import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'

export interface ApprovalChannel {
  readonly id: string
  /**
   * Resolves once the user decides. Returning null means this channel cannot reach a user,
   * so the caller falls back to reporting `approval_required` to its driver.
   */
  request(requests: ApprovalRequest[]): Promise<ApprovalDecision[] | null>
}
