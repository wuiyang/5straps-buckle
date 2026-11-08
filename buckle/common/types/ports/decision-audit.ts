import type { GrantScope } from '@5straps/protocol'
import type { ApprovalErrorCode, GrantSave } from './approval-backend.js'
import type { ApprovalSource, Assurance } from './approval-source.js'

/** What carried a decision: nothing beyond its route, a device's signed request, or the envelope the paired key sealed. */
export type DecisionProofKind = 'none' | 'device' | 'envelope'

/**
 * A decision as its audit entries name it; `decidedBy` names the key that signed a device's decision, or the judge that
 * passed it, and `caller` the actor a form answer's transport authenticated.
 */
export interface AuditedDecision {
  token: string
  approved: boolean
  scope: GrantScope
  source: ApprovalSource
  proof: DecisionProofKind
  decidedBy?: string
  caller?: string
}

/** A skip of an approval's save, as its audit entries name it. */
export interface AuditedSkip {
  token: string
  source: ApprovalSource
  caller?: string
}

/** How a received answer ended, told once. */
export interface AuditEnding<Applied> {
  applied(outcome: Applied): void
  refused(refusal: { code: ApprovalErrorCode }): void
  /** The answer stopped on an error before the ledger said how it ended. */
  failed(): void
}

/** `save`: where the lasting grant of a session or always approval stands once the answer applied. */
export type DecisionEnding = AuditEnding<{ assurance: Assurance; repeated: boolean; save?: GrantSave }>
/** `repeated`: the save was skipped already; `removed`: its grant had saved and is gone; `unfinished`: its removal is not confirmed. */
export type SkipEnding = AuditEnding<{ repeated: boolean; removed: boolean; unfinished?: true }>

/**
 * Each decision's audit, and each skip's: received before the ledger reads it, then how it ended, never inside the
 * approvals lock. Every call returns at once and never throws, so a record that cannot be written never holds up or
 * refuses an answer.
 */
export interface DecisionAudit {
  received(decision: AuditedDecision): DecisionEnding
  skipReceived(skip: AuditedSkip): SkipEnding
}
