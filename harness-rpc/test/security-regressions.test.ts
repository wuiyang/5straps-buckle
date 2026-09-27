import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { hasExecutable } from '../common/domain/executable.js'
import { createHttpApp } from '../server/hono/http-app.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync('/tmp/buckle-security-')
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AUTH_TOKEN: 'agent-token', BUCKLE_ADMIN_TOKEN: 'owner-token' })
  const runtime = await createRuntime({ config })
  const app = createHttpApp({ config, runtime, authToken: config.authToken })
  return { root, workspace, config, runtime, app }
}

const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

describe('owner approval authority', () => {
  it('refuses agent decisions and accepts only the setup credential', async () => {
    const { runtime, app } = await fixture()
    const [approval] = await runtime.approvals.issue({ tool: 'fs_read', sessionId: 'read-session', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/synthetic', reason: 'outside', offeredScopes: ['session'] }] })
    const body = JSON.stringify({ token: approval!.token, approved: true, scope: 'session' })
    expect((await app.request('/setup/approvals', { method: 'POST', headers: headers('agent-token'), body })).status).toBe(401)
    expect((await app.request('/v1/approvals', { method: 'POST', headers: headers('agent-token'), body })).status).toBe(404)
    expect(runtime.grants.activeSubjects({ sessionId: 'read-session', rule: 'read_scope' })).toEqual([])
    expect((await app.request('/setup/approvals', { method: 'POST', headers: headers('owner-token'), body })).status).toBe(200)
    expect(runtime.grants.activeSubjects({ sessionId: 'read-session', rule: 'read_scope' })).toEqual(['/synthetic'])
  })

  it('does not expose standing grants to the agent credential', async () => {
    const { app } = await fixture()
    expect((await app.request('/setup/grants', { headers: headers('agent-token') })).status).toBe(401)
    expect((await app.request('/setup/grants', { headers: headers('owner-token') })).status).toBe(200)
  })
})

// fs_search_content is only registered when a real ripgrep binary is on PATH, so on a host
// without one this block would fail with "Unknown tool" and prove nothing. Skipping keeps the
// skip visible in the run summary. To run it here, put a ripgrep binary on PATH first.
describe.skipIf(!hasExecutable('rg'))('recursive credential search', () => {
  it('searches permitted content but excludes protected credentials before reading', async () => {
    const { runtime, workspace } = await fixture()
    writeFileSync(join(workspace, 'credentials.json'), '{"synthetic":"private-marker"}')
    writeFileSync(join(workspace, 'readme.txt'), 'public-marker')
    const invoke = (tool: string, args: Record<string, string>) => runtime.invoke({ request: { requestId: crypto.randomUUID(), tool, args, approvalTokens: [] }, sessionId: 'search-session' })
    expect((await invoke('fs_read', { path: 'credentials.json' })).outcome).toBe('approval_required')
    const response = await invoke('fs_search_content', { path: '.', pattern: 'marker' })
    expect(response.outcome).toBe('ok')
    expect(JSON.stringify(response)).toContain('public-marker')
    expect(JSON.stringify(response)).not.toContain('private-marker')
    expect(JSON.stringify(response)).toContain('excludedFiles')
    await runtime.grants.grant({ sessionId: 'search-session', rule: 'sensitive_path', subject: join(workspace, 'credentials.json'), scope: 'session' })
    expect(JSON.stringify(await invoke('fs_search_content', { path: '.', pattern: 'marker' }))).not.toContain('private-marker')
  })

  it('never searches runtime state even when it sits inside the search root', async () => {
    const { runtime, root } = await fixture()
    await runtime.grants.grant({ sessionId: 'search-session', rule: 'read_scope', subject: root, scope: 'session' })
    const response = await runtime.invoke({ request: { requestId: 'state-search', tool: 'fs_search_content', args: { path: root, pattern: 'read_scope' }, approvalTokens: [] }, sessionId: 'search-session' })
    expect(response.outcome).toBe('ok')
    if (response.outcome === 'ok') expect(response.output).toMatchObject({ matches: [] })
  })
})

describe('owner filesystem restore', () => {
  it('journals a real tool mutation and refuses agent access to restore history', async () => {
    const { workspace, runtime, app } = await fixture()
    await runtime.grants.grant({ sessionId: 'writer', rule: 'write_scope', subject: workspace, scope: 'session' })
    const response = await runtime.invoke({ sessionId: 'writer', request: { requestId: 'write-change', tool: 'fs_write', args: { path: 'created.txt', content: 'synthetic content' }, approvalTokens: [], context: { stageId: 'message-edit' } } })
    expect(response.outcome).toBe('ok')
    const [checkpoint] = await runtime.history.list()
    expect(checkpoint?.stageId).toBe('message-edit')
    expect(checkpoint?.paths).toContain(join(workspace, 'created.txt'))
    expect((await app.request('/setup/history', { headers: headers('agent-token') })).status).toBe(401)
    expect((await app.request(`/setup/history/${checkpoint!.id}/restore`, { method: 'POST', headers: headers('agent-token') })).status).toBe(401)
    expect((await app.request(`/setup/history/${checkpoint!.id}/restore`, { method: 'POST', headers: headers('owner-token') })).status).toBe(200)
    expect(await runtime.history.list()).toHaveLength(2)
  })
})
