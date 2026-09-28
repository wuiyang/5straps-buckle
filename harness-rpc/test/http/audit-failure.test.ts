import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

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
  const { state, workspace, environment } = nodeEnvironment('buckle-audit-failure-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_PACKS: 'fs' })
  const buckle = await createBuckleHttp({ environment })
  nodes.push(buckle)
  writeFileSync(join(workspace, 'note.md'), 'audited read')
  // The log file becomes a directory: every append fails, as on a full or read-only disk.
  const log = join(state, 'actions.jsonl')
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

  it('reports readiness 503 while liveness stays 200, and ready again once a write succeeds', async () => {
    const { buckle, repair } = await brokenAudit()
    expect((await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('first') })).status).toBe(503)
    const ready = await buckle.request('/health/ready')
    expect(ready.status).toBe(503)
    expect(await ready.json()).toEqual({ error: expect.stringContaining('audit log is unavailable') })
    expect((await buckle.request('/health')).status).toBe(200)

    repair()
    const again = await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('after-repair') })
    expect(await again.json()).toMatchObject({ outcome: 'ok', output: { content: 'audited read' } })
    expect((await buckle.request('/health/ready')).status).toBe(200)
  })

  it('lets the owner inspect the node, refuses the owner\'s changes, and still answers refusals', async () => {
    const { buckle } = await brokenAudit()
    await buckle.request('/v1/invoke', { method: 'POST', headers: headers(AGENT), body: read('marks-it') })

    const status = await buckle.request('/setup/status', { headers: headers(ADMIN) })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ audit: 'unavailable' })
    expect((await buckle.request('/setup/workspaces', { headers: headers(ADMIN) })).status).toBe(200)
    const change = await buckle.request('/setup/policy', { method: 'DELETE', headers: headers(ADMIN) })
    expect(change.status).toBe(503)
    expect((await buckle.request('/v1/manifest', { headers: headers('not-the-agent-token') })).status).toBe(401)
    expect((await buckle.request('/setup/status', { headers: headers('not-the-admin-token') })).status).toBe(401)
  })
})
