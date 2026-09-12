import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpServer } from './mcp/server.js'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { BuckleConfig } from '../config.js'
import type { BuckleRuntime } from '../runtime.js'
import { createWorkspaceManager, WorkspaceError, WorkspaceRegistrationSchema } from '../services/workspace-manager.js'
import { requireBearerToken, tokenMatches } from './rpc/auth.js'
import { createRpcApp } from './rpc/app.js'
import { createSetupApp } from './setup/app.js'
import { logger } from '../logger.js'

export function createWorkspaceApp(input: { config: BuckleConfig; runtime: BuckleRuntime }): Hono {
  const manager = createWorkspaceManager(input)
  const app = new Hono()
  const faces = new Map<string, Hono>()

  if (input.config.setupToken) {
    app.use('/setup/workspaces', requireBearerToken(input.config.setupToken))
    app.use('/setup/workspaces/*', requireBearerToken(input.config.setupToken))
    app.use('/setup/workspaces', bodyLimit({ maxSize: 65_536 }))
    app.get('/setup/workspaces', context => context.json({ workspaces: manager.list() }))
    app.get('/setup/workspaces/:id', context => {
      const workspace = manager.list().find(item => item.id === context.req.param('id'))
      return workspace ? context.json({ workspace }) : context.json({ error: 'Workspace not found' }, 404)
    })
    app.post('/setup/workspaces', async context => {
      const parsed = WorkspaceRegistrationSchema.safeParse(await context.req.json().catch(() => null))
      if (!parsed.success) return context.json({ error: 'Invalid workspace registration' }, 400)
      const auditId = auditAdmin(input.runtime, 'workspace_register', parsed.data.id)
      const workspace = manager.register(parsed.data)
      auditAdmin(input.runtime, 'workspace_register', workspace.id, auditId)
      return context.json({ workspace }, 201)
    })
    app.patch('/setup/workspaces/:id', async context => {
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await context.req.json().catch(() => null))
      if (!parsed.success) return context.json({ error: 'enabled is required' }, 400)
      const id = context.req.param('id')
      const auditId = auditAdmin(input.runtime, 'workspace_enabled', id)
      const workspace = manager.setEnabled(id, parsed.data.enabled)
      auditAdmin(input.runtime, 'workspace_enabled', id, auditId)
      return context.json({ workspace })
    })
  }

  app.all('/workspaces/:id/*', async context => {
    const id = context.req.param('id')
    const path = context.req.path.slice(`/workspaces/${id}`.length)
    const credentials = manager.credentials(id)
    const credential = path.startsWith('/setup/') ? credentials?.setupToken : credentials?.authToken
    if (!credential || !tokenMatches(context.req.header('authorization'), credential)) return context.json({ error: 'Unauthorized' }, 401)
    const { config, runtime } = await manager.resolve(id)
    let face = faces.get(id)
    if (!face) {
      face = createRpcApp({ config, runtime, authToken: config.authToken })
      const mcpHandler = createMcpHandler(() => createMcpServer({ runtime, serverName: config.serverName, version: runtime.manifest().version }))
      face.use('/mcp', requireBearerToken(config.authToken))
      face.all('/mcp', context => mcpHandler.fetch(context.req.raw))
      runtime.onToolsChanged(() => mcpHandler.notify.toolsChanged())
      if (config.setupToken) face.route('/setup', createSetupApp({ config, runtime, setupToken: config.setupToken }))
      faces.set(id, face)
    }
    const url = new URL(context.req.url)
    url.pathname = path
    return face.fetch(new Request(url, context.req.raw))
  })

  app.onError((error, context) => {
    if (error instanceof WorkspaceError) return context.json({ error: error.message }, error.status)
    logger.error('Workspace request failed', { message: error.message })
    return context.json({ error: 'Workspace request failed; inspect local owner logs' }, 500)
  })
  return app
}

function auditAdmin(runtime: BuckleRuntime, tool: string, workspaceId: string, auditId?: string): string {
  const id = auditId ?? randomUUID()
  runtime.actions.record({
    auditId: id, event: auditId ? 'result' : 'attempt', workspaceId,
    at: new Date().toISOString(), requestId: id, sessionId: 'node-admin', tool,
    outcome: auditId ? 'ok' : 'started', durationMs: 0, effects: [], args: {},
  })
  return id
}
