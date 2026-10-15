import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { loadConfig } from '../common/runtime/config.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

// buckle serve and buckle mcp both open on one workspace, each a process of its own (two managers on one state
// directory stand in for them). Whichever took the workbench lock kept it, and the other could take no change up: a
// deny or a pack switched off never applied there, and its calls ran under the old rules.

let base: string
let site: string
const managers: WorkspaceManager[] = []

function open(): Promise<WorkspaceManager> {
  const config = loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'other-process-admin-fixture', BUCKLE_SANDBOX: 'none' })
  return openWorkspaceManager({ config }).then((manager) => { managers.push(manager); return manager })
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-other-process-')))
  const folder = join(base, 'site')
  mkdirSync(folder)
  writeFileSync(join(folder, 'note.md'), 'a note')
  site = (await (await open()).create({ id: 'site', dir: folder, settings: settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }) })).workspace.id
})
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
  rmSync(base, { recursive: true, force: true })
})

/** A workbench the runtime provisions, so its process holds the workbench lock, discarded unless `open`. */
async function useWorkbench(runtime: BuckleRuntime, open = false): Promise<void> {
  const id = randomUUID()
  await runtime.workbenches.provision({ id, token: 'other-process-workbench-fixture-token-0000', projectId: 'project', chatId: 'chat', allowShell: false })
  if (!open) await runtime.workbenches.discard(id, 'owner')
}

function read(runtime: BuckleRuntime) {
  return runtime.invoke({ request: { requestId: `read-${randomUUID()}`, tool: 'fs_read', args: { path: 'note.md' }, approvalTokens: [] }, sessionId: 'other-process' })
}

const packsOf = (runtime: BuckleRuntime) => runtime.manifest().packs.map(pack => pack.id)

describe('a settings change in a process that does not hold the workbenches, while buckle serve holds them', () => {
  let serve: BuckleRuntime
  let mcp: BuckleRuntime
  let owner: WorkspaceManager
  beforeEach(async () => {
    serve = (await (await open()).resolve(site)).runtime
    await useWorkbench(serve)
    mcp = (await (await open()).resolve(site)).runtime
    owner = await open()
    expect(await read(mcp)).toMatchObject({ outcome: 'ok' })
  })

  it('applies a deny written meanwhile to the next buckle mcp call', async () => {
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_read'] } } }))

    expect(await read(mcp)).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
    expect(mcp.policy.effective().tools?.deny).toContain('fs_read')
    expect(await read(serve)).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
  })

  it('takes a pack switched off out of that process\'s tools', async () => {
    expect(packsOf(mcp)).toEqual(['fs', 'web'])
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs'] } }))

    expect(await read(mcp)).toMatchObject({ outcome: 'ok' })
    expect(packsOf(mcp)).toEqual(['fs'])
    expect(mcp.manifest().tools.some(tool => tool.name.startsWith('web_'))).toBe(false)
  })

  it('lets the owner\'s policy write through over a closed workbench, which serve then takes up', async () => {
    await mcp.policy.apply({ ...emptyWorkspacePolicy(), tools: { deny: ['fs_read'] } })

    expect(await read(serve)).toMatchObject({ outcome: 'error', error: { message: 'Disabled by workspace tool policy' } })
  })

  it('refuses the owner\'s policy write as a conflict while serve holds an open workbench', async () => {
    await useWorkbench(serve, true)

    await expect(mcp.policy.apply({ ...emptyWorkspacePolicy(), tools: { deny: ['fs_read'] } })).rejects.toMatchObject({ code: 'POLICY_CONFLICT', status: 409 })
  })
})

describe('a settings change taken up while no process holds the workbenches', () => {
  it('leaves them free, so buckle serve can still take them up', async () => {
    const earlier = await open()
    await useWorkbench((await earlier.resolve(site)).runtime)
    await earlier.close()
    managers.splice(managers.indexOf(earlier), 1)
    const serve = (await (await open()).resolve(site)).runtime
    const mcp = (await (await open()).resolve(site)).runtime
    await (await open()).updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs'] } }))

    expect(await read(mcp)).toMatchObject({ outcome: 'ok' })
    expect(packsOf(mcp)).toEqual(['fs'])
    await expect(serve.workbenches.list()).resolves.toHaveLength(1)
  })
})
