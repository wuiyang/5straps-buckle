import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { approvalsPath, loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import type { ActionLogEntry } from '../src/ports/action-log.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'

// Pins today's Hono edge responses before the Nitro move (Buckle phase plan, B2). The commits that
// move a route flip the matching expectation on purpose and list the flip in their message.

const NODE_AGENT = 'node-agent-characterisation-only'
const NODE_ADMIN = 'node-admin-characterisation-only'
const ONE_AGENT = 'workspace-one-agent-characterisation'
const ONE_ADMIN = 'workspace-one-admin-characterisation'
const MAX_REQUEST_BYTES = 4_096
const WORKBENCH_BODY_LIMIT = 1_048_576
const SETUP_BODY_LIMIT = 65_536
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'characterisation', version: '0' } } })
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function node(options: { admin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-edges-'))
  for (const folder of ['default', 'one', 'state']) mkdirSync(join(root, folder))
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT,
    ...(options.admin === false ? {} : { BUCKLE_ADMIN_TOKEN: NODE_ADMIN }), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_MAX_REQUEST_BYTES: String(MAX_REQUEST_BYTES),
  })
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  const app = createHttpApp({ config, runtime, authToken: NODE_AGENT })
  cleanups.push(() => runtime.workbenches.close())
  const request = (path: string, init: RequestInit = {}) => app.request(path, init)
  async function registerOne(): Promise<void> {
    const response = await request('/setup/workspaces', { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify({ id: 'one', name: 'Workspace one', root: join(root, 'one'), authToken: ONE_AGENT, adminToken: ONE_ADMIN }) })
    expect(response.status).toBe(201)
  }
  return { root, config, runtime, request, registerOne }
}

function json(token?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

type BodyKind = 'content-length' | 'chunked'

function oversized(kind: BodyKind, bytes: number): { headers: Record<string, string>; body: BodyInit; duplex?: 'half' } {
  if (kind === 'content-length') return { headers: { 'content-length': String(bytes) }, body: 'a'.repeat(bytes) }
  const chunk = new TextEncoder().encode('a'.repeat(16_384))
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close()
      controller.enqueue(chunk)
      sent += chunk.byteLength
    },
  })
  return { headers: {}, body, duplex: 'half' }
}

async function shape(response: Response): Promise<{ status: number; contentType: string | null; body: unknown }> {
  const contentType = response.headers.get('content-type')
  const text = await response.text()
  return { status: response.status, contentType: contentType?.split(';')[0] ?? null, body: contentType?.includes('json') ? JSON.parse(text) : text }
}

function audited(runtime: BuckleRuntime): ActionLogEntry[] {
  return runtime.actions.read(500)
}

describe('413 on every face (content-length and chunked)', () => {
  const faces = [
    { face: '/v1/invoke', token: NODE_AGENT, limit: MAX_REQUEST_BYTES, expected: { status: 413, contentType: 'application/json', body: { error: 'Request body is too large' } } },
    { face: '/mcp', token: NODE_AGENT, limit: MAX_REQUEST_BYTES, expected: { status: 413, contentType: 'text/plain', body: 'Payload Too Large' } },
    { face: '/workspaces/one/mcp', token: ONE_AGENT, limit: MAX_REQUEST_BYTES, expected: { status: 500, contentType: 'application/json', body: { error: 'Internal Buckle error' } } },
    { face: `/v1/workbenches/${randomUUID()}/invoke`, token: 'any-workbench-token', limit: WORKBENCH_BODY_LIMIT, expected: { status: 422, contentType: 'application/json', body: { error: 'Workbench operation failed; inspect Buckle logs' } } },
    { face: '/setup/workspaces', token: NODE_ADMIN, limit: SETUP_BODY_LIMIT, expected: { status: 500, contentType: 'application/json', body: { error: 'Workspace request failed; inspect local owner logs' } } },
    { face: '/setup/workbenches', token: NODE_ADMIN, limit: SETUP_BODY_LIMIT, expected: { status: 422, contentType: 'application/json', body: { error: 'Workbench operation failed; inspect Buckle logs' } } },
  ]
  for (const { face, token, limit, expected } of faces) {
    for (const kind of ['content-length', 'chunked'] as const) {
      it(`${face} with ${kind}`, async () => {
        const buckle = await node()
        if (face.startsWith('/workspaces/one/')) await buckle.registerOne()
        const body = oversized(kind, limit + 1)
        const response = await buckle.request(face, { method: 'POST', ...body, headers: { ...MCP_HEADERS, ...bearer(token), ...body.headers } })
        expect(await shape(response)).toEqual(expected)
      })
    }
  }
})

describe('unhandled setup-face errors', () => {
  it('answers a text 500 at node level when the approvals file is unreadable', async () => {
    const buckle = await node()
    writeFileSync(approvalsPath(buckle.config), '{ not json')
    expect(await shape(await buckle.request('/setup/approvals', { headers: bearer(NODE_ADMIN) }))).toEqual({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })
  })

  it('answers the rpc face JSON 500 under /workspaces/:id/setup', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/workspaces/one/setup/status', { headers: bearer(ONE_ADMIN) })).status).toBe(200)
    writeFileSync(join(buckle.root, 'state', 'workspaces', 'one', 'approvals.json'), '{ not json')
    expect(await shape(await buckle.request('/workspaces/one/setup/approvals', { headers: bearer(ONE_ADMIN) }))).toEqual({ status: 500, contentType: 'application/json', body: { error: 'Internal Buckle error' } })
  })
})

describe('404 and method mismatch', () => {
  it('answers Hono\'s text 404 for an unknown path', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/nope'))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
    expect(await shape(await buckle.request('/v1/nope', { headers: bearer(NODE_AGENT) }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
  })

  it('answers the text 404 for a wrong method on an existing path', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/v1/manifest', { method: 'POST', headers: bearer(NODE_AGENT) }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
    expect(await shape(await buckle.request('/health', { method: 'POST' }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
  })

  it('checks the bearer token before anything else, OPTIONS included', async () => {
    const buckle = await node()
    const unauthorized = { status: 401, contentType: 'application/json', body: { error: 'Unauthorized' } }
    expect(await shape(await buckle.request('/v1/manifest', { method: 'OPTIONS' }))).toEqual(unauthorized)
    expect(await shape(await buckle.request('/v1/nope'))).toEqual(unauthorized)
    expect(await shape(await buckle.request('/mcp', { method: 'OPTIONS' }))).toEqual(unauthorized)
  })

  it('lets the stateless MCP SDK answer a JSON-RPC 405, without an Allow header, for every method but POST', async () => {
    const buckle = await node()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await buckle.request('/mcp', { method, headers: { ...MCP_HEADERS, ...bearer(NODE_AGENT) }, ...(['PUT', 'PATCH'].includes(method) ? { body: INITIALIZE } : {}) })
      expect(response.headers.get('allow')).toBeNull()
      expect(await shape(response)).toEqual({ status: 405, contentType: 'application/json', body: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null } })
    }
  })
})

describe('unknown /setup paths', () => {
  it('audits a probe without the admin token as setup_auth_rejected and answers 401', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/setup/x'))).toEqual({ status: 401, contentType: 'application/json', body: { error: 'Unauthorized' } })
    expect(audited(buckle.runtime)).toContainEqual(expect.objectContaining({ tool: 'setup_auth_rejected', outcome: 'denied', sessionId: 'http-untrusted', workspaceId: 'default' }))
  })

  it('audits an unknown path with the admin token as setup_get_unknown and answers the text 404', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/setup/x', { headers: bearer(NODE_ADMIN) }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
    expect(audited(buckle.runtime)).toContainEqual(expect.objectContaining({ tool: 'setup_get_unknown', event: 'result', outcome: 'error', detail: 'HTTP 404' }))
  })

  it('does not mount /setup without an admin token', async () => {
    const buckle = await node({ admin: false })
    expect(await shape(await buckle.request('/setup/status', { headers: bearer(NODE_AGENT) }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
    expect(await shape(await buckle.request('/setup/workspaces', { headers: bearer(NODE_AGENT) }))).toEqual({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
  })
})

describe('workspace routing', () => {
  it('serves /workspaces/default/** as an alias of the node faces', async () => {
    const buckle = await node()
    const direct = await (await buckle.request('/v1/manifest', { headers: bearer(NODE_AGENT) })).json() as Record<string, unknown>
    const alias = await buckle.request('/workspaces/default/v1/manifest', { headers: bearer(NODE_AGENT) })
    expect(alias.status).toBe(200)
    expect(await alias.json()).toEqual({ ...direct, generatedAt: expect.any(String) })
  })

  it('answers 401 for an unknown workspace and audits it as unresolved', async () => {
    const buckle = await node()
    const response = await buckle.request('/workspaces/ghost/v1/invoke', { method: 'POST', headers: json(NODE_AGENT), body: '{}' })
    expect(await shape(response)).toEqual({ status: 401, contentType: 'application/json', body: { error: 'Unauthorized' } })
    expect(audited(buckle.runtime)).toContainEqual(expect.objectContaining({ tool: 'workspace_invoke_rejected', workspaceId: 'unresolved', outcome: 'denied', detail: 'HTTP 401' }))
  })

  it('answers 409 for a disabled workspace on a non-setup path', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/setup/workspaces/one', { method: 'PATCH', headers: json(NODE_ADMIN), body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    const response = await buckle.request('/workspaces/one/v1/manifest', { headers: bearer(ONE_AGENT) })
    expect(await shape(response)).toEqual({ status: 409, contentType: 'application/json', body: { error: 'Workspace is disabled or retired' } })
  })
})

describe('workbench edges', () => {
  async function provisioned() {
    const buckle = await node()
    const grant = { id: randomUUID(), token: 'workbench-grant-characterisation-only-32', projectId: 'project', chatId: 'chat', allowShell: false }
    const provision = await buckle.request('/setup/workbenches', { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify(grant) })
    expect(provision.status).toBe(200)
    expect(provision.headers.get('cache-control')).toBe('no-store')
    return { ...buckle, grant }
  }

  it('marks workbench responses no-store', async () => {
    const buckle = await provisioned()
    const response = await buckle.request(`/v1/workbenches/${buckle.grant.id}`, { headers: bearer(buckle.grant.token) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 400 for a body that fails the schema or is not JSON', async () => {
    const buckle = await provisioned()
    const invalid = { status: 400, contentType: 'application/json', body: { error: 'Invalid workbench request' } }
    const path = `/v1/workbenches/${buckle.grant.id}/invoke`
    expect(await shape(await buckle.request(path, { method: 'POST', headers: json(buckle.grant.token), body: '{}' }))).toEqual(invalid)
    expect(await shape(await buckle.request(path, { method: 'POST', headers: json(buckle.grant.token), body: '{ not json' }))).toEqual(invalid)
  })
})

describe('audit tool names per face', () => {
  it('records the transport and admin entries each face writes', async () => {
    const buckle = await node()
    await buckle.registerOne()
    await buckle.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, ...bearer(NODE_AGENT) }, body: INITIALIZE })
    await buckle.request(`/v1/workbenches/${randomUUID()}/invoke`, { method: 'POST', headers: json('wrong-workbench-token'), body: '{}' })
    await buckle.request('/setup/workspaces', { headers: bearer(NODE_ADMIN) })
    await buckle.request('/setup/status', { headers: bearer(NODE_ADMIN) })
    await buckle.request('/v1/invoke', { method: 'POST', headers: json('wrong-token'), body: '{}' })
    await buckle.request('/workspaces/one/mcp', { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE })
    await buckle.request('/workspaces/one/setup/status')
    const tools = audited(buckle.runtime).map(entry => `${entry.tool}:${entry.event}:${entry.outcome}`)
    expect(tools).toEqual(expect.arrayContaining([
      'http_workspace_registry_post:attempt:started', 'http_workspace_registry_post:result:ok',
      'workspace_register:attempt:started', 'workspace_register:result:ok',
      'http_mcp_post:attempt:started', 'http_mcp_post:result:ok',
      'http_workbench_post:attempt:started', 'http_workbench_post:result:denied',
      'http_workspace_registry_get:result:ok',
      'setup_get_status:result:ok',
      'rpc_invoke_rejected:result:denied',
      'workspace_mcp_auth_rejected:result:denied',
      'workspace_setup_auth_rejected:result:denied',
    ]))
  })
})

describe('health', () => {
  it('leaves /health open and gates the workspace twin behind the agent token', async () => {
    const buckle = await node()
    await buckle.registerOne()
    const health = await buckle.request('/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok', serverId: buckle.config.serverId, protocolVersion: expect.any(String) })
    expect((await buckle.request('/workspaces/one/health')).status).toBe(401)
    expect((await buckle.request('/workspaces/default/health')).status).toBe(401)
    expect((await buckle.request('/workspaces/one/health', { headers: bearer(ONE_AGENT) })).status).toBe(200)
  })
})
