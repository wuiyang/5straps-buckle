import type { GrantScope } from '@5straps/protocol'
import type { ApprovalErrorCode } from './approval-backend.js'
import type { ApprovalSource, Assurance } from './approval-source.js'

/** What carried a decision: nothing beyond its route, a device's signed request, or the envelope the paired key sealed. */
export type DecisionProofKind = 'none' | 'device' | 'envelope'

/** A decision as its audit entries name it; `decidedBy` names the key that signed a device's decision, or the judge that passed it. */
export interface AuditedDecision {
  token: string
  approved: boolean
  scope: GrantScope
  source: ApprovalSource
  proof: DecisionProofKind
  decidedBy?: string
}

/** How a received decision ended, told once. */
export interface DecisionEnding {
  applied(outcome: { assurance: Assurance; repeated: boolean; grantOwed: boolean }): void
  refused(refusal: { code: ApprovalErrorCode }): void
  /** The decision stopped on an error before the ledger said how it ended. */
  failed(): void
}

/**
 * Each decision's audit: received before the guard runs, then how it ended, never inside the approvals lock. Every call
 * returns at once and never throws, so a record that cannot be written never holds up or refuses an answer.
 */
export interface DecisionAudit {
  received(decision: AuditedDecision): DecisionEnding
}
