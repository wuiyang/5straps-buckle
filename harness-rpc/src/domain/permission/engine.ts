import type { PermissionRuleId } from '@5straps/protocol'
import type { ResolvedEffect } from '../effect.js'
import type { GrantLookup, PermissionDecision, PermissionRule } from './decision.js'

export type PermissionOutcome =
  | { kind: 'allow' }
  | { kind: 'ask'; asks: Array<Extract<PermissionDecision, { kind: 'ask' }>> }
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

      for (const rule of rules) {
        for (const effect of effects) {
          const decision = rule.evaluate({ tool, effect, grants })
          if (!decision || decision.kind === 'allow') continue
          if (decision.kind === 'deny') return { kind: 'deny', denial: decision }
          asks.set(askKey(rule.id, decision.subject), decision)
        }
      }

      return asks.size === 0 ? { kind: 'allow' } : { kind: 'ask', asks: [...asks.values()] }
    },
  }
}

function askKey(rule: PermissionRuleId, subject: string): string {
  return `${rule}:${subject}`
}
