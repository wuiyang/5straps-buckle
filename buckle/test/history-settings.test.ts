import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isToolAllowed } from '../common/domain/tool-policy.js'
import { loadConfig } from '../common/runtime/config.js'
import { openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { idOf, workspacesOf } from './support/workspaces.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// Slice D, rollback as an agent option, item 2: packs.history withholds history_list and history_restore, on by default
// since every restore asks a person, over the node's BUCKLE_ALLOW_HISTORY; the tool policy reads a denial of fs_read or
// fs_write as one of the history tool that reads or writes as it.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-history-settings-')))
  roots.push(root)
  return root
}

async function node(extra: Record<string, string> = {}): Promise<CoreRuntime> {
  const root = scratch()
  mkdirSync(join(root, 'workspace'))
  const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,history', ...extra }) })
  runtimes.push(runtime)
  return runtime
}

const call = (runtime: CoreRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> => runtime.invoke({ sessionId: 'agent', request: { requestId: `${tool}-${Math.random()}`, tool, args, approvalTokens: [] } })

describe('packs.history', () => {
  it('is on by Buckle\'s default, the node\'s BUCKLE_ALLOW_HISTORY else, and the workspace\'s own over both, naming its source', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(resolveSettings(unset, loadConfig({}).workspaceDefaults)).toMatchObject({ packs: { history: true }, sources: { 'packs.history': 'built-in' } })
    const off = loadConfig({ BUCKLE_ALLOW_HISTORY: 'false' }).workspaceDefaults
    expect(resolveSettings(unset, off)).toMatchObject({ packs: { history: false }, sources: { 'packs.history': 'node' } })
    expect(resolveSettings(WorkspaceSettingsSchema.parse({ version: 1, packs: { history: true } }), off)).toMatchObject({ packs: { history: true }, sources: { 'packs.history': 'workspace' } })
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: scratch() })).toMatchObject({ allowHistory: true })
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: scratch(), BUCKLE_ALLOW_HISTORY: 'false' })).toMatchObject({ allowHistory: false })
  })

  it('off, withholds the pack with its reason: the manifest lists neither tool, and a call is refused as an unknown tool', async () => {
    const runtime = await node({ BUCKLE_ALLOW_HISTORY: 'false' })
    expect(runtime.manifest().packs.find(pack => pack.id === 'history')).toEqual({ id: 'history', version: '1.0.0', toolNames: ['history_list', 'history_restore'], unavailableReason: 'The change history tools are turned off in this workspace: its setting packs.history is off' })
    expect(runtime.manifest().tools.map(tool => tool.name).filter(name => name.startsWith('history_'))).toEqual([])
    expect(await call(runtime, 'history_list', {})).toMatchObject({ outcome: 'error', error: { code: 'TOOL_NOT_FOUND' } })
    const on = await node()
    expect(on.manifest().tools.map(tool => tool.name).filter(name => name.startsWith('history_'))).toEqual(['history_list', 'history_restore'])
  })

  it('is set, shown with its source, and unset by buckle workspace', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'history-settings-admin-credential', BUCKLE_SANDBOX: 'none' })
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().packs
    out = ''
    await buckle(['show'])
    expect(out).toMatch(/packs\.history +on +built-in/)
    expect((await buckle(['set', 'packs.history', 'off'])).exitCode).toBe(0)
    expect(stored()).toEqual({ history: false })
    out = ''
    await buckle(['show'])
    expect(out).toMatch(/packs\.history +off +workspace/)
    expect((await buckle(['unset', 'packs.history'])).exitCode).toBe(0)
    expect(stored()).toEqual({})
    await manager.close()
  })
})

describe('the tool policy', () => {
  it('reads a denial of fs_write as one of history_restore, and of fs_read as one of history_list, and an allowlist must name each', () => {
    expect(isToolAllowed({ tools: { deny: ['fs_write'] } }, 'history_restore')).toBe(false)
    expect(isToolAllowed({ tools: { deny: ['fs_read'] } }, 'history_list')).toBe(false)
    expect(isToolAllowed({ tools: { deny: ['fs_read'] } }, 'history_restore')).toBe(true)
    expect(isToolAllowed({ tools: { deny: ['fs_write'] } }, 'history_list')).toBe(true)
    expect(isToolAllowed({ tools: { allow: ['fs_write', 'fs_read'], deny: [] } }, 'history_restore')).toBe(false)
    expect(isToolAllowed({ tools: { allow: ['history_restore'], deny: [] } }, 'history_restore')).toBe(true)
  })

  it('leaves a denied history tool out of the manifest and refuses its call', async () => {
    const runtime = await node()
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), tools: { deny: ['fs_write'] } })
    expect(runtime.manifest().tools.map(tool => tool.name)).not.toContain('history_restore')
    expect(runtime.manifest().tools.map(tool => tool.name)).toContain('history_list')
    expect(await call(runtime, 'history_restore', { steps: 1 })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('bounded history settings', () => {
  it('resolves ten turns, a sixty-second idle gap and a 32 MiB file cap, with workspace overrides', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(resolveSettings(unset, loadConfig({}).workspaceDefaults)).toMatchObject({ history: { keepTurns: 10, turnIdleMs: 60_000, maxFileBytes: 33_554_432 } })
    const own = WorkspaceSettingsSchema.parse({ version: 1, history: { keepTurns: 3, turnIdleMs: 5000, maxFileBytes: 2048 } })
    expect(resolveSettings(own, loadConfig({}).workspaceDefaults)).toMatchObject({ history: own.history, sources: { 'history.keepTurns': 'workspace' } })
    expect(loadConfig({}).historyMaxBytes).toBe(268_435_456)
  })
})
