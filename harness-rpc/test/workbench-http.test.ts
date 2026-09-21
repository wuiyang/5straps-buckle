import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createRuntime } from '../src/runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const root = mkdtempSync('/tmp/buckle-workbench-http-')
  const source = join(root, 'source'), child = join(root, 'child')
  mkdirSync(source); mkdirSync(child)
  writeFileSync(join(source, 'note.txt'), 'default fixture')
  writeFileSync(join(child, 'note.txt'), 'child fixture')
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: source, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'fixture-agent', BUCKLE_ADMIN_TOKEN: 'fixture-setup', BUCKLE_ALLOW_SHELL: 'false' })
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  const app = createHttpApp({ config, runtime, authToken: config.authToken })
  cleanups.push(async () => { await runtime.workbenches.close(); rmSync(root, { recursive: true, force: true }) })
  const request = (path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => app.request(path, { method, headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { root, source, child, config, runtime, app, request }
}
it('requires setup provisioning and a separate workbench grant for editor operations', async () => {
  const f = await fixture()
  const grant = { id: randomUUID(), token: 'fixture-workbench-grant-long-enough', projectId: 'project', chatId: 'chat', allowShell: false }
  expect((await f.request('/setup/workbenches', f.config.authToken, grant)).status).toBe(401)
  expect((await f.request('/setup/workbenches', f.config.adminToken, grant)).status).toBe(200)
  const path = '/v1/workbenches/' + grant.id
  for (const token of [f.config.authToken, f.config.adminToken, 'wrong-fixture-workbench-grant-long']) expect((await f.request(path, token)).status).toBe(401)
  const read = await f.request(path + '/invoke', grant.token, { actorId: 'user-alice', tool: 'fs_read', args: { path: 'note.txt' } })
  expect(read.status).toBe(200)
  expect(await read.text()).toContain('default fixture')
  const policy = await f.request('/setup/policy', f.config.adminToken)
  const revision = (await policy.json() as { revision: string }).revision
  const replacement = await f.request('/setup/policy', f.config.adminToken, { expectedRevision: revision, version: 1, commands: { allow: [], deny: [] }, network: { allow: [] }, mount: null, updatedAt: null }, 'PUT')
  expect(replacement.status).toBe(409)
  expect(await replacement.text()).toContain('Resolve active work')
  await f.request(path + '/discard', grant.token, { actorId: 'user-alice' })
})

it('routes child workbench credentials independently of child agent credentials', async () => {
  const f = await fixture()
  const agent = 'fixture-child-agent-long-enough', setup = 'fixture-child-setup-long-enough'
  expect((await f.request('/setup/workspaces', f.config.adminToken, { id: 'child', name: 'Child', root: f.child, authToken: agent, setupToken: setup })).status).toBe(201)
  const grant = { id: randomUUID(), token: 'fixture-child-workbench-token-long', projectId: 'project', chatId: 'chat', allowShell: false }
  const path = '/workspaces/child/v1/workbenches/' + grant.id
  expect((await f.request('/workspaces/child/setup/workbenches', setup, grant)).status).toBe(200)
  expect((await f.request(path, agent)).status).toBe(401)
  const read = await f.request(path + '/invoke', grant.token, { actorId: 'alice', tool: 'fs_read', args: { path: 'note.txt' } })
  expect(read.status).toBe(200)
  expect(await read.text()).toContain('child fixture')
  expect((await f.request('/setup/workspaces/child', f.config.adminToken, { enabled: false }, 'PATCH')).status).toBe(409)
  expect((await f.request(path + '/discard', grant.token, { actorId: 'alice' })).status).toBe(200)
  expect((await f.request('/setup/workspaces/child', f.config.adminToken, { enabled: false }, 'PATCH')).status).toBe(200)
  expect((await f.request(path, grant.token)).status).toBe(409)
})
