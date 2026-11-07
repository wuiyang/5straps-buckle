import type { ApprovalDecision, ApprovalRequest, PermissionRuleId } from '@5straps/protocol'
import type { ApprovalSource } from '../../types/ports/approval-source.js'
import { assuranceOf, atLeast } from './assurance.js'
import { isSecretFileSubject } from '../permission/rules/sensitive-path-rule.js'
import { compileHostPattern, UrlPatternError } from '../url-pattern.js'

/** Owner decision D17: every route's words for an ask whose whole call cannot be shown, which nobody approves. */
export const RECORDED_BEFORE_NOTE = 'recorded before this build, or its kept call is missing or damaged: its whole call cannot be shown, so it cannot be approved; deny it, or have the agent re-send the call to ask again'

/** Named as the approval contract's ApprovalErrorCode values, so no mapping layer sits between them. */
export type GuardRefusalCode =
  | 'unknown_ask' | 'conflicting_decision' | 'action_mismatch' | 'incomplete_action' | 'scope_not_offered' | 'scope_forbidden'
  | 'statement_invalid' | 'proof_expired' | 'assurance_too_low'

export interface GuardRefusal { ok: false; code: GuardRefusalCode; reason: string }

export interface DecisionClaim {
  decision: ApprovalDecision
  source: ApprovalSource
  // BUCKLE-D18 host pattern: never a field of the decision, so only `buckle approve --host` can pass one.
  widenTo?: string
  /** The digest of the challenge a person's key signed. */
  challenge?: string
  /** A signed `once`'s proof deadline, in ms: the authenticated request's, never the body's. */
  consumeNotAfter?: number
}

export interface LedgerView {
  resolved?: { decision: ApprovalDecision; widenedTo?: string; request?: ApprovalRequest }
  /** `challenges`: the digests the ask was shown under, with the workspace's name and without it. */
  waiting?: { request: ApprovalRequest; complete: boolean; challenges: readonly string[] }
}

export interface DecisionPlan { widenedTo?: string; wider?: string }

export type GuardVerdict =
  | GuardRefusal
  | { ok: true; repeated: true; asked?: { rule: PermissionRuleId; subject: string } }
  | { ok: true; apply: DecisionPlan }

// Needs no ask, so the registry also runs it before it locks the approvals file.
export function screenDecision(claim: DecisionClaim): GuardRefusal | { ok: true; widenedTo?: string } {
  const { decision } = claim
  if (decision.scope !== 'once' && !atLeast(assuranceOf(claim.source), 'local')) return refuse('assurance_too_low', 'This answer is relayed, so it decides once and nothing that outlives the call')
  if (claim.widenTo === undefined) return { ok: true }
  return checkWidening({ pattern: claim.widenTo, decision, source: claim.source })
}

export function guardDecision(input: { claim: DecisionClaim; ledger: LedgerView; now: number }): GuardVerdict {
  const { claim: { decision }, claim, ledger } = input
  const screened = screenDecision(claim)
  if (!screened.ok) return screened
  const { widenedTo } = screened
  if (ledger.resolved) return repeatOf({ decision, widenedTo, resolved: ledger.resolved })
  const asked = ledger.waiting
  if (!asked) return refuse('unknown_ask', 'Approval token is unknown or expired')
  if (claim.challenge !== undefined && !asked.challenges.includes(claim.challenge)) return refuse('action_mismatch', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows')
  // Owner decision D17, on every route: an ask never shown whole is never approved.
  if (decision.approved && !asked.complete) return refuse('incomplete_action', `This ask was ${RECORDED_BEFORE_NOTE}`)
  const { request } = asked
  if (decision.approved && !request.offeredScopes.includes(decision.scope)) return refuse('scope_not_offered', `Scope ${decision.scope} is not offered for this approval`)
  const wider = widerGrant({ decision, request, widened: widenedTo !== undefined })
  if (wider !== null && 'reason' in wider) return wider
  // A secret file's use (docs/user/how-to/secrets.md) is remembered as other grants are; any other sensitive file is allowed once.
  if (request.rule === 'sensitive_path' && decision.approved && decision.scope !== 'once' && !isSecretFileSubject(request.subject)) return refuse('scope_forbidden', 'Sensitive files can only be allowed once')
  if (!decision.approved && decision.scope !== 'once' && request.rule !== 'sensitive_path') return refuse('scope_forbidden', 'Persistent denials are supported only for sensitive files')
  if (decision.approved && decision.scope === 'once' && claim.consumeNotAfter !== undefined && (!Number.isFinite(claim.consumeNotAfter) || claim.consumeNotAfter <= input.now)) return refuse('proof_expired', 'Signed approval expired before tool admission; sign a fresh decision over the current challenge')
  if (widenedTo !== undefined) {
    const refusal = patternRefusal({ rule: request.rule, subject: request.subject, pattern: widenedTo })
    if (refusal) return refuse('scope_forbidden', refusal)
  }
  return { ok: true, apply: { ...(widenedTo === undefined ? {} : { widenedTo }), ...(wider === null ? {} : { wider: wider.subject }) } }
}

function refuse(code: GuardRefusalCode, reason: string): GuardRefusal {
  return { ok: false, code, reason }
}

function repeatOf(input: { decision: ApprovalDecision; widenedTo: string | undefined; resolved: NonNullable<LedgerView['resolved']> }): GuardVerdict {
  const { decision, resolved } = input
  const previous = resolved.decision
  const same = previous.approved === decision.approved && previous.scope === decision.scope && resolved.widenedTo === input.widenedTo && previous.subject === decision.subject
  if (!same) return refuse('conflicting_decision', 'Approval already has a different decision')
  return { ok: true, repeated: true, ...(resolved.request ? { asked: { rule: resolved.request.rule, subject: resolved.request.subject } } : {}) }
}

// Only the ask's own widerSubject, approved for the session or always: a once covers the one call that asked.
function widerGrant(input: { decision: ApprovalDecision; request: ApprovalRequest; widened: boolean }): { subject: string } | GuardRefusal | null {
  const named = input.decision.subject
  if (named === undefined || named === input.request.subject) return null
  if (!input.decision.approved) return refuse('statement_invalid', 'A denial names no subject: it denies the ask\'s own')
  if (input.request.widerSubject === undefined || named !== input.request.widerSubject) return refuse('scope_not_offered', `This ask grants ${input.request.subject}${input.request.widerSubject === undefined ? '' : ` or ${input.request.widerSubject}`}, not ${named}`)
  if (input.decision.scope === 'once') return refuse('scope_forbidden', 'A once approval covers the one call that asked; grant the folder and its subfolders for the session or always instead')
  if (input.widened) return refuse('scope_forbidden', 'A host pattern and a wider subject do not combine')
  return { subject: named }
}

function checkWidening(input: { pattern: string; decision: ApprovalDecision; source: ApprovalSource }): { ok: true; widenedTo: string } | GuardRefusal {
  if (input.source !== 'cli') return refuse('scope_forbidden', 'Only buckle approve widens an approval to a host pattern')
  if (!input.decision.approved) return refuse('scope_forbidden', 'A denial names no host pattern; deny without --host')
  if (input.decision.scope === 'once') return refuse('scope_forbidden', 'A once approval covers one call to the host that asked; widen a session or always approval instead')
  const pattern = input.pattern.trim()
  let wildcard: boolean
  try {
    wildcard = compileHostPattern(pattern).wildcard
  } catch (error) {
    if (error instanceof UrlPatternError) return refuse('statement_invalid', error.message)
    throw error
  }
  if (!wildcard) return refuse('statement_invalid', `--host takes a wildcard pattern such as *.example.com, got ${pattern}; without --host the approval is for the host that asked`)
  return { ok: true, widenedTo: pattern }
}

// The subject carries no scheme, so it is tried as http and as https: a pattern naming port 443 covers one asked over https.
function patternRefusal(input: { rule: PermissionRuleId; subject: string; pattern: string }): string | null {
  if (input.rule !== 'network_egress') return `--host widens a network approval only; this one is ${input.rule} for ${input.subject}`
  const matcher = compileHostPattern(input.pattern)
  const covers = ['http', 'https'].some(scheme => {
    try {
      return matcher.matches(new URL(`${scheme}://${input.subject}/`))
    } catch {
      return false
    }
  })
  return covers ? null : `The pattern ${input.pattern} does not cover ${input.subject}, the host that asked`
}
