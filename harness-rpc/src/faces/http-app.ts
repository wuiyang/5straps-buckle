import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import type { BuckleConfig } from '../config.js'
import type { BuckleRuntime } from '../runtime.js'
import { createMcpServer } from './mcp/server.js'
import { createRpcApp } from './rpc/app.js'
import { requireBearerToken } from './rpc/auth.js'
import { createWorkspaceApp } from './workspace-app.js'
import { createSetupApp } from './setup/app.js'

/**
 * The whole HTTP surface: native RPC under /v1 and MCP under /mcp, both behind the same bearer
 * gate, and the owner's /setup behind a different one when a setup token is configured. Only
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
  app.route('/', createRpcApp({ config, runtime, authToken }))

  const mcpHandler = createMcpHandler(() => createMcpServer({
    runtime,
    serverName: config.serverName,
    version: runtime.manifest().version,
  }))
  app.use('/mcp', requireBearerToken(authToken))
  app.all('/mcp', context => mcpHandler.fetch(context.req.raw))
  runtime.onToolsChanged(() => mcpHandler.notify.toolsChanged())

  if (config.setupToken) app.route('/setup', createSetupApp({ config, runtime, setupToken: config.setupToken }))

  return app
}
