import { WorkspacePolicySchema } from '@5straps/protocol'
import { Hono } from 'hono'
import type { BuckleConfig } from '../../config.js'
import { isRestrictive, PolicyError } from '../../domain/policy.js'
import { logger } from '../../logger.js'
import type { BuckleRuntime } from '../../runtime.js'
import { requireBearerToken } from '../rpc/auth.js'

/**
 * The owner's face. It reads and replaces the workspace policy and reports how the node is set
 * up, behind the setup credential alone: the agent's token opens nothing here, and nothing here
 * runs a tool. Rings drives it to push configuration; `buckle policy` does the same locally.
 */
export function createSetupApp(input: { config: BuckleConfig; runtime: BuckleRuntime; setupToken: string }): Hono {
  const { config, runtime, setupToken } = input
  const app = new Hono()

  app.use('/*', requireBearerToken(setupToken))

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
  }))

  app.put('/policy', async context => {
    const parsed = WorkspacePolicySchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'Invalid workspace policy', issues: parsed.error.issues }, 400)
    try {
      const effective = await runtime.policy.apply(parsed.data)
      logger.info('Workspace policy replaced through the setup face', { workspace: config.cwd })
      return context.json({ effective, stored: runtime.policy.stored(), base: runtime.policy.base() })
    } catch (error) {
      if (error instanceof PolicyError) return context.json({ error: error.message }, 400)
      throw error
    }
  })

  app.delete('/policy', async context => {
    const effective = await runtime.policy.clear()
    return context.json({ effective, stored: null, base: runtime.policy.base() })
  })

  return app
}
