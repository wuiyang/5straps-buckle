import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { initializeCommon } from '../common/runtime/initialize.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { SETTINGS_WATCH_DEBOUNCE_MS } from '../common/services/workspaces/workspace-runtime.js'
import { settingsPath, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { fixedInteraction } from './support/interaction.js'

// The workspace-model brief, item 7 and Q2: a running workspace takes up a write to its workspace.json at the next
// call, found by a stat, with no watcher. Lists and the approval wait apply between calls; a change to the packs waits
// until no work is active; a file that will not read leaves the settings in force.

let base: string
let folder: string
let serving: WorkspaceManager
let owner: WorkspaceManager
/** The site's id, which its records are keyed by (D85, Q15). */
let site: string
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
  site = (await serving.create({ id: 'site', dir: folder, settings: settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs'] } }) })).workspace.id
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) await manager.close()
  rmSync(base, { recursive: true, force: true })
})

async function read(path = 'note.md') {
  const { runtime } = await serving.resolve(site)
  return runtime.invoke({ request: { requestId: `read-${Math.random()}`, tool: 'fs_read', args: { path }, approvalTokens: [] }, sessionId: 'live' })
}

describe('the settings watcher takes a change up with no call', () => {
  it('applies a change while the workspace is idle, before any call', async () => {
    const { config } = await serving.resolve(site)
    expect(config.approvalTimeoutMs).toBe(15_000)
    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 4_321 }))
    // No call is made: the folder watcher takes the change up on its own, within its debounce.
    await vi.waitFor(() => expect(config.approvalTimeoutMs).toBe(4_321), { timeout: 5_000, interval: 50 })
  })
})

describe('the settings watcher of a node that closed', () => {
  it('stops with the node, so a change after it wakes no runtime', async () => {
    const common = initializeCommon({ config: loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'live-settings-admin-fixture', BUCKLE_SANDBOX: 'none' }), role: 'cli' })
    await common.start()
    const { config } = await (await common.services.getWorkspaces()).resolve(site)
    await common.owner.close()

    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 4_321 }))
    await delay(SETTINGS_WATCH_DEBOUNCE_MS * 4)
    expect(config.approvalTimeoutMs).toBe(15_000)
  })
})

describe('a write to workspace.json from another process', () => {
  it('applies a policy list at the next call, with no restart', async () => {
    expect(await read()).toMatchObject({ outcome: 'ok' })
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_read'] } } }))

    expect(await read()).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('Disabled by workspace tool policy. Ask the owner to review buckle policy show ') } })
  })

  // Phase 2 item 6: the browser pack reads the workspace's browser settings, which swap in at the next call as a policy
  // list does, with no wait for work: they are no part of the sandbox layout.
  it('takes a change to the browser settings up at the next call, with no wait for work', async () => {
    await read()
    const { runtime, config } = await serving.resolve(site)
    const registry = runtime.registry()
    await owner.updateSettings(site, settings => ({ ...settings, browser: { ...settings.browser, idleTimeoutMs: 120_000 } }))

    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(config.browserIdleTimeoutMs).toBe(120_000)
    expect(runtime.registry()).not.toBe(registry)
  })

  it('applies the approval wait and the variables at the next call', async () => {
    await read()
    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 1_234, env: { GREETING: 'hello' } }))
    const { config } = await serving.resolve(site)
    expect(config.approvalTimeoutMs).toBe(15_000)

    await read()
    expect(config).toMatchObject({ approvalTimeoutMs: 1_234, commandEnvironment: { GREETING: 'hello' } })
  })

  // The delete policy brief, items 1 and 2: the permission rules are rebuilt from the settings in force, so a change to
  // either delete setting is the next call's policy with no restart.
  it('applies files.deleteInWorkspace and files.massDeleteLimit at the next call', async () => {
    const { runtime } = await serving.resolve(site)
    await runtime.grants.grant({ sessionId: 'live', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    const root = runtime.paths().root
    const remove = (...names: string[]) => runtime.invoke({ request: { requestId: `delete-${randomUUID()}`, tool: 'fs_delete', args: { paths: names }, approvalTokens: [] }, sessionId: 'live' })
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) writeFileSync(join(folder, name), name)

    expect(await remove('a.txt')).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    await owner.updateSettings(site, settings => ({ ...settings, files: { ...settings.files, deleteInWorkspace: 'ask' } }))
    expect(await remove('b.txt')).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${root}` }] })

    await owner.updateSettings(site, settings => ({ ...settings, files: { deleteInWorkspace: 'allow', massDeleteLimit: 1 } }))
    expect(await remove('b.txt', 'c.txt')).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-batch:${root}` }] })

    await owner.updateSettings(site, settings => ({ ...settings, files: { ...settings.files, massDeleteLimit: 0 } }))
    expect(await remove('d.txt', 'e.txt', 'f.txt')).toMatchObject({ outcome: 'ok', output: { removed: 3 } })
  })

  it('rebuilds the packs at the next call while no work is active', async () => {
    const { runtime } = await serving.resolve(site)
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs'])
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))

    await read()
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs', 'web'])
  })

  it('refuses a call while work is active after the packs changed, naming no path, and takes them up once it is resolved', async () => {
    const { runtime } = await serving.resolve(site)
    await read()
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))
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
    writeFileSync(settingsPath(join(base, 'state'), site), '{ not json')

    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(errors.mock.calls.filter(([message]) => message === 'Workspace settings changed but cannot be read; the ones in force stay')).toHaveLength(1)

    rmSync(settingsPath(join(base, 'state'), site))
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_read'] } } }))
    expect(await read()).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('Disabled by workspace tool policy. Ask the owner to review buckle policy show ') } })
  })

  it('refuses every call once the workspace is switched offline, as a stdio server holding it learns', async () => {
    await read()
    await owner.update(site, { online: false })
    await expect(read()).rejects.toMatchObject({ status: 409, message: 'Workspace is offline' })
  })
})

// A call refused before the invoker sees it, for a settings change that waits for work, one that will not apply, or an
// offline workspace, leaves the pair every call leaves: an attempt, and an error result with the refusal's code, its
// arguments redacted, so the log holds what the agent was told.
describe('a call refused before it reaches the invoker', () => {
  const REFUSED = 'refused-before-the-invoker'
  // The runtime a stdio server already holds: a resolve of an offline workspace is refused before any call.
  const held = async () => (await serving.resolve(site)).runtime
  const call = (runtime: BuckleRuntime, path = 'note.md') => runtime.invoke({ request: { requestId: REFUSED, tool: 'fs_read', args: { path }, approvalTokens: [] }, sessionId: 'live' }).catch((error: unknown) => error)
  const recorded = (runtime: BuckleRuntime) => runtime.actions.read(100).filter(entry => entry.requestId === REFUSED)
  function expectPair(entries: ReturnType<typeof recorded>) {
    expect(entries.map(entry => [entry.event, entry.outcome, entry.detail])).toEqual([['attempt', 'started', undefined], ['result', 'error', 'WORKSPACE_REFUSED']])
    expect(entries[0]!.auditId).toBe(entries[1]!.auditId)
    for (const entry of entries) expect(entry).toMatchObject({ workspaceId: site, sessionId: 'live', tool: 'fs_read', args: { path: '[7 characters]' }, effects: [] })
    expect(JSON.stringify(entries)).not.toContain('note.md')
  }

  it('records a call refused while a change to the packs waits for active work', async () => {
    const runtime = await held()
    await read()
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))
    vi.spyOn(runtime, 'hasActiveWork').mockResolvedValue(true)

    expect(await call(runtime)).toMatchObject({ status: 409 })
    expectPair(recorded(runtime))
  })

  it('records a call refused while a change to the mounts waits for active work', async () => {
    const runtime = await held()
    await read()
    mkdirSync(join(base, 'data'))
    await owner.addMount(site, { source: join(base, 'data'), target: '/data', access: 'rw' })
    vi.spyOn(runtime, 'hasActiveWork').mockResolvedValue(true)

    expect(await call(runtime)).toMatchObject({ status: 409 })
    expectPair(recorded(runtime))
  })

  it('records a call refused because the settings change will not apply', async () => {
    const runtime = await held()
    await read()
    const file = settingsPath(join(base, 'state'), site)
    const before = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceSettings
    writeFileSync(file, JSON.stringify({ ...before, revision: before.revision + 1, packs: { ...before.packs, enabled: ['fs', 'environment'] } }))

    expect(await call(runtime)).toMatchObject({ status: 409, message: expect.stringContaining('could not be taken up yet') })
    expectPair(recorded(runtime))
  })

  it('records a call refused because the workspace is offline', async () => {
    const runtime = await held()
    await read()
    await owner.update(site, { online: false })

    expect(await call(runtime)).toMatchObject({ status: 409, message: 'Workspace is offline' })
    expectPair(recorded(runtime))
  })

  it('records nothing for a call that is answered, beyond the invoker\'s own pair', async () => {
    const runtime = await held()
    expect(await call(runtime)).toMatchObject({ outcome: 'ok' })
    expect(recorded(runtime).map(entry => [entry.event, entry.outcome])).toEqual([['attempt', 'started'], ['result', 'ok']])
  })
})

// Findings 7, 8, and 28 of the Phase 1 review: a change rebuilds only what it reaches, waits for active work only where
// it rebuilds, closes what it replaces, and applies whole or not at all.
describe('what a change to workspace.json rebuilds', () => {
  async function openWorkbench() {
    const { runtime } = await serving.resolve(site)
    await runtime.workbenches.provision({ id: randomUUID(), token: 'live-settings-workbench-fixture-token-0000', projectId: 'project', chatId: 'chat', allowShell: false })
    return { runtime, statuses: async () => (await runtime.workbenches.list()).map(workbench => workbench.status) }
  }

  it('swaps the approval wait in while a workbench is open, and leaves the workbench and its terminals alone', async () => {
    const { statuses } = await openWorkbench()
    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 60_000 }))
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(await statuses()).toEqual(['open'])
    expect((await serving.resolve(site)).config.approvalTimeoutMs).toBe(60_000)
  })

  it('applies the variables while a workbench is open, which stays open', async () => {
    const { statuses } = await openWorkbench()
    await owner.updateSettings(site, settings => ({ ...settings, env: { NODE_ENV: 'dev' } }))
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(await statuses()).toEqual(['open'])
    expect((await serving.resolve(site)).config.commandEnvironment).toEqual({ NODE_ENV: 'dev' })
  })

  // Taking a new policy up stops the terminals of every open workbench, so a list change alone waits for none to be open.
  it('waits to apply a policy list while a workbench is open, which stays open', async () => {
    const { statuses } = await openWorkbench()
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_list'] } } }))
    await expect(read()).rejects.toMatchObject({ status: 409 })
    expect(await statuses()).toEqual(['open'])
  })

  it('closes the packs a rebuild replaces, and keeps them where nothing they are built from changed', async () => {
    const log = join(base, 'packs.log')
    const plugin = join(base, 'probe-plugin.mjs')
    writeFileSync(plugin, `import { appendFileSync } from 'node:fs'\nexport function createPack() { appendFileSync(${JSON.stringify(log)}, 'built\\n'); return { id: 'probe', version: '1.0.0', tools: [], skills: [], unavailableReason: null, close() { appendFileSync(${JSON.stringify(log)}, 'closed\\n') } } }\n`)
    writeFileSync(join(base, 'state', 'workspaces', site, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'probe', specifier: pathToFileURL(plugin).href, enabled: true }] }))
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: null } }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\n')

    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 30_000 }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\n')

    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, hostLsp: true } }))
    await read()
    expect(readFileSync(log, 'utf8')).toBe('built\nbuilt\nclosed\n')
  })

  it('applies nothing of a version that will not apply, says so once, refuses each call meanwhile naming no path, and tries it again at the next call', async () => {
    const errors = vi.spyOn(logger, 'error')
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_list'] } } }))
    await read()
    const file = settingsPath(join(base, 'state'), site)
    const before = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceSettings
    // A hand edit the CLI would refuse: a pack this node cannot build, with the deny lifted and a new wait beside it.
    writeFileSync(file, JSON.stringify({ ...before, revision: before.revision + 1, approvalWaitMs: 5_000, packs: { ...before.packs, enabled: ['fs', 'environment'] }, policy: { ...before.policy, tools: { deny: [] } } }))
    const { runtime, config } = await serving.resolve(site)
    const list = () => runtime.invoke({ request: { requestId: `list-${Math.random()}`, tool: 'fs_list', args: { path: '.' }, approvalTokens: [] }, sessionId: 'live' })

    // Never answered under the settings the change replaced (fix brief 4, finding 1): refused until it applies.
    const retry = { status: 409, message: 'This workspace\'s settings changed and could not be taken up yet; retry the call, and if it keeps failing, the owner\'s log says why' }
    await expect(list()).rejects.toMatchObject(retry)
    await expect(list()).rejects.toMatchObject(retry)
    expect(config).toMatchObject({ approvalTimeoutMs: 15_000, enabledPacks: ['fs'] })
    expect(errors.mock.calls.filter(([message]) => message === 'Workspace settings changed but cannot be applied; calls are refused until they can be')).toHaveLength(1)

    // The same version, tried again once what it needs is there.
    config.environmentValidator = process.execPath
    expect(await list()).toMatchObject({ outcome: 'ok' })
    expect(config).toMatchObject({ approvalTimeoutMs: 5_000, enabledPacks: ['fs', 'environment'] })
  })
})

// Fix brief 1, D, and its recheck: the policy lists and the variables are the light swap, taken up by the next call
// with no 409 while work is active; only the packs and the mounts wait for none.
describe('a policy list or a variable changed while work is active', () => {
  /** A node serving with nobody at a terminal, so a gated write is held for the approval wait: a call in flight. */
  async function holdingWrite() {
    const holder = await openWorkspaceManager({ config: loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'live-settings-admin-fixture', BUCKLE_SANDBOX: 'none' }), interaction: fixedInteraction() })
    managers.push(holder)
    await owner.updateSettings(site, settings => ({ ...settings, approvalWaitMs: 1_500 }))
    const { runtime, config } = await holder.resolve(site)
    const held = runtime.invoke({ request: { requestId: 'held-write', tool: 'fs_write', args: { path: 'new.txt', content: 'x' }, approvalTokens: [] }, sessionId: 'live' })
    await vi.waitFor(() => expect(runtime.inspectActiveWork()).toBe(true))
    return { runtime, config, held, call: (tool: string, args: Record<string, unknown>) => runtime.invoke({ request: { requestId: `${tool}-${Math.random()}`, tool, args: args as never, approvalTokens: [] }, sessionId: 'live' }) }
  }

  it('answers a call at once through a hand edit of the stored browser block, which no pack reads, though another call is in flight', async () => {
    const { held, call } = await holdingWrite()
    await owner.updateSettings(site, settings => ({ ...settings, browser: { ...settings.browser, headed: true } }))

    expect(await call('fs_read', { path: 'note.md' })).toMatchObject({ outcome: 'ok' })
    expect(await held).toMatchObject({ outcome: 'approval_required' })
  })

  it('applies a policy list at the next call with no 409 while another call is in flight, which keeps the rules it started with', async () => {
    const { held, call } = await holdingWrite()
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, tools: { deny: ['fs_list'] } } }))

    expect(await call('fs_list', { path: '.' })).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('Disabled by workspace tool policy. Ask the owner to review buckle policy show ') } })
    expect(await call('fs_read', { path: 'note.md' })).toMatchObject({ outcome: 'ok' })
    expect(await held).toMatchObject({ outcome: 'approval_required' })
  })

  it('applies a command list and the variables at the next call with no 409 while another call is in flight', async () => {
    const { config, held, call } = await holdingWrite()
    await owner.updateSettings(site, settings => ({ ...settings, env: { GREETING: 'hello' }, policy: { ...settings.policy, commands: { ...settings.policy.commands, allow: ['ls *'] } } }))

    expect(await call('fs_read', { path: 'note.md' })).toMatchObject({ outcome: 'ok' })
    expect(config.commandEnvironment).toEqual({ GREETING: 'hello' })
    expect(config.policy.commands.allow).toEqual(['ls *'])
    expect(await held).toMatchObject({ outcome: 'approval_required' })
  })

  // A shell copy awaiting review is work for the packs and the mounts, which rebuild the tools, and for nothing else.
  it('applies them at the next call while a shell result waits for review, and still holds the packs back', async () => {
    const { runtime, config } = await serving.resolve(site)
    await read()
    const id = `shell-${randomUUID()}`
    const directory = join(base, 'state', 'workspaces', site, 'isolated-shell', workspaceStateKey(folder), id)
    mkdirSync(join(directory, 'workspace'), { recursive: true })
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ id, sessionId: 's', stageId: 'st', tool: 'shell_exec', sourceRoot: folder, copyRoot: join(directory, 'workspace'), writableRoots: [folder], excluded: [], createdAt: new Date().toISOString(), status: 'needs_review' }))
    expect(runtime.inspectActiveWork()).toBe(true)

    await owner.updateSettings(site, settings => ({ ...settings, env: { GREETING: 'hello' }, policy: { ...settings.policy, commands: { ...settings.policy.commands, allow: ['ls *'] } } }))
    expect(await read()).toMatchObject({ outcome: 'ok' })
    expect(config).toMatchObject({ commandEnvironment: { GREETING: 'hello' }, policy: { commands: { allow: ['ls *'] } } })

    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'web'] } }))
    await expect(read()).rejects.toMatchObject({ status: 409 })
    expect(runtime.manifest().packs.map(pack => pack.id)).toEqual(['fs'])
  })
})

// Finding 27 of the Phase 1 review: a code_run script's calls ran under whatever another call had taken up meanwhile.
describe('a code_run script\'s calls', () => {
  it('run under the settings the script started with, and its tools stay open until it ends, whatever is applied meanwhile', async () => {
    const log = join(base, 'packs.log')
    const plugin = join(base, 'probe-plugin.mjs')
    writeFileSync(plugin, `import { appendFileSync } from 'node:fs'\nexport function createPack() { appendFileSync(${JSON.stringify(log)}, 'built\\n'); return { id: 'probe', version: '1.0.0', tools: [], skills: [], unavailableReason: null, close() { appendFileSync(${JSON.stringify(log)}, 'closed\\n') } } }\n`)
    writeFileSync(join(base, 'state', 'workspaces', site, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'probe', specifier: pathToFileURL(plugin).href, enabled: true }] }))
    await owner.updateSettings(site, settings => ({ ...settings, packs: { ...settings.packs, enabled: null } }))
    await read()
    const { runtime } = await serving.resolve(site)
    const go = join(folder, 'go')
    const script = `const first = await tools.fs_read({ path: 'note.md' })
      while (!(await tools.fs_list({ path: '.' })).entries.some(entry => entry.name === 'go')) {}
      const second = await tools.fs_read({ path: 'note.md' })
      return [first.content, second.content]`
    const running = runtime.invoke({ request: { requestId: 'script', tool: 'code_run', args: { script }, approvalTokens: [] }, sessionId: 'live' })
    await vi.waitFor(() => expect(runtime.actions.read(50).some(entry => entry.tool === 'fs_list')).toBe(true))

    // The owner's own reload applies a deny at once, as `buckle policy` in this process would, while the script runs.
    await owner.updateSettings(site, settings => ({ ...settings, policy: { ...settings.policy, filesystem: { rules: [{ path: 'note.md', read: 'deny' }] } } }))
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
