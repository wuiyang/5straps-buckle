import type { PermissionRuleId } from '@5straps/protocol'
import type { ResolvedEffect } from '../effect.js'
import type { GrantLookup, PermissionDecision, PermissionRule } from './decision.js'

export type PermissionOutcome =
  | { kind: 'allow'; allowedBy: string[] }
  /** `allowedBy`: the grants the effects it does not ask about relied on, kept for a call whose asks are answered without a person (D91). */
  | { kind: 'ask'; asks: Array<Extract<PermissionDecision, { kind: 'ask' }>>; allowedBy?: string[] }
  | { kind: 'deny'; denial: Extract<PermissionDecision, { kind: 'deny' }> }

export interface PermissionEngine {
  evaluate(input: { tool: string; effects: ResolvedEffect[]; grants: GrantLookup }): PermissionOutcome
}

/**
 * Rules run in this order and a denial short-circuits, so floor rules are evaluated before
 * any scope rule can allow the same effect. Reordering this list changes the security model.
 */
export function createPermissionEngine(rules: PermissionRule[]): PermissionEngine {
  return {
    evaluate({ tool, effects, grants }) {
      const asks = new Map<string, Extract<PermissionDecision, { kind: 'ask' }>>()
      const allowedBy = new Set<string>()

      for (const rule of rules) {
        for (const effect of effects) {
          const decision = rule.evaluate({ tool, effect, effects, grants })
          if (!decision) continue
          if (decision.kind === 'allow') {
            if (decision.via) allowedBy.add(askKey(decision.via.rule, decision.via.subject))
            continue
          }
          if (decision.kind === 'deny') return { kind: 'deny', denial: decision }
          asks.set(askKey(rule.id, decision.subject), decision)
        }
      }

      if (asks.size > 0) return { kind: 'ask', asks: [...asks.values()], allowedBy: [...allowedBy] }
      return { kind: 'allow', allowedBy: [...allowedBy] }
    },
  }
}

function askKey(rule: PermissionRuleId, subject: string): string {
  return `${rule}:${subject}`
}
