import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sandboxBinds, type BuckleConfig } from '../../common/runtime/config.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

const NODE_AGENT = 'node-agent'
const NODE_SETUP = 'node-setup'
/** Each workspace's agent token, as registration printed it once (D83 (3)). */
const minted = new Map<string, string>()
const agent = (id: string) => minted.get(id) ?? `never-minted-${id}`
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
let app: BuckleHttp
let root: string
const nodes: BuckleHttp[] = []

/** A node on this test's directories; configure sets what no environment variable carries. */
async function node(configure?: (config: BuckleConfig) => void): Promise<BuckleHttp> {
  const started = await createBuckleHttp({
    environment: { BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: NODE_SETUP, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1' },
    ...(configure ? { configure } : {}),
  })
  nodes.push(started)
  return started
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'buckle-multi-'))
  for (const folder of ['default', 'one', 'two']) mkdirSync(join(root, folder))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  app = await node()
  writeFileSync(join(root, 'one', 'hello.txt'), 'workspace one')
  writeFileSync(join(root, 'two', 'hello.txt'), 'workspace two')
})
afterEach(async () => {
  minted.clear()
  for (const started of nodes.splice(0)) await started.close()
})

async function register(id: string, token = NODE_SETUP, overrides: Record<string, unknown> = {}): Promise<Response> {
  const response = await app.request('/setup/workspaces', { method: 'POST', headers: headers(token), body: JSON.stringify({ name: id, dir: join(root, id), ...overrides }) })
  if (response.status === 201) minted.set(id, (await response.clone().json() as { token: { token: string } }).token.token)
  return response
}

function invoke(id: string, token: string, path = '/workspace/hello.txt') {
  return app.request(`/workspaces/${id}/v1/invoke`, { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId: 'request-1', tool: 'fs_read', args: { path } }) })
}

describe('multiple workspaces on one Buckle', () => {
  it('preserves the default endpoints and migrates without rewriting existing workspace state', async () => {
    expect((await app.request('/v1/manifest', { headers: headers(NODE_AGENT) })).status).toBe(200)
    expect((await app.request('/workspaces/default/v1/manifest', { headers: headers(NODE_AGENT) })).status).toBe(200)
    const body = await (await app.request('/setup/workspaces', { headers: headers(NODE_SETUP) })).json() as { workspaces: Array<{ id: string; online: boolean }> }
    expect(body.workspaces).toMatchObject([{ id: app.runtime.workspaceId, name: 'default', online: true }])
  })

  it('requires node admin for registration and never returns stored credentials', async () => {
    expect((await register('one', NODE_AGENT)).status).toBe(401)
    expect((await register('one')).status).toBe(201)
    const response = await app.request('/setup/workspaces', { headers: headers(NODE_SETUP) })
    const body = await response.text()
    expect(body).toContain('"name":"one"')
    expect(body).not.toContain(agent('one'))
    expect((await register('two', NODE_SETUP, { dir: join(root, 'one') })).status).toBe(409)
    expect((await register('one', NODE_SETUP, { dir: join(root, 'two') })).status).toBe(409)
  })

  it('isolates credentials, filesystem access, policies and local audit', async () => {
    await register('one')
    await register('two')
    expect((await invoke('one', NODE_AGENT)).status).toBe(401)
    expect((await invoke('one', agent('two'))).status).toBe(401)
    expect((await invoke('one', NODE_SETUP)).status).toBe(401)
    const response = await invoke('one', agent('one'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('workspace one')
    const crossRoot = await invoke('one', agent('one'), join(root, 'two', 'hello.txt'))
    expect(await crossRoot.text()).not.toContain('workspace two')
    const auditPath = '/workspaces/one/setup/audit'
    expect((await app.request(auditPath, { headers: headers(agent('one')) })).status).toBe(401)
    const idOfOne = await app.idOf('one')
    const audit = await (await app.request(auditPath, { headers: headers(NODE_SETUP) })).json() as { entries: Array<{ workspaceId: string; event: string }> }
    expect(audit.entries.length).toBeGreaterThan(0)
    expect(audit.entries.every(entry => entry.workspaceId === app.runtime.workspaceId || entry.workspaceId === idOfOne)).toBe(true)
    const twoAudit = await (await app.request('/workspaces/two/setup/audit', { headers: headers(NODE_SETUP) })).json() as { entries: unknown[] }
    expect(twoAudit.entries).toEqual([])
    const policy = { version: 1, commands: { deny: ['curl *'] } }
    expect((await app.request('/workspaces/one/setup/policy', { method: 'PUT', headers: headers(NODE_SETUP), body: JSON.stringify(policy) })).status).toBe(200)
    const otherPolicy = await (await app.request('/workspaces/two/setup/policy', { headers: headers(NODE_SETUP) })).text()
    expect(otherPolicy).not.toContain('curl *')
  })

  it('persists registration and supports disabling and enabling without deleting files', async () => {
    await register('one')
    app = await node()
    expect((await invoke('one', agent('one'))).status).toBe(200)
    const patch = (online: boolean) => app.request('/setup/workspaces/one', { method: 'PATCH', headers: headers(NODE_SETUP), body: JSON.stringify({ online }) })
    expect((await patch(false)).status).toBe(200)
    expect((await invoke('one', agent('one'))).status).toBe(409)
    expect((await patch(true)).status).toBe(200)
    expect(await (await invoke('one', agent('one'))).text()).toContain('workspace one')
  })

  it('hides node credentials even if a workspace owner grants an outside path', async () => {
    await register('one')
    const response = await invoke('one', agent('one'), join(root, 'state', 'workspaces.json'))
    const body = await response.text()
    expect(body).not.toContain(agent('one'))
    expect(body).toContain('error')
  })
})

it('rejects workspaces exposed by inherited host read-only mounts', async () => {
  app = await node(config => { config.mountReadOnlyPaths = [root] })
  const response = await register('one')
  expect(response.status).toBe(409)
  expect(await response.text()).toContain('read-only mount')
})

it('inherits the node callbacks, so a registered workspace is not absent from the audit trail', async () => {
  app = await node((config) => {
    config.reportUrl = 'https://reports.example.test/events'
    config.reportToken = 'node-report-fixture'
    config.approvalWebhook = 'https://reports.example.test/approvals'
  })
  await register('one')
  const response = await app.request('/workspaces/one/setup/status', { headers: headers(NODE_SETUP) })
  expect(response.status).toBe(200)
  // Every entry it posts carries workspaceId: 'one', which is the identity that was missing.
  expect(await response.json()).toMatchObject({ reporting: true, workspaceId: await app.idOf('one') })
})

it('retains setup history and audit while a workspace is offline, and serves it again once reactivated', async () => {
  await register('one')
  await invoke('one', agent('one'))
  expect((await app.request('/setup/workspaces/one', { method: 'DELETE', headers: headers(NODE_SETUP) })).status).toBe(204)
  expect((await invoke('one', agent('one'))).status).toBe(409)
  expect((await app.request('/workspaces/one/setup/audit', { headers: headers(NODE_SETUP) })).status).toBe(200)
  expect((await app.request('/workspaces/one/setup/history', { headers: headers(NODE_SETUP) })).status).toBe(200)
  expect((await app.request('/setup/workspaces/one/reactivate', { method: 'POST', headers: headers(NODE_SETUP) })).status).toBe(200)
  expect(await (await invoke('one', agent('one'))).text()).toContain('workspace one')
})

it('shows real host directory entries only under setup authority', async () => {
  const path = `/setup/directories?path=${encodeURIComponent(root)}&limit=1`
  expect((await app.request(path, { headers: headers(NODE_AGENT) })).status).toBe(401)
  const first = await (await app.request(path, { headers: headers(NODE_SETUP) })).json() as { path: string; entries: Array<{ name: string }>; nextCursor: string }
  expect(first.path).toBe(root)
  expect(first.entries).toHaveLength(1)
  expect(first.nextCursor).toBeTruthy()
  const second = await (await app.request(`${path}&cursor=${first.nextCursor}`, { headers: headers(NODE_SETUP) })).json() as { entries: Array<{ name: string }> }
  expect(second.entries[0]?.name).not.toBe(first.entries[0]?.name)
})

it('checks policy revisions and applies read-denied paths to filesystem tools', async () => {
  await register('one')
  const path = '/workspaces/one/setup/policy'
  const before = await (await app.request(path, { headers: headers(NODE_SETUP) })).json() as { effective: Record<string, unknown>; revision: string }
  const body = { ...before.effective, filesystem: { rules: [{ path: 'hello.txt', read: 'deny' }] }, expectedRevision: before.revision }
  expect((await app.request(path, { method: 'PUT', headers: headers(NODE_SETUP), body: JSON.stringify(body) })).status).toBe(200)
  expect((await app.request(path, { method: 'PUT', headers: headers(NODE_SETUP), body: JSON.stringify(body) })).status).toBe(409)
  const response = await (await invoke('one', agent('one'))).text()
  expect(response).not.toContain('workspace one')
  expect(response).toContain('PERMISSION_DENIED')
  const listing = await (await app.request('/workspaces/one/setup/files?path=.', { headers: headers(NODE_SETUP) })).json() as { entries: Array<{ name: string; read: string }> }
  expect(listing.entries.find(entry => entry.name === 'hello.txt')?.read).toBe('deny')
})

// Fix brief 1, F (finding 43 of the Phase 1 review): until the mount table holds them per workspace, BUCKLE_MOUNTS is the
// node's for every workspace, as the docs say; a workspace still cannot hold a mount's source.
it('refuses a workspace holding a mount\'s source, and gives every other the node\'s mounts', async () => {
  const mounts = [{ source: join(root, 'two', 'hello.txt'), target: '/srv/auth/config.json', readOnly: true as const }]
  // BUCKLE_MOUNTS: the node's read-only mounts, every workspace's where its own table holds none.
  app = await node((config) => { config.workspaceDefaults = { ...config.workspaceDefaults, mounts: [{ source: mounts[0]!.source, target: mounts[0]!.target, access: 'ro' }] } })
  expect((await register('two')).status).toBe(409)
  expect((await register('one')).status).toBe(201)
  const child = await (await app.services.getWorkspaces()).resolve(await app.idOf('one'))
  expect(sandboxBinds(child.config.mounts)).toEqual(mounts)
})
