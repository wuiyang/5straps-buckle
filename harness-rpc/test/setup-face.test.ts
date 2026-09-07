import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'

const AGENT = 'agent-token'
const SETUP = 'setup-token'

let app: Hono
let runtime: BuckleRuntime
let workspace: string
let stateDirectory: string

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'buckle-setup-ws-'))
  stateDirectory = mkdtempSync(join(tmpdir(), 'buckle-setup-state-'))
  writeFileSync(join(workspace, 'hello.txt'), 'hello\n')
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: AGENT,
    BUCKLE_SETUP_TOKEN: SETUP,
    BUCKLE_STATE_DIR: stateDirectory,
    BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_COMMAND_DENY: 'wget *',
  })
  runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  app = createHttpApp({ config, runtime, authToken: AGENT })
})

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
    const config = loadConfig({ BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_STATE_DIR: stateDirectory, BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_ALLOW_SHELL: 'false' })
    const bare = createHttpApp({ config, runtime, authToken: AGENT })
    expect((await bare.request('/setup/policy', { headers: bearer(SETUP) })).status).toBe(404)
  })

  it('refuses to be the same credential as the agent token', () => {
    expect(() => loadConfig({ BUCKLE_AUTH_TOKEN: 'same', BUCKLE_SETUP_TOKEN: 'same' })).toThrow(/must differ/)
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
    // The same three-part view as a read, so a pusher never has to read back to learn the result.
    expect(Object.keys(await put.json() as object).sort()).toEqual(['base', 'effective', 'stored'])

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
