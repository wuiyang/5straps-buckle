import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, unreadWorkspaceDefaults } from '../common/runtime/config.js'
import { openSettingsFile, resolveSettings, settingsPath, withMount, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// Phase 2 item 4 of the workspace-model brief: BUCKLE_SHELL_NETWORK and BUCKLE_SHELL_ISOLATION become each workspace's
// shell.network and shell.isolation, resolved as every setting is (D85, Q3): the workspace's, else buckle.env's, else
// Buckle's own.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-shell-settings-')))
  roots.push(root)
  return root
}

describe('a workspace\'s shell settings', () => {
  it('are its own, else the node\'s, else off for the network and on for isolation, naming where each came from', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(resolveSettings(unset, loadConfig({}).workspaceDefaults)).toMatchObject({ shell: { network: false, isolation: true }, sources: { 'shell.network': 'built-in', 'shell.isolation': 'built-in' } })
    const node = loadConfig({ BUCKLE_SHELL_NETWORK: 'true', BUCKLE_SHELL_ISOLATION: 'false' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ shell: { network: true, isolation: false }, sources: { 'shell.network': 'node', 'shell.isolation': 'node' } })
    const own = WorkspaceSettingsSchema.parse({ version: 1, shell: { network: false, isolation: true } })
    expect(resolveSettings(own, node)).toMatchObject({ shell: { network: false, isolation: true }, sources: { 'shell.network': 'workspace', 'shell.isolation': 'workspace' } })
  })

  it('come from the node\'s environment file alone, whatever the caller\'s env says', () => {
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller: { BUCKLE_SHELL_NETWORK: 'true', BUCKLE_SHELL_ISOLATION: 'false' } }
    expect(loadConfig({ ...layers.caller }, process.platform, layers).workspaceDefaults.shell).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_SHELL_NETWORK', 'BUCKLE_SHELL_ISOLATION'])
  })
})

describe('a workspace\'s shell, from its settings', () => {
  let root: string
  beforeEach(() => {
    root = scratch()
    for (const folder of ['shared', 'isolated']) mkdirSync(join(root, folder))
  })

  async function node(environment: Record<string, string> = {}) {
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs,shell', ...environment }))
    // Each at its real path: with no bubblewrap here, the shell is withheld under a mount whatever its own settings say.
    for (const name of ['shared', 'isolated']) {
      await registerWorkspace(manager, { id: name, dir: join(root, name) })
      await manager.updateSettings(idOf(manager, name), settings => withMount(settings, null))
    }
    await manager.updateSettings(idOf(manager, 'shared'), settings => ({ ...settings, shell: { isolation: false } }))
    return manager
  }
  const reason = (manifest: { packs: Array<{ id: string; unavailableReason: string | null }> }) => manifest.packs.find(pack => pack.id === 'shell')?.unavailableReason

  it('is isolated in one workspace and shares its folder in another on the same node', async () => {
    const manager = await node()
    expect(reason((await byName(manager, 'shared')).runtime.manifest())).toBeNull()
    expect(reason((await byName(manager, 'isolated')).runtime.manifest())).toBe('Isolated shell execution requires bubblewrap; the workspace setting shell.isolation, off, opts into shared-workspace checkpoints')
    await manager.close()
  })

  it('reaches the network only where its own setting lets it', async () => {
    const manager = await node()
    const { runtime } = await byName(manager, 'shared')
    // Every ask answered, so the call reaches the shell's own check.
    await runtime.policy.setDangerouslyAllow('on')
    const call = () => runtime.invoke({ request: { requestId: `net-${Math.random()}`, tool: 'shell_exec', args: { command: 'true', allowNetwork: true }, approvalTokens: [] }, sessionId: 'shared' })
    expect(await call()).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('Shell networking is disabled') } })
    await manager.updateSettings(idOf(manager, 'shared'), settings => ({ ...settings, shell: { ...settings.shell, network: true } }))
    expect(await call()).toMatchObject({ outcome: 'ok', output: { exitCode: 0 } })
    await manager.close()
  })

  // A shell cannot honour a URL list from inside the command, so with a list in force it stays off the network
  // whatever shell.network says: the list is the workspace's, else the node's (BUCKLE_ALLOWED_HOSTS folds into it).
  async function networkedShell(environment: Record<string, string>) {
    const manager = await node(environment)
    const { runtime } = await byName(manager, 'shared')
    await runtime.policy.setDangerouslyAllow('on')
    await manager.updateSettings(idOf(manager, 'shared'), settings => ({ ...settings, shell: { ...settings.shell, network: true } }))
    const call = () => runtime.invoke({ request: { requestId: `net-${Math.random()}`, tool: 'shell_exec', args: { command: 'true', allowNetwork: true }, approvalTokens: [] }, sessionId: 'shared' })
    return { manager, call, list: (allow: string[]) => manager.updateSettings(idOf(manager, 'shared'), settings => ({ ...settings, policy: { ...settings.policy, network: { allow } } })) }
  }
  const OFF_THE_NETWORK = { outcome: 'error', error: { message: expect.stringContaining('Shell networking is disabled') } }

  it('stays off the network with a URL list of its own, though shell.network is on, and reaches it again without one', async () => {
    const { manager, call, list } = await networkedShell({})
    expect(await call()).toMatchObject({ outcome: 'ok' })
    await list(['example.com'])
    expect(await call()).toMatchObject(OFF_THE_NETWORK)
    await list([])
    expect(await call()).toMatchObject({ outcome: 'ok' })
    await manager.close()
  })

  it('stays off the network with the URL list the node gives it in BUCKLE_ALLOWED_HOSTS, though shell.network is on', async () => {
    const { manager, call } = await networkedShell({ BUCKLE_ALLOWED_HOSTS: 'example.com' })
    expect(await call()).toMatchObject(OFF_THE_NETWORK)
    await manager.close()
  })

  it('takes a change up at the next call, as a change to the packs is', async () => {
    const manager = await node()
    const { runtime } = await byName(manager, 'isolated')
    await manager.updateSettings(idOf(manager, 'isolated'), settings => ({ ...settings, shell: { isolation: false } }))
    await runtime.takeUpSettings()
    expect(reason(runtime.manifest())).toBeNull()
    await manager.close()
  })
})

describe('buckle workspace set shell.network and shell.isolation', () => {
  it('store an own value, and unset takes it out, so the node\'s applies', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'shell-settings-admin-credential', BUCKLE_SANDBOX: 'none' })
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().shell
    expect((await buckle(['set', 'shell.isolation', 'off'])).exitCode).toBe(0)
    expect((await buckle(['set', 'shell.network', 'on'])).exitCode).toBe(0)
    expect(stored()).toEqual({ isolation: false, network: true })
    out = ''
    await buckle(['show'])
    expect(out).toMatch(/shell\.network +on +workspace/)
    expect(out).toMatch(/shell\.isolation +off +workspace/)
    expect((await buckle(['set', 'shell.network', 'sometimes'])).exitCode).toBe(1)
    expect((await buckle(['unset', 'shell.isolation'])).exitCode).toBe(0)
    expect(stored()).toEqual({ network: true })
    await manager.close()
  })
})
