import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApprovalDecisionSchema, WorkspacePolicySchema } from '@5straps/protocol'
import { Hono, type Context } from 'hono'
import type { BuckleConfig } from '../../config.js'
import { isRestrictive, PolicyError } from '../../domain/policy.js'
import { redactAuditArguments } from '../../domain/redact.js'
import { logger } from '../../logger.js'
import type { BuckleRuntime } from '../../runtime.js'
import { tokenMatches, requireBearerToken } from '../rpc/auth.js'

/**
 * The owner's face. It reads and replaces the workspace policy and reports how the node is set
 * up, behind the setup credential alone: the agent's token opens nothing here, and nothing here
 * runs a tool. Rings drives it to push configuration; `buckle policy` does the same locally.
 */
export function createSetupApp(input: { config: BuckleConfig; runtime: BuckleRuntime; setupToken: string }): Hono {
  const { config, runtime, setupToken } = input
  const app = new Hono()

  app.use('/*', async (context, next) => {
    if (!tokenMatches(context.req.header('authorization'), setupToken)) {
      const auditId = randomUUID()
      runtime.actions.record({ auditId, event: 'result', workspaceId: runtime.workspaceId, requestId: auditId,
        at: new Date().toISOString(), sessionId: 'http-untrusted', tool: 'setup_auth_rejected',
        outcome: 'denied', durationMs: 0, effects: [], args: {},
      })
    }
    await next()
  })
  app.use('/*', requireBearerToken(setupToken))
  app.use('/*', async (context, next) => {
    const auditId = randomUUID()
    const at = new Date().toISOString()
    const start = performance.now()
    const mutation = !['GET', 'HEAD'].includes(context.req.method)
    const resource = context.req.path.split('/').find(part => ['policy', 'history', 'history-stages', 'approvals', 'grants', 'audit', 'status'].includes(part)) ?? 'unknown'
    const entry = {
      auditId, workspaceId: runtime.workspaceId, at, requestId: auditId, sessionId: 'workspace-admin',
      tool: `setup_${context.req.method.toLowerCase()}_${resource}`, durationMs: 0, effects: [], args: {},
    }
    if (mutation) runtime.actions.record({ ...entry, event: 'attempt', outcome: 'started' })
    await next()
    runtime.actions.record({ ...entry, event: 'result', outcome: context.res.ok ? 'ok' : 'error',
      durationMs: Math.round(performance.now() - start), detail: `HTTP ${context.res.status}`,
    })
  })

  app.post('/history-stages/restore', async context => {
    const parsed = z.object({ stageId: z.string().min(1), sessionId: z.string().min(1) }).safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'stageId and sessionId are required' }, 400)
    return historyResponse(context, () => runtime.history.restoreStage(parsed.data.stageId, parsed.data.sessionId))
  })
  app.get('/audit', async context => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().nonnegative().optional() }).safeParse(context.req.query())
    if (!parsed.success) return context.json({ error: 'Invalid audit page' }, 400)
    await runtime.actions.recoverInterrupted()
    const page = runtime.actions.page(parsed.data)
    return context.json({ ...page, entries: page.entries.map(entry => entry.event ? entry : {
      at: entry.at, requestId: entry.requestId, sessionId: entry.sessionId, tool: entry.tool,
      outcome: entry.outcome, durationMs: entry.durationMs, effects: ['legacy details withheld'], args: redactAuditArguments(entry.args),
    }) })
  })
  app.get('/history', context => context.json({ checkpoints: runtime.history.list() }))
  app.post('/history/:id/restore', async context => historyResponse(context, () => runtime.history.restore(context.req.param('id'))))
  app.post('/history/:id/recover', async context => historyResponse(context, () => runtime.history.recover(context.req.param('id'))))

  app.get('/approvals', context => context.json({ approvals: runtime.approvals.pending() }))
  app.post('/approvals', async context => {
    const parsed = ApprovalDecisionSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid approval decision' }, 400)
    const result = runtime.approvals.resolve(parsed.data)
    return result.ok ? context.json({ resolved: true }) : context.json({ error: result.reason }, 409)
  })
  app.get('/grants', context => context.json({ grants: runtime.grants.list() }))
  app.delete('/grants/:grantId', context => {
    if (!runtime.grants.revoke(context.req.param('grantId'))) return context.json({ error: 'Grant not found' }, 404)
    return context.body(null, 204)
  })

  app.get('/status', context => {
    const manifest = runtime.manifest()
    const effective = runtime.policy.effective()
    return context.json({
      serverId: config.serverId,
      name: config.serverName,
      version: manifest.version,
      workspace: { root: config.cwd, mount: effective.mount, displayRoot: runtime.paths().displayRoot },
      sandbox: manifest.sandbox,
      packs: manifest.packs,
      policy: { restrictive: isRestrictive(effective), storedAt: runtime.policy.stored()?.updatedAt ?? null },
      reporting: runtime.reporter.configured,
    })
  })

  app.get('/policy', context => context.json({
    effective: runtime.policy.effective(),
    stored: runtime.policy.stored(),
    base: runtime.policy.base(),
    ceiling: config.nodePolicy ?? null,
  }))

  app.put('/policy', async context => {
    const parsed = WorkspacePolicySchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid workspace policy', issues: parsed.error.issues }, 400)
    try {
      const effective = await runtime.policy.apply(parsed.data)
      logger.info('Workspace policy replaced through the setup face', { workspace: config.cwd })
      return context.json({ effective, stored: runtime.policy.stored(), base: runtime.policy.base(), ceiling: config.nodePolicy ?? null })
    } catch (error) {
      if (error instanceof PolicyError) return context.json({ error: error.message }, 400)
      throw error
    }
  })

  app.delete('/policy', async context => {
    const effective = await runtime.policy.clear()
    return context.json({ effective, stored: null, base: runtime.policy.base(), ceiling: config.nodePolicy ?? null })
  })

  return app
}

async function historyResponse(context: Context, operation: () => Promise<unknown>) {
  try { return context.json(await operation()) }
  catch (error) {
    const conflict = error instanceof Error && error.message.startsWith('Restore conflict:')
    logger.warn('Owner history operation failed', { message: error instanceof Error ? error.message : 'Unknown error' })
    return context.json({ error: conflict ? error.message : 'History operation failed; inspect local owner logs' }, conflict ? 409 : 422)
  }
}
