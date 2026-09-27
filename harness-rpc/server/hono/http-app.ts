import { createWorkbenchApp } from './workbench-app.js'
import { bodyLimit } from 'hono/body-limit'
import { auditHttpRequest } from './audit.js'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from '../../common/runtime/log.js'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import type { WorkspaceManager } from '../../common/services/workspaces/workspace-manager.js'
import { createMcpServer } from '../../mcp/server.js'
import { createRpcApp } from './rpc-app.js'
import { requireBearerToken } from './auth.js'
import { allowPostOnly } from './mcp-allow.js'
import { createWorkspaceApp } from './workspace-app.js'
import { createSetupApp } from './setup-app.js'
import { stateBusyResponse } from './state-busy.js'

/**
 * The whole HTTP surface: native RPC under /v1 and MCP under /mcp, both behind the same bearer
 * gate, and the owner's /setup behind a different one when an admin credential is configured. Only
 * /health is open, and it reports nothing a caller could act on.
 */
export function createHttpApp(input: {
  config: BuckleConfig
  runtime: BuckleRuntime
  authToken: string
  /** The common runtime's manager, so registered workspaces close with it; tests may leave it out. */
  workspaces?: WorkspaceManager
}): Hono {
  const { config, runtime, authToken } = input
  const app = new Hono()
  app.route('/', createWorkspaceApp({ config, runtime, ...(input.workspaces ? { workspaces: input.workspaces } : {}) }))
  app.route('/v1/workbenches', createWorkbenchApp(runtime))
  app.route('/', createRpcApp({ config, runtime, authToken }))

  const mcpHandler = createMcpHandler(() => createMcpServer({
    runtime,
    serverName: config.serverName,
    version: runtime.manifest().version,
  }))
  app.use('/mcp', auditHttpRequest({ actions: runtime.actions, workspaceId: runtime.workspaceId, face: 'http_mcp' }))
  app.use('/mcp', bodyLimit({ maxSize: config.maxRequestBytes }))
  app.use('/mcp', requireBearerToken(authToken))
  app.all('/mcp', async context => allowPostOnly(await mcpHandler.fetch(context.req.raw)))
  runtime.onToolsChanged(() => mcpHandler.notify.toolsChanged())

  if (config.adminToken) app.route('/setup', createSetupApp({ config, runtime, adminToken: config.adminToken }))

  // Faces without their own handler (setup, MCP) keep Hono's default answers for anything else.
  app.onError((error, context) => {
    const busy = stateBusyResponse(error, context)
    if (busy) return busy
    if (error instanceof HTTPException) return error.getResponse()
    logger.error('Unhandled Buckle request error', { error, path: context.req.path })
    return context.text('Internal Server Error', 500)
  })
  return app
}
