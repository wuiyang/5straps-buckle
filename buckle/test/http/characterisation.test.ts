import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalsPath } from '../../common/runtime/config.js'
import type { ActionLog, ActionLogEntry } from '../../common/types/ports/action-log.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createBuckleHttp } from '../support/buckle-http.js'
import { holdToken } from '../support/workspaces.js'

// Pins the edge responses through the Nitro move (Buckle phase plan, B2), on the served surface:
// the harness answers through the built Nitro app serve listens with. The commits that move a route
// flip the matching expectation on purpose and list the flip in their message. B13: /health is
// Nitro's. B15: /v1/**, /workspaces/[id]/(health|v1/**) and every path outside the MCP and setup faces
// are Nitro's. B16: /mcp and /workspaces/[id]/mcp are Nitro's. B17: /setup/** and
// /workspaces/[id]/setup/** are Nitro's, so every path is. B18 removed Hono and the dispatcher.

const NODE_AGENT = 'node-agent-characterisation-only'
const NODE_ADMIN = 'node-admin-characterisation-only'
const ONE_AGENT = 'workspace-one-agent-characterisation'
/** The node's admin credential is every workspace's (D83). */
const ONE_ADMIN = NODE_ADMIN
const MAX_REQUEST_BYTES = 4_096
const WORKBENCH_BODY_LIMIT = 1_048_576
const SETUP_BODY_LIMIT = 65_536
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'characterisation', version: '0' } } })
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function node(options: { admin?: boolean; adminHttp?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-edges-'))
  for (const folder of ['default', 'one']) mkdirSync(join(root, folder))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const buckle = await createBuckleHttp({ environment: {
    BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT,
    ...(options.admin === false ? {} : { BUCKLE_ADMIN_TOKEN: NODE_ADMIN }), ...(options.adminHttp === false ? {} : { BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' }), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_MAX_REQUEST_BYTES: String(MAX_REQUEST_BYTES),
  } })
  const { config, runtime } = buckle
  cleanups.push(() => buckle.close())
  const request = (path: string, init: RequestInit = {}) => buckle.request(path, init)
  async function registerOne(): Promise<void> {
    const response = await request('/setup/workspaces', { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify({ name: 'one', dir: join(root, 'one') }) })
    expect(response.status).toBe(201)
    await holdToken(join(root, 'state'), await buckle.idOf('one'), ONE_AGENT)
  }
  async function provisionWorkbench(): Promise<{ id: string; token: string }> {
    const grant = { id: randomUUID(), token: 'workbench-grant-characterisation-only-32', projectId: 'project', chatId: 'chat', allowShell: false }
    expect((await request(buckle.setup('workbenches'), { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify(grant) })).status).toBe(200)
    return grant
  }
  return { root, config, runtime, request, registerOne, provisionWorkbench, setup: buckle.setup, nodeActions: buckle.nodeActions, idOf: buckle.idOf, services: buckle.services }
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

/** The node's log and the node folder's workspace's, together: a refusal before a workspace is known lands on the first (D85, Q15). */
function audited(buckle: { runtime: BuckleRuntime; nodeActions: ActionLog }): ActionLogEntry[] {
  return [...buckle.nodeActions.read(500), ...buckle.runtime.actions.read(500)]
}

describe('413 on every face (content-length and chunked)', () => {
  const tooLarge = { status: 413, contentType: 'application/json', body: { error: 'Request body is too large' } }
  const faces = [
    { face: '/v1/invoke', token: NODE_AGENT, limit: MAX_REQUEST_BYTES, expected: tooLarge },
    // B16 flips: text 413 'Payload Too Large' and the workspace twin's JSON 500 became the JSON 413.
    { face: '/mcp', token: NODE_AGENT, limit: MAX_REQUEST_BYTES, expected: tooLarge },
    { face: '/workspaces/one/mcp', token: ONE_AGENT, limit: MAX_REQUEST_BYTES, expected: tooLarge },
    // B15 flip: 422 became the JSON 413, and the grant is checked before the body (it was after).
    { face: '/v1/workbenches/:grant/invoke', token: ':grant', limit: WORKBENCH_BODY_LIMIT, expected: tooLarge },
    // B17 flips: the registry's JSON 500 and the workbench setup route's 422 became the JSON 413.
    { face: '/setup/workspaces', token: NODE_ADMIN, limit: SETUP_BODY_LIMIT, expected: tooLarge },
    { face: '/workspaces/default/setup/workbenches', token: NODE_ADMIN, limit: SETUP_BODY_LIMIT, expected: tooLarge },
  ]
  for (const { face, token, limit, expected } of faces) {
    for (const kind of ['content-length', 'chunked'] as const) {
      it(`${face} with ${kind}`, async () => {
        const buckle = await node()
        if (face.startsWith('/workspaces/one/')) await buckle.registerOne()
        const grant = face.includes(':grant') ? await buckle.provisionWorkbench() : undefined
        const body = oversized(kind, limit + 1)
        const response = await buckle.request(face.replace(':grant', grant?.id ?? ''), { method: 'POST', ...body, headers: { ...MCP_HEADERS, ...bearer(token.replace(':grant', grant?.token ?? '')), ...body.headers } })
        expect(await shape(response)).toEqual(expected)
      })
    }
  }
})

describe('unhandled setup-face errors', () => {
  // B17 flip: Hono's text 500 became the JSON 500 of every other face.
  it('answers the JSON 500 at node level when the approvals file is unreadable', async () => {
    const buckle = await node()
    writeFileSync(approvalsPath(buckle.config), '{ not json')
    expect(await shape(await buckle.request(buckle.setup('approvals'), { headers: bearer(NODE_ADMIN) }))).toEqual({ status: 500, contentType: 'application/json', body: { error: 'Internal Buckle error' } })
    expect(audited(buckle)).toContainEqual(expect.objectContaining({ tool: 'setup_get_approvals', event: 'result', outcome: 'error', detail: 'HTTP 500' }))
  })

  it('answers the JSON 500 under /workspaces/:id/setup', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/workspaces/one/setup/status', { headers: bearer(ONE_ADMIN) })).status).toBe(200)
    writeFileSync(join(buckle.root, 'state', 'workspaces', await buckle.idOf('one'), 'approvals.json'), '{ not json')
    expect(await shape(await buckle.request('/workspaces/one/setup/approvals', { headers: bearer(ONE_ADMIN) }))).toEqual({ status: 500, contentType: 'application/json', body: { error: 'Internal Buckle error' } })
  })
})

describe('404 and method mismatch', () => {
  const notFound = { status: 404, contentType: 'application/json', body: { error: 'Not Found' } }

  // B15 flip: Hono's text 404 became Nitro's JSON 404.
  it('answers the JSON 404 for an unknown path', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/nope'))).toEqual(notFound)
    expect(await shape(await buckle.request('/v1/nope', { headers: bearer(NODE_AGENT) }))).toEqual(notFound)
  })

  // B13 flip for /health, B15 for /v1/manifest: a wrong method falls through to the catch-all, so the
  // credential is still checked first (the compiled router falls back from a method-specific route).
  it('answers the JSON 404 for a wrong method on an existing path, after the credential', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/v1/manifest', { method: 'POST', headers: bearer(NODE_AGENT) }))).toEqual(notFound)
    expect((await buckle.request('/v1/manifest', { method: 'POST' })).status).toBe(401)
    expect(await shape(await buckle.request('/health', { method: 'POST' }))).toEqual(notFound)
  })

  it('checks the bearer token before anything else, OPTIONS included', async () => {
    const buckle = await node()
    const unauthorized = { status: 401, contentType: 'application/json', body: { error: 'Unauthorized' } }
    expect(await shape(await buckle.request('/v1/manifest', { method: 'OPTIONS' }))).toEqual(unauthorized)
    expect(await shape(await buckle.request('/v1/nope'))).toEqual(unauthorized)
    expect(await shape(await buckle.request('/mcp', { method: 'OPTIONS' }))).toEqual(unauthorized)
  })

  it('lets the stateless MCP SDK answer a JSON-RPC 405, with Allow: POST (RFC 9110), for every method but POST', async () => {
    const buckle = await node()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await buckle.request('/mcp', { method, headers: { ...MCP_HEADERS, ...bearer(NODE_AGENT) }, ...(['PUT', 'PATCH'].includes(method) ? { body: INITIALIZE } : {}) })
      expect(response.headers.get('allow')).toBe('POST')
      expect(await shape(response)).toEqual({ status: 405, contentType: 'application/json', body: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null } })
    }
  })
})

describe('the /workspaces/:id twins', () => {
  const rows = [
    { name: 'oversized POST /v1/invoke', path: '/workspaces/one/v1/invoke', method: 'POST', token: ONE_AGENT, bytes: MAX_REQUEST_BYTES + 1, expected: { status: 413, contentType: 'application/json', body: { error: 'Request body is too large' } } },
    // B17 flips: the 422 became the JSON 413, and the text 404 below the JSON 404.
    { name: 'oversized POST /setup/workbenches', path: '/workspaces/one/setup/workbenches', method: 'POST', token: ONE_ADMIN, bytes: SETUP_BODY_LIMIT + 1, expected: { status: 413, contentType: 'application/json', body: { error: 'Request body is too large' } } },
    // B15 flips: the text 404s became Nitro's JSON 404.
    { name: 'GET /v1/nope', path: '/workspaces/one/v1/nope', method: 'GET', token: ONE_AGENT, expected: { status: 404, contentType: 'application/json', body: { error: 'Not Found' } } },
    { name: 'GET /nope', path: '/workspaces/one/nope', method: 'GET', token: ONE_AGENT, expected: { status: 404, contentType: 'application/json', body: { error: 'Not Found' } } },
    { name: 'GET /setup/x', path: '/workspaces/one/setup/x', method: 'GET', token: ONE_ADMIN, expected: { status: 404, contentType: 'application/json', body: { error: 'Not Found' } } },
    { name: 'POST /v1/manifest', path: '/workspaces/one/v1/manifest', method: 'POST', token: ONE_AGENT, expected: { status: 404, contentType: 'application/json', body: { error: 'Not Found' } } },
  ]
  for (const row of rows) {
    it(`${row.name} answers as its node-level route does today`, async () => {
      const buckle = await node()
      await buckle.registerOne()
      const body = row.bytes === undefined ? undefined : oversized('content-length', row.bytes)
      const response = await buckle.request(row.path, { method: row.method, ...(body ?? {}), headers: { ...MCP_HEADERS, ...bearer(row.token), ...(body?.headers ?? {}) } })
      expect(await shape(response)).toEqual(row.expected)
    })
  }

  it('lets the MCP SDK answer a JSON-RPC 405 with Allow: POST for GET', async () => {
    const buckle = await node()
    await buckle.registerOne()
    const response = await buckle.request('/workspaces/one/mcp', { headers: { ...MCP_HEADERS, ...bearer(ONE_AGENT) } })
    expect(response.headers.get('allow')).toBe('POST')
    expect(await shape(response)).toEqual({ status: 405, contentType: 'application/json', body: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null } })
  })
})

describe('unknown /setup paths', () => {
  it('audits a probe without the admin token as setup_auth_rejected and answers 401', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/setup/x'))).toEqual({ status: 401, contentType: 'application/json', body: { error: 'Unauthorized' } })
    expect(audited(buckle)).toContainEqual(expect.objectContaining({ tool: 'setup_auth_rejected', outcome: 'denied', sessionId: 'http-untrusted', workspaceId: 'node' }))
  })

  // B17 flip: the text 404 became the JSON 404.
  it('audits an unknown path with the admin token as setup_get_unknown and answers the JSON 404', async () => {
    const buckle = await node()
    expect(await shape(await buckle.request('/setup/x', { headers: bearer(NODE_ADMIN) }))).toEqual({ status: 404, contentType: 'application/json', body: { error: 'Not Found' } })
    expect(audited(buckle)).toContainEqual(expect.objectContaining({ tool: 'setup_get_unknown', event: 'result', outcome: 'error', detail: 'HTTP 404' }))
  })

  // B17 flips: the text 404 became the JSON 404, and /workspaces/<name>/setup/** answers it too
  // (it was 401): the node's workspace has no admin credential to check. With the experimental flag
  // on, so this is the no-token check and not the flag's (review M4 of B23-B25).
  it('answers every /setup path 404 without an admin token, and audits nothing', async () => {
    const buckle = await node({ admin: false, adminHttp: true })
    const notFound = { status: 404, contentType: 'application/json', body: { error: 'Not Found' } }
    for (const path of ['/setup/status', '/setup/workspaces', '/setup/x', '/workspaces/default/setup/status']) {
      expect(await shape(await buckle.request(path, { headers: bearer(NODE_AGENT) })), path).toEqual(notFound)
      expect(await shape(await buckle.request(path)), path).toEqual(notFound)
    }
    expect(audited(buckle).filter(entry => entry.tool.startsWith('setup_'))).toEqual([])
  })
})

describe('workspace routing', () => {
  it('serves /workspaces/<name>/** as an alias of the node faces, the name being the folder\'s', async () => {
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
    expect(audited(buckle)).toContainEqual(expect.objectContaining({ tool: 'workspace_invoke_rejected', workspaceId: 'unresolved', outcome: 'denied', detail: 'HTTP 401' }))
  })

  it('answers 409 for a disabled workspace on a non-setup path', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/setup/workspaces/one', { method: 'PATCH', headers: json(NODE_ADMIN), body: JSON.stringify({ online: false }) })).status).toBe(200)
    const response = await buckle.request('/workspaces/one/v1/manifest', { headers: bearer(ONE_AGENT) })
    expect(await shape(response)).toEqual({ status: 409, contentType: 'application/json', body: { error: 'Workspace is offline' } })
  })
})

describe('workbench edges', () => {
  async function provisioned() {
    const buckle = await node()
    const grant = { id: randomUUID(), token: 'workbench-grant-characterisation-only-32', projectId: 'project', chatId: 'chat', allowShell: false }
    const provision = await buckle.request(buckle.setup('workbenches'), { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify(grant) })
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
    await buckle.request(buckle.setup('status'), { headers: bearer(NODE_ADMIN) })
    await buckle.request('/v1/invoke', { method: 'POST', headers: json('wrong-token'), body: '{}' })
    await buckle.request('/workspaces/one/mcp', { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE })
    await buckle.request('/workspaces/one/setup/status')
    const tools = audited(buckle).map(entry => `${entry.tool}:${entry.event}:${entry.outcome}`)
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
    // A registry change names the actor on its own entries, not only on the transport entry beside them (review item 19).
    const registered = audited(buckle).filter(entry => entry.tool === 'workspace_register')
    expect(registered.map(entry => [entry.event, entry.actorId])).toEqual([['attempt', 'admin:node'], ['result', 'admin:node']])
  })

  // Fix brief 4, findings 22 and 40: the registration's entries named the name asked for in the id field, or `unresolved`,
  // and never the UUID the registry assigned.
  it('records a registration under the id the registry assigned, with the name it holds, and the attempt under the name asked for', async () => {
    const buckle = await node()
    const second = join(buckle.root, 'second')
    mkdirSync(second)
    await buckle.registerOne()
    const legacy = await buckle.request('/setup/workspaces', { method: 'POST', headers: json(NODE_ADMIN), body: JSON.stringify({ id: 'legacy', dir: second }) })
    expect(legacy.status).toBe(201)

    const made = (await legacy.json() as { workspace: { id: string } }).workspace.id
    const entries = audited(buckle).filter(entry => entry.tool === 'workspace_register').map(entry => [entry.event, entry.workspaceId, entry.workspaceName])
    expect(entries).toEqual([
      ['attempt', 'unresolved', 'one'], ['result', await buckle.idOf('one'), 'one'],
      ['attempt', 'unresolved', 'legacy'], ['result', made, 'legacy'],
    ])
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

// Review L1 of B15-B17 flip: HEAD on a route file that serves GET answers as GET does, headers only.
// Before, the compiled router had no HEAD entry and HEAD fell to a catch-all or the router's 404.
describe('HEAD on GET routes', () => {
  it('answers the open health routes and the guarded GET routes as GET, without a body', async () => {
    const buckle = await node()
    await buckle.registerOne()
    const rows: Array<{ path: string; token?: string; status: number }> = [
      { path: '/health', status: 200 },
      { path: '/health/ready', status: 200 },
      { path: '/v1/manifest', status: 401 },
      { path: '/v1/manifest', token: NODE_AGENT, status: 200 },
      { path: '/workspaces/one/v1/skills', token: ONE_AGENT, status: 200 },
      { path: buckle.setup('status'), token: NODE_ADMIN, status: 200 },
      { path: '/workspaces/one/setup/status', token: ONE_ADMIN, status: 200 },
      { path: '/v1/invoke', token: NODE_AGENT, status: 404 },
    ]
    for (const row of rows) {
      const response = await buckle.request(row.path, { method: 'HEAD', headers: row.token ? bearer(row.token) : {} })
      expect({ path: row.path, status: response.status, body: await response.text() }).toEqual({ path: row.path, status: row.status, body: '' })
    }
    // The owner's route audits HEAD under its own method.
    expect(audited(buckle).map(entry => entry.tool)).toContain('setup_head_status')
  })

  it('leaves a route that serves every method its own answer: MCP answers HEAD 405', async () => {
    const buckle = await node()
    const response = await buckle.request('/mcp', { method: 'HEAD', headers: { ...bearer(NODE_AGENT), ...MCP_HEADERS } })
    expect(response.status).toBe(405)
  })
})

// Review L2 of B15-B17: every method but POST on /v1/invoke is refused and audited as the invoke face
// refuses a call before the invoker sees it, as the Hono middleware did for every method.
describe('other methods on /v1/invoke', () => {
  it('audits rpc_invoke_rejected at node level and workspace_invoke_rejected under a workspace', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/v1/invoke')).status).toBe(401)
    expect((await buckle.request('/v1/invoke', { method: 'PUT', headers: bearer(NODE_AGENT) })).status).toBe(404)
    expect((await buckle.request('/workspaces/one/v1/invoke', { method: 'DELETE' })).status).toBe(401)
    const entries = audited(buckle).filter(entry => entry.tool.endsWith('invoke_rejected')).map(entry => `${entry.tool}:${entry.workspaceId}:${entry.detail}`)
    expect(entries).toEqual(expect.arrayContaining(['rpc_invoke_rejected:node:HTTP 401', `rpc_invoke_rejected:${buckle.runtime.workspaceId}:HTTP 404`, `workspace_invoke_rejected:${await buckle.idOf('one')}:HTTP 401`]))
  })

  // Fix brief 4, finding 39: a token's own refused call was filed under the node, while its /workspaces/ twin filed it in the
  // workspace's log, so one refusal landed in two places by route.
  it('files a token\'s refused call in the log of its own workspace, on /v1 and on the /workspaces/ route alike', async () => {
    const buckle = await node()
    await buckle.registerOne()
    expect((await buckle.request('/v1/invoke', { method: 'PUT', headers: bearer(ONE_AGENT) })).status).toBe(404)
    expect((await buckle.request('/workspaces/one/v1/invoke', { method: 'PUT', headers: bearer(ONE_AGENT) })).status).toBe(404)

    const id = await buckle.idOf('one')
    const refusals = (log: ActionLog) => log.read(100).filter(entry => entry.tool === 'rpc_invoke_rejected' && entry.detail === 'HTTP 404').map(entry => entry.workspaceId)
    expect(refusals(buckle.nodeActions)).toEqual([])
    const twin = (await (await buckle.services.getWorkspaces()).resolve(id)).runtime
    expect(refusals(twin.actions)).toEqual([id, id])
  })
})
