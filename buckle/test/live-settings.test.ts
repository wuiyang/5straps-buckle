import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { settingsPath, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

// The workspace-model brief, item 7 and Q2: a running workspace takes up a write to its workspace.json at the next
// call, found by a stat, with no watcher. Lists and the approval wait apply between calls; a change to the packs waits
// until no work is active; a file that will not read leaves the settings in force.

let base: string
let folder: string
let serving: WorkspaceManager
let owner: WorkspaceManager
const managers: WorkspaceManager[] = []

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-live-settings-')))
  folder = join(base, 'site')
  mkdirSync(folder)
  writeFileSync(join(folder, 'note.md'), 'a note')
  const config = loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'live-settings-admin-fixture', BUCKLE_SANDBOX: 'none' })
  // The node serving calls, and the owner's CLI in another process, each with its own view of the state directory.
  serving = await openWorkspaceManager({ config })
  owner = await openWorkspaceManager({ config })
  managers.push(serving, owner)
  await serving.create({ id: 'site', dir: folder, settings: settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs'] } }) })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) await manager.close()
  rmSync(base, { recursive: true, force: true })
})

async function read(path = 'note.md') {
  const { runtime } = await serving.resolve('site')
  return runtime.invoke({ request: { requestId: `read-${Math.random()}`, tool: 'fs_read', args: { path }, approvalTokens: [] }, sessionId: 'live' })
}

describe('a write to workspace.json from another process', () => {
  it('applies a policy list at the next call, with no restart', async () => {
    expect(await read()).toMatchObject({ outcome: 'ok' })
    await owner.updateSettings('site', settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_read'] } } }))

    expect(await read()).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
  })

  it('applies the approval wait and the variables at the next call', async () => {
    await read()
    await owner.updateSettings('site', settings => ({ ...settings, approvalWaitMs: 1_234, env: { GREETING: 'hello' } }))
    const { config } = await serving.resolve('site')
    expect(config.approvalTimeoutMs).toBe(15_000)

    await read()
    expect(config).toMatchObject({ approvalTimeoutMs: 1_234, commandEnvironment: { GREETING: 'hello' } })
  })

  it('rebuilds the packs at the next call while no work is active', async () => {
    const { runtime } = await serving.resolve('site')
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs'])
    await owner.updateSettings('site', settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))

    await read()
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs', 'web'])
  })

  it('refuses a call while work is active after the packs changed, naming no path, and takes them up once it is resolved', async () => {
    const { runtime } = await serving.resolve('site')
    await read()
    await owner.updateSettings('site', settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))
    const active = vi.spyOn(runtime, 'hasActiveWork').mockResolvedValue(true)

    const refused = await read().catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 409, message: 'This workspace\'s settings changed in a way that rebuilds its tools; the change takes effect once its active work is resolved, so call again then' })
    expect(String((refused as Error).message)).not.toContain(base)
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs'])

    active.mockResolvedValue(false)
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs', 'web'])
  })

  it('keeps the settings in force while the file will not read, saying so once, and takes up the repair', async () => {
    await read()
    const errors = vi.spyOn(logger, 'error')
    writeFileSync(settingsPath(join(base, 'state'), 'site'), '{ not json')

    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(errors.mock.calls.filter(([message]) => message === 'Workspace settings changed but cannot be read; the ones in force stay')).toHaveLength(1)

    rmSync(settingsPath(join(base, 'state'), 'site'))
    await owner.updateSettings('site', settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_read'] } } }))
    expect(await read()).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
  })

  it('refuses every call once the workspace is switched offline, as a stdio server holding it learns', async () => {
    await read()
    await owner.update('site', { online: false })
    await expect(read()).rejects.toMatchObject({ status: 409, message: 'Workspace is offline' })
  })
})

// Findings 7, 8, and 28 of the Phase 1 review: a change rebuilds only what it reaches, waits for active work only where
// it rebuilds, closes what it replaces, and applies whole or not at all.
describe('what a change to workspace.json rebuilds', () => {
  async function openWorkbench() {
    const { runtime } = await serving.resolve('site')
    await runtime.workbenches.provision({ id: randomUUID(), token: 'live-settings-workbench-fixture-token-0000', projectId: 'project', chatId: 'chat', allowShell: false })
    return { runtime, statuses: async () => (await runtime.workbenches.list()).map(workbench => workbench.status) }
  }

  it('swaps the approval wait in while a workbench is open, and leaves the workbench and its terminals alone', async () => {
    const { statuses } = await openWorkbench()
    await owner.updateSettings('site', settings => ({ ...settings, approvalWaitMs: 60_000 }))
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(await statuses()).toEqual(['open'])
    expect((await serving.resolve('site')).config.approvalTimeoutMs).toBe(60_000)
  })

  it.each([
    ['the variables', (settings: WorkspaceSettings) => ({ ...settings, env: { NODE_ENV: 'dev' } })],
    ['a policy list', (settings: WorkspaceSettings) => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_list'] } } })],
  ])('waits to apply %s while a workbench is open, which stays open', async (_change, change) => {
    const { statuses } = await openWorkbench()
    await owner.updateSettings('site', change)
    await expect(read()).rejects.toMatchObject({ status: 409 })
    expect(await statuses()).toEqual(['open'])
  })

  it('closes the packs a rebuild replaces, and keeps them where nothing they are built from changed', async () => {
    const log = join(base, 'packs.log')
    const plugin = join(base, 'probe-plugin.mjs')
    writeFileSync(plugin, `import { appendFileSync } from 'node:fs'\nexport function createPack() { appendFileSync(${JSON.stringify(log)}, 'built\\n'); return { id: 'probe', version: '1.0.0', tools: [], skills: [], unavailableReason: null, close() { appendFileSync(${JSON.stringify(log)}, 'closed\\n') } } }\n`)
    writeFileSync(join(base, 'state', 'workspaces', 'site', 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'probe', specifier: pathToFileURL(plugin).href, enabled: true }] }))
    await owner.updateSettings('site', settings => ({ ...settings, packs: { ...settings.packs, enabled: null } }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\n')

    await owner.updateSettings('site', settings => ({ ...settings, approvalWaitMs: 30_000 }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\n')

    await owner.updateSettings('site', settings => ({ ...settings, packs: { ...settings.packs, hostLsp: true } }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\nbuilt\nclosed\n')
  })

  it('applies nothing of a version that will not apply, says so once, keeps the settings in force, and tries it again at the next call', async () => {
    const errors = vi.spyOn(logger, 'error')
    await owner.updateSettings('site', settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_list'] } } }))
    await read()
    const file = settingsPath(join(base, 'state'), 'site')
    const before = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceSettings
    // A hand edit the CLI would refuse: a pack this node cannot build, with the deny lifted and a new wait beside it.
    writeFileSync(file, JSON.stringify({ ...before, revision: before.revision + 1, approvalWaitMs: 5_000, packs: { ...before.packs, enabled: ['fs', 'environment'] }, policy: { ...before.policy, tools: { deny: [] } } }))
    const { runtime, config } = await serving.resolve('site')
    const list = () => runtime.invoke({ request: { requestId: `list-${Math.random()}`, tool: 'fs_list', args: { path: '.' }, approvalTokens: [] }, sessionId: 'live' })

    expect(await list()).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
    expect(await list()).toMatchObject({ outcome: 'error' })
    expect(config).toMatchObject({ approvalTimeoutMs: 15_000, enabledPacks: ['fs'] })
    expect(errors.mock.calls.filter(([message]) => message === 'Workspace settings changed but cannot be applied; the ones in force stay')).toHaveLength(1)

    // The same version, tried again once what it needs is there.
    config.environmentValidator = process.execPath
    expect(await list()).toMatchObject({ outcome: 'ok' })
    expect(config).toMatchObject({ approvalTimeoutMs: 5_000, enabledPacks: ['fs', 'environment'] })
  })
})

// Finding 27 of the Phase 1 review: a code_run script's calls ran under whatever another call had taken up meanwhile.
describe('a code_run script\'s calls', () => {
  it('run under the settings the script started with, and its tools stay open until it ends, whatever is applied meanwhile', async () => {
    const log = join(base, 'packs.log')
    const plugin = join(base, 'probe-plugin.mjs')
    writeFileSync(plugin, `import { appendFileSync } from 'node:fs'\nexport function createPack() { appendFileSync(${JSON.stringify(log)}, 'built\\n'); return { id: 'probe', version: '1.0.0', tools: [], skills: [], unavailableReason: null, close() { appendFileSync(${JSON.stringify(log)}, 'closed\\n') } } }\n`)
    writeFileSync(join(base, 'state', 'workspaces', 'site', 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'probe', specifier: pathToFileURL(plugin).href, enabled: true }] }))
    await owner.updateSettings('site', settings => ({ ...settings, packs: { ...settings.packs, enabled: null } }))
    await read()
    const { runtime } = await serving.resolve('site')
    const go = join(folder, 'go')
    const script = `const first = await tools.fs_read({ path: 'note.md' })
      while (!(await tools.fs_list({ path: '.' })).entries.some(entry => entry.name === 'go')) {}
      const second = await tools.fs_read({ path: 'note.md' })
      return [first.content, second.content]`
    const running = runtime.invoke({ request: { requestId: 'script', tool: 'code_run', args: { script }, approvalTokens: [] }, sessionId: 'live' })
    await vi.waitFor(() => expect(runtime.actions.read(50).some(entry => entry.tool === 'fs_list')).toBe(true))

    // The owner's own reload applies a deny at once, as `buckle policy` in this process would, while the script runs.
    await owner.updateSettings('site', settings => ({ ...settings, policy: { ...settings.policy, filesystem: { rules: [{ path: 'note.md', read: 'deny' }] } } }))
    await runtime.reload()
    // The rebuilt packs leave plugins out under a filesystem rule; the probe the script started with is not closed yet.
    expect(readFileSync(log, 'utf8')).toBe('built\n')
    writeFileSync(go, '')

    const response = await running
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(JSON.stringify(response)).toContain('["a note","a note"]')
    await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toBe('built\nclosed\n'))
    expect(await read()).toMatchObject({ outcome: 'error' })
  })
})
