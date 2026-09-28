import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

// B20 over the admin face (ruling H1e): the switch shows read-only, with the root it is bound to
// (owner decision D7); a policy document that names it is refused 409, since it is not part of a
// policy (review H1 of B20-B22); any other policy write and a clear keep it; a registered workspace's
// needs the node's too.

const AGENT = 'dangerously-http-agent-token'
const ADMIN = 'dangerously-http-admin-token'
const CHILD_ADMIN = 'dangerously-http-child-admin-token'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

async function node(): Promise<BuckleHttp & { root: string }> {
  const { root, environment } = nodeEnvironment('buckle-dangerously-http-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  const started = await createBuckleHttp({ environment })
  nodes.push(started)
  return Object.assign(started, { root })
}

const headers = (token = ADMIN) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const status = async (buckle: BuckleHttp, path = '/setup/status', token = ADMIN) => (await (await buckle.request(path, { headers: headers(token) })).json()) as { dangerouslyAllow: unknown }
const put = (buckle: BuckleHttp, body: unknown) => buckle.request('/setup/policy', { method: 'PUT', headers: headers(), body: JSON.stringify(body) })
const policy = { version: 1, commands: { allow: [], deny: [] }, network: { allow: ['example.com'] }, mount: null, updatedAt: null }

describe('the dangerously-allow switch on the admin face', () => {
  it('shows it in /setup/status and /setup/policy, refuses a PUT that changes it with 409, and keeps it through other writes and a clear', async () => {
    const buckle = await node()
    const boundTo = buckle.config.cwd
    expect((await status(buckle)).dangerouslyAllow).toEqual({ on: false, allowedByNode: null, effective: false, boundTo })
    // The owner's local CLI switched it on.
    await buckle.runtime.policy.setDangerouslyAllow(true)
    expect((await status(buckle)).dangerouslyAllow).toEqual({ on: true, allowedByNode: null, effective: true, boundTo })
    expect(await (await buckle.request('/setup/policy', { headers: headers() })).json()).toMatchObject({ dangerouslyAllow: { on: true } })

    const refused = await put(buckle, { ...policy, dangerouslyAllow: { commands: false, fileReads: false } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: expect.stringContaining('buckle policy dangerously-allow on|off') })
    expect(buckle.runtime.policy.dangerouslyAllow().on).toBe(true)
    expect(buckle.runtime.policy.stored()).toBeNull()

    const stored = await put(buckle, policy)
    expect(stored.status).toBe(200)
    expect(Object.keys((await stored.json() as { stored: object }).stored)).not.toContain('dangerouslyAllow')
    expect(buckle.runtime.policy.dangerouslyAllow().on).toBe(true)
    expect((await buckle.request('/setup/policy', { method: 'DELETE', headers: headers() })).status).toBe(200)
    expect(buckle.runtime.policy.dangerouslyAllow().on).toBe(true)

    await buckle.runtime.policy.setDangerouslyAllow(false)
    expect((await put(buckle, { ...policy, dangerouslyAllow: { commands: true, fileReads: true } })).status).toBe(409)
    expect(buckle.runtime.policy.dangerouslyAllow().on).toBe(false)
  })

  it('shows a registered workspace\'s switch without effect until the node\'s own is on', async () => {
    const buckle = await node()
    mkdirSync(join(buckle.root, 'child'))
    mkdirSync(join(buckle.root, 'other'))
    const child = { id: 'child', name: 'child', root: join(buckle.root, 'child'), authToken: 'dangerously-http-child-agent-token', adminToken: CHILD_ADMIN }
    expect((await buckle.request('/setup/workspaces', { method: 'POST', headers: headers(), body: JSON.stringify(child) })).status).toBe(201)
    // Registration cannot carry the switch in: only the local CLI sets it.
    const smuggled = await buckle.request('/setup/workspaces', { method: 'POST', headers: headers(), body: JSON.stringify({ ...child, id: 'other', root: join(buckle.root, 'other'), authToken: 'dangerously-http-other-agent-token', adminToken: 'dangerously-http-other-admin-token', policy: { ...policy, dangerouslyAllow: { commands: true, fileReads: true } } }) })
    expect(smuggled.status).toBe(409)
    const childRuntime = (await (await buckle.services.getWorkspaces()).resolve('child')).runtime
    await childRuntime.policy.setDangerouslyAllow(true)
    expect((await status(buckle, '/workspaces/child/setup/status', CHILD_ADMIN)).dangerouslyAllow).toEqual({ on: true, allowedByNode: false, effective: false, boundTo: '/workspace' })
    await buckle.runtime.policy.setDangerouslyAllow(true)
    expect((await status(buckle, '/workspaces/child/setup/status', CHILD_ADMIN)).dangerouslyAllow).toEqual({ on: true, allowedByNode: true, effective: true, boundTo: '/workspace' })
  })
})
