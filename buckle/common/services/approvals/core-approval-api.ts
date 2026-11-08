import { z } from 'zod'
import { ApprovalDecisionSchema, GrantScopeSchema, SignedApprovalDecisionSchema, type ApprovalDecision, type ApprovalRequest, type ApprovalWithdraw, type GrantScope, type PermissionRuleId } from '@5straps/protocol'
import type { ApprovalChallenge, ShownApprovalCall } from '@5straps/protocol/signed-request'
import { rightsOf } from '../../domain/approval/assurance.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import { redactedSubject } from '../../domain/permission/rules/dangerously-allow.js'
import type { ApprovalError, ApprovalErrorCode, DecisionBody, DecisionReceipt } from '../../types/ports/approval-backend.js'
import { SOURCES, type Assurance } from '../../types/ports/approval-source.js'
import type { DecisionRefusal, OpenedDecision } from './approval-envelope.js'
import { isDeviceProof, spendDeviceProof, type DeviceProof } from './device-proof.js'
import type { ListedApproval } from './approval-listing.js'
import type { GroupSelector, GroupWithdrawal, PendingAsk, Resolution } from './approval-registry.js'
import type { ApprovalAnswer } from './approval-service.js'

/** What a core client sends. Core holds the source its tag names, and the decision guard checks it as any backend's. */
export type CoreDecisionInput =
  /** `buckle approve` and `buckle approvals --watch`: a person at the node. `hostPattern` is `--host` (BUCKLE-D18). */
  | { source: 'cli'; decision: DecisionBody; hostPattern?: string }
  /** `--approve-if-safe`: the thorough stage that passed, as `<stage>:<provider>:<model>`; its once binds to the code it rated. */
  | { source: 'judge'; decision: DecisionBody; rater: string; code?: CodeBinding }
  /**
   * The setup POST, signed by an enrolled device: `proof` is what the node's request verifier minted once the signature
   * checked and its nonce was claimed, which core checks again; the deadline is the proof's, never the body's. The body
   * is the decision.
   */
  | { source: 'devices'; body: unknown; proof: DeviceProof }
  /** The setup POST under the admin bearer: a plain body, or the envelope the key paired at setup seals. It only denies. */
  | { source: 'sealed'; body: unknown }

/** The rule and subject a decision answered. */
export interface AnsweredAsk { rule: PermissionRuleId; subject: string }

/** The decision as core read it from a client's input; `challenge` is the digest a device's key signed. */
export interface ReadDecision { token: string; approved: boolean; scope: GrantScope; challenge?: string }

/**
 * Where a refusal came: the proof that carried the decision, the statement it read as, or the decision itself, which
 * the decision guard checked.
 */
export type RefusalStep = 'proof' | 'statement' | 'decision'

/**
 * A backend's receipt, with what a core client says of it: the decision as read, the ask answered, and the wider subject
 * or host pattern an approval granted in place of the ask's own.
 */
export type CoreDecisionReceipt =
  | { status: 'applied'; state: 'approved' | 'denied'; assurance: Assurance; decision: ReadDecision; asked?: AnsweredAsk; granted?: string; widened?: { pattern: string; askedBy: string }; grantOwed?: true; saveError?: string }
  | { status: 'repeated'; state: 'approved' | 'denied'; decision: ReadDecision; asked?: AnsweredAsk; grantOwed?: true; saveError?: string }
  | { status: 'refused'; step: 'decision'; decision: ReadDecision; error: ApprovalError }
  | { status: 'refused'; step: 'proof' | 'statement'; error: ApprovalError }

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
  /** What the setup POST's audit entry keeps of a decision's receipt (decisionRecord). */
  decisionRecord(receipt: CoreDecisionReceipt): DecisionRecord | undefined
}

/** How a core client's input reads: the approval service's answer it makes, or why it makes none. */
export type ReadInput = { ok: true; answer: ApprovalAnswer } | { ok: false; receipt: CoreDecisionReceipt }

/** What reading an input needs of core: the envelope opener, which claims the envelope's nonce under its store's lock. */
export interface ReadContext {
  open(body: unknown): Promise<OpenedDecision>
}

/** The approval service's answer a core client's input makes, under the source core holds for its tag. */
export async function readInput(input: CoreDecisionInput, context: ReadContext): Promise<ReadInput> {
  switch (input.source) {
    case 'cli':
    case 'judge':
      return { ok: true, answer: answerOf(input) }
    case 'devices':
      return readSigned(input)
    case 'sealed':
      return readSealed(input.body, context)
  }
}

function answerOf(input: Extract<CoreDecisionInput, { source: 'cli' | 'judge' }>): ApprovalAnswer {
  const decision = decisionOf(input.decision)
  const widen = input.decision.widen === undefined ? {} : { widen: input.decision.widen }
  if (input.source === 'cli') return { decision, source: SOURCES.cli, ...widen, ...(input.hostPattern === undefined ? {} : { widenTo: input.hostPattern }) }
  return { decision, source: SOURCES.judge, ...widen, decidedBy: `judge:${input.rater}`.slice(0, 200), ...(input.code === undefined ? {} : { code: input.code }) }
}

// A person's key decides on the challenge the node signed, named by its digest, and on nothing else.
function readSigned(input: Extract<CoreDecisionInput, { source: 'devices' }>): ReadInput {
  const { proof } = input
  if (!isDeviceProof(proof)) return UNVERIFIED
  const refusal = spendDeviceProof(proof, input.body)
  if (refusal !== null) return { ok: false, receipt: { status: 'refused', step: 'proof', error: { code: refusal === 'replayed' ? 'replayed' : 'proof_invalid', message: refusal, retryable: false } } }
  const signed = SignedApprovalDecisionSchema.safeParse(input.body)
  if (!signed.success) return INVALID
  const { challenge, ...decision } = signed.data
  // The challenge a device was shown names the ask's own subject and no wider one, so its decision grants that alone.
  if (decision.subject !== undefined) return { ok: false, receipt: { status: 'refused', step: 'decision', decision: readOf(decision, challenge), error: { code: 'scope_forbidden', message: DEVICE_SUBJECT, retryable: false } } }
  return { ok: true, answer: { decision, source: SOURCES.devices, challenge, decidedBy: `key:${proof.keyId}`, consumeNotAfter: proof.deadline, proof: 'device' } }
}

async function readSealed(body: unknown, context: ReadContext): Promise<ReadInput> {
  const opened = await context.open(body)
  if (!opened.ok) return { ok: false, receipt: { status: 'refused', step: 'proof', error: { code: PROOF_CODES[opened.reason], message: opened.reason, retryable: false } } }
  const parsed = ApprovalDecisionSchema.safeParse(opened.body)
  if (!parsed.success) return INVALID
  // The sealed source only denies: the decision guard refuses its approvals.
  return { ok: true, answer: { decision: parsed.data, source: SOURCES.sealed, ...(opened.sealed ? { proof: 'envelope' as const } : {}) } }
}

const UNVERIFIED: ReadInput = { ok: false, receipt: { status: 'refused', step: 'proof', error: { code: 'proof_invalid', message: 'unverified', retryable: false } } }
const INVALID: ReadInput = { ok: false, receipt: { status: 'refused', step: 'statement', error: { code: 'statement_invalid', message: 'Invalid approval decision', retryable: false } } }
const DEVICE_SUBJECT = 'A device\'s decision grants the subject of the challenge it was shown and names none of its own; grant a folder and its subfolders at the node, with buckle approve --below'
const PROOF_CODES: Readonly<Record<DecisionRefusal, ApprovalErrorCode>> = { expired: 'proof_expired', replayed: 'replayed', tampered: 'proof_invalid', unknown_key: 'proof_invalid', plain_refused: 'proof_invalid' }

const DecisionInputSchema = z.object({
  kind: z.literal('plain'),
  decision: z.object({ token: z.string().min(1), outcome: z.enum(['approve', 'deny']), scope: GrantScopeSchema, widen: z.literal('below').optional() }).strict(),
}).strict()

/** A backend's decision as core reads it, checked whole since a backend may be any code; null for one that does not read as one. */
export function backendDecisionOf(input: unknown): DecisionBody | null {
  const parsed = DecisionInputSchema.safeParse(input)
  return parsed.success ? parsed.data.decision : null
}

/** What a backend gets for a decision that does not read as one: refused before the ledger is read. */
export const INVALID_BACKEND_DECISION: DecisionReceipt = { status: 'refused', error: { code: 'statement_invalid', message: 'Invalid approval decision', retryable: false } }

export function decisionOf(body: DecisionBody): ApprovalDecision {
  return { token: body.token, approved: body.outcome === 'approve', scope: body.scope }
}

function readOf(decision: ApprovalDecision, challenge: string | undefined): ReadDecision {
  return { token: decision.token, approved: decision.approved, scope: decision.scope, ...(challenge === undefined ? {} : { challenge }) }
}

/** What an answer came to, rated as the decision guard rated the source that sent it. */
export function receiptOf(input: { answer: ApprovalAnswer; result: Resolution }): CoreDecisionReceipt {
  const { answer, result } = input
  const decision = readOf(answer.decision, answer.challenge)
  if (!result.ok) return { status: 'refused', step: 'decision', decision, error: { code: result.code, message: result.reason, retryable: result.retryable === true } }
  const state = decision.approved ? 'approved' : 'denied'
  const said = {
    ...(result.asked === undefined ? {} : { asked: result.asked }),
    ...(result.grantOwed ? { grantOwed: true as const } : {}),
    ...(result.saveError === undefined ? {} : { saveError: result.saveError }),
  }
  if (result.repeated) return { status: 'repeated', state, decision, ...said }
  return {
    status: 'applied', state, assurance: rightsOf(answer.source.kind).assurance, decision, ...said,
    ...(result.granted === undefined ? {} : { granted: result.granted }),
    ...(result.widened === undefined ? {} : { widened: result.widened }),
  }
}

/**
 * What the setup POST's audit entry keeps of a decision the guard checked: the decision as read and, where it answered
 * an ask, the rule and the subject as the audit keeps subjects. Undefined for one refused before that.
 */
export type DecisionRecord = ReadDecision & Partial<AnsweredAsk> & { grantOwed?: true }

export function decisionRecord(receipt: CoreDecisionReceipt): DecisionRecord | undefined {
  if (receipt.status === 'refused') return receipt.step === 'decision' ? receipt.decision : undefined
  const { decision, asked } = receipt
  return { ...decision, ...(asked === undefined ? {} : { rule: asked.rule, subject: redactedSubject(asked.rule, asked.subject) }), ...(receipt.grantOwed ? { grantOwed: true } : {}) }
}

/** The receipt a backend reads: whether its decision applied, and whether its grant saved, never the subject a core client prints. */
export function backendReceipt(receipt: CoreDecisionReceipt): DecisionReceipt {
  if (receipt.status === 'refused') return { status: 'refused', error: receipt.error }
  const save = { ...(receipt.grantOwed ? { grantOwed: true as const } : {}), ...(receipt.saveError === undefined ? {} : { saveError: receipt.saveError }) }
  if (receipt.status === 'repeated') return { status: 'repeated', state: receipt.state, ...save }
  return { status: 'applied', state: receipt.state, assurance: receipt.assurance, ...save }
}
