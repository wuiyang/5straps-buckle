import type { DecisionAudit } from '../../types/ports/decision-audit.js'

/** Today's decision audit: no entry of its own, so each route keeps only the audit it writes now. */
export const NO_DECISION_AUDIT: DecisionAudit = {
  received: async () => undefined,
  applied: async () => undefined,
  refused: async () => undefined,
}
