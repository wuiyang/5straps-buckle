import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'

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
    expect(refused).toMatchObject({ status: 409, message: 'This workspace\'s packs or folder changed; the change takes effect once its active work is resolved, so call again then' })
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
