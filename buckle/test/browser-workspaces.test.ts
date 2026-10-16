import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, unreadWorkspaceDefaults, type NodeConfig } from '../common/runtime/config.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { runCli } from './support/cli.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// Phase 2 item 6 of the workspace-model brief (Q10, D84 (2)): the browser's idle timeout and the owner's modes (an
// attached Chrome, a profile folder, arguments, a window) are each workspace's; a profile folder or an attached Chrome
// belongs to one workspace at a time, and a second is refused, naming the one that holds it.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-browser-workspaces-')))
  roots.push(root)
  return root
}

/** Two workspaces, alpha registered before beta, on a node with a fake agent-browser that records its arguments. */
async function node(environment: Record<string, string> = {}) {
  const root = scratch()
  for (const folder of ['alpha', 'beta', 'profile', 'other-profile']) mkdirSync(join(root, folder))
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('{"success":true}')\n`)
  chmodSync(binary, 0o755)
  const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'browser-workspaces-admin-credential', BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: binary, ...environment })
  const manager = await workspacesOf(config)
  for (const name of ['alpha', 'beta']) await registerWorkspace(manager, { id: name, dir: join(root, name) })
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  return { root, config, manager, calls }
}

function open(manager: WorkspaceManager, name: string) {
  return byName(manager, name).then(({ runtime }) => runtime.invoke({ request: { requestId: `open-${randomUUID()}`, tool: 'browser_command', args: { command: 'snapshot', args: [] }, approvalTokens: [] }, sessionId: name }))
}

async function set(config: NodeConfig, name: string, key: string, value: string) {
  let err = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const { exitCode } = await runCli({ argv: ['workspace', 'set', key, value, '--workspace', name], config, confirm: null, cwd: '/' })
  vi.restoreAllMocks()
  return { exitCode, err }
}

describe('a workspace\'s browser settings', () => {
  it('are its own: its window and idle timeout reach its browser alone', async () => {
    const { config, manager, calls } = await node()
    expect((await set(config, 'alpha', 'browser.headed', 'on')).exitCode).toBe(0)
    expect((await set(config, 'alpha', 'browser.idleTimeoutMs', '120000')).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    const [alpha, beta] = calls()
    expect(alpha).toContain('--headed')
    expect(alpha![alpha!.indexOf('--idle-timeout') + 1]).toBe('120000')
    expect(beta).not.toContain('--headed')
    expect(beta![beta!.indexOf('--idle-timeout') + 1]).toBe('300000')
    await manager.close()
  })

  it('come from the node\'s environment file alone, whatever the caller\'s env says', () => {
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller: { BUCKLE_BROWSER_PROFILE: '/owner/profile', BUCKLE_BROWSER_HEADED: 'true' } }
    expect(loadConfig({ ...layers.caller }, process.platform, layers).workspaceDefaults.browser).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_BROWSER_PROFILE', 'BUCKLE_BROWSER_HEADED'])
  })
})

describe('a profile folder', () => {
  it('belongs to the workspace that names it as its own: another naming it too is refused, naming the holder', async () => {
    const { root, config, manager, calls } = await node()
    expect((await set(config, 'alpha', 'browser.profile', join(root, 'profile'))).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.profile', join(root, 'profile'))
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That profile folder belongs to workspace alpha, and serves one workspace at a time: unset it there first')
    expect(refused.err).not.toContain(join(root, 'profile'))
    expect((await set(config, 'beta', 'browser.profile', join(root, 'other-profile'))).exitCode).toBe(0)
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(calls().map(call => call[call.indexOf('--profile') + 1])).toEqual([join(root, 'profile'), join(root, 'other-profile')])
    await manager.close()
  })

  it('the node names belongs to the first online workspace taking it, and to one naming it as its own over that', async () => {
    const root = scratch()
    mkdirSync(join(root, 'shared-profile'))
    const { config, manager, calls } = await node({ BUCKLE_BROWSER_PROFILE: join(root, 'shared-profile') })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'error', error: { message: 'The profile folder this browser keeps its logins in belongs to workspace alpha, and serves one workspace at a time; the owner chooses which with buckle workspace set browser.profile or browser.cdp' } })
    // beta names the node's folder as its own: it holds it from now on, and alpha is the one refused, at its next call.
    expect((await set(config, 'beta', 'browser.profile', join(root, 'shared-profile'))).exitCode).toBe(0)
    expect(await open(manager, 'beta')).toMatchObject({ outcome: 'ok' })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('belongs to workspace beta') } })
    // Taken offline, beta holds nothing, and alpha has the folder again.
    await manager.update(idOf(manager, 'beta'), { online: false })
    expect(await open(manager, 'alpha')).toMatchObject({ outcome: 'ok' })
    expect(calls().filter(call => call[0] === 'snapshot')).toHaveLength(3)
    await manager.close()
  })
})

describe('an attached Chrome', () => {
  it('belongs to one workspace at a time, as a profile folder does', async () => {
    const { config, manager } = await node()
    expect((await set(config, 'alpha', 'browser.cdp', '9222')).exitCode).toBe(0)
    const refused = await set(config, 'beta', 'browser.cdp', '9222')
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('That Chrome belongs to workspace alpha')
    expect(refused.err).not.toContain('9222')
    expect((await set(config, 'beta', 'browser.cdp', '9333')).exitCode).toBe(0)
    await manager.close()
  })
})
