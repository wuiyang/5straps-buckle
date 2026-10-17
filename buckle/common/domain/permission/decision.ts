import type { GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { ResolvedEffect } from '../effect.js'

export type PermissionDecision =
  | { kind: 'allow'; via?: GrantReference }
  | { kind: 'ask'; rule: PermissionRuleId; subject: string; reason: string; offeredScopes: GrantScope[]; cause?: AskCause }
  | { kind: 'deny'; rule: PermissionRuleId; subject: string; reason: string }

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
  /** Exact subjects, each compared as it was recorded. */
  subjectsFor(rule: PermissionRuleId): string[]
  /** Host patterns the owner widened a network approval to; absent where none can exist. */
  patternsFor?(rule: PermissionRuleId): string[]
}

export interface RuleInput {
  tool: string
  effect: ResolvedEffect
  grants: GrantLookup
}

export interface PermissionRule {
  id: PermissionRuleId
  /** Null means the effect is outside this rule's concern. */
  evaluate(input: RuleInput): PermissionDecision | null
}

export function ask(
  rule: PermissionRuleId,
  subject: string,
  reason: string,
  offeredScopes: GrantScope[] = ['once', 'session', 'always'],
  cause?: AskCause,
): PermissionDecision {
  return { kind: 'ask', rule, subject, reason, offeredScopes, ...(cause === undefined ? {} : { cause }) }
}

export function deny(rule: PermissionRuleId, subject: string, reason: string): PermissionDecision {
  return { kind: 'deny', rule, subject, reason }
}

export function allowedVia(rule: PermissionRuleId, subject: string): PermissionDecision {
  return { kind: 'allow', via: { rule, subject } }
}
