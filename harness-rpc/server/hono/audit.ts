import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { ActionLog } from '../../common/types/ports/action-log.js'

/** Transport status is separate from tool completion, including SDK refusals before dispatch. */
export function auditHttpRequest(input: { actions: ActionLog; workspaceId: string; face: string }): MiddlewareHandler {
  return async (context, next) => {
    const auditId = randomUUID()
    const start = performance.now()
    const entry = { auditId, workspaceId: input.workspaceId, requestId: auditId, sessionId: 'http-transport',
      at: new Date().toISOString(), tool: `${input.face}_${context.req.method.toLowerCase()}`, effects: [], args: {}, durationMs: 0,
    }
    await input.actions.record({ ...entry, event: 'attempt', outcome: 'started' })
    await next()
    await input.actions.record({ ...entry, event: 'result', outcome: context.res.status === 401 || context.res.status === 403 ? 'denied' : context.res.ok ? 'ok' : 'error',
      durationMs: Math.round(performance.now() - start), detail: `HTTP ${context.res.status}; transport status only`,
    })
  }
}
