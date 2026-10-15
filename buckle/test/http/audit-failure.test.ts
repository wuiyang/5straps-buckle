import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuckleHttp, mintedToken, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'
import { actionsPath } from '../../common/runtime/config.js'

// B19: an audit log that will not take writes refuses what it would have to record, with a 503 an agent
// may read, makes readiness 503, and still lets the owner inspect the node and refusals answer.

const AGENT = 'audit-failure-agent-token'
const ADMIN = 'audit-failure-admin-token'
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function brokenAudit(): Promise<{ buckle: BuckleHttp; state: string; workspace: string; repair: () => void }> {
  const { state, workspace, environment } = nodeEnvironment('buckle-audit-failure-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  const buckle = await createBuckleHttp({ environment })
  nodes.push(buckle)
  writeFileSync(join(workspace, 'note.md'), 'audited read')
  // The log file becomes a directory: every append fails, as on a full or read-only disk.
  const log = actionsPath(buckle.config)
  rmSync(log, { force: true })
  mkdirSync(log)
  return { buckle, state, workspace, repair: () => rmSync(log, { recursive: true }) }
}

const read = (requestId: string) => JSON.stringify({ requestId, tool: 'fs_read', args: { path: 'note.md' } })

describe('an audit log that will not take writes', () => {
  it('refuses tool calls with a path-free 503, and runs nothing', async () => {
    const { buckle, state, workspace } = await brokenAudit()
    const response = await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: JSON.stringify({ requestId: 'refused-write', tool: 'fs_write', args: { path: 'never.md', content: 'x' } }) })
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error: expect.stringContaining('cannot write its audit log') })
    expect(body).not.toContain(state)
    expect(existsSync(join(workspace, 'never.md'))).toBe(false)
    // MCP over HTTP records its transport attempt first, so it is refused the same way.
    expect((await buckle.request('/mcp', { method: 'POST', headers: { ...headers(AGENT), accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(503)
  })

  it('reports readiness 503 while liveness stays 200, and ready again once repaired, seen through readiness polls alone (review M2 of B18-B19)', async () => {
    const { buckle, repair } = await brokenAudit()
    expect((await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('first') })).status).toBe(503)
    const ready = await buckle.request('/health/ready')
    expect(ready.status).toBe(503)
    expect(await ready.json()).toEqual({ error: expect.stringContaining('audit log is unavailable') })
    expect((await buckle.request('/health')).status).toBe(200)
    // A refusal writes no entry and clears nothing.
    expect((await buckle.request('/v1/manifest', { headers: headers('not-the-agent-token') })).status).toBe(401)
    expect((await buckle.request('/health/ready')).status).toBe(503)

    repair()
    const entries = buckle.runtime.actions.read(200).length
    // No traffic but readiness polls: each may probe the log again, a few seconds apart.
    await vi.waitFor(async () => expect((await buckle.request('/health/ready')).status).toBe(200), { timeout: 10_000, interval: 250 })
    expect(buckle.runtime.actions.read(200)).toHaveLength(entries)
    const again = await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('after-repair') })
    expect(await again.json()).toMatchObject({ outcome: 'ok', output: { content: 'audited read' } })
  })

  it('keeps health per log: one workspace\'s broken log keeps the node unready however well the others write (review M2 of B18-B19)', async () => {
    const { state, root, environment } = nodeEnvironment('buckle-audit-two-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
    const buckle = await createBuckleHttp({ environment })
    nodes.push(buckle)
    mkdirSync(join(root, 'child'))
    writeFileSync(join(root, 'child', 'note.md'), 'child read')
    const child = { id: 'child', name: 'child', dir: join(root, 'child') }
    const childToken = await mintedToken(buckle.request('/setup/workspaces', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify(child) }))
    const childRead = (requestId: string) => buckle.request('/workspaces/child/v1/invoke', { method: 'POST', headers: headers(childToken), body: JSON.stringify({ requestId, tool: 'fs_read', args: { path: '/workspace/note.md' } }) })
    expect(await (await childRead('child-opens')).json()).toMatchObject({ outcome: 'ok' })
    const childLog = join(state, 'workspaces', await buckle.idOf('child'), 'actions.jsonl')
    rmSync(childLog, { force: true })
    mkdirSync(childLog)

    expect((await childRead('child-1')).status).toBe(503)
    writeFileSync(join(environment.BUCKLE_WORKSPACE_ROOT!, 'note.md'), 'node read')
    const nodeCall = await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('node-1') })
    expect(await nodeCall.json()).toMatchObject({ outcome: 'ok' })

    expect((await buckle.request('/health/ready')).status).toBe(503)
    // The node's own face names the workspace keeping it unready, and each log says when it last failed (review M4 and L5 of B20-B22).
    expect(await (await buckle.request(buckle.setup('status'), { headers: headers(ADMIN) })).json()).toMatchObject({ audit: 'available', auditLastFailureAt: null, auditFailingWorkspaces: [await buckle.idOf('child')] })
    const childStatus = await (await buckle.request('/workspaces/child/setup/status', { headers: headers(ADMIN) })).json() as Record<string, unknown>
    expect(childStatus).toMatchObject({ audit: 'unavailable', auditLastFailureAt: expect.stringMatching(/^\d{4}-/) })
    expect(Object.keys(childStatus)).not.toContain('auditFailingWorkspaces')

    rmSync(childLog, { recursive: true })
    await vi.waitFor(async () => expect((await buckle.request('/health/ready')).status).toBe(200), { timeout: 10_000, interval: 250 })
    expect(await (await buckle.request(buckle.setup('status'), { headers: headers(ADMIN) })).json()).toMatchObject({ auditFailingWorkspaces: [] })
  })

  it('stops counting a retired workspace\'s broken log toward readiness (review L5 of B20-B22)', async () => {
    const { state, root, environment } = nodeEnvironment('buckle-audit-retired-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
    const buckle = await createBuckleHttp({ environment })
    nodes.push(buckle)
    mkdirSync(join(root, 'child'))
    const child = { id: 'child', name: 'child', dir: join(root, 'child') }
    const childToken = await mintedToken(buckle.request('/setup/workspaces', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify(child) }))
    const childRead = (requestId: string) => buckle.request('/workspaces/child/v1/invoke', { method: 'POST', headers: headers(childToken), body: JSON.stringify({ requestId, tool: 'fs_list', args: { path: '/workspace' } }) })
    expect((await childRead('opens')).status).toBe(200)
    const childLog = join(state, 'workspaces', await buckle.idOf('child'), 'actions.jsonl')
    rmSync(childLog, { force: true })
    mkdirSync(childLog)
    expect((await childRead('refused')).status).toBe(503)
    expect((await buckle.request('/health/ready')).status).toBe(503)

    expect((await buckle.request('/setup/workspaces/child', { method: 'DELETE', headers: headers(ADMIN) })).status).toBe(204)
    expect((await buckle.request('/health/ready')).status).toBe(200)
    // The owner reads the retired workspace, which writes to its broken log: readiness stays (review L12 of B23-B25).
    const read = await buckle.request('/workspaces/child/setup/status', { headers: headers(ADMIN) })
    expect(read.status).toBe(200)
    expect((await buckle.request('/health/ready')).status).toBe(200)
  })

  it('answers a re-send of a call an audit failure stopped with 503, as the call itself was (review L5 of B23-B25)', async () => {
    const { environment } = nodeEnvironment('buckle-audit-resend-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_PACKS: 'fs' })
    const buckle = await createBuckleHttp({ environment })
    nodes.push(buckle)
    const stopped = { requestId: 'stopped-1', outcome: 'error' as const, error: { code: 'AUDIT_UNAVAILABLE', message: 'fixture', retryable: false } }
    vi.spyOn(buckle.runtime, 'invoke').mockResolvedValue(stopped)
    const response = await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: JSON.stringify({ requestId: 'stopped-1', tool: 'fs_list', args: { path: '.' } }) })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  })

  it('lets the owner inspect the node, refuses the owner\'s changes, and still answers refusals', async () => {
    const { buckle } = await brokenAudit()
    await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('marks-it') })

    const status = await buckle.request(buckle.setup('status'), { headers: headers(ADMIN) })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ audit: 'unavailable' })
    expect((await buckle.request('/setup/workspaces', { headers: headers(ADMIN) })).status).toBe(200)
    const change = await buckle.request(buckle.setup('policy'), { method: 'DELETE', headers: headers(ADMIN) })
    expect(change.status).toBe(503)
    expect((await buckle.request('/v1/manifest', { headers: headers('not-the-agent-token') })).status).toBe(401)
    expect((await buckle.request(buckle.setup('status'), { headers: headers('not-the-admin-token') })).status).toBe(401)
  })
})
