import { randomUUID } from 'node:crypto'
import { redactCredentials } from '@5straps/runtime'
import type { JsonObject, PermissionRuleId } from '@5straps/protocol'
import { rightsOf } from '../../domain/approval/assurance.js'
import { redactedSubject } from '../../domain/permission/rules/dangerously-allow.js'
import { DECISION_TOOL, SESSION_END_TOOL } from '../../domain/record-tools.js'
import { MAX_LOGGED_ID } from '../../domain/redact.js'
import type { ActionLog, ActionLogEntry } from '../../types/ports/action-log.js'
import type { ApprovalErrorCode } from '../../types/ports/approval-backend.js'
import type { ApprovalSource, SourceKind } from '../../types/ports/approval-source.js'
import type { AnsweredCall, AuditedDecision, AuditedSessionEnd, AuditedSkip, AuditedWidening, DecisionAudit, DecisionEnding } from '../../types/ports/decision-audit.js'

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

/** A received answer's result entry, as each kind of answer fills it: what applied, or the refusal's code and fields. */
interface RecordEnding {
  applied(fields: JsonObject): void
  refused(code: ApprovalErrorCode, fields: JsonObject): void
  failed(): void
}

/**
 * Each decision and each skip in its workspace's own log, through the log service: received as an attempt, then how it
 * ended as its result, under one auditId. A refusal keeps its code and never its reason, which may name the ask's subject.
 * A decision names the widening it asked for and, once the ledger read its ask, the subject its grant took and the call
 * it answered, by that call's attempt entry. Each session's end is one result entry under the session it ended. An answer
 * from a route anything holding the agent's token can send (an HTTP form) gives way first, attempt and refusal alike, so a
 * flood of them pushes out no person's record; what it applied is kept.
 */
export function createLoggedDecisionAudit(input: { actions: Pick<ActionLog, 'append'>; workspaceId: string }): DecisionAudit {
  function received(args: JsonObject, answer: Answered & { decidedBy?: string }): RecordEnding {
    const auditId = randomUUID()
    const start = performance.now()
    const untrusted = { untrusted: rightsOf(answer.source.kind).sameCaller === true }
    const entry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: DECISION_SESSION, tool: DECISION_TOOL, effects: [], actorId: actorOf(answer), actorTrust: 'authenticated' as const }
    input.actions.append({ ...entry, event: 'attempt', outcome: 'started', durationMs: 0, args }, untrusted)
    const ended = (result: Pick<ActionLogEntry, 'outcome' | 'args' | 'detail'>, options?: { untrusted: boolean }) => input.actions.append({ ...entry, event: 'result', durationMs: Math.round(performance.now() - start), ...result }, options)
    return {
      applied: fields => ended({ outcome: 'ok', args: { ...args, ...fields } }),
      refused: (code, fields) => ended({ outcome: 'error', args: { ...args, ...fields, code }, detail: code }, untrusted),
      failed: () => ended({ outcome: 'error', args }, untrusted),
    }
  }
  return {
    received: decision => decisionEnding(decision, received(decisionArgs(decision), decision)),
    skipReceived: (skip) => {
      const ending = received(skipArgs(skip), skip)
      return { applied: outcome => ending.applied(outcome), refused: ({ code }) => ending.refused(code, {}), failed: ending.failed }
    },
    sessionEnded: end => input.actions.append(sessionEndEntry(input.workspaceId, end)),
  }
}

function decisionEnding(decision: AuditedDecision, ending: RecordEnding): DecisionEnding {
  return {
    applied: ({ widenedTo, call, ...outcome }) => ending.applied({
      ...outcome,
      ...(widenedTo === undefined || call === undefined ? {} : { widening: { kind: decision.widen.kind, subject: auditedSubject(call.rule, widenedTo) } }),
      ...callArgs(call),
    }),
    refused: ({ code, call }) => ending.refused(code, callArgs(call)),
    failed: ending.failed,
  }
}

function sessionEndEntry(workspaceId: string, end: AuditedSessionEnd): ActionLogEntry {
  const auditId = randomUUID()
  const { sessionId, actor, ...counts } = end
  return {
    auditId, workspaceId, event: 'result', at: new Date().toISOString(), requestId: auditId, sessionId: sessionId.slice(0, MAX_LOGGED_ID),
    tool: SESSION_END_TOOL, outcome: 'ok', durationMs: 0, effects: [], args: { ...(actor === undefined ? {} : { actor: actor.slice(0, MAX_LOGGED_ID) }), ...counts },
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
    widening: wideningArgs(decision.widen),
  }
}

function wideningArgs(widen: AuditedWidening): JsonObject {
  return widen.kind === 'host' ? { kind: 'host', subject: auditedSubject('network_egress', widen.pattern) } : { kind: widen.kind }
}

/** A subject as the audit keeps one, with a credential hidden in each of its path's parts as an audited path hides one. */
function auditedSubject(rule: PermissionRuleId, subject: string): string {
  return redactedSubject(rule, subject.split('/').map(part => redactCredentials(part, 'value')).join('/'))
}

/** The call as the audit keeps it: the subject as every entry keeps one, and its attempt entry's ids, cut as every id. */
function callArgs(call: AnsweredCall | undefined): JsonObject {
  if (call === undefined) return {}
  const { rule, subject, attempt } = call
  return {
    call: {
      ...(attempt === undefined ? {} : { requestId: attempt.requestId.slice(0, MAX_LOGGED_ID), auditId: attempt.auditId.slice(0, MAX_LOGGED_ID) }),
      rule, subject: auditedSubject(rule, subject),
    },
  }
}

function skipArgs(skip: AuditedSkip): JsonObject {
  return { token: skip.token.slice(0, MAX_LOGGED_ID), outcome: 'skip_save', source: sourceArgs(skip.source) }
}

function sourceArgs(source: ApprovalSource): JsonObject {
  return { id: source.id.slice(0, MAX_LOGGED_ID), kind: source.kind }
}
