import type { ApprovalDecision, ApprovalRequest, PermissionRuleId } from '@5straps/protocol'
import type { ApprovalErrorCode } from '../../types/ports/approval-backend.js'
import type { ApprovalSource } from '../../types/ports/approval-source.js'
import { approvesFloor, atLeast, rightsOf, type SourceRights } from './assurance.js'
import { RECORDED_BEFORE_NOTE } from './recorded-before-note.js'
import { routeOf, type RecordedRoute } from './routes.js'
import type { AskMarks } from '../permission/decision.js'
import { FLOOR_POLICY, type FloorPolicy } from '../permission/floor-policy.js'
import { isSecretFileSubject } from '../permission/rules/sensitive-path-rule.js'
import { compileHostPattern, UrlPatternError } from '../url-pattern.js'

export type GuardRefusalCode = Extract<ApprovalErrorCode,
  | 'unknown_ask' | 'conflicting_decision' | 'action_mismatch' | 'incomplete_action' | 'scope_not_offered' | 'scope_forbidden'
  | 'statement_invalid' | 'proof_expired' | 'assurance_too_low' | 'capability_exceeded' | 'approver_not_allowed'>

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
  /** The actor the transport authenticated for the request that carried a form answer, never one the body names. */
  caller?: string
}

/** `actor`, on either: the identity the transport authenticated for the call that raised the ask. */
export interface LedgerView {
  /** `owedBy`: the source that recorded a decision whose lasting grant is still owed. */
  resolved?: { decision: ApprovalDecision; widenedTo?: string; request?: ApprovalRequest; owedBy?: ApprovalSource; actor?: string }
  /**
   * `challenges`: the digests the ask was shown under, with the workspace's name and without it. `marks`: the rule's floor
   * and destructive marks. `routes`: the routes the ask was sent down.
   */
  waiting?: { request: ApprovalRequest; complete: boolean; challenges: readonly string[]; marks: AskMarks; routes: readonly RecordedRoute[]; actor?: string }
}

/** The workspace's settings a decision meets, as core reads them when it decides, never from the route that sent it. */
export interface LiveSettings {
  /** Whether MCP form answers decide here: the forms setting as it stands now. */
  forms: boolean
}

export interface DecisionPlan { widenedTo?: string; wider?: string }

export type GuardVerdict =
  | GuardRefusal
  | { ok: true; repeated: true; asked?: { rule: PermissionRuleId; subject: string } }
  | { ok: true; apply: DecisionPlan }

// Needs no ask, so the registry also runs it before it locks the approvals file.
export function screenDecision(claim: DecisionClaim, live: LiveSettings): GuardRefusal | { ok: true; widenedTo?: string } {
  const { decision } = claim
  const rights = rightsOf(claim.source.kind)
  const unset = settingRefusal({ rights, live })
  if (unset) return unset
  if (decision.approved && !rights.approves) return refuse('capability_exceeded', 'Approval requires an enrolled device key: review and confirm with buckle client approve')
  const lasting = decision.scope !== 'once' && !(rights.deniesLasting && !decision.approved)
  if (lasting && !atLeast(rights.assurance, 'local')) return refuse('assurance_too_low', 'This answer is relayed, so it decides once and nothing that outlives the call')
  if (claim.widenTo === undefined) return { ok: true }
  return checkWidening({ pattern: claim.widenTo, decision, source: claim.source })
}

/**
 * The live settings come first, then the caller where the source's rights bind it, so a repeat, a save retry, and an
 * ask already gone meet them too. `policy`: whether the file floor takes scope always; today's floor policy unless a
 * caller turns it the safer way.
 */
export function guardDecision(input: { claim: DecisionClaim; ledger: LedgerView; now: number; live: LiveSettings; policy?: FloorPolicy }): GuardVerdict {
  const { claim: { decision }, claim, ledger } = input
  const policy = input.policy ?? FLOOR_POLICY
  const screened = screenDecision(claim, input.live)
  if (!screened.ok) return screened
  const { widenedTo } = screened
  const rights = rightsOf(claim.source.kind)
  const raised = ledger.resolved ?? ledger.waiting
  const stranger = raised === undefined ? null : callerRefusal({ rights, source: claim.source, caller: claim.caller, actor: raised.actor })
  if (stranger) return stranger
  if (ledger.resolved) return repeatOf({ decision, widenedTo, resolved: ledger.resolved, source: claim.source })
  const asked = ledger.waiting
  if (!asked) return refuse('unknown_ask', 'Approval token is unknown or expired')
  const unrouted = routingRefusal({ source: claim.source, rights, routes: asked.routes, approved: decision.approved })
  if (unrouted) return unrouted
  if (claim.challenge !== undefined && !asked.challenges.includes(claim.challenge)) return refuse('action_mismatch', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows')
  // Owner decision D17, on every route: an ask never shown whole is never approved.
  if (decision.approved && !asked.complete) return refuse('incomplete_action', `This ask was ${RECORDED_BEFORE_NOTE}`)
  // A floor ask always reaches a person: the decision AI rates it and never approves it.
  if (decision.approved && asked.marks.floor && !approvesFloor(rights)) return refuse('assurance_too_low', 'A person decides a floor ask: approve it at the node, or with an enrolled key')
  const { request } = asked
  if (decision.approved && !request.offeredScopes.includes(decision.scope)) return refuse('scope_not_offered', `Scope ${decision.scope} is not offered for this approval`)
  if (decision.approved && decision.scope === 'always' && alwaysForbidden({ request, marks: asked.marks, policy })) return refuse('scope_forbidden', 'A destructive ask is approved once or for the session, never always')
  const wider = widerGrant({ decision, request, widened: widenedTo !== undefined, widens: rights.widens })
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

/**
 * What a skip meets in the ledger: the decision recorded, the source kept with the grant it made, while it keeps one,
 * and the actor of the call that raised its ask.
 */
export interface RecordedForSkip { approved: boolean; scope: ApprovalDecision['scope']; source?: ApprovalSource; actor?: string }

/** A skip gives up a session or always approval's grant, and only the source that recorded the decision sends one. */
// Needs no decision, so the registry also runs it before it locks the approvals file.
export function screenSkip(input: { source: ApprovalSource; live: LiveSettings }): GuardRefusal | { ok: true } {
  return settingRefusal({ rights: rightsOf(input.source.kind), live: input.live }) ?? { ok: true }
}

export function guardSkip(input: { source: ApprovalSource; caller?: string; recorded: RecordedForSkip | undefined; live: LiveSettings }): GuardRefusal | { ok: true } {
  const { recorded } = input
  const rights = rightsOf(input.source.kind)
  const screened = screenSkip(input)
  if (!screened.ok) return screened
  if (recorded === undefined) return refuse('unknown_ask', 'No decision is recorded for this token, so it has no save to skip')
  const stranger = callerRefusal({ rights, source: input.source, caller: input.caller, actor: recorded.actor })
  if (stranger) return stranger
  if (!recorded.approved || recorded.scope === 'once') return refuse('conflicting_decision', 'This decision made no session or always grant, so it has no save to skip')
  if (recorded.source !== undefined && !sameSource(recorded.source, input.source)) return refuse('approver_not_allowed', `${recorded.source.id} recorded this decision, so only it may skip its save`)
  return { ok: true }
}

function sameSource(left: ApprovalSource, right: ApprovalSource): boolean {
  return left.id === right.id && left.kind === right.kind
}

function settingRefusal(input: { rights: SourceRights; live: LiveSettings }): GuardRefusal | null {
  if (input.rights.whileFormsOn && !input.live.forms) return refuse('approver_not_allowed', 'MCP form approvals are off in this workspace (approval.forms), so a form answer decides nothing: answer at the node')
  return null
}

// No caller, or an ask that recorded no actor, is never the same caller.
function callerRefusal(input: { rights: SourceRights; source: ApprovalSource; caller: string | undefined; actor: string | undefined }): GuardRefusal | null {
  if (!input.rights.sameCaller || (input.caller !== undefined && input.caller === input.actor)) return null
  return refuse('approver_not_allowed', `Only the caller that raised this ask answers it through ${input.source.id}: answer it at the node`)
}

function refuse(code: GuardRefusalCode, reason: string): GuardRefusal {
  return { ok: false, code, reason }
}

function repeatOf(input: { decision: ApprovalDecision; widenedTo: string | undefined; resolved: NonNullable<LedgerView['resolved']>; source: ApprovalSource }): GuardVerdict {
  const { decision, resolved } = input
  const previous = resolved.decision
  const same = previous.approved === decision.approved && previous.scope === decision.scope && resolved.widenedTo === input.widenedTo && previous.subject === decision.subject
  if (!same) return refuse('conflicting_decision', 'Approval already has a different decision')
  // Only the source that recorded a decision retries its owed grant's save, as only it skips one.
  if (resolved.owedBy !== undefined && !sameSource(resolved.owedBy, input.source)) return refuse('approver_not_allowed', `${resolved.owedBy.id} recorded this decision, so only it may retry its save`)
  return { ok: true, repeated: true, ...(resolved.request ? { asked: { rule: resolved.request.rule, subject: resolved.request.subject } } : {}) }
}

// A destructive command never takes always, whatever an ask offered; the file floor does while the floor policy offers it.
function alwaysForbidden(input: { request: ApprovalRequest; marks: AskMarks; policy: FloorPolicy }): boolean {
  if (input.request.rule === 'destructive_command') return true
  return input.marks.destructive && !input.policy.alwaysAtFloor
}

// The source's own route; a source routed to every ask, or one that only denies under a notify route.
function routingRefusal(input: { source: ApprovalSource; rights: SourceRights; routes: readonly RecordedRoute[]; approved: boolean }): GuardRefusal | null {
  if (input.rights.everyAsk) return null
  const route = routeOf(input.source, input.routes)
  if (route === undefined) return refuse('approver_not_allowed', `This ask was not routed to ${input.source.id}`)
  if (route.role === 'notify' && input.approved) return refuse('approver_not_allowed', `${input.source.id} is only told of this ask, so it may deny it and never approve it`)
  return null
}

// Only the ask's own widerSubject, approved for the session or always: a once covers the one call that asked.
function widerGrant(input: { decision: ApprovalDecision; request: ApprovalRequest; widened: boolean; widens: boolean }): { subject: string } | GuardRefusal | null {
  const named = input.decision.subject
  if (named === undefined || named === input.request.subject) return null
  if (!input.decision.approved) return refuse('statement_invalid', 'A denial names no subject: it denies the ask\'s own')
  if (!input.widens) return refuse('scope_forbidden', 'Only the node\'s terminal and buckle approve grant a folder and its subfolders')
  if (input.request.widerSubject === undefined || named !== input.request.widerSubject) return refuse('scope_not_offered', `This ask grants ${input.request.subject}${input.request.widerSubject === undefined ? '' : ` or ${input.request.widerSubject}`}, not ${named}`)
  if (input.decision.scope === 'once') return refuse('scope_forbidden', 'A once approval covers the one call that asked; grant the folder and its subfolders for the session or always instead')
  if (input.widened) return refuse('scope_forbidden', 'A host pattern and a wider subject do not combine')
  return { subject: named }
}

function checkWidening(input: { pattern: string; decision: ApprovalDecision; source: ApprovalSource }): { ok: true; widenedTo: string } | GuardRefusal {
  if (input.source.kind !== 'cli') return refuse('scope_forbidden', 'Only buckle approve widens an approval to a host pattern')
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
