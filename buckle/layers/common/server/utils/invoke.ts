import { getRouterParam, type H3Event } from 'h3'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import { recordRefusal } from './audit.js'
import type { RefusalAudit } from './guards.js'
import { NODE_LEVEL } from './target.js'

/** Refused before the invoker saw it: the credential in the guard, a body or a method in the route. */
export const INVOKE_REFUSED: RefusalAudit = {
  node: ({ actions, status }) => recordInvokeRefusal(actions, NODE_LEVEL, status),
  named: 'workspace_invoke_rejected',
}

/** Records who was refused and the status, never the payload or the credential. */
export function recordInvokeRefusal(actions: ActionLog, workspaceId: string, status: number): Promise<void> {
  return recordRefusal(actions, { tool: 'rpc_invoke_rejected', workspaceId, sessionId: 'rpc-untrusted', status, detail: `HTTP ${status}` })
}

/** Whether a /v1 catch-all request names /v1/invoke: every method but POST lands there (review L2 of B15-B17). */
export function isInvokePath(event: H3Event): boolean {
  return getRouterParam(event, 'path') === 'invoke'
}
