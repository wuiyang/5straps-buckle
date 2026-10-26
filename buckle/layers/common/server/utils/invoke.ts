import { getRouterParam, type H3Event } from 'h3'
import type { InvokeResponse } from '@5straps/protocol'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import { recordRefusal } from './audit.js'
import type { RefusalAudit } from './guards.js'
import { NODE_LEVEL } from './target.js'

/** Mirrors the MCP face's fallback, so both name a session the same way when a caller gives none. */
export const ANONYMOUS_SESSION_ID = 'rpc'

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

/**
 * A requestId that already names another call, or a re-sent call that asks for something other than
 * what its requestId already waits on, or that already ran and cannot be answered with its own
 * response, is a conflict; a session or workspace with too many asks waiting is told to slow down; a
 * session id past its cap is a bad request; a node shutting down or state busy in another process is
 * unavailable (review L7 of B18-B19). Other refusals are 422.
 */
// AUDIT_UNAVAILABLE: a re-send joined to a call an audit failure stopped answers as that call did (review L5 of B23-B25).
const ERROR_STATUS: Readonly<Record<string, number>> = { APPROVAL_CONFLICT: 409, REQUEST_ID_REUSED: 409, REQUEST_ALREADY_EXECUTED: 409, APPROVAL_LIMIT: 429, SESSION_ID_TOO_LONG: 400, BUCKLE_SHUTTING_DOWN: 503, STATE_BUSY: 503, AUDIT_UNAVAILABLE: 503 }

/**
 * The status a tool call's answer goes out with: 200 for an outcome, and for an error its code's status above, else the
 * route's own (`more`: the files route's 413), else 422. One map, so /v1/invoke and /v1/files answer a code alike.
 */
export function invokeStatus(response: InvokeResponse, more: Readonly<Record<string, number>> = {}): number {
  if (response.outcome !== 'error') return 200
  return ERROR_STATUS[response.error.code] ?? more[response.error.code] ?? 422
}
