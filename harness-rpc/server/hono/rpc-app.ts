import { randomUUID } from 'node:crypto'
import { InvokeRequestSchema } from '@5straps/protocol'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { TokenSource } from '../../common/services/access/tokens.js'
import { requireBearerToken } from './auth.js'
import { toDescriptor } from '../../common/domain/skill.js'
import { logger } from '../../common/runtime/log.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { stateBusyResponse } from './state-busy.js'

export interface RpcAppDependencies {
  config: BuckleConfig
  runtime: BuckleRuntime
  authToken: TokenSource
}

/** Mirrors the MCP face's fallback, so both name a session the same way when a caller gives none. */
const ANONYMOUS_SESSION_ID = 'rpc'

/**
 * A re-sent call that asks for something other than what its requestId already waits on is a
 * conflict; a session with too many asks waiting is told to slow down. Other refusals are 422.
 */
const ERROR_STATUS: Readonly<Record<string, ContentfulStatusCode>> = { APPROVAL_CONFLICT: 409, APPROVAL_LIMIT: 429 }

export function createRpcApp({ config, runtime, authToken }: RpcAppDependencies): Hono {
  const app = new Hono()

  app.get('/health', context => context.json({
    status: 'ok',
    serverId: config.serverId,
    protocolVersion: runtime.manifest().protocolVersion,
  }))

  const dispatched = new WeakSet<Request>()
  app.use('/v1/invoke', async (context, next) => {
    await next()
    if (context.res.status < 400 || dispatched.has(context.req.raw)) return
    const auditId = randomUUID()
    await runtime.actions.record({
      auditId, event: 'result', workspaceId: runtime.workspaceId, at: new Date().toISOString(),
      requestId: auditId, sessionId: 'rpc-untrusted', tool: 'rpc_invoke_rejected',
      outcome: [401, 403].includes(context.res.status) ? 'denied' : 'error', durationMs: 0,
      effects: [], args: {}, detail: `HTTP ${context.res.status}`,
    })
  })
  app.use('/v1/*', requireBearerToken(authToken))

  app.use('/v1/invoke', bodyLimit({
    maxSize: config.maxRequestBytes,
    onError: context => context.json({ error: 'Request body is too large' }, 413),
  }))

  app.get('/v1/manifest', context => context.json(runtime.manifest()))

  app.get('/v1/skills', context => context.json({
    skills: runtime.skills().map(skill => ({ ...toDescriptor(skill), content: skill.content })),
  }))

  app.get('/v1/skills/:id', context => {
    const skill = runtime.skills().find(item => item.id === context.req.param('id'))
    if (!skill) return context.json({ error: 'Skill not found' }, 404)
    return context.json({ skill: { ...toDescriptor(skill), content: skill.content } })
  })

  app.post('/v1/invoke', async context => {
    const parsed = InvokeRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid invoke request', issues: parsed.error.issues }, 400)

    // A caller that supplies no session shares one, so a grant it was just given still applies
    // to its next call. A fresh id per request made every session grant dead on arrival.
    const sessionId = parsed.data.context?.sessionId ?? ANONYMOUS_SESSION_ID
    dispatched.add(context.req.raw)
    const response = await runtime.invoke({ request: parsed.data, sessionId, signal: context.req.raw.signal })
    return context.json(response, response.outcome === 'error' ? ERROR_STATUS[response.error.code] ?? 422 : 200)
  })

  app.onError((error, context) => {
    const busy = stateBusyResponse(error, context)
    if (busy) return busy
    logger.error('Unhandled Buckle request error', { message: error.message, path: context.req.path })
    return context.json({ error: 'Internal Buckle error' }, 500)
  })

  return app
}

