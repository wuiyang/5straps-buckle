import type { H3Event } from 'h3'
import type { ActionLog, ActionLogEntry } from '../../../../common/types/ports/action-log.js'
import { useServices } from './services.js'

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
  return useServices(event).getNodeActions()
}

/**
 * One refusal, through the log service, since it stands whether or not its entry is written: which face refused whom
 * with what status, and nothing the caller sent but what `args` names (a signed request's claimed key fingerprint,
 * which is public). Anyone can send one, so it gives way to every other held entry.
 */
export function recordRefusal(actions: ActionLog, input: { tool: string; workspaceId: string; sessionId: string; status: number; outcome?: Outcome; detail?: string; args?: Record<string, string> }): void {
  const auditId = crypto.randomUUID()
  actions.append({ auditId, event: 'result', workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: input.sessionId,
    tool: input.tool, outcome: input.outcome ?? outcomeOf(input.status), durationMs: 0, effects: [], args: input.args ?? {}, ...(input.detail === undefined ? {} : { detail: input.detail }) }, UNTRUSTED)
}

/** How a transport's attempt is written: before an agent's change, as the owner's own change is, or queued. */
export type TransportAttempt = 'required' | 'owner' | 'queued'

const ATTEMPT_WRITES: Readonly<Record<TransportAttempt, (actions: ActionLog, entry: ActionLogEntry) => Promise<void>>> = {
  required: (actions, entry) => actions.record(entry),
  owner: (actions, entry) => actions.ownerAttempt(entry, { ignoreWarning: false }),
  queued: async (actions, entry) => actions.append(entry),
}

/**
 * Transport status beside tool completion (an attempt, then the result with the HTTP status), for faces whose request
 * is not itself one tool call. A `required` attempt is durable before the work runs, so an agent's change does not run
 * without it; every result goes through the log service.
 */
export async function withTransportAudit<T>(actions: ActionLog, input: { tool: string; workspaceId: string; attempt: TransportAttempt; actorId?: string }, run: () => Promise<T>): Promise<T> {
  const entry = transportEntry(input)
  const started = performance.now()
  await ATTEMPT_WRITES[input.attempt](actions, { ...entry, event: 'attempt', outcome: 'started' })
  let result: T
  try {
    result = await run()
  } catch (error) {
    actions.append(transportResult(entry, statusOf(error), started))
    throw error
  }
  actions.append(transportResult(entry, statusOf(result), started))
  return result
}

/** The pair a transport audit leaves for a request refused before its work began, through the log service, as a refusal. */
export function recordTransportRefusal(actions: ActionLog, input: { tool: string; workspaceId: string; status: number }): void {
  const entry = transportEntry(input)
  actions.append({ ...entry, event: 'attempt', outcome: 'started' }, UNTRUSTED)
  actions.append(transportResult(entry, input.status, performance.now()), UNTRUSTED)
}

const UNTRUSTED = { untrusted: true } as const

function transportEntry(input: { tool: string; workspaceId: string; actorId?: string }): ActionLogEntry {
  const auditId = crypto.randomUUID()
  return { auditId, workspaceId: input.workspaceId, requestId: auditId, sessionId: 'http-transport', at: new Date().toISOString(), tool: input.tool, outcome: 'started', effects: [], args: {}, durationMs: 0, ...(input.actorId ? { actorId: input.actorId } : {}) }
}

function transportResult(entry: ActionLogEntry, status: number, started: number): ActionLogEntry {
  return { ...entry, event: 'result', outcome: outcomeOf(status), durationMs: Math.round(performance.now() - started), detail: `HTTP ${status}; transport status only` }
}
