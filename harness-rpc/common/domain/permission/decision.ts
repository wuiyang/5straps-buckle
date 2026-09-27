import type { GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { ResolvedEffect } from '../effect.js'

export type PermissionDecision =
  | { kind: 'allow'; via?: GrantReference }
  | { kind: 'ask'; rule: PermissionRuleId; subject: string; reason: string; offeredScopes: GrantScope[] }
  | { kind: 'deny'; rule: PermissionRuleId; subject: string; reason: string }

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
): PermissionDecision {
  return { kind: 'ask', rule, subject, reason, offeredScopes }
}

export function deny(rule: PermissionRuleId, subject: string, reason: string): PermissionDecision {
  return { kind: 'deny', rule, subject, reason }
}

export function allowedVia(rule: PermissionRuleId, subject: string): PermissionDecision {
  return { kind: 'allow', via: { rule, subject } }
}
