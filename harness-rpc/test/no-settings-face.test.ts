import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createMcpServer } from '../src/faces/mcp/server.js'
import { createRuntime } from '../src/runtime.js'

/**
 * `BUCKLE-D19`: node settings are the owner's CLI writing the environment file. No HTTP route
 * (the RPC face in `faces/rpc/app.ts`, the setup face in `faces/setup/app.ts`, the workspace and
 * workbench faces in `faces/workspace-app.ts` and `faces/workbench-app.ts`, mounted together by
 * `faces/http-app.ts`) and no MCP tool may read or change them.
 */
const SETTINGS_WORDS = /settings|environment|env\b|\.env|config/i

async function node() {
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: 'agent-token-fixture',
    BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-no-settings-state-')),
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-no-settings-ws-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  return { config, runtime }
}

describe('no face exposes node settings', () => {
  it('mounts no HTTP route that names settings, the environment or config, setup face included', async () => {
    const { config, runtime } = await node()
    const app = createHttpApp({ config, runtime, authToken: config.authToken })
    const paths = app.routes.map(route => route.path)

    expect(paths.some(path => path.startsWith('/setup'))).toBe(true)
    expect(paths.filter(path => SETTINGS_WORDS.test(path))).toEqual([])
  })

  it('answers no settings path on the setup face, even to the admin credential', async () => {
    const { config, runtime } = await node()
    const app = createHttpApp({ config, runtime, authToken: config.authToken })
    const headers = { authorization: 'Bearer admin-token-fixture', 'content-type': 'application/json' }

    for (const path of ['/setup/settings', '/setup/env', '/setup/config']) {
      expect((await app.request(path, { headers })).status).toBe(404)
      expect((await app.request(path, { method: 'PUT', headers, body: '{}' })).status).toBe(404)
    }
  })

  it('registers no MCP tool that reads or writes settings', async () => {
    const { runtime } = await node()
    const server = createMcpServer({ runtime, serverName: 'no-settings', version: '0.0.0' })
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter(name => SETTINGS_WORDS.test(name))).toEqual([])
    await server.close()
  })

  it('keeps the settings writer out of every face but the CLI', () => {
    const faces = join(import.meta.dirname, '../src/faces')
    const sources = walk(faces).filter(path => !path.startsWith(join(faces, 'cli')))

    expect(sources.length).toBeGreaterThan(5)
    for (const path of sources) expect(readFileSync(path, 'utf8'), path).not.toMatch(/cli\/(settings|node-settings|environment-file)\.js/)
  })
})

describe('the manifest an agent token reads', () => {
  it('reports withheld packs in fixed text, naming the setting behind a built-in one and never a configured path or a plugin error', async () => {
    const state = mkdtempSync(join(tmpdir(), 'buckle-manifest-state-'))
    writeFileSync(join(state, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'broken', specifier: '/opt/private-fixture/plugins/broken.mjs', enabled: true }] }))
    const config = loadConfig({
      BUCKLE_AUTH_TOKEN: 'agent-token-fixture',
      BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
      BUCKLE_STATE_DIR: state,
      BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-manifest-ws-')),
      BUCKLE_ALLOW_SHELL: 'false',
      BUCKLE_AGENT_BROWSER_COMMAND: '/opt/private-fixture/bin/agent-browser',
    })
    const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
    const app = createHttpApp({ config, runtime, authToken: config.authToken })

    const response = await app.request('/v1/manifest', { headers: { authorization: 'Bearer agent-token-fixture' } })
    const body = await response.text()
    const reasons = Object.fromEntries((JSON.parse(body) as { packs: Array<{ id: string; unavailableReason: string | null }> }).packs.map(pack => [pack.id, pack.unavailableReason]))

    expect(response.status).toBe(200)
    expect(body).not.toContain('/opt/private-fixture')
    expect(reasons.broken).toBe('The plugin failed to load; the node\'s log has the error')
    expect(reasons.browser).toBe('agent-browser is not installed on this node, or BUCKLE_AGENT_BROWSER_COMMAND does not name it')
    expect(reasons.shell).toContain('BUCKLE_ALLOW_SHELL=false')
  })
})

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
  })
}
