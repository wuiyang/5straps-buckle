import { createWorkbenchApp } from './workbench-app.js'
import { bodyLimit } from 'hono/body-limit'
import { auditHttpRequest } from './audit.js'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createMcpServer } from '../../mcp/server.js'
import { createRpcApp } from './rpc-app.js'
import { requireBearerToken } from './auth.js'
import { allowPostOnly } from './mcp-allow.js'
import { createWorkspaceApp } from './workspace-app.js'
import { createSetupApp } from './setup-app.js'

/**
 * The whole HTTP surface: native RPC under /v1 and MCP under /mcp, both behind the same bearer
 * gate, and the owner's /setup behind a different one when an admin credential is configured. Only
 * /health is open, and it reports nothing a caller could act on.
 */
export function createHttpApp(input: {
  config: BuckleConfig
  runtime: BuckleRuntime
  authToken: string
}): Hono {
  const { config, runtime, authToken } = input
  const app = new Hono()
  app.route('/', createWorkspaceApp({ config, runtime }))
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

  return app
}
