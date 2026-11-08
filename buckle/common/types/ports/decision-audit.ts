import type { GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { CallAttempt } from './action-log.js'
import type { ApprovalErrorCode, GrantSave } from './approval-backend.js'
import type { ApprovalSource, Assurance } from './approval-source.js'

/** What carried a decision: nothing beyond its route, a device's signed request, or the envelope the paired key sealed. */
export type DecisionProofKind = 'none' | 'device' | 'envelope'

/** The widening an answer asked for: none, the ask's wider subject (`below`), or a host pattern `buckle approve --host` sent. */
export type AuditedWidening = { kind: 'none' } | { kind: 'below' } | { kind: 'host'; pattern: string }

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
  widen: AuditedWidening
  decidedBy?: string
  caller?: string
}

/** The call a decision answered, as the ledger held its ask: the rule and subject asked about, and the call's attempt entry where the ask kept it. */
export interface AnsweredCall { rule: PermissionRuleId; subject: string; attempt?: CallAttempt }

/** A skip of an approval's save, as its audit entries name it. */
export interface AuditedSkip {
  token: string
  source: ApprovalSource
  caller?: string
}

/** How a received answer ended, told once. */
export interface AuditEnding<Applied, Refused = { code: ApprovalErrorCode }> {
  applied(outcome: Applied): void
  refused(refusal: Refused): void
  /** The answer stopped on an error before the ledger said how it ended. */
  failed(): void
}

/**
 * `save`: where the lasting grant of a session or always approval stands once the answer applied; `widenedTo`: the subject
 * the grant took in place of the ask's own; `call`: the call it answered, where the ledger held its ask, a refusal's too.
 */
export type DecisionEnding = AuditEnding<
  { assurance: Assurance; repeated: boolean; save?: GrantSave; widenedTo?: string; call?: AnsweredCall },
  { code: ApprovalErrorCode; call?: AnsweredCall }
>
/** `repeated`: the save was skipped already; `removed`: its grant had saved and is gone; `unfinished`: its removal is not confirmed. */
export type SkipEnding = AuditEnding<{ repeated: boolean; removed: boolean; unfinished?: true }>

/**
 * Why sessions end: the session idled past its window, a stdio MCP process ended, or `buckle serve` stopped or first opened
 * the workspace after it started, which ends every caller's HTTP MCP session, as that face keeps no session of its own to
 * close.
 */
export type SessionEndCause = 'idle' | 'stdio_closed' | 'serve_stopped' | 'serve_started'

/** One session's end, as its audit entry names it: the session and its actor, what it withdrew, dropped, and removed. */
export interface AuditedSessionEnd {
  sessionId: string
  /** The actor that asked in the session; absent for the node's own process. */
  actor?: string
  cause: SessionEndCause
  /** Asks still waiting, withdrawn. */
  withdrawn: number
  /** Once approvals no call spent. */
  onces: number
  /** Lasting grants decided but not yet written, which are now never written. */
  owed: number
  /** Session approvals and session denials removed from the grants. */
  grants: number
  denials: number
}

/**
 * Each decision's audit, and each skip's: received before the ledger reads it, then how it ended, never inside the
 * approvals lock; and each session's end, once it applied. Every call returns at once and never throws, so a record that
 * cannot be written never holds up or refuses an answer.
 */
export interface DecisionAudit {
  received(decision: AuditedDecision): DecisionEnding
  skipReceived(skip: AuditedSkip): SkipEnding
  sessionEnded(end: AuditedSessionEnd): void
}
