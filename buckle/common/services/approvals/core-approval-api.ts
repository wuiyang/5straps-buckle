import type { ApprovalDecision, ApprovalRequest, ApprovalWithdraw, PermissionRuleId } from '@5straps/protocol'
import type { ApprovalChallenge, ShownApprovalCall } from '@5straps/protocol/signed-request'
import { rightsOf, type Assurance } from '../../domain/approval/assurance.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import type { ApprovalError, DecisionBody, DecisionReceipt } from '../../types/ports/approval-backend.js'
import { SOURCES, type ApprovalSource } from '../../types/ports/approval-source.js'
import type { ListedApproval } from './approval-listing.js'
import type { GroupSelector, GroupWithdrawal, PendingAsk, Resolution } from './approval-registry.js'
import type { ApprovalAnswer } from './approval-service.js'

/** What a core client sends. Core holds the source its tag names, and the decision guard checks it as any backend's. */
export type CoreDecisionInput =
  /** `buckle approve` and `buckle approvals --watch`: a person at the node. `hostPattern` is `--host` (BUCKLE-D18). */
  | { source: 'cli'; decision: DecisionBody; hostPattern?: string }
  /** `--approve-if-safe`: the thorough stage that passed, as `<stage>:<provider>:<model>`; its once binds to the code it rated. */
  | { source: 'judge'; decision: DecisionBody; rater: string; code?: CodeBinding }

/** The rule and subject a decision answered. */
export interface AnsweredAsk { rule: PermissionRuleId; subject: string }

/**
 * A backend's receipt, with what a core client says of it: the ask answered, and the wider subject or host pattern an
 * approval granted in place of the ask's own.
 */
export type CoreDecisionReceipt =
  | { status: 'applied'; state: 'approved' | 'denied'; assurance: Assurance; asked?: AnsweredAsk; granted?: string; widened?: { pattern: string; askedBy: string }; grantOwed?: true }
  | { status: 'repeated'; state: 'approved' | 'denied'; asked?: AnsweredAsk; grantOwed?: true }
  | { status: 'refused'; error: ApprovalError }

/** Every waiting ask's challenge, with each large whole call carried once by its signed reference. */
export interface ChallengeListing {
  challenges: Array<{ token: string; challenge: ApprovalChallenge | null }>
  calls: Record<string, ShownApprovalCall>
}

/** A withdrawal, with its selector as the registry keeps it (a requestId hashed) for the audit entry. */
export interface CallWithdrawal extends GroupWithdrawal {
  selector: GroupSelector
}

/** Core's approval API for the processes and routes that are not backends: the CLI approvers and the setup routes. */
export interface CoreApprovalApi {
  decide(input: CoreDecisionInput): Promise<CoreDecisionReceipt>
  /** The requests still waiting in this workspace's queue. */
  pending(): ApprovalRequest[]
  /** The asks still waiting, each with the whole call it came from, for a client that shows them. */
  waiting(): PendingAsk[]
  /** One ask still waiting, with its call, read alone: what `buckle approve` shows. */
  waitingAsk(token: string): PendingAsk | undefined
  /** The waiting requests as a listing carries them: each group's whole call once, named by `callRef` from each of its asks. */
  listing(): ListedApproval[]
  /**
   * The challenges and each large whole call once, by its signed full-content reference. A challenge carries the
   * workspace's name only where `workspaceName` asks for it: a device from before the name existed refuses a challenge
   * with a field it does not know.
   */
  challengeListing(options?: { workspaceName?: boolean }): ChallengeListing
  /**
   * The owner's withdraw of one call (owner decision D6): its asks still waiting are withdrawn and told cancelled, and
   * its answered `once` approvals no call spent are dropped.
   */
  withdrawCall(selector: ApprovalWithdraw): Promise<CallWithdrawal>
}

/** The approval service's answer a core client's decision makes, under the source core holds for its tag. */
export function answerOf(input: CoreDecisionInput): ApprovalAnswer {
  const decision = decisionOf(input.decision)
  const widen = input.decision.widen === undefined ? {} : { widen: input.decision.widen }
  switch (input.source) {
    case 'cli':
      return { decision, source: SOURCES.cli, ...widen, ...(input.hostPattern === undefined ? {} : { widenTo: input.hostPattern }) }
    case 'judge':
      return { decision, source: SOURCES.judge, ...widen, decidedBy: `judge:${input.rater}`.slice(0, 200), ...(input.code === undefined ? {} : { code: input.code }) }
  }
}

export function decisionOf(body: DecisionBody): ApprovalDecision {
  return { token: body.token, approved: body.outcome === 'approve', scope: body.scope }
}

/** What a decision came to, rated as the decision guard rated the source that sent it. */
export function receiptOf(input: { decision: ApprovalDecision; source: ApprovalSource; result: Resolution }): CoreDecisionReceipt {
  const { result } = input
  if (!result.ok) return { status: 'refused', error: { code: result.code, message: result.reason, retryable: result.code === 'audit_unavailable' } }
  const state = input.decision.approved ? 'approved' : 'denied'
  const said = {
    ...(result.asked === undefined ? {} : { asked: result.asked }),
    ...(result.grantOwed ? { grantOwed: true as const } : {}),
  }
  if (result.repeated) return { status: 'repeated', state, ...said }
  return {
    status: 'applied', state, assurance: rightsOf(input.source.kind).assurance, ...said,
    ...(result.granted === undefined ? {} : { granted: result.granted }),
    ...(result.widened === undefined ? {} : { widened: result.widened }),
  }
}

/** The receipt a backend reads: whether its decision applied, never the subject a core client prints. */
export function backendReceipt(receipt: CoreDecisionReceipt): DecisionReceipt {
  if (receipt.status === 'refused') return receipt
  if (receipt.status === 'repeated') return { status: 'repeated', state: receipt.state }
  return { status: 'applied', state: receipt.state, assurance: receipt.assurance, ...(receipt.grantOwed ? { grantOwed: true } : {}) }
}
