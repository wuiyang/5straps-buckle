import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../../common/runtime/config.js'
import { configFromEnvironment } from '../support/workspace-config.js'
import { workspaceRegistryCommand } from '../../cli/workspace.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import type { WorkspaceManager } from '../../common/services/workspaces/workspace-manager.js'
import { createCommandPolicyRule } from '../../common/domain/permission/rules/command-policy-rule.js'
import { compilePolicy } from '../../common/domain/policy.js'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'

const NODE_AGENT = 'node-agent-token-fixture'
const NODE_ADMIN = 'node-admin-credential-fixture'
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
let app: BuckleHttp
let config: BuckleConfig
let runtime: BuckleRuntime
let workspaces: WorkspaceManager
let root: string
/** Workspace one's first agent token, as registration printed it once (D83 (3)). */
let workspaceAgent: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'buckle-tokens-'))
  for (const folder of ['default', 'one']) mkdirSync(join(root, folder))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(root, 'one', 'hello.txt'), 'workspace one')
  app = await createBuckleHttp({ environment: { BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: NODE_ADMIN, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1' } })
  config = app.config
  runtime = app.runtime
  workspaces = await app.services.getWorkspaces()
})
afterEach(() => app.close())

async function register(body: Record<string, unknown> = {}): Promise<Response> {
  const response = await app.request('/setup/workspaces', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ id: 'one', name: 'Workspace one', dir: join(root, 'one'), ...body }) })
  if (response.status === 201) workspaceAgent = (await response.clone().json() as { token: { token: string } }).token.token
  return response
}

function read(token: string) {
  return app.request('/workspaces/one/v1/invoke', { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId: 'request-1', tool: 'fs_read', args: { path: '/workspace/hello.txt' } }) })
}

describe('several agent tokens per workspace', () => {
  it('runs tools with a minted token and refuses it once revoked', async () => {
    expect((await register()).status).toBe(201)

    const minted = await app.request('/setup/workspaces/one/tokens', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ label: 'second harness' }) })
    expect(minted.status).toBe(201)
    // The secret is shown once, and no cache on the way keeps it (review L9 of B15-B17).
    expect(minted.headers.get('cache-control')).toBe('no-store')
    const { token } = await minted.json() as { token: { id: string; token: string; label: string } }
    expect(token.label).toBe('second harness')

    expect((await read(token.token)).status).toBe(200)
    expect((await read(workspaceAgent)).status).toBe(200)

    expect((await app.request(`/setup/workspaces/one/tokens/${token.id}`, { method: 'DELETE', headers: headers(NODE_ADMIN) })).status).toBe(204)
    expect((await read(token.token)).status).toBe(401)
    expect((await read(workspaceAgent)).status).toBe(200)
  })

  it('lists tokens without their secrets and keeps the last one', async () => {
    await register()
    const listed = await app.request('/setup/workspaces/one/tokens', { headers: headers(NODE_ADMIN) })
    const body = await listed.text()
    expect(body).toContain('initial')
    expect(body).not.toContain(workspaceAgent)
    expect((await app.request('/setup/workspaces/one/tokens/initial', { method: 'DELETE', headers: headers(NODE_ADMIN) })).status).toBe(409)
  })

  it('mints and revokes under the admin credential alone', async () => {
    await register()
    for (const token of [NODE_AGENT, workspaceAgent]) {
      expect((await app.request('/setup/workspaces/one/tokens', { method: 'POST', headers: headers(token), body: '{}' })).status).toBe(401)
      expect((await app.request('/setup/workspaces/one/tokens/initial', { method: 'DELETE', headers: headers(token) })).status).toBe(401)
    }
  })

  // Buckle mints every agent token (D83 (3)) and keeps no admin credential per workspace: a body that brings either is refused.
  it.each([['an agent token', { authToken: 'chosen-by-the-caller-agent-token' }], ['an admin credential', { adminToken: 'chosen-by-the-caller-admin-token' }], ['a setup token', { setupToken: 'chosen-by-the-caller-setup-token' }]])('refuses a registration that brings %s', async (_label, extra) => {
    const response = await app.request('/setup/workspaces', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ id: 'one', name: 'Workspace one', dir: join(root, 'one'), ...extra }) })
    expect(response.status).toBe(400)
    expect(workspaces.known('one')).toBe(false)
  })
})

describe('buckle workspace, the owner-side registry command', () => {
  it('refuses to mint on a node with no admin credential', async () => {
    const bare = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ALLOW_SHELL: 'false' })
    expect((await workspaceRegistryCommand({ config: bare, workspaces, cwd: root, argv: ['add', join(root, 'one'), '--name', 'one'] })).exitCode).toBe(1)
  })

  it('adds a workspace, mints a second token and revokes it', async () => {
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['add', join(root, 'one'), '--name', 'one'] })).exitCode).toBe(0)
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['token', 'add', 'one', '--label', 'laptop'] })).exitCode).toBe(0)
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['token', 'list', 'one'] })).exitCode).toBe(0)
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['token', 'revoke', 'one', 'initial'] })).exitCode).toBe(0)
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['token', 'revoke', 'one', 'initial'] })).exitCode).toBe(1)
  })

  it('refuses a workspace root that overlaps the node state directory', async () => {
    expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['add', join(root, 'state'), '--name', 'one'] })).exitCode).toBe(1)
  })
})

describe('a tool never administers the Buckle that runs it', () => {
  const rule = createCommandPolicyRule(compilePolicy(emptyWorkspacePolicy()))
  const judge = (args: string[]) => rule.evaluate({ effect: { kind: 'exec', command: 'buckle', args }, tool: 'shell_exec', sessionId: 'session', approvedSubjects: [] } as never)

  it.each([['workspace', 'add', 'mine', '--root', '/tmp'], ['workspace', 'token', 'add', 'mine'], ['workspace', 'token', 'revoke', 'mine', 'initial'], ['workspaces', 'list']])('refuses buckle %s %s', (...args) => {
    expect(judge(args)).toMatchObject({ kind: 'deny' })
  })
})

describe('a registry in the pre-BUCKLE-08 shape', () => {
  const LEGACY_AGENT = 'legacy-agent-credential-fixture-value'
  const LEGACY_SETUP = 'legacy-setup-credential-fixture-value'

  // Written under a running node, which migrated its registry when it started: a file no version reads.
  beforeEach(() => {
    writeFileSync(join(root, 'state', 'workspaces.json'), JSON.stringify({ version: 1, workspaces: [{ id: 'consultation', name: 'Consultation', root: join(root, 'one'), authToken: LEGACY_AGENT, setupToken: LEGACY_SETUP, enabled: true }] }))
  })

  it('answers the registry routes with a 409 that names the file and the fields to repair, never the values', async () => {
    const response = await app.request('/setup/workspaces', { headers: headers(NODE_ADMIN) })
    expect(response.status).toBe(409)
    const { error } = await response.json() as { error: string }
    expect(error).toContain(join(root, 'state', 'workspaces.json'))
    expect(error).toContain('version')
    expect(error).toContain('workspaces.0.dir')
    expect(error).not.toContain(LEGACY_AGENT)
    expect(error).not.toContain(LEGACY_SETUP)
  })

  it('tells a caller that has not authenticated only that the registry needs repair, and audits the rejection', async () => {
    for (const [path, init, tool] of [
      ['/workspaces/consultation/v1/manifest', { headers: headers(LEGACY_AGENT) }, null],
      ['/workspaces/consultation/v1/invoke', { method: 'POST', headers: headers(LEGACY_AGENT), body: '{}' }, 'workspace_invoke_rejected'],
      ['/workspaces/anything/v1/workbenches/one', { headers: headers('a-plausible-workbench-grant-of-32-characters') }, 'workbench_auth_rejected'],
    ] as const) {
      const response = await app.request(path, init)
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({ error: 'Workspace registry needs owner repair' })
      expect(body).not.toContain(root)
      expect(body).not.toContain('workspaces.0')
      if (tool) expect(runtime.actions.read(1)[0]).toMatchObject({ tool, workspaceId: 'unresolved', outcome: 'denied', detail: 'HTTP 503' })
    }
    // A workbench path without a grant reads nothing, the registry included: the plain 401 (review L6 of B15-B17).
    expect((await app.request('/workspaces/anything/v1/workbenches/one')).status).toBe(401)
    // The admin credential is the node's (D83), checked without the registry: a caller without it learns nothing at all.
    expect((await app.request('/workspaces/anything/setup/status')).status).toBe(401)
    expect(runtime.actions.read(1)[0]).toMatchObject({ tool: 'workspace_setup_auth_rejected', workspaceId: 'unresolved', outcome: 'denied', detail: 'HTTP 401' })
  })

  it('reports the same repair from buckle workspace list', async () => {
    let stderr = ''
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
    try {
      expect((await workspaceRegistryCommand({ config, workspaces, cwd: root, argv: ['list'] })).exitCode).toBe(1)
    } finally {
      err.mockRestore()
    }
    expect(stderr).toContain('workspaces.0.dir')
  })
})

