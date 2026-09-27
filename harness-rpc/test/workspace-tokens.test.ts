import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig, type BuckleConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { workspaceRegistryCommand } from '../src/faces/cli/workspace.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'
import { createCommandPolicyRule } from '../src/domain/permission/rules/command-policy-rule.js'
import { compilePolicy } from '../src/domain/policy.js'
import { emptyWorkspacePolicy } from '@5straps/protocol'

const NODE_AGENT = 'node-agent-token-fixture'
const NODE_ADMIN = 'node-admin-credential-fixture'
const WORKSPACE_AGENT = 'workspace-agent-token-fixture-only'
const WORKSPACE_ADMIN = 'workspace-admin-credential-fixture-only'
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
let app: Hono
let config: BuckleConfig
let runtime: BuckleRuntime
let root: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'buckle-tokens-'))
  for (const folder of ['default', 'one', 'state']) mkdirSync(join(root, folder))
  writeFileSync(join(root, 'one', 'hello.txt'), 'workspace one')
  config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ADMIN_TOKEN: NODE_ADMIN, BUCKLE_ALLOW_SHELL: 'false' })
  runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  app = createHttpApp({ config, runtime, authToken: NODE_AGENT })
})

function register(body: Record<string, unknown> = {}) {
  return app.request('/setup/workspaces', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ id: 'one', name: 'Workspace one', root: join(root, 'one'), authToken: WORKSPACE_AGENT, adminToken: WORKSPACE_ADMIN, ...body }) })
}

function read(token: string) {
  return app.request('/workspaces/one/v1/invoke', { method: 'POST', headers: headers(token), body: JSON.stringify({ requestId: 'request-1', tool: 'fs_read', args: { path: '/workspace/hello.txt' } }) })
}

describe('several agent tokens per workspace', () => {
  it('runs tools with a minted token and refuses it once revoked', async () => {
    expect((await register()).status).toBe(201)

    const minted = await app.request('/setup/workspaces/one/tokens', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ label: 'second harness' }) })
    expect(minted.status).toBe(201)
    const { token } = await minted.json() as { token: { id: string; token: string; label: string } }
    expect(token.label).toBe('second harness')

    expect((await read(token.token)).status).toBe(200)
    expect((await read(WORKSPACE_AGENT)).status).toBe(200)

    expect((await app.request(`/setup/workspaces/one/tokens/${token.id}`, { method: 'DELETE', headers: headers(NODE_ADMIN) })).status).toBe(204)
    expect((await read(token.token)).status).toBe(401)
    expect((await read(WORKSPACE_AGENT)).status).toBe(200)
  })

  it('lists tokens without their secrets and keeps the last one', async () => {
    await register()
    const listed = await app.request('/setup/workspaces/one/tokens', { headers: headers(NODE_ADMIN) })
    const body = await listed.text()
    expect(body).toContain('initial')
    expect(body).not.toContain(WORKSPACE_AGENT)
    expect((await app.request('/setup/workspaces/one/tokens/initial', { method: 'DELETE', headers: headers(NODE_ADMIN) })).status).toBe(409)
  })

  it('mints and revokes under the admin credential alone', async () => {
    await register()
    for (const token of [NODE_AGENT, WORKSPACE_AGENT, WORKSPACE_ADMIN]) {
      expect((await app.request('/setup/workspaces/one/tokens', { method: 'POST', headers: headers(token), body: '{}' })).status).toBe(401)
      expect((await app.request('/setup/workspaces/one/tokens/initial', { method: 'DELETE', headers: headers(token) })).status).toBe(401)
    }
  })

  it('refuses a registration that names the admin credential setupToken', async () => {
    const response = await app.request('/setup/workspaces', { method: 'POST', headers: headers(NODE_ADMIN), body: JSON.stringify({ id: 'one', name: 'Workspace one', root: join(root, 'one'), authToken: WORKSPACE_AGENT, setupToken: WORKSPACE_ADMIN }) })
    expect(response.status).toBe(400)
    expect((await app.request('/workspaces/one/setup/status', { headers: headers(WORKSPACE_ADMIN) })).status).toBe(401)
  })
})

describe('buckle workspace, the owner-side registry command', () => {
  it('refuses to mint on a node with no admin credential', async () => {
    const bare = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: NODE_AGENT, BUCKLE_ALLOW_SHELL: 'false' })
    expect(workspaceRegistryCommand({ config: bare, runtime, argv: ['add', 'one', '--root', join(root, 'one')] }).exitCode).toBe(1)
  })

  it('adds a workspace, mints a second token and revokes it', () => {
    expect(workspaceRegistryCommand({ config, runtime, argv: ['add', 'one', '--root', join(root, 'one')] }).exitCode).toBe(0)
    expect(workspaceRegistryCommand({ config, runtime, argv: ['token', 'add', 'one', '--label', 'laptop'] }).exitCode).toBe(0)
    expect(workspaceRegistryCommand({ config, runtime, argv: ['token', 'list', 'one'] }).exitCode).toBe(0)
    expect(workspaceRegistryCommand({ config, runtime, argv: ['token', 'revoke', 'one', 'initial'] }).exitCode).toBe(0)
    expect(workspaceRegistryCommand({ config, runtime, argv: ['token', 'revoke', 'one', 'initial'] }).exitCode).toBe(1)
  })

  it('refuses a workspace root that overlaps the node state directory', () => {
    expect(workspaceRegistryCommand({ config, runtime, argv: ['add', 'one', '--root', join(root, 'state')] }).exitCode).toBe(1)
  })
})

describe('a tool never administers the Buckle that runs it', () => {
  const rule = createCommandPolicyRule(compilePolicy(emptyWorkspacePolicy()))
  const judge = (args: string[]) => rule.evaluate({ effect: { kind: 'exec', command: 'buckle', args }, tool: 'shell_exec', sessionId: 'session', approvedSubjects: [] } as never)

  it.each([['workspace', 'add', 'mine', '--root', '/tmp'], ['workspace', 'token', 'add', 'mine'], ['workspace', 'token', 'revoke', 'mine', 'initial'], ['workspaces', 'list']])('refuses buckle %s %s', (...args) => {
    expect(judge(args)).toMatchObject({ kind: 'deny' })
  })
})
