import type { ApprovalSeverity, GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { DeleteRunView } from '../delete-policy.js'
import type { ResolvedEffect } from '../effect.js'

export type PermissionDecision =
  | { kind: 'allow'; via?: GrantReference }
  /** `widerSubject`: what a person may grant for the session or always in place of `subject` (a delete's folder and subfolders). */
  | ({ kind: 'ask'; rule: PermissionRuleId; subject: string; reason: string; offeredScopes: GrantScope[]; cause?: AskCause; widerSubject?: string; severity?: ApprovalSeverity } & AskMarks)
  | { kind: 'deny'; rule: PermissionRuleId; subject: string; reason: string }

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/**
 * The marks the rule that asked sets, kept with the ask in the approvals ledger: `floor`, a person decides it, whatever
 * else could answer (the built-in command floor, the destructive list, and the file floor); `destructive`, it removes or
 * rewrites data (every destructive command ask, and the file floor).
 */
export interface AskMarks {
  floor: boolean
  destructive: boolean
}

/**
 * Why the destructive floor asked (D91), set by that rule alone and never sent anywhere: a built-in floor reason or
 * another reading limit (`floor`), an interpreter the policy does not allow and nothing else (`interpreter`), or the
 * workspace's destructive list (`destructive-list`); or set by the decision AI's gate, an allowed command its quick stage
 * rated danger, which a person now decides (`judge`). The thorough stage answers an `interpreter` ask; the quick stage, by
 * its scope, any but a `judge` one (domain/permission/judged.ts).
 */
export type AskCause = 'floor' | 'interpreter' | 'destructive-list' | 'judge'

/** The standing grant a rule relied on, so the action log can say why a call was permitted. */
export interface GrantReference {
  rule: PermissionRuleId
  subject: string
}

export interface GrantLookup {
  deniedSubjectsFor?(rule: PermissionRuleId): string[]
  /** Exact subjects, each compared as it was recorded; with `scopes`, those granted under one of them alone. */
  subjectsFor(rule: PermissionRuleId, scopes?: readonly GrantScope[]): string[]
  /** Host patterns the owner widened a network approval to; absent where none can exist. */
  patternsFor?(rule: PermissionRuleId): string[]
}

export interface RuleInput {
  tool: string
  effect: ResolvedEffect
  /** Every effect of the call, for a rule that judges the call as a whole (the mass-delete guard); `effect` alone where absent. */
  effects?: readonly ResolvedEffect[]
  /** What the script this call belongs to removed before it, for the mass-delete guard; absent for a call no script made. */
  run?: DeleteRunView
  grants: GrantLookup
}

export interface PermissionRule {
  id: PermissionRuleId
  /** Null means the effect is outside this rule's concern. */
  evaluate(input: RuleInput): PermissionDecision | null
}

export function ask(input: {
  rule: PermissionRuleId
  subject: string
  reason: string
  marks: Readonly<AskMarks>
  offeredScopes?: GrantScope[]
  cause?: AskCause
  severity?: ApprovalSeverity
}): Ask {
  const { rule, subject, reason, marks, cause, severity } = input
  return {
    kind: 'ask', rule, subject, reason, offeredScopes: input.offeredScopes ?? ['once', 'session', 'always'], floor: marks.floor, destructive: marks.destructive,
    ...(cause === undefined ? {} : { cause }), ...(severity === undefined ? {} : { severity }),
  }
}

/** The marks of an ask that is neither the floor nor destructive. */
export const PLAIN_MARKS: Readonly<AskMarks> = { floor: false, destructive: false }

/** The marks of every ask the file floor makes. */
export const FILE_FLOOR_MARKS: Readonly<AskMarks> = { floor: true, destructive: true }

/** The marks of a destructive command's ask: every one is destructive, and the built-in floor's and the destructive list's are the floor too. */
export function commandMarks(cause: AskCause): AskMarks {
  return { floor: cause === 'floor' || cause === 'destructive-list', destructive: true }
}

export function deny(rule: PermissionRuleId, subject: string, reason: string): PermissionDecision {
  return { kind: 'deny', rule, subject, reason }
}

export function allowedVia(rule: PermissionRuleId, subject: string): PermissionDecision {
  return { kind: 'allow', via: { rule, subject } }
}
