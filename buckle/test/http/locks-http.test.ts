import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { holdLockInProcess, killHolder } from '../support/lock-holder.js'
import { nodeEnvironment } from '../support/node-environment.js'

const holders: ChildProcess[] = []
const nodes: BuckleHttp[] = []
afterEach(async () => {
  for (const holder of holders.splice(0)) if (holder.exitCode === null && holder.signalCode === null) await killHolder(holder)
  for (const node of nodes.splice(0)) await node.close()
})

describe('a state file busy past the wait, over HTTP', () => {
  it('answers the owner\'s route 503 with the reason, which names the state file', async () => {
    const { state, environment } = nodeEnvironment('buckle-locks-http-', { BUCKLE_AUTH_TOKEN: 'busy-agent-token-fixture', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'busy-admin-token-fixture', BUCKLE_PACKS: 'fs' })
    // A short wait, so the busy answer is tested without the real five seconds.
    const buckle = await createBuckleHttp({ environment, configure: (config) => { config.stateLockDeadlineMs = 300 } })
    nodes.push(buckle)
    const grant = await buckle.runtime.grants.grant({ sessionId: 's', rule: 'read_scope', subject: '/shots', scope: 'always' })
    holders.push(await holdLockInProcess(join(state, 'workspaces', buckle.runtime.workspaceId, 'grants.json.lock.sqlite')))

    const response = await buckle.request(buckle.setup(`grants/${grant.id}`), { method: 'DELETE', headers: { authorization: 'Bearer busy-admin-token-fixture' } })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: expect.stringContaining('is busy in another Buckle process') })
    expect(buckle.runtime.actions.read(5)).toContainEqual(expect.objectContaining({ tool: 'setup_delete_grants', event: 'result', outcome: 'error', detail: 'HTTP 503' }))
  })
})

describe('busy audit state while the invoke attempt is recorded (review L3 of B15-B17)', () => {
  it('answers the agent 503 with the fixed busy text, which names no path, and runs nothing', async () => {
    const { state, workspace, environment } = nodeEnvironment('buckle-locks-audit-', { BUCKLE_AUTH_TOKEN: 'busy-agent-token-fixture', BUCKLE_PACKS: 'fs' })
    const buckle = await createBuckleHttp({ environment, configure: (config) => { config.stateLockDeadlineMs = 300 } })
    nodes.push(buckle)
    holders.push(await holdLockInProcess(join(state, 'workspaces', buckle.runtime.workspaceId, 'actions.jsonl.pending.json.lock.sqlite')))

    const response = await buckle.request('/v1/invoke', { method: 'POST', headers: { authorization: 'Bearer busy-agent-token-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'busy-1', tool: 'fs_write', args: { path: 'never.md', content: 'x' } }) })

    expect(response.status).toBe(503)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error: 'Buckle state is busy in another process; retry shortly' })
    expect(body).not.toContain(state)
    expect(existsSync(join(workspace, 'never.md'))).toBe(false)
  })
})

describe('a refusal while the audit state is busy (review L7 of B20-B22)', () => {
  it('answers a wrong credential 401 on the owner\'s face, /v1/invoke and /mcp, never 500, though its entry cannot be written', async () => {
    const { state, environment } = nodeEnvironment('buckle-locks-refusal-', { BUCKLE_AUTH_TOKEN: 'busy-agent-token-fixture', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'busy-admin-token-fixture', BUCKLE_PACKS: 'fs' })
    const buckle = await createBuckleHttp({ environment, configure: (config) => { config.stateLockDeadlineMs = 300 } })
    nodes.push(buckle)
    holders.push(await holdLockInProcess(join(state, 'workspaces', buckle.runtime.workspaceId, 'actions.jsonl.pending.json.lock.sqlite')))
    const wrong = { authorization: 'Bearer wrong-token-fixture-only-000000', 'content-type': 'application/json' }
    for (const [path, method] of [[buckle.setup('status'), 'GET'], [buckle.setup('policy'), 'PUT'], ['/v1/invoke', 'POST'], ['/mcp', 'POST'], ['/workspaces/workspace/setup/status', 'GET']] as const) {
      const response = await buckle.request(path, { method, headers: wrong, ...(method === 'GET' ? {} : { body: '{}' }) })
      expect({ path, status: response.status }).toEqual({ path, status: 401 })
    }
  })
})

