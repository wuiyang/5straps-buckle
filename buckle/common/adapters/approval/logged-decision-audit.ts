import { randomUUID } from 'node:crypto'
import type { JsonObject } from '@5straps/protocol'
import { DECISION_TOOL } from '../../domain/record-tools.js'
import { MAX_LOGGED_ID } from '../../domain/redact.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'
import type { AuditedDecision, DecisionAudit } from '../../types/ports/decision-audit.js'

/** Decisions belong to no agent's session; their entries share this one. */
const DECISION_SESSION = 'approvals'

/**
 * Each decision in its workspace's own log, through the log service: received as an attempt, then how it ended as its
 * result, under one auditId. A refusal keeps its code and never its reason, which may name the ask's subject.
 */
export function createLoggedDecisionAudit(input: { actions: Pick<ActionLog, 'append'>; workspaceId: string }): DecisionAudit {
  return {
    received(decision) {
      const auditId = randomUUID()
      const start = performance.now()
      const args = decisionArgs(decision)
      const entry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: DECISION_SESSION, tool: DECISION_TOOL, effects: [] }
      input.actions.append({ ...entry, event: 'attempt', outcome: 'started', durationMs: 0, args })
      const ended = (result: Pick<ActionLogEntry, 'outcome' | 'args' | 'detail'>) => input.actions.append({ ...entry, event: 'result', durationMs: Math.round(performance.now() - start), ...result })
      return {
        applied: outcome => ended({ outcome: 'ok', args: { ...args, ...outcome } }),
        refused: ({ code }) => ended({ outcome: 'error', args: { ...args, code }, detail: code }),
        failed: () => ended({ outcome: 'error', args }),
      }
    },
  }
}

function decisionArgs(decision: AuditedDecision): JsonObject {
  return {
    token: decision.token.slice(0, MAX_LOGGED_ID), outcome: decision.approved ? 'approve' : 'deny', scope: decision.scope,
    source: { id: decision.source.id.slice(0, MAX_LOGGED_ID), kind: decision.source.kind }, proof: decision.proof,
    ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy.slice(0, MAX_LOGGED_ID) }),
  }
}
