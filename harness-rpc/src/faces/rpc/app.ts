import { ApprovalDecisionSchema, InvokeRequestSchema } from '@5straps/protocol'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { BuckleConfig } from '../../config.js'
import { requireBearerToken } from './auth.js'
import { toDescriptor } from '../../domain/skill.js'
import { logger } from '../../logger.js'
import type { BuckleRuntime } from '../../runtime.js'

export interface RpcAppDependencies {
  config: BuckleConfig
  runtime: BuckleRuntime
  authToken: string
}

/** Mirrors the MCP face's fallback, so both name a session the same way when a caller gives none. */
const ANONYMOUS_SESSION_ID = 'rpc'

export function createRpcApp({ config, runtime, authToken }: RpcAppDependencies): Hono {
  const app = new Hono()

  app.get('/health', context => context.json({
    status: 'ok',
    serverId: config.serverId,
    protocolVersion: runtime.manifest().protocolVersion,
  }))

  app.use('/v1/*', requireBearerToken(authToken))

  app.use('/v1/invoke', bodyLimit({
    maxSize: config.maxRequestBytes,
    onError: context => context.json({ error: 'Request body is too large' }, 413),
  }))

  app.get('/v1/manifest', context => context.json(runtime.manifest()))

  app.get('/v1/skills', context => context.json({
    skills: runtime.skills().map(skill => ({ ...toDescriptor(skill), content: skill.content })),
  }))

  app.post('/v1/invoke', async context => {
    const parsed = InvokeRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid invoke request', issues: parsed.error.issues }, 400)

    // A caller that supplies no session shares one, so a grant it was just given still applies
    // to its next call. A fresh id per request made every session grant dead on arrival.
    const sessionId = parsed.data.context?.sessionId ?? ANONYMOUS_SESSION_ID
    const response = await runtime.invoke({ request: parsed.data, sessionId })
    return context.json(response, response.outcome === 'error' ? 422 : 200)
  })

  app.get('/v1/approvals', context => context.json({ approvals: runtime.approvals.pending() }))

  app.post('/v1/approvals', async context => {
    const parsed = ApprovalDecisionSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid approval decision', issues: parsed.error.issues }, 400)

    const result = runtime.approvals.resolve(parsed.data)
    if (!result.ok) return context.json({ error: result.reason }, 409)
    return context.json({ resolved: true })
  })

  app.get('/v1/grants', context => context.json({ grants: runtime.grants.list() }))

  app.delete('/v1/grants/:grantId', context => {
    if (!runtime.grants.revoke(context.req.param('grantId'))) return context.json({ error: 'Grant not found' }, 404)
    return context.body(null, 204)
  })

  app.onError((error, context) => {
    logger.error('Unhandled Buckle request error', { message: error.message, path: context.req.path })
    return context.json({ error: 'Internal Buckle error' }, 500)
  })

  return app
}

