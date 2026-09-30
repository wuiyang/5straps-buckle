import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../common/runtime/config.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

const AGENT = 'agent-token'
const SETUP = 'setup-token'

let app: BuckleHttp
let runtime: BuckleRuntime
let workspace: string
let stateDirectory: string
const nodes: BuckleHttp[] = []

// A gated call over HTTP answers approval_required within a millisecond: a grace period of 1 ms (0 would wait until answered).
function environment(extra: Record<string, string> = {}): Record<string, string> {
  return { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_STATE_DIR: stateDirectory, BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra }
}

async function node(extra: Record<string, string> = {}): Promise<BuckleHttp> {
  const started = await createBuckleHttp({ environment: environment(extra) })
  nodes.push(started)
  return started
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'buckle-setup-ws-'))
  stateDirectory = mkdtempSync(join(tmpdir(), 'buckle-setup-state-'))
  writeFileSync(join(workspace, 'hello.txt'), 'hello\n')
  app = await node({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: SETUP, BUCKLE_COMMAND_DENY: 'wget *' })
  runtime = app.runtime
})
afterEach(async () => { for (const started of nodes.splice(0)) await started.close() })

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function invoke(tool: string, args: Record<string, unknown>) {
  const response = await app.request('/v1/invoke', {
    method: 'POST',
    headers: bearer(AGENT),
    body: JSON.stringify({ requestId: 'r', tool, args, approvalTokens: [] }),
  })
  return await response.json() as { outcome: string; output?: Record<string, unknown>; error?: { code: string; message: string } }
}

describe('who may open the setup face', () => {
  it('refuses the agent token, a missing token, and a wrong token', async () => {
    expect((await app.request('/setup/policy', { headers: bearer(AGENT) })).status).toBe(401)
    expect((await app.request('/setup/policy')).status).toBe(401)
    expect((await app.request('/setup/policy', { headers: bearer('nope') })).status).toBe(401)
  })

  it('admits the setup token there and nowhere else', async () => {
    expect((await app.request('/setup/policy', { headers: bearer(SETUP) })).status).toBe(200)
    expect((await app.request('/v1/manifest', { headers: bearer(SETUP) })).status).toBe(401)
  })

  it('is absent altogether when no setup token is configured', async () => {
    const bare = await node()
    expect((await bare.request('/setup/policy', { headers: bearer(SETUP) })).status).toBe(404)
  })

  it('refuses to be the same credential as the agent token', () => {
    expect(() => loadConfig({ BUCKLE_AUTH_TOKEN: 'same', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'same' })).toThrow(/must differ/)
  })

  it('uses only the current admin credential setting', () => {
    expect(loadConfig({ BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_SETUP_TOKEN: SETUP }).adminToken).toBe('')
    expect(loadConfig({ BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: SETUP }).adminToken).toBe(SETUP)
  })
})

describe('pushing a policy', () => {
  it('reports the environment share and the stored share apart, unioned as effective', async () => {
    const put = await app.request('/setup/policy', {
      method: 'PUT',
      headers: bearer(SETUP),
      body: JSON.stringify({ version: 1, network: { allow: ['example.com'] }, commands: { deny: ['curl *'] } }),
    })
    expect(put.status).toBe(200)
    // Writes return the same policy view as reads.
    expect(Object.keys(await put.json() as object).sort()).toEqual(['base', 'ceiling', 'dangerouslyAllow', 'effective', 'revision', 'stored'])

    const body = await (await app.request('/setup/policy', { headers: bearer(SETUP) })).json() as {
      base: { commands: { deny: string[] } }
      stored: { commands: { deny: string[] }; updatedAt: string | null }
      effective: { commands: { deny: string[] }; network: { allow: string[] } }
    }
    expect(body.base.commands.deny).toEqual(['wget *'])
    expect(body.stored.commands.deny).toEqual(['curl *'])
    expect(body.stored.updatedAt).not.toBeNull()
    expect(body.effective.commands.deny).toEqual(['wget *', 'curl *'])
    expect(body.effective.network.allow).toEqual(['example.com'])
  })

  it('takes effect on the next call without a restart', async () => {
    await app.request('/setup/policy', {
      method: 'PUT',
      headers: bearer(SETUP),
      body: JSON.stringify({ version: 1, network: { allow: ['example.com'] } }),
    })
    const refused = await invoke('web_fetch', { url: 'https://other.test/' })
    expect(refused.outcome).toBe('error')
    expect(refused.error?.code).toBe('PERMISSION_DENIED')
    expect(refused.error?.message).toContain('approved list')
  })

  it('refuses a regular expression before storing anything', async () => {
    const put = await app.request('/setup/policy', {
      method: 'PUT',
      headers: bearer(SETUP),
      body: JSON.stringify({ version: 1, commands: { allow: ['^pnpm (build|test)'] } }),
    })
    expect(put.status).toBe(400)
    expect(runtime.policy.stored()).toBeNull()
  })

  it('can be cleared, which leaves the environment share standing', async () => {
    await app.request('/setup/policy', { method: 'PUT', headers: bearer(SETUP), body: JSON.stringify({ version: 1, commands: { deny: ['curl'] } }) })
    const cleared = await app.request('/setup/policy', { method: 'DELETE', headers: bearer(SETUP) })
    expect(cleared.status).toBe(200)
    expect(runtime.policy.effective().commands.deny).toEqual(['wget *'])
  })
})

describe('mounting the workspace', () => {
  beforeEach(async () => {
    await app.request('/setup/policy', { method: 'PUT', headers: bearer(SETUP), body: JSON.stringify({ version: 1, mount: '/workspace' }) })
  })

  it('is what the manifest now names as the workspace', async () => {
    const manifest = await (await app.request('/v1/manifest', { headers: bearer(AGENT) })).json() as { workspaceRoots: string[] }
    expect(manifest.workspaceRoots[0]).toBe('/workspace')
  })

  it('lets the agent name files under the mount and see them relative', async () => {
    const read = await invoke('fs_read', { path: '/workspace/hello.txt' })
    expect(read.outcome).toBe('ok')
    expect(read.output?.path).toBe('hello.txt')
    expect(read.output?.content).toBe('hello\n')
  })

  it('refuses a read elsewhere outright, with no approval on offer', async () => {
    const outside = await invoke('fs_read', { path: '/etc/hostname' })
    expect(outside.outcome).toBe('error')
    expect(outside.error?.code).toBe('PERMISSION_DENIED')
  })

  it('names the mount, not the real root, when it refuses', async () => {
    const outside = await invoke('fs_read', { path: '/etc/hostname' })
    expect(outside.error?.message).toContain('/workspace')
    expect(outside.error?.message).not.toContain(workspace)
  })

  it('records the refusal as a denial, so it is as visible in the log as a run', async () => {
    await invoke('fs_read', { path: '/etc/hostname' })
    expect(runtime.actions.read(1)[0]?.outcome).toBe('denied')
  })
})

describe("Buckle's own state", () => {
  it('is refused to every tool, with no approval on offer', async () => {
    const read = await invoke('fs_read', { path: join(stateDirectory, 'policy.json') })
    expect(read.outcome).toBe('error')
    expect(read.error?.code).toBe('PERMISSION_DENIED')
    expect(read.error?.message).toContain('not reachable')
  })
})

describe('workspace audit inspection', () => {
  it('records attempt and result while hiding content and restricting reads to setup', async () => {
    await invoke('fs_read', { path: 'hello.txt' })
    expect((await app.request('/setup/audit', { headers: bearer(AGENT) })).status).toBe(401)
    const response = await app.request('/setup/audit?limit=20', { headers: bearer(SETUP) })
    const body = await response.json() as { entries: Array<{ event: string; auditId: string; workspaceId: string; tool: string }> }
    const toolEntries = body.entries.filter(item => item.tool === 'fs_read')
    expect(toolEntries.map(item => item.event)).toEqual(['result', 'attempt'])
    expect(toolEntries[0]?.auditId).toBe(toolEntries[1]?.auditId)
    expect(body.entries.every(item => item.workspaceId === 'default')).toBe(true)
    expect(JSON.stringify(body)).not.toContain('hello.txt')
    expect((await app.request('/setup/audit?limit=9999', { headers: bearer(SETUP) })).status).toBe(400)
  })

  it('does not execute a tool if the attempt cannot be persisted', async () => {
    const before = runtime.actions.read(200).length
    runtime.actions.record = () => { throw new Error('Audit storage unavailable') }
    const response = await app.request('/v1/invoke', { method: 'POST', headers: bearer(AGENT), body: JSON.stringify({ requestId: 'audit-failed', tool: 'fs_write', args: { path: 'new.txt', content: 'must not be written' } }) })
    expect(response.status).toBe(500)
    expect(runtime.actions.read(200)).toHaveLength(before)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
  })

  it('does not execute a cleared tool when the attempt write is still pending and then fails', async () => {
    // Cleared to run: only the failed attempt record can stop the write.
    await runtime.grants.grant({ sessionId: 'any', rule: 'write_scope', subject: workspace, scope: 'always' })
    const before = runtime.actions.read(200).length
    runtime.actions.record = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      throw new Error('Audit storage unavailable')
    }
    const response = await app.request('/v1/invoke', { method: 'POST', headers: bearer(AGENT), body: JSON.stringify({ requestId: 'audit-failed-later', tool: 'fs_write', args: { path: 'late.txt', content: 'must not be written' } }) })
    expect(response.status).toBe(500)
    expect(runtime.actions.read(200)).toHaveLength(before)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(workspace, 'late.txt'))).toBe(false)
  })
})

describe('audit coverage outside tool execution', () => {
  it('records rejected RPC requests without storing supplied payload or credentials', async () => {
    const response = await app.request('/v1/invoke', { method: 'POST', headers: bearer('not-authorized-secret'), body: JSON.stringify({ secret: 'private-payload' }) })
    expect(response.status).toBe(401)
    const entries = runtime.actions.read(20)
    expect(entries.at(-1)).toMatchObject({ tool: 'rpc_invoke_rejected', outcome: 'denied' })
    expect(JSON.stringify(entries)).not.toContain('private-payload')
    expect(JSON.stringify(entries)).not.toContain('not-authorized-secret')
  })

  it('records setup changes and audit inspection', async () => {
    await app.request('/setup/policy', { method: 'PUT', headers: bearer(SETUP), body: JSON.stringify({ version: 1, commands: { deny: ['curl *'] } }) })
    const changes = runtime.actions.read(20).filter(entry => entry.tool === 'setup_put_policy')
    expect(changes.map(entry => entry.event)).toEqual(['attempt', 'result'])
    expect(changes[0]?.auditId).toBe(changes[1]?.auditId)
    await app.request('/setup/audit', { headers: bearer(SETUP) })
    expect(runtime.actions.read(1)[0]).toMatchObject({ tool: 'setup_get_audit', outcome: 'ok' })
  })
})

it('persists project and agent correlation without changing authorization', async () => {
  await app.request('/v1/invoke', { method: 'POST', headers: bearer(AGENT), body: JSON.stringify({
    requestId: 'correlated-call', tool: 'fs_read', args: { path: 'hello.txt' },
    context: { sessionId: 'session-fixture', chatId: 'chat-fixture', projectId: 'project-fixture', actorId: 'owner-fixture', agentId: 'agent-fixture' },
  }) })
  // GPT review of c71dee5 (requester attribution): the claimed requester sits beside the authenticated actor, never in its place.
  expect(runtime.actions.read(1)[0]).toMatchObject({ chatId: 'chat-fixture', projectId: 'project-fixture', agentId: 'agent-fixture', actorId: expect.stringMatching(/^agent:/), actorTrust: 'authenticated', claimedActorId: 'owner-fixture', claimedActorTrust: 'claimed' })
})

it('records the authenticated agent as the actor of a call that forges another requester, and of one that names none', async () => {
  const send = (requestId: string, context?: object) => app.request('/v1/invoke', { method: 'POST', headers: bearer(AGENT), body: JSON.stringify({ requestId, tool: 'fs_read', args: { path: 'hello.txt' }, ...(context ? { context } : {}) }) })
  await send('forged-requester', { actorId: 'agent:someone-else' })
  await send('no-requester')
  const results = runtime.actions.read(20).filter(entry => entry.tool === 'fs_read' && entry.event === 'result')
  const forged = results.find(entry => entry.requestId === 'forged-requester')!
  const unclaimed = results.find(entry => entry.requestId === 'no-requester')!
  expect(forged).toMatchObject({ actorTrust: 'authenticated', claimedActorId: 'agent:someone-else', claimedActorTrust: 'claimed' })
  expect(forged.actorId).toMatch(/^agent:/)
  expect(forged.actorId).not.toBe('agent:someone-else')
  expect(unclaimed).toMatchObject({ actorId: forged.actorId, actorTrust: 'authenticated' })
  expect(unclaimed).not.toHaveProperty('claimedActorId')
})

it('records MCP transport failures and setup authentication rejection without submitted secrets', async () => {
  expect((await app.request('/mcp', { method: 'POST', headers: bearer('wrong-private-token'), body: JSON.stringify({ secret: 'private-content' }) })).status).toBe(401)
  await app.request('/setup/policy', { headers: bearer('wrong-private-token') })
  const entries = runtime.actions.read(20)
  expect(entries.some(entry => entry.tool === 'http_mcp_post' && entry.outcome === 'denied')).toBe(true)
  expect(entries.some(entry => entry.tool === 'setup_auth_rejected')).toBe(true)
  expect(JSON.stringify(entries)).not.toContain('wrong-private-token')
  expect(JSON.stringify(entries)).not.toContain('private-content')
})
