import { randomUUID } from 'node:crypto'
import type { JsonObject } from '@5straps/protocol'
import { rightsOf } from '../../domain/approval/assurance.js'
import { DECISION_TOOL, SESSION_END_TOOL } from '../../domain/record-tools.js'
import { MAX_LOGGED_ID } from '../../domain/redact.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'
import type { ApprovalSource, SourceKind } from '../../types/ports/approval-source.js'
import type { AuditedDecision, AuditedSessionEnd, AuditedSkip, AuditEnding, DecisionAudit } from '../../types/ports/decision-audit.js'

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
 * Each session's end is one result entry under the session it ended. An answer from a route anything holding the agent's
 * token can send (an HTTP form) gives way first, attempt and refusal alike, so a flood of them pushes out no person's
 * record; what it applied is kept.
 */
export function createLoggedDecisionAudit(input: { actions: Pick<ActionLog, 'append'>; workspaceId: string }): DecisionAudit {
  function received<Applied extends JsonObject>(args: JsonObject, answer: Answered & { decidedBy?: string }): AuditEnding<Applied> {
    const auditId = randomUUID()
    const start = performance.now()
    const untrusted = { untrusted: rightsOf(answer.source.kind).sameCaller === true }
    const entry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: DECISION_SESSION, tool: DECISION_TOOL, effects: [], actorId: actorOf(answer), actorTrust: 'authenticated' as const }
    input.actions.append({ ...entry, event: 'attempt', outcome: 'started', durationMs: 0, args }, untrusted)
    const ended = (result: Pick<ActionLogEntry, 'outcome' | 'args' | 'detail'>, options?: { untrusted: boolean }) => input.actions.append({ ...entry, event: 'result', durationMs: Math.round(performance.now() - start), ...result }, options)
    return {
      applied: outcome => ended({ outcome: 'ok', args: { ...args, ...outcome } }),
      refused: ({ code }) => ended({ outcome: 'error', args: { ...args, code }, detail: code }, untrusted),
      failed: () => ended({ outcome: 'error', args }, untrusted),
    }
  }
  return {
    received: decision => received(decisionArgs(decision), decision),
    skipReceived: skip => received(skipArgs(skip), skip),
    sessionEnded: end => input.actions.append(sessionEndEntry(input.workspaceId, end)),
  }
}

function sessionEndEntry(workspaceId: string, end: AuditedSessionEnd): ActionLogEntry {
  const auditId = randomUUID()
  const { sessionId, ...counts } = end
  return {
    auditId, workspaceId, event: 'result', at: new Date().toISOString(), requestId: auditId, sessionId: sessionId.slice(0, MAX_LOGGED_ID),
    tool: SESSION_END_TOOL, outcome: 'ok', durationMs: 0, effects: [], args: counts,
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
