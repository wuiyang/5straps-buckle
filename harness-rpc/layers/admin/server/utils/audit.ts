import type { H3Event } from 'h3'
import type { ActionLog, ActionLogEntry } from '../../../../common/types/ports/action-log.js'
import { statusOf } from '../../../common/server/utils/audit.js'
import { isMutation } from '../../../common/server/utils/guards.js'

/** The resources the setup face names in its audit entries; any other path is `unknown`. */
const RESOURCE = /^(?:policy|history|history-stages|approvals|grants|audit|status|files|workbenches|tools)$/

/** The first path segment below /setup/ that names a resource, as the setup face named its entries. */
export function resourceOf(event: H3Event): string {
  const segments = event.url.pathname.split('/')
  return segments.slice(segments.indexOf('setup') + 1).find(segment => RESOURCE.test(segment)) ?? 'unknown'
}

/**
 * The admin audit wrapper: `setup_<method>_<resource>` on the workspace's own log, an attempt before a
 * change and a result with the HTTP status after every request, in the workspace-admin session.
 */
export async function withSetupAudit<T>(event: H3Event, input: { actions: ActionLog; workspaceId: string; resource: string }, run: () => Promise<T>): Promise<T> {
  const auditId = crypto.randomUUID()
  const started = performance.now()
  const entry: ActionLogEntry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: 'workspace-admin',
    tool: `setup_${event.req.method.toLowerCase()}_${input.resource}`, outcome: 'started', durationMs: 0, effects: [], args: {} }
  if (isMutation(event)) await input.actions.record({ ...entry, event: 'attempt' })
  const result = (status: number): ActionLogEntry => ({ ...entry, event: 'result', outcome: status >= 200 && status < 300 ? 'ok' : 'error', durationMs: Math.round(performance.now() - started), detail: `HTTP ${status}` })
  let value: T
  try {
    value = await run()
  } catch (error) {
    await input.actions.record(result(statusOf(error)))
    throw error
  }
  await input.actions.record(result(statusOf(value)))
  return value
}

/** An owner change to the registry: `workspace_*` on the node's log, an attempt and then its result, in the node-admin session. */
export async function withRegistryAudit<T>(actions: ActionLog, input: { tool: string; workspaceId: string }, run: () => Promise<T>): Promise<T> {
  const auditId = crypto.randomUUID()
  const entry = (outcome: ActionLogEntry['outcome'], event: 'attempt' | 'result'): ActionLogEntry => ({ auditId, event, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId,
    sessionId: 'node-admin', tool: input.tool, outcome, durationMs: 0, effects: [], args: {} })
  await actions.record(entry('started', 'attempt'))
  let value: T
  try {
    value = await run()
  } catch (error) {
    await actions.record(entry('error', 'result'))
    throw error
  }
  await actions.record(entry('ok', 'result'))
  return value
}
