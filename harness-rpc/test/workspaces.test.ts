import { createWorkspaceManager } from '../src/services/workspace-manager.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig, type BuckleConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createRuntime } from '../src/runtime.js'

const NODE_AGENT = 'node-agent'
const NODE_SETUP = 'node-setup'
const agent = (id: string) => `workspace-agent-${id}-fixture-only`
const setup = (id: string) => `workspace-setup-${id}-fixture-only`
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
let app: Hono
let config: BuckleConfig
let root: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'buckle-multi-'))
  const { mkdirSync } = await import('node:fs')
  for (const folder of ['default', 'one', 'two', 'state']) mkdirSync(join(root, folder))
  config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ADMIN_TOKEN: NODE_SETUP, BUCKLE_ALLOW_SHELL: 'false' })
  app = createHttpApp({ config, runtime: await createRuntime({ config, channel: () => createDeferredApprovalChannel() }), authToken: NODE_AGENT })
  writeFileSync(join(root, 'one', 'hello.txt'), 'workspace one')
  writeFileSync(join(root, 'two', 'hello.txt'), 'workspace two')
})

function register(id: string, token = NODE_SETUP, overrides: Record<string, unknown> = {}) {
  return app.request('/setup/workspaces', { method: 'POST', headers: headers(token), body: JSON.stringify({ id, name: `Workspace ${id}`, root: join(root, id), authToken: agent(id), adminToken: setup(id), ...overrides }) })
}

function invoke(id: string, token: string, path = '/workspace/hello.txt') {
  return app.request(`/workspaces/${id}/v1/invoke`, { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId: 'request-1', tool: 'fs_read', args: { path } }) })
}

describe('multiple workspaces on one Buckle', () => {
  it('preserves the default endpoints and migrates without rewriting existing workspace state', async () => {
    expect((await app.request('/v1/manifest', { headers: headers(NODE_AGENT) })).status).toBe(200)
    expect((await app.request('/workspaces/default/v1/manifest', { headers: headers(NODE_AGENT) })).status).toBe(200)
    const body = await (await app.request('/setup/workspaces', { headers: headers(NODE_SETUP) })).json() as { workspaces: Array<{ id: string; default: boolean }> }
    expect(body.workspaces).toMatchObject([{ id: 'default', default: true }])
  })

  it('requires node admin for registration and never returns stored credentials', async () => {
    expect((await register('one', NODE_AGENT)).status).toBe(401)
    expect((await register('one')).status).toBe(201)
    const response = await app.request('/setup/workspaces', { headers: headers(NODE_SETUP) })
    const body = await response.text()
    expect(body).toContain('Workspace one')
    expect(body).not.toContain(agent('one'))
    expect(body).not.toContain(setup('one'))
    expect((await register('two', NODE_SETUP, { authToken: agent('one') })).status).toBe(409)
    expect((await register('two', NODE_SETUP, { root: join(root, 'one') })).status).toBe(409)
  })

  it('isolates credentials, filesystem access, policies and local audit', async () => {
    await register('one')
    await register('two')
    expect((await invoke('one', NODE_AGENT)).status).toBe(401)
    expect((await invoke('one', agent('two'))).status).toBe(401)
    expect((await invoke('one', setup('one'))).status).toBe(401)
    const response = await invoke('one', agent('one'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('workspace one')
    const crossRoot = await invoke('one', agent('one'), join(root, 'two', 'hello.txt'))
    expect(await crossRoot.text()).not.toContain('workspace two')
    const auditPath = '/workspaces/one/setup/audit'
    expect((await app.request(auditPath, { headers: headers(agent('one')) })).status).toBe(401)
    expect((await app.request(auditPath, { headers: headers(setup('two')) })).status).toBe(401)
    const audit = await (await app.request(auditPath, { headers: headers(setup('one')) })).json() as { entries: Array<{ workspaceId: string; event: string }> }
    expect(audit.entries.length).toBeGreaterThan(0)
    expect(audit.entries.every(entry => entry.workspaceId === 'one')).toBe(true)
    const twoAudit = await (await app.request('/workspaces/two/setup/audit', { headers: headers(setup('two')) })).json() as { entries: unknown[] }
    expect(twoAudit.entries).toEqual([])
    const policy = { version: 1, commands: { deny: ['curl *'] } }
    expect((await app.request('/workspaces/one/setup/policy', { method: 'PUT', headers: headers(setup('one')), body: JSON.stringify(policy) })).status).toBe(200)
    const otherPolicy = await (await app.request('/workspaces/two/setup/policy', { headers: headers(setup('two')) })).text()
    expect(otherPolicy).not.toContain('curl *')
  })

  it('persists registration and supports disabling and enabling without deleting files', async () => {
    await register('one')
    app = createHttpApp({ config, runtime: await createRuntime({ config, channel: () => createDeferredApprovalChannel() }), authToken: NODE_AGENT })
    expect((await invoke('one', agent('one'))).status).toBe(200)
    const patch = (enabled: boolean) => app.request('/setup/workspaces/one', { method: 'PATCH', headers: headers(NODE_SETUP), body: JSON.stringify({ enabled }) })
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
    expect(body).not.toContain(setup('one'))
    expect(body).toContain('error')
  })
})

it('rejects workspaces exposed by inherited host read-only mounts', async () => {
  config.mountReadOnlyPaths = [root]
  app = createHttpApp({ config, runtime: await createRuntime({ config, channel: () => createDeferredApprovalChannel() }), authToken: NODE_AGENT })
  const response = await register('one')
  expect(response.status).toBe(409)
  expect(await response.text()).toContain('read-only mount')
})

it('inherits the node callbacks, so a registered workspace is not absent from the audit trail', async () => {
  config.reportUrl = 'https://reports.example.test/events'
  config.reportToken = 'node-report-fixture'
  config.approvalWebhook = 'https://reports.example.test/approvals'
  await register('one')
  const response = await app.request('/workspaces/one/setup/status', { headers: headers(setup('one')) })
  expect(response.status).toBe(200)
  // Every entry it posts carries workspaceId: 'one', which is the identity that was missing.
  expect(await response.json()).toMatchObject({ reporting: true, workspaceId: 'one' })
})

it('retains setup history and audit after workspace retirement and requires explicit reactivation', async () => {
  await register('one')
  await invoke('one', agent('one'))
  expect((await app.request('/setup/workspaces/one', { method: 'DELETE', headers: headers(NODE_SETUP) })).status).toBe(204)
  expect((await invoke('one', agent('one'))).status).toBe(409)
  expect((await app.request('/workspaces/one/setup/audit', { headers: headers(setup('one')) })).status).toBe(200)
  expect((await app.request('/workspaces/one/setup/history', { headers: headers(setup('one')) })).status).toBe(200)
  expect((await app.request('/setup/workspaces/one', { method: 'PATCH', headers: headers(NODE_SETUP), body: JSON.stringify({ enabled: true }) })).status).toBe(409)
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
  const before = await (await app.request(path, { headers: headers(setup('one')) })).json() as { effective: Record<string, unknown>; revision: string }
  const body = { ...before.effective, filesystem: { rules: [{ path: 'hello.txt', read: 'deny' }] }, expectedRevision: before.revision }
  expect((await app.request(path, { method: 'PUT', headers: headers(setup('one')), body: JSON.stringify(body) })).status).toBe(200)
  expect((await app.request(path, { method: 'PUT', headers: headers(setup('one')), body: JSON.stringify(body) })).status).toBe(409)
  const response = await (await invoke('one', agent('one'))).text()
  expect(response).not.toContain('workspace one')
  expect(response).toContain('PERMISSION_DENIED')
  const listing = await (await app.request('/workspaces/one/setup/files?path=.', { headers: headers(setup('one')) })).json() as { entries: Array<{ name: string; read: string }> }
  expect(listing.entries.find(entry => entry.name === 'hello.txt')?.read).toBe('deny')
})

it('keeps explicit credential mounts out of managed workspaces', async () => {
  config.sandboxMounts = [{ source: join(root, 'two', 'hello.txt'), target: '/srv/auth/config.json', readOnly: true }]
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  app = createHttpApp({ config, runtime, authToken: NODE_AGENT })
  expect((await register('two')).status).toBe(409)
  expect((await register('one')).status).toBe(201)
  const manager = createWorkspaceManager({ config, runtime })
  const child = await manager.resolve('one')
  expect(child.config.sandboxMounts).toEqual([])
})
