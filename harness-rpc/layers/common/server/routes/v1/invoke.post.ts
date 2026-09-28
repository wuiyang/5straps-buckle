import { InvokeRequestSchema } from '@5straps/protocol'
import type { H3Event } from 'h3'
import type { ActionLog } from '../../../../../common/types/ports/action-log.js'
import { recordRefusal, statusOf } from '../../utils/audit.js'
import { readJson } from '../../utils/body.js'
import { requireAgent, type RefusalAudit } from '../../utils/guards.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { json } from '../../utils/respond.js'
import { NODE_WORKSPACE, useTarget } from '../../utils/target.js'

/** Mirrors the MCP face's fallback, so both name a session the same way when a caller gives none. */
const ANONYMOUS_SESSION_ID = 'rpc'

/**
 * A re-sent call that asks for something other than what its requestId already waits on is a
 * conflict; a session or workspace with too many asks waiting is told to slow down; a session id past
 * its cap is a bad request. Other refusals are 422.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = { APPROVAL_CONFLICT: 409, APPROVAL_LIMIT: 429, SESSION_ID_TOO_LONG: 400 }

/** Refused before the invoker saw it: the credential here, the body in the handler. */
const INVOKE_REFUSED: RefusalAudit = {
  node: ({ actions, status }) => recordInvokeRefusal(actions, NODE_WORKSPACE, status),
  named: 'workspace_invoke_rejected',
}

export default defineOperationHandler({
  guards: [requireAgent(INVOKE_REFUSED)],
  handler: async (event) => {
    const { config, runtime } = await useTarget(event)
    const parsed = await readInvokeRequest(event, config.maxRequestBytes).catch(async (error: unknown) => {
      await recordInvokeRefusal(runtime.actions, runtime.workspaceId, statusOf(error))
      throw error
    })
    if (!parsed.success) {
      await recordInvokeRefusal(runtime.actions, runtime.workspaceId, 400)
      return json({ error: 'Invalid invoke request', issues: parsed.error.issues }, { status: 400 })
    }
    // A caller that supplies no session shares one, so a grant it was just given still applies
    // to its next call. A fresh id per request made every session grant dead on arrival.
    const sessionId = parsed.data.context?.sessionId ?? ANONYMOUS_SESSION_ID
    const response = await runtime.invoke({ request: parsed.data, sessionId, signal: event.req.signal })
    return json(response, { status: response.outcome === 'error' ? ERROR_STATUS[response.error.code] ?? 422 : 200 })
  },
})

async function readInvokeRequest(event: H3Event, limit: number) {
  return InvokeRequestSchema.safeParse(await readJson(event, limit))
}

// Records who was refused and the status, never the payload or the credential.
function recordInvokeRefusal(actions: ActionLog, workspaceId: string, status: number): Promise<void> {
  return recordRefusal(actions, { tool: 'rpc_invoke_rejected', workspaceId, sessionId: 'rpc-untrusted', status, detail: `HTTP ${status}` })
}
