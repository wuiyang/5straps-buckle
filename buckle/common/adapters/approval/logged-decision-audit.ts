import { randomUUID } from 'node:crypto'
import type { JsonObject } from '@5straps/protocol'
import { DECISION_TOOL } from '../../domain/record-tools.js'
import { MAX_LOGGED_ID } from '../../domain/redact.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'
import type { ApprovalSource, SourceKind } from '../../types/ports/approval-source.js'
import type { AuditedDecision, AuditedSkip, AuditEnding, DecisionAudit } from '../../types/ports/decision-audit.js'

/** Decisions belong to no agent's session; their entries share this one. */
const DECISION_SESSION = 'approvals'

/** An answer as the actor table reads it: its route, and the caller its transport authenticated, where it names one. */
interface Answered { source: ApprovalSource; caller?: string }

/**
 * Who answered, by the route it came by, where no key or judge that decided is named. An HTTP form answer names its
 * caller, the agent token that sent it, so a token answering its own ask is traced in this log; a stdio caller is the
 * same for every answer and names no one.
 */
const ACTOR_OF: Readonly<Record<SourceKind, (answer: Answered) => string>> = {
  terminal: () => 'local-owner',
  cli: () => 'local-owner',
  forms: () => 'forms',
  'http-forms': answer => answer.caller ?? 'http-forms',
  devices: () => 'devices',
  judge: () => 'judge',
  sealed: () => 'sealed',
  backend: answer => `backend:${answer.source.id}`,
}

/**
 * Each decision and each skip in its workspace's own log, through the log service: received as an attempt, then how it
 * ended as its result, under one auditId. A refusal keeps its code and never its reason, which may name the ask's subject.
 */
export function createLoggedDecisionAudit(input: { actions: Pick<ActionLog, 'append'>; workspaceId: string }): DecisionAudit {
  function received<Applied extends JsonObject>(args: JsonObject, actorId: string): AuditEnding<Applied> {
    const auditId = randomUUID()
    const start = performance.now()
    const entry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: DECISION_SESSION, tool: DECISION_TOOL, effects: [], actorId, actorTrust: 'authenticated' as const }
    input.actions.append({ ...entry, event: 'attempt', outcome: 'started', durationMs: 0, args })
    const ended = (result: Pick<ActionLogEntry, 'outcome' | 'args' | 'detail'>) => input.actions.append({ ...entry, event: 'result', durationMs: Math.round(performance.now() - start), ...result })
    return {
      applied: outcome => ended({ outcome: 'ok', args: { ...args, ...outcome } }),
      refused: ({ code }) => ended({ outcome: 'error', args: { ...args, code }, detail: code }),
      failed: () => ended({ outcome: 'error', args }),
    }
  }
  return {
    received: decision => received(decisionArgs(decision), actorOf(decision)),
    skipReceived: skip => received(skipArgs(skip), actorOf(skip)),
  }
}

function actorOf(answer: Answered & { decidedBy?: string }): string {
  return (answer.decidedBy ?? ACTOR_OF[answer.source.kind](answer)).slice(0, MAX_LOGGED_ID)
}

function decisionArgs(decision: AuditedDecision): JsonObject {
  return {
    token: decision.token.slice(0, MAX_LOGGED_ID), outcome: decision.approved ? 'approve' : 'deny', scope: decision.scope,
    source: sourceArgs(decision.source), proof: decision.proof,
    ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy.slice(0, MAX_LOGGED_ID) }),
  }
}

function skipArgs(skip: AuditedSkip): JsonObject {
  return { token: skip.token.slice(0, MAX_LOGGED_ID), outcome: 'skip_save', source: sourceArgs(skip.source) }
}

function sourceArgs(source: ApprovalSource): JsonObject {
  return { id: source.id.slice(0, MAX_LOGGED_ID), kind: source.kind }
}
