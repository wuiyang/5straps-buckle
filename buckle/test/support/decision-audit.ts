import type { AuditedDecision, AuditedNoResponse, AuditedSessionEnd, AuditedSkip, DecisionAudit, DecisionEnding, SkipEnding } from '../../common/types/ports/decision-audit.js'

const UNHEARD_ENDING = { applied: () => undefined, refused: () => undefined, failed: () => undefined }

/** A decision audit that keeps nothing, for a service whose decisions a test does not read. */
export const UNHEARD_DECISIONS: DecisionAudit = { received: () => UNHEARD_ENDING, skipReceived: () => UNHEARD_ENDING, sessionEnded: () => undefined, noResponse: () => undefined }

export type HeardDecision =
  | { step: 'received'; fields: AuditedDecision }
  | { step: 'applied'; fields: AuditedDecision & Parameters<DecisionEnding['applied']>[0] }
  | { step: 'refused'; fields: AuditedDecision & Parameters<DecisionEnding['refused']>[0] }
  | { step: 'failed'; fields: AuditedDecision }
  | { step: 'skip_received'; fields: AuditedSkip }
  | { step: 'skip_applied'; fields: AuditedSkip & Parameters<SkipEnding['applied']>[0] }
  | { step: 'skip_refused'; fields: AuditedSkip & Parameters<SkipEnding['refused']>[0] }
  | { step: 'skip_failed'; fields: AuditedSkip }
  | { step: 'session_ended'; fields: AuditedSessionEnd }
  | { step: 'no_response'; fields: AuditedNoResponse }

/** A decision audit that keeps each step it was told, in order, with the decision, skip, or session end it was about. */
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
    skipReceived(skip) {
      entries.push({ step: 'skip_received', fields: skip })
      return {
        applied: (outcome) => { entries.push({ step: 'skip_applied', fields: { ...skip, ...outcome } }) },
        refused: (refusal) => { entries.push({ step: 'skip_refused', fields: { ...skip, ...refusal } }) },
        failed: () => { entries.push({ step: 'skip_failed', fields: skip }) },
      }
    },
    sessionEnded(end) { entries.push({ step: 'session_ended', fields: end }) },
    noResponse(skip) { entries.push({ step: 'no_response', fields: skip }) },
  }
  return { audit, entries }
}
