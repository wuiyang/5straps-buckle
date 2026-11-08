import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createBuckleHttp, mintedToken } from '../support/buckle-http.js'
import { auditEntries } from '../support/action-log-writer.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const root = mkdtempSync('/tmp/buckle-workbench-http-')
  const source = join(root, 'source'), child = join(root, 'child')
  mkdirSync(source); mkdirSync(child); mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(source, 'note.txt'), 'default fixture')
  writeFileSync(join(child, 'note.txt'), 'child fixture')
  const buckle = await createBuckleHttp({ environment: { BUCKLE_WORKSPACE_ROOT: source, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'fixture-agent', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'fixture-setup', BUCKLE_ALLOW_SHELL: 'false' } })
  cleanups.push(async () => { await buckle.close(); rmSync(root, { recursive: true, force: true }) })
  const request = (path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => buckle.request(path, { method, headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { root, source, child, config: buckle.config, runtime: buckle.runtime, buckle, request }
}
it('requires setup provisioning and a separate workbench grant for editor operations', async () => {
  const f = await fixture()
  const grant = { id: randomUUID(), token: 'fixture-workbench-grant-long-enough', projectId: 'project', chatId: 'chat', allowShell: false }
  expect((await f.request(f.buckle.setup('workbenches'), f.config.authToken, grant)).status).toBe(401)
  expect((await f.request(f.buckle.setup('workbenches'), f.config.adminToken, grant)).status).toBe(200)
  const path = '/v1/workbenches/' + grant.id
  for (const token of [f.config.authToken, f.config.adminToken, 'wrong-fixture-workbench-grant-long']) expect((await f.request(path, token)).status).toBe(401)
  const read = await f.request(path + '/invoke', grant.token, { actorId: 'user-alice', tool: 'fs_read', args: { path: 'note.txt' } })
  expect(read.status).toBe(200)
  expect(read.headers.get('cache-control')).toBe('no-store')
  expect(await read.text()).toContain('default fixture')
  const policy = await f.request(f.buckle.setup('policy'), f.config.adminToken)
  const revision = (await policy.json() as { revision: string }).revision
  const replacement = await f.request(f.buckle.setup('policy'), f.config.adminToken, { expectedRevision: revision, version: 1, commands: { allow: [], deny: [] }, network: { allow: [] }, mount: null, updatedAt: null }, 'PUT')
  expect(replacement.status).toBe(409)
  expect(await replacement.text()).toContain('Close the open workbenches')
  await f.request(path + '/discard', grant.token, { actorId: 'user-alice' })
})

it('routes child workbench credentials independently of child agent credentials', async () => {
  const f = await fixture()
  const agent = await mintedToken(f.request('/setup/workspaces', f.config.adminToken, { id: 'child', name: 'Child', dir: f.child }))
  // The node's admin credential is every workspace's (D83).
  const setup = f.config.adminToken
  const grant = { id: randomUUID(), token: 'fixture-child-workbench-token-long', projectId: 'project', chatId: 'chat', allowShell: false }
  const path = '/workspaces/child/v1/workbenches/' + grant.id
  expect((await f.request('/workspaces/child/setup/workbenches', setup, grant)).status).toBe(200)
  expect((await f.request(path, agent)).status).toBe(401)
  const read = await f.request(path + '/invoke', grant.token, { actorId: 'alice', tool: 'fs_read', args: { path: 'note.txt' } })
  expect(read.status).toBe(200)
  expect(await read.text()).toContain('child fixture')
  // A grant is for one workspace: the child's does not open the node's workbench of the same id.
  expect((await f.request('/v1/workbenches/' + grant.id, grant.token)).status).toBe(401)
  expect((await f.request('/setup/workspaces/child', f.config.adminToken, { online: false }, 'PATCH')).status).toBe(409)
  expect((await f.request(path + '/discard', grant.token, { actorId: 'alice' })).status).toBe(200)
  expect((await f.request('/setup/workspaces/child', f.config.adminToken, { online: false }, 'PATCH')).status).toBe(200)
  expect((await f.request(path, grant.token)).status).toBe(409)
})

it('audits a changing workbench call as transport status beside the operation, and a refused grant', async () => {
  const f = await fixture()
  const grant = { id: randomUUID(), token: 'fixture-workbench-grant-long-enough', projectId: 'project', chatId: 'chat', allowShell: false }
  expect((await f.request(f.buckle.setup('workbenches'), f.config.adminToken, grant)).status).toBe(200)
  expect((await f.request(`/v1/workbenches/${grant.id}/reviews`, grant.token, { actorId: 'alice' })).status).toBe(200)
  expect((await f.request(`/v1/workbenches/${grant.id}/reviews`, 'wrong-fixture-workbench-grant-long', { actorId: 'alice' })).status).toBe(401)
  const tools = [...(await auditEntries(f.buckle.nodeActions, 200)), ...(await auditEntries(f.runtime.actions, 200))].map(entry => `${entry.tool}:${entry.outcome}`)
  expect(tools).toEqual(expect.arrayContaining(['http_workbench_post:started', 'http_workbench_post:ok', 'http_workbench_post:denied', 'workbench_auth_rejected:denied']))
  await f.request(`/v1/workbenches/${grant.id}/discard`, grant.token, { actorId: 'alice' })
})
