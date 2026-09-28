import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '../../common/types/ports/action-log.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// Review M1 and L6 of B15-B17: nothing an agent-facing route answers names the owner's state path,
// and a workbench path tells a caller without the grant nothing about whether its workspace exists.

const NODE_AGENT = 'pre-auth-node-agent-token'
const NODE_ADMIN = 'pre-auth-node-admin-token'
const agent = (id: string) => `pre-auth-${id}-agent-token-fixture`
const admin = (id: string) => `pre-auth-${id}-admin-token-fixture`
const FAKE_GRANT = 'pre-auth-fake-workbench-grant-token-0123'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function node(): Promise<BuckleHttp & { root: string; state: string }> {
  const { root, state, environment } = nodeEnvironment('buckle-pre-auth-', { BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ADMIN_TOKEN: NODE_ADMIN })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  return Object.assign(started, { root, state })
}

function bearer(token?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

async function register(buckle: BuckleHttp & { root: string }, id: string): Promise<string> {
  const directory = join(buckle.root, id)
  mkdirSync(directory)
  const response = await buckle.request('/setup/workspaces', { method: 'POST', headers: bearer(NODE_ADMIN), body: JSON.stringify({ id, name: id, root: directory, authToken: agent(id), adminToken: admin(id) }) })
  expect(response.status).toBe(201)
  return realpathSync(directory)
}

/** A stored policy the workspace's runtime refuses to load, as a grammar change on upgrade would leave it. */
function breakStoredPolicy(state: string, id: string, root: string): void {
  const directory = join(state, 'workspaces', id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const policy = { version: 1, commands: { allow: ['git {'], deny: [] }, network: { allow: [] }, mount: null, updatedAt: null }
  writeFileSync(join(directory, 'policy.json'), JSON.stringify({ version: 1, workspaces: { [root]: policy } }))
}

function nodeLog(buckle: BuckleHttp): ActionLogEntry[] {
  return buckle.runtime.actions.read(200)
}

describe('a workspace whose stored policy will not load', () => {
  it('answers every agent-facing caller without the state path, and only the owner with the repair', async () => {
    const buckle = await node()
    breakStoredPolicy(buckle.state, 'two', await register(buckle, 'two'))
    const workbench = `/workspaces/two/v1/workbenches/${randomUUID()}`
    const probes: Array<{ path: string; token?: string; method?: string; status: number; error: string }> = [
      // The review's probe: no credential on a workbench twin opens nothing and says nothing.
      { path: workbench, status: 401, error: 'Unauthorized' },
      // Review L1 of B18-B19: a fake grant is checked against the stored record, so nothing opens and it is a 401 too.
      { path: workbench, token: FAKE_GRANT, status: 401, error: 'Unauthorized' },
      { path: '/workspaces/two/v1/manifest', token: agent('two'), status: 409, error: 'Workspace policy needs owner repair' },
      { path: '/workspaces/two/v1/skills', token: agent('two'), status: 409, error: 'Workspace policy needs owner repair' },
      { path: '/workspaces/two/health', token: agent('two'), status: 409, error: 'Workspace policy needs owner repair' },
      { path: '/workspaces/two/v1/invoke', token: agent('two'), method: 'POST', status: 409, error: 'Workspace policy needs owner repair' },
      { path: '/workspaces/two/mcp', token: agent('two'), method: 'POST', status: 409, error: 'Workspace policy needs owner repair' },
    ]
    for (const probe of probes) {
      const response = await buckle.request(probe.path, { method: probe.method ?? 'GET', headers: bearer(probe.token), ...(probe.method === 'POST' ? { body: '{}' } : {}) })
      const body = await response.text()
      expect({ path: probe.path, status: response.status, body: JSON.parse(body) }).toEqual({ path: probe.path, status: probe.status, body: { error: probe.error } })
      expect(body).not.toContain(buckle.state)
    }
    // The owner's face keeps the full message: the file, the reason and the repair.
    const owner = await (await buckle.request('/workspaces/two/setup/status', { headers: bearer(admin('two')) })).text()
    expect(owner).toContain('Stored policy in')
    expect(owner).toContain('buckle policy')
  })

  it('audits the workbench refusal on the node log under the workspace, without the credential', async () => {
    const buckle = await node()
    breakStoredPolicy(buckle.state, 'two', await register(buckle, 'two'))
    await buckle.request(`/workspaces/two/v1/workbenches/${randomUUID()}`, { headers: bearer(FAKE_GRANT) })
    const refusal = nodeLog(buckle).find(entry => entry.tool === 'workbench_auth_rejected')
    expect(refusal).toMatchObject({ workspaceId: 'two', detail: 'HTTP 401' })
    expect(JSON.stringify(nodeLog(buckle))).not.toContain(FAKE_GRANT)
  })
})

describe('workbench twins before the grant (review L6)', () => {
  it('answers an unknown workspace, a disabled one and a wrong grant with the same 401', async () => {
    const buckle = await node()
    await register(buckle, 'one')
    expect((await buckle.request('/setup/workspaces/one', { method: 'PATCH', headers: bearer(NODE_ADMIN), body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    for (const workspace of ['ghost', 'one']) {
      for (const token of [undefined, FAKE_GRANT, agent('one')]) {
        const response = await buckle.request(`/workspaces/${workspace}/v1/workbenches/${randomUUID()}`, { headers: bearer(token) })
        expect({ workspace, token, status: response.status }).toEqual({ workspace, token, status: 401 })
      }
    }
    const unresolved = nodeLog(buckle).filter(entry => entry.tool === 'workbench_auth_rejected' && entry.workspaceId === 'unresolved')
    expect(unresolved).toHaveLength(3)
  })
})

describe('a fake grant before authentication (review L1 of B18-B19)', () => {
  it('answers 401 for a workspace whose root is gone, a broken policy, a disabled one and a healthy one, and opens none of their runtimes', async () => {
    const buckle = await node()
    const gone = await register(buckle, 'gone')
    breakStoredPolicy(buckle.state, 'broken', await register(buckle, 'broken'))
    await register(buckle, 'sleepy')
    await register(buckle, 'healthy')
    expect((await buckle.request('/setup/workspaces/sleepy', { method: 'PATCH', headers: bearer(NODE_ADMIN), body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    rmSync(gone, { recursive: true })
    const opened = async () => (await (await buckle.services.getWorkspaces()).opened()).map(runtime => runtime.workspaceId)
    const before = await opened()
    // Only the PATCH that disabled it opened one; the probes below must open no other.
    expect(before).toEqual(['sleepy'])

    for (const workspace of ['gone', 'broken', 'sleepy', 'healthy', 'default']) {
      const response = await buckle.request(`/workspaces/${workspace}/v1/workbenches/${randomUUID()}`, { headers: bearer(FAKE_GRANT) })
      expect({ workspace, status: response.status, body: await response.json() }).toEqual({ workspace, status: 401, body: { error: 'Unauthorized' } })
    }
    expect(await opened()).toEqual(before)
  })

  it('still answers the registry\'s own 503 when the registry cannot be read', async () => {
    const buckle = await node()
    await register(buckle, 'one')
    writeFileSync(join(buckle.state, 'workspaces.json'), '{ not json')
    const response = await buckle.request(`/workspaces/one/v1/workbenches/${randomUUID()}`, { headers: bearer(FAKE_GRANT) })
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 503, body: { error: 'Workspace registry needs owner repair' } })
  })
})
