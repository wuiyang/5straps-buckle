import type { GrantScope } from '@5straps/protocol'
import type { Assurance } from '../../domain/approval/assurance.js'
import type { ApprovalErrorCode } from './approval-backend.js'
import type { ApprovalSource } from './approval-source.js'

/** What carried a decision: nothing beyond its route, a device's signed request, or the envelope the paired key sealed. */
export type DecisionProofKind = 'none' | 'device' | 'envelope'

/** A decision as its audit entries name it; `decidedBy` names the key that signed a device's decision. */
export interface AuditedDecision {
  token: string
  approved: boolean
  scope: GrantScope
  source: ApprovalSource
  proof: DecisionProofKind
  decidedBy?: string
}

/** Each decision's audit: received before the guard runs, then applied or refused, never inside the approvals lock. */
export interface DecisionAudit {
  received(decision: AuditedDecision): Promise<void>
  applied(decision: AuditedDecision & { assurance: Assurance; repeated: boolean; grantOwed: boolean }): Promise<void>
  refused(decision: AuditedDecision & { code: ApprovalErrorCode; reason: string }): Promise<void>
}
