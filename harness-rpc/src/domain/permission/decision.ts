import type { GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { ResolvedEffect } from '../effect.js'

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'ask'; rule: PermissionRuleId; subject: string; reason: string; offeredScopes: GrantScope[] }
  | { kind: 'deny'; rule: PermissionRuleId; subject: string; reason: string }

export interface GrantLookup {
  subjectsFor(rule: PermissionRuleId): string[]
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
