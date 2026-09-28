import type { H3Event } from 'h3'
import type { AUDIT_UNAVAILABLE } from '../../../../common/adapters/action-log/file-action-log.js'
import type { ActionLog, ActionLogEntry } from '../../../../common/types/ports/action-log.js'
import { hasCode } from './errors.js'
import { useServices } from './services.js'

// Checked against the common constant at compile time; the layers take common code as types only.
const AUDIT_UNAVAILABLE_CODE: typeof AUDIT_UNAVAILABLE = 'AUDIT_UNAVAILABLE'

type Outcome = ActionLogEntry['outcome']

/** 401 and 403 are refusals; any other status of 400 or more is an error. */
export function outcomeOf(status: number): Outcome {
  if (status === 401 || status === 403) return 'denied'
  return status < 400 ? 'ok' : 'error'
}

/** The status a handler's answer or failure leaves with: an HTTPError's own, 500 for anything else. */
export function statusOf(result: unknown): number {
  if (result instanceof Response) return result.status
  const status = (result as { status?: unknown } | null)?.status
  return result instanceof Error ? (typeof status === 'number' ? status : 500) : 200
}

/** The node's own audit log, where refusals before a workspace is resolved are recorded. */
export async function nodeActions(event: H3Event): Promise<ActionLog> {
  return (await useServices(event).getWorkspaceRuntime()).actions
}

/** One refusal: which face refused whom with what status, and nothing the caller sent. */
export async function recordRefusal(actions: ActionLog, input: { tool: string; workspaceId: string; sessionId: string; status: number; outcome?: Outcome; detail?: string }): Promise<void> {
  const auditId = crypto.randomUUID()
  await actions.record({ auditId, event: 'result', workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: input.sessionId,
    tool: input.tool, outcome: input.outcome ?? outcomeOf(input.status), durationMs: 0, effects: [], args: {}, ...(input.detail === undefined ? {} : { detail: input.detail }) })
}

/**
 * The log for an entry the answer does not depend on: a refusal, which stands anyway, an owner's read,
 * and the result of work already done. When the audit storage will not take it, the owner's log
 * records that and readiness reports it (B19), and the answer still goes out. Nothing an agent can
 * run goes through this: a tool call's attempt, and any change's, must be written first.
 */
export function tolerantLog(event: H3Event, actions: ActionLog): ActionLog {
  return {
    ...actions,
    record: entry => actions.record(entry).catch((error: unknown) => {
      if (!hasCode(error, AUDIT_UNAVAILABLE_CODE)) throw error
      event.context.logger?.error('Answering without an audit entry the storage would not take', { tool: entry.tool, event: entry.event ?? 'result' })
    }),
  }
}

/**
 * Transport status beside tool completion (an attempt, then the result with the HTTP status), for
 * faces whose request is not itself one tool call. A change's attempt is durable before the work runs;
 * a read's, and every result, are written if the storage takes them (tolerantLog).
 */
export async function withTransportAudit<T>(event: H3Event, actions: ActionLog, input: { tool: string; workspaceId: string; required: boolean }, run: () => Promise<T>): Promise<T> {
  const entry = transportEntry(input)
  const started = performance.now()
  const tolerant = tolerantLog(event, actions)
  await (input.required ? actions : tolerant).record({ ...entry, event: 'attempt', outcome: 'started' })
  let result: T
  try {
    result = await run()
  } catch (error) {
    await tolerant.record(transportResult(entry, statusOf(error), started))
    throw error
  }
  await tolerant.record(transportResult(entry, statusOf(result), started))
  return result
}

/** The pair a transport audit leaves for a request refused before its work began. */
export async function recordTransportRefusal(actions: ActionLog, input: { tool: string; workspaceId: string; status: number }): Promise<void> {
  const entry = transportEntry(input)
  await actions.record({ ...entry, event: 'attempt', outcome: 'started' })
  await actions.record(transportResult(entry, input.status, performance.now()))
}

function transportEntry(input: { tool: string; workspaceId: string }): ActionLogEntry {
  const auditId = crypto.randomUUID()
  return { auditId, workspaceId: input.workspaceId, requestId: auditId, sessionId: 'http-transport', at: new Date().toISOString(), tool: input.tool, outcome: 'started', effects: [], args: {}, durationMs: 0 }
}

function transportResult(entry: ActionLogEntry, status: number, started: number): ActionLogEntry {
  return { ...entry, event: 'result', outcome: outcomeOf(status), durationMs: Math.round(performance.now() - started), detail: `HTTP ${status}; transport status only` }
}
