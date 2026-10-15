import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, mintedToken, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// The workspace-model brief, item 3: /mcp and /v1/* serve the workspace the bearer token belongs to, so an agent's
// config needs only the host, the port and its token; /workspaces/<id>/... stays, for the token of <id> alone. A token
// of no workspace and a token of another one are refused alike, in text and in the work done to refuse them.

const NODE_AGENT = 'routing-node-agent-token-fixture'
const ADMIN = 'routing-node-admin-token-fixture'
const PROTOCOL = '2026-07-28'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function node(): Promise<{ buckle: BuckleHttp; one: string }> {
  const { root, environment } = nodeEnvironment('buckle-token-routing-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  writeFileSync(join(root, 'workspace', 'note.md'), 'default note')
  mkdirSync(join(root, 'one'))
  writeFileSync(join(root, 'one', 'note.md'), 'workspace one note')
  const buckle = await createBuckleHttp({ environment })
  nodes.push(buckle)
  const one = await mintedToken(buckle.request('/setup/workspaces', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify({ id: 'one', name: 'One', dir: join(root, 'one') }) }))
  return { buckle, one }
}

function headers(token?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

function read(buckle: BuckleHttp, path: string, token?: string): Promise<Response> {
  return buckle.request(path, { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId: `read-${Math.random()}`, tool: 'fs_read', args: { path: 'note.md' } }) })
}

describe('a request at /mcp or /v1 with no workspace in its path', () => {
  it('runs on the workspace its token belongs to', async () => {
    const { buckle, one } = await node()
    expect(await (await read(buckle, '/v1/invoke', one)).json()).toMatchObject({ outcome: 'ok', output: { content: 'workspace one note' } })
    expect(await (await read(buckle, '/v1/invoke', NODE_AGENT)).json()).toMatchObject({ outcome: 'ok', output: { content: 'default note' } })
    expect(await (await buckle.request('/v1/manifest', { headers: headers(one) })).json()).toMatchObject({ name: 'One' })
  })

  // A token's holder learns its own workspace is offline, as on its /workspaces/<id>/ path; no other workspace is named.
  it('answers the token of an offline workspace that its workspace is offline', async () => {
    const { buckle, one } = await node()
    expect((await buckle.request('/setup/workspaces/one', { method: 'PATCH', headers: headers(ADMIN), body: JSON.stringify({ online: false }) })).status).toBe(200)
    const response = await read(buckle, '/v1/invoke', one)
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { error: 'Workspace is offline' } })
  })

  it('answers a token of no workspace with the bare 401 an absent one gets', async () => {
    const { buckle } = await node()
    for (const token of [undefined, 'a-token-no-workspace-holds-at-all']) {
      const response = await read(buckle, '/v1/invoke', token)
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    }
  })

  it('serves MCP the token\'s workspace too', async () => {
    const { buckle, one } = await node()
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_read', arguments: { path: 'note.md' }, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } })
    const response = await buckle.request('/mcp', { method: 'POST', headers: { ...headers(one), accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': 'fs_read' }, body: call })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('workspace one note')
  })
})

describe('a request at /workspaces/<id>/', () => {
  it('runs for a token of <id> alone, and answers another workspace\'s token as it answers a token of none', async () => {
    const { buckle, one } = await node()
    expect((await read(buckle, '/workspaces/one/v1/invoke', one)).status).toBe(200)
    const foreign = await read(buckle, '/workspaces/one/v1/invoke', NODE_AGENT)
    const unknown = await read(buckle, '/workspaces/one/v1/invoke', 'a-token-no-workspace-holds-at-all')
    expect({ status: foreign.status, body: await foreign.text() }).toEqual({ status: unknown.status, body: await unknown.text() })
    expect(foreign.status).toBe(401)
  })
})
