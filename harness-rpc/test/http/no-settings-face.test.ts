import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintApprovalKey } from '@5straps/protocol/envelope'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '../../mcp/server.js'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { PACKAGE_ROOT, sourceFiles } from '../support/sources.js'

/**
 * `BUCKLE-D19`: node settings are the owner's CLI writing the environment file. No HTTP route (the
 * file routes of layers/common, layers/mcp and layers/admin) and no MCP tool may read or change them.
 */
const SETTINGS_WORDS = /settings|environment|env\b|\.env|config/i

const nodes: BuckleHttp[] = []
afterEach(async () => { for (const started of nodes.splice(0)) await started.close() })

async function served(environment: Record<string, string>, prepare?: (state: string) => void): Promise<BuckleHttp> {
  const state = mkdtempSync(join(tmpdir(), 'buckle-no-settings-state-'))
  prepare?.(state)
  const started = await createBuckleHttp({ environment: { BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', ...environment } })
  nodes.push(started)
  return started
}

function node(): Promise<BuckleHttp> {
  return served({ BUCKLE_AUTH_TOKEN: 'agent-token-fixture', BUCKLE_ADMIN_TOKEN: 'admin-token-fixture', BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-no-settings-ws-')) })
}

describe('no face exposes node settings', () => {
  it('mounts no HTTP route that names settings, the environment or config, setup face included', async () => {
    const buckle = await node()
    const paths = buckle.routes().map(route => route.path)

    expect(paths.some(path => path.startsWith('/setup'))).toBe(true)
    expect(paths.some(path => path.startsWith('/v1'))).toBe(true)
    expect(paths.filter(path => SETTINGS_WORDS.test(path))).toEqual([])
  })

  it('answers no settings path on the setup face, even to the admin credential', async () => {
    const buckle = await node()
    const headers = { authorization: 'Bearer admin-token-fixture', 'content-type': 'application/json' }

    for (const path of ['/setup/settings', '/setup/env', '/setup/config']) {
      expect((await buckle.request(path, { headers })).status).toBe(404)
      expect((await buckle.request(path, { method: 'PUT', headers, body: '{}' })).status).toBe(404)
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

  it('keeps the settings writer and the environment reader out of everything but the CLI and its entry point', () => {
    const sources = sourceFiles('common', 'mcp', 'server', 'layers')
    const runtime = join(PACKAGE_ROOT, 'common/runtime')

    expect(sources.length).toBeGreaterThan(20)
    // Any specifier naming them, static or dynamic, with or without an extension (review L6 of B13-B14).
    for (const path of sources) expect(readFileSync(path, 'utf8'), path).not.toMatch(/cli\/(?:settings|node-settings|environment-file)(?:\.[jt]s)?['"]/)
    // The reader sits in common/runtime for main and the CLI; no face or service may reach it.
    for (const path of sources.filter(path => !path.startsWith(runtime))) expect(readFileSync(path, 'utf8'), path).not.toMatch(/runtime\/environment(?:\.[jt]s)?['"]/)
  })

  it('echoes a setting\'s value only where a route reports its effect, on every GET route and with either credential', async () => {
    const base = mkdtempSync(join(tmpdir(), 'buckle-no-settings-values-'))
    const root = join(base, 'zq81-root')
    const scratch = join(base, 'zq81-scratch')
    const readOnly = join(root, 'zq81-read-only')
    for (const directory of [root, scratch, readOnly]) mkdirSync(directory, { recursive: true })
    const values: Record<string, string> = {
      BUCKLE_SERVER_NAME: 'zq81-name', BUCKLE_WORKSPACE_ROOT: root, BUCKLE_WORKSPACE_MOUNT: '/zq81-mount',
      BUCKLE_SCRATCH_ROOTS: scratch, BUCKLE_MOUNT_READ_ONLY: readOnly, BUCKLE_PACKS: 'fs,web,shell',
      BUCKLE_NETWORK_ALLOW: 'zq81-net.test', BUCKLE_ALLOWED_HOSTS: 'zq81-host.internal',
      // RINGS-D20: the approval key is never an effect any route reports.
      BUCKLE_RINGS_APPROVAL_KEY: mintApprovalKey(),
    }
    // BUCKLE_ALLOW_SHELL and BUCKLE_ALLOW_HOST_GIT are booleans, so no value of theirs is distinctive;
    // their effect is the withheld pack's reason, which names the variable.
    const app = await served({
      ...values, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'false',
      BUCKLE_AUTH_TOKEN: 'agent-token-fixture', BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
    })
    // Effects a route reports: what the node is called, the root and paths the agent addresses, and
    // the policy base. `/setup/policy` returning BUCKLE_NETWORK_ALLOW entries awaits the maintainer's
    // ruling under BUCKLE-D19; any other value reaching a body fails here.
    const reported: Record<string, string[]> = {
      '/v1/manifest': ['BUCKLE_SERVER_NAME', 'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_SCRATCH_ROOTS'],
      '/setup/status': ['BUCKLE_SERVER_NAME', 'BUCKLE_WORKSPACE_ROOT', 'BUCKLE_WORKSPACE_MOUNT'],
      '/setup/workspaces': ['BUCKLE_SERVER_NAME', 'BUCKLE_WORKSPACE_ROOT'],
      '/setup/policy': ['BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_NETWORK_ALLOW'],
    }
    const paths = [...new Set(app.routes().filter(route => route.method === 'GET' && !/[:*]/.test(route.path)).map(route => route.path))]

    const answered: string[] = []
    for (const path of paths) {
      for (const token of ['agent-token-fixture', 'admin-token-fixture']) {
        const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } })
        if (response.status !== 200) continue
        const body = await response.text()
        answered.push(path)
        expect(Object.keys(values).filter(key => body.includes(values[key]!)), `${path} with ${token}`).toEqual(reported[path] ?? [])
      }
    }
    expect(answered).toEqual(expect.arrayContaining(['/v1/manifest', '/setup/status', '/setup/policy', '/setup/tools', '/setup/audit']))
  })
})

describe('the manifest an agent token reads', () => {
  it('reports withheld packs in fixed text, naming the setting behind a built-in one and never a configured path or a plugin error', async () => {
    const app = await served({
      BUCKLE_AUTH_TOKEN: 'agent-token-fixture',
      BUCKLE_ADMIN_TOKEN: 'admin-token-fixture',
      BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-manifest-ws-')),
      BUCKLE_AGENT_BROWSER_COMMAND: '/opt/private-fixture/bin/agent-browser',
    }, state => writeFileSync(join(state, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'broken', specifier: '/opt/private-fixture/plugins/broken.mjs', enabled: true }] })))

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

