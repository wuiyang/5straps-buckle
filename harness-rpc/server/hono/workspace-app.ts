import { createWorkbenchApp } from './workbench-app.js'
import { browseDirectories, DirectoryQuerySchema } from '../../common/services/setup/directory-browser.js'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpServer } from '../../mcp/server.js'
import { auditHttpRequest } from './audit.js'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { BuckleConfig } from '../../common/runtime/config.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createWorkspaceManager, type WorkspaceManager, WorkspaceError, WorkspaceRegistrationSchema, WorkspacePatchSchema, WorkspaceRegistryError, WorkspaceTokenInputSchema } from '../../common/services/workspaces/workspace-manager.js'
import { matchesTokenSource } from '../../common/services/access/tokens.js'
import { requireBearerToken } from './auth.js'
import { allowPostOnly } from './mcp-allow.js'
import { createRpcApp } from './rpc-app.js'
import { createSetupApp } from './setup-app.js'
import { logger } from '../../common/runtime/log.js'
import { stateBusyResponse } from './state-busy.js'

export function createWorkspaceApp(input: { config: BuckleConfig; runtime: BuckleRuntime; workspaces?: WorkspaceManager }): Hono {
  const manager = input.workspaces ?? createWorkspaceManager(input)
  const nodeRuntime = input.runtime
  const app = new Hono()
  const faces = new Map<string, Hono>()
  const nodeAudit = auditHttpRequest({ actions: input.runtime.actions, workspaceId: 'default', face: 'http_workspace_registry' })
  app.use('*', async (context, next) => {
    if (context.req.path === '/setup/directories' || context.req.path === '/setup/workspaces' || context.req.path.startsWith('/setup/workspaces/')) return nodeAudit(context, next)
    await next()
  })

  if (input.config.adminToken) {
    app.use('/setup/directories', requireBearerToken(input.config.adminToken))
    app.get('/setup/directories', async context => {
      const parsed = DirectoryQuerySchema.safeParse(context.req.query())
      if (!parsed.success) return context.json({ error: 'Invalid directory request' }, 400)
      return context.json(await browseDirectories({ ...parsed.data, eligibility: manager.eligibility }))
    })
    app.use('/setup/workspaces', requireBearerToken(input.config.adminToken))
    app.use('/setup/workspaces/*', requireBearerToken(input.config.adminToken))
    app.use('/setup/workspaces', bodyLimit({ maxSize: 65_536 }))
    app.get('/setup/workspaces', context => context.json({ workspaces: manager.list() }))
    app.get('/setup/workspaces/:id', context => {
      const workspace = manager.list().find(item => item.id === context.req.param('id'))
      return workspace ? context.json({ workspace }) : context.json({ error: 'Workspace not found' }, 404)
    })
    app.post('/setup/workspaces', async context => {
      const parsed = WorkspaceRegistrationSchema.safeParse(await context.req.json().catch(() => null))
      if (!parsed.success) return context.json({ error: 'Invalid workspace registration' }, 400)
      const workspace = await auditAdminOperation(input.runtime, 'workspace_register', parsed.data.id, () => manager.register(parsed.data))
      return context.json({ workspace }, 201)
    })
    app.patch('/setup/workspaces/:id', async context => {
      const parsed = WorkspacePatchSchema.safeParse(await context.req.json().catch(() => null))
      if (!parsed.success) return context.json({ error: 'Invalid workspace settings' }, 400)
      const id = context.req.param('id')
      const workspace = await auditAdminOperation(input.runtime, 'workspace_update', id, () => manager.update(id, parsed.data))
      return context.json({ workspace })
    })
    app.delete('/setup/workspaces/:id', async context => {
      const id = context.req.param('id')
      await auditAdminOperation(input.runtime, 'workspace_retire', id, () => manager.update(id, { retired: true }))
      return context.body(null, 204)
    })
    app.post('/setup/workspaces/:id/reactivate', async context => {
      const id = context.req.param('id')
      const workspace = await auditAdminOperation(input.runtime, 'workspace_reactivate', id, () => manager.update(id, { retired: false }))
      return context.json({ workspace })
    })

    // `BUCKLE-D12`: minting and revoking sit behind the admin credential, which no tool reads.
    app.get('/setup/workspaces/:id/tokens', context => context.json({ tokens: manager.listTokens(context.req.param('id')) }))
    app.post('/setup/workspaces/:id/tokens', async context => {
      const parsed = WorkspaceTokenInputSchema.safeParse(await context.req.json().catch(() => ({})))
      if (!parsed.success) return context.json({ error: 'Invalid workspace token request' }, 400)
      const id = context.req.param('id')
      const minted = await auditAdminOperation(input.runtime, 'workspace_token_add', id, () => manager.addToken(id, parsed.data))
      return context.json({ token: minted }, 201)
    })
    app.delete('/setup/workspaces/:id/tokens/:tokenId', async context => {
      const id = context.req.param('id')
      const revoked = await auditAdminOperation(input.runtime, 'workspace_token_revoke', id, () => manager.revokeToken(id, context.req.param('tokenId')))
      return revoked ? context.body(null, 204) : context.json({ error: 'Workspace token not found' }, 404)
    })
  }

  // Before authentication a caller learns nothing about the registry beyond that it needs repair.
  const auditRejected = async (input: { id: string; known: boolean; path: string; status: 401 | 503 }) => {
    if (input.path !== '/v1/invoke' && input.path !== '/mcp' && !input.path.startsWith('/setup/')) return
    const auditId = randomUUID()
    await nodeRuntime.actions.record({ auditId, event: 'result', workspaceId: input.known ? input.id : 'unresolved',
      at: new Date().toISOString(), requestId: auditId, sessionId: 'http-untrusted', tool: input.path === '/mcp' ? 'workspace_mcp_auth_rejected' : input.path.startsWith('/setup/') ? 'workspace_setup_auth_rejected' : 'workspace_invoke_rejected',
      outcome: 'denied', durationMs: 0, effects: [], args: {}, detail: `HTTP ${input.status}`,
    })
  }
  const registryNeedsRepair = async (input: { id: string; path: string }) => {
    await auditRejected({ ...input, known: false, status: 503 })
    return Response.json({ error: 'Workspace registry needs owner repair' }, { status: 503 })
  }

  app.all('/workspaces/:id/*', async context => {
    const id = context.req.param('id')
    const path = context.req.path.slice(`/workspaces/${id}`.length)
    try {
      if (path.startsWith('/v1/workbenches/')) {
        const { runtime } = await manager.resolve(id)
        const workbenchId = path.split('/')[3] ?? ''
        if (!await runtime.workbenches.authenticate(workbenchId, context.req.header('authorization'))) {
          await runtime.workbenches.auditRejected()
          return context.json({ error: 'Unauthorized' }, 401)
        }
        const app = new Hono().route('/v1/workbenches', createWorkbenchApp(runtime))
        const url = new URL(context.req.url)
        url.pathname = path
        return app.fetch(new Request(url, context.req.raw))
      }
      const known = manager.known(id)
      const credential = path.startsWith('/setup/') ? manager.adminToken(id) : () => manager.agentTokens(id)
      if (!credential || !matchesTokenSource(context.req.header('authorization'), credential)) {
        await auditRejected({ id, known, path, status: 401 })
        return context.json({ error: 'Unauthorized' }, 401)
      }
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) return registryNeedsRepair({ id, path })
      throw error
    }
    if (path.startsWith('/setup/workbenches') && context.req.method !== 'GET') await manager.resolve(id)
    const { config, runtime } = await manager.resolve(id, { setup: path.startsWith('/setup/') })
    let face = faces.get(id)
    if (!face) {
      const agentTokens = () => manager.agentTokens(id)
      face = createRpcApp({ config, runtime, authToken: agentTokens })
      const mcpHandler = createMcpHandler(() => createMcpServer({ runtime, serverName: config.serverName, version: runtime.manifest().version }))
      face.use('/mcp', auditHttpRequest({ actions: runtime.actions, workspaceId: runtime.workspaceId, face: 'http_mcp' }))
      face.use('/mcp', bodyLimit({ maxSize: config.maxRequestBytes }))
      face.use('/mcp', requireBearerToken(agentTokens))
      face.all('/mcp', async context => allowPostOnly(await mcpHandler.fetch(context.req.raw)))
      runtime.onToolsChanged(() => mcpHandler.notify.toolsChanged())
      if (config.adminToken) face.route('/setup', createSetupApp({ config, runtime, adminToken: config.adminToken }))
      faces.set(id, face)
    }
    const url = new URL(context.req.url)
    url.pathname = path
    return face.fetch(new Request(url, context.req.raw))
  })

  app.onError((error, context) => {
    if (error instanceof WorkspaceError) return context.json({ error: error.message }, error.status)
    const busy = stateBusyResponse(error, context)
    if (busy) return busy
    logger.error('Workspace request failed', { message: error.message })
    return context.json({ error: 'Workspace request failed; inspect local owner logs' }, 500)
  })
  return app
}

async function auditAdminOperation<T>(runtime: BuckleRuntime, tool: string, workspaceId: string, operation: () => T | Promise<T>): Promise<T> {
  const auditId = await auditAdmin(runtime, tool, workspaceId)
  let result: T
  try { result = await operation() }
  catch (error) {
    await auditAdmin(runtime, tool, workspaceId, auditId, 'error')
    throw error
  }
  await auditAdmin(runtime, tool, workspaceId, auditId)
  return result
}

async function auditAdmin(runtime: BuckleRuntime, tool: string, workspaceId: string, auditId?: string, outcome: 'ok' | 'error' = 'ok'): Promise<string> {
  const id = auditId ?? randomUUID()
  await runtime.actions.record({
    auditId: id, event: auditId ? 'result' : 'attempt', workspaceId,
    at: new Date().toISOString(), requestId: id, sessionId: 'node-admin', tool,
    outcome: auditId ? outcome : 'started', durationMs: 0, effects: [], args: {},
  })
  return id
}
