import type { HttpBindings } from '@hono/node-server'
import { runInScope, type OperationContextInput, type OperationScope } from '@5straps/runtime'
import type { MiddlewareHandler } from 'hono'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import type { BuckleServices } from '../../common/runtime/services.js'
import type { ApprovalHold } from '../../common/services/approvals/interaction.js'
import { logger } from '../../common/runtime/log.js'

export type ScopeEnv = { Bindings: HttpBindings | undefined; Variables: { services: BuckleServices; scope: OperationScope } }

const NOT_READY = 'Buckle is not ready'
const MAX_CLIENT_REQUEST_ID = 200

export function notReadyResponse(): Response {
  return Response.json({ error: NOT_READY }, { status: 503 })
}

// Temporary until the Nitro layers replace the Hono faces: each request runs in its own operation
// scope, with the service accessors on the Hono context and the HTTP hold bound to it.
export function operationScopes(common: BuckleCommon, hold?: ApprovalHold): MiddlewareHandler<ScopeEnv> {
  return async (context, next) => {
    // Failed or closing readiness means no business operations (nitro/runtime.md, Lifetimes).
    if (common.owner.state !== 'ready') return context.json({ error: NOT_READY }, 503)
    const scope = common.owner.registry.createScope({ context: requestContext(context.req.header('x-request-id')), signal: context.req.raw.signal })
    context.set('services', common.services)
    context.set('scope', scope)
    const outgoing = context.env?.outgoing
    // A streamed response outlives next(); the node response closing is the operation's end.
    if (outgoing) outgoing.once('close', () => disposeScope(scope))
    try {
      if (hold) (await common.services.getInteraction(scope)).bind(hold)
      await runInScope(scope, next)
    } finally {
      if (!outgoing) disposeScope(scope)
    }
  }
}

function requestContext(clientRequestId: string | undefined): OperationContextInput {
  return clientRequestId ? { clientRequestId: clientRequestId.slice(0, MAX_CLIENT_REQUEST_ID) } : {}
}

function disposeScope(scope: OperationScope): void {
  void scope.dispose().catch((error: unknown) => {
    logger.warn('Operation scope closed with errors', { correlationId: scope.context.correlationId, error })
  })
}
