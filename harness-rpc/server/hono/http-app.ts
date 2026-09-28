import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from '../../common/runtime/log.js'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import type { WorkspaceManager } from '../../common/services/workspaces/workspace-manager.js'
import { createWorkspaceApp } from './workspace-app.js'
import { createSetupApp } from './setup-app.js'
import { stateBusyResponse } from './state-busy.js'

/**
 * What the Hono faces still serve until the admin layer moves (B17): the owner's /setup behind the
 * admin credential when one is configured, and its /workspaces/[id]/ twins. The native RPC, workbench
 * and MCP routes are the common and MCP layers'.
 */
export function createHttpApp(input: {
  config: BuckleConfig
  runtime: BuckleRuntime
  authToken: string
  /** The common runtime's manager, so registered workspaces close with it; tests may leave it out. */
  workspaces?: WorkspaceManager
}): Hono {
  const { config, runtime } = input
  const app = new Hono()
  app.route('/', createWorkspaceApp({ config, runtime, ...(input.workspaces ? { workspaces: input.workspaces } : {}) }))

  if (config.adminToken) app.route('/setup', createSetupApp({ config, runtime, adminToken: config.adminToken }))

  // The setup face keeps Hono's default answers for anything else.
  app.onError((error, context) => {
    const busy = stateBusyResponse(error, context)
    if (busy) return busy
    if (error instanceof HTTPException) return error.getResponse()
    logger.error('Unhandled Buckle request error', { error, path: context.req.path })
    return context.text('Internal Server Error', 500)
  })
  return app
}
