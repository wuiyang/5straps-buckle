import type { AuditedDecision, DecisionAudit, DecisionEnding } from '../../common/types/ports/decision-audit.js'

/** A decision audit that keeps nothing, for a service whose decisions a test does not read. */
export const UNHEARD_DECISIONS: DecisionAudit = { received: () => ({ applied: () => undefined, refused: () => undefined, failed: () => undefined }) }

export type HeardDecision =
  | { step: 'received'; fields: AuditedDecision }
  | { step: 'applied'; fields: AuditedDecision & Parameters<DecisionEnding['applied']>[0] }
  | { step: 'refused'; fields: AuditedDecision & Parameters<DecisionEnding['refused']>[0] }
  | { step: 'failed'; fields: AuditedDecision }

/** A decision audit that keeps each step it was told, in order, with the decision it was about. */
export function recordingDecisionAudit(): { audit: DecisionAudit; entries: HeardDecision[] } {
  const entries: HeardDecision[] = []
  const audit: DecisionAudit = {
    received(decision) {
      entries.push({ step: 'received', fields: decision })
      return {
        applied: (outcome) => { entries.push({ step: 'applied', fields: { ...decision, ...outcome } }) },
        refused: (refusal) => { entries.push({ step: 'refused', fields: { ...decision, ...refusal } }) },
        failed: () => { entries.push({ step: 'failed', fields: decision }) },
      }
    },
  }
  return { audit, entries }
}
