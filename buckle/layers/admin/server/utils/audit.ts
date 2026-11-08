import type { H3Event } from 'h3'
import type { JsonValue } from '@5straps/protocol'
import type { ActionLog, ActionLogEntry } from '../../../../common/types/ports/action-log.js'
import { statusOf } from '../../../common/server/utils/audit.js'
import { isMutation } from '../../../common/server/utils/guards.js'
import type { IGNORE_WARNING_QUERY } from '../../../../common/domain/global-flags.js'

// Checked against the common constant at compile time; the layers take common code as types only.
const IGNORE_WARNING: typeof IGNORE_WARNING_QUERY = 'ignoreWarning'

/** Whether a setup request makes the owner's choice to run a change whose record cannot be written: ignoreWarning=true in its query. */
export function ignoresWarning(event: H3Event): boolean {
  return event.url.searchParams.get(IGNORE_WARNING) === 'true'
}

/** The resources the setup face names in its audit entries; any other path is `unknown`. */
const RESOURCE = /^(?:policy|history|history-stages|approvals|grants|audit|status|files|workbenches|tools|sessions)$/

/** The first path segment below /setup/ that names a resource, as the setup face named its entries. */
export function resourceOf(event: H3Event): string {
  const segments = event.url.pathname.split('/')
  return segments.slice(segments.indexOf('setup') + 1).find(segment => RESOURCE.test(segment)) ?? 'unknown'
}

/**
 * The admin audit wrapper: `setup_<method>_<resource>` on the workspace's own log, an attempt before a
 * change and a result with the HTTP status after every request, in the workspace-admin session, naming
 * the actor. The results go through the log service; the attempt waits as the owner's records do (ActionLog.ownerAttempt),
 * so a broken log stops a change unless the request ignores the warning (ignoresWarning). A read writes no attempt.
 */
export async function withSetupAudit<T>(event: H3Event, input: { actions: ActionLog; workspaceId: string; resource: string; actorId: string; args?: () => Record<string, JsonValue> }, run: () => Promise<T>): Promise<T> {
  const auditId = crypto.randomUUID()
  const started = performance.now()
  // actorId names who the guard let in: admin:<workspace>, or key:<fingerprint> for a signed request (review H4 of B23-B25).
  const entry: ActionLogEntry = { auditId, workspaceId: input.workspaceId, at: new Date().toISOString(), requestId: auditId, sessionId: 'workspace-admin',
    tool: `setup_${event.req.method.toLowerCase()}_${input.resource}`, outcome: 'started', durationMs: 0, effects: [], args: {}, ...(input.actorId ? { actorId: input.actorId } : {}) }
  if (isMutation(event)) await input.actions.ownerAttempt({ ...entry, event: 'attempt' }, { ignoreWarning: ignoresWarning(event) })
  // What the route said it did, on its result (review L14 of B23-B25): never a value the caller sent unless the route names it.
  const result = (status: number): ActionLogEntry => ({ ...entry, event: 'result', outcome: status >= 200 && status < 300 ? 'ok' : 'error', durationMs: Math.round(performance.now() - started), detail: `HTTP ${status}`, args: input.args?.() ?? {} })
  let value: T
  try {
    value = await run()
  } catch (error) {
    input.actions.append(result(statusOf(error)))
    throw error
  }
  input.actions.append(result(statusOf(value)))
  return value
}

/**
 * An owner change to the registry: `workspace_*` on the node's log, an attempt and then its result, in the
 * node-admin session, each naming the actor the guard let in, so a token mint is tied to the key or
 * credential that asked for it. The result goes through the log service, and the attempt waits as the owner's records
 * do (ActionLog.ownerAttempt), unless `ignoreWarning`.
 */
export async function withRegistryAudit<T>(actions: ActionLog, input: { tool: string; workspaceId: string; workspaceName?: string; actorId: string; ignoreWarning: boolean; named?: (value: T) => { workspaceId: string; workspaceName: string } }, run: () => Promise<T>): Promise<T> {
  const auditId = crypto.randomUUID()
  const entry = (outcome: ActionLogEntry['outcome'], event: 'attempt' | 'result', whose: { workspaceId: string; workspaceName?: string } = input): ActionLogEntry => ({ auditId, event, workspaceId: whose.workspaceId, ...(whose.workspaceName === undefined ? {} : { workspaceName: whose.workspaceName }), at: new Date().toISOString(), requestId: auditId,
    sessionId: 'node-admin', tool: input.tool, outcome, durationMs: 0, effects: [], args: {}, ...(input.actorId ? { actorId: input.actorId } : {}) })
  await actions.ownerAttempt(entry('started', 'attempt'), { ignoreWarning: input.ignoreWarning })
  let value: T
  try {
    value = await run()
  } catch (error) {
    actions.append(entry('error', 'result'))
    throw error
  }
  // A registration names its workspace by the id it was assigned only once it exists: the result says which, the attempt could not.
  actions.append(entry('ok', 'result', input.named ? input.named(value) : input))
  return value
}
