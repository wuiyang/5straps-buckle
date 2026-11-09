import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { loadConfig, unreadWorkspaceDefaults } from '../common/runtime/config.js'
import { defaultSettings, openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// The delete policy brief, item 1 and 2: files.deleteInWorkspace (allow, Buckle's default, or ask) and
// files.massDeleteLimit (100 by default, 0 for no limit), per workspace over the node's BUCKLE_DELETE_IN_WORKSPACE and
// BUCKLE_MASS_DELETE_LIMIT, which a node reads from its environment file alone, as every workspace default.

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-delete-settings-')))
  roots.push(root)
  return root
}

function captured() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  return { out: () => out, err: () => err, clear: () => { out = ''; err = '' } }
}

describe('a workspace\'s delete policy', () => {
  it('is its own, else the node\'s, else allow with a limit of 100, naming where each came from', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(resolveSettings(unset, loadConfig({}).workspaceDefaults)).toMatchObject({ files: { deleteInWorkspace: 'allow', massDeleteLimit: 100 }, sources: { 'files.deleteInWorkspace': 'built-in', 'files.massDeleteLimit': 'built-in' } })
    const node = loadConfig({ BUCKLE_DELETE_IN_WORKSPACE: 'ask', BUCKLE_MASS_DELETE_LIMIT: '0' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ files: { deleteInWorkspace: 'ask', massDeleteLimit: 0 }, sources: { 'files.deleteInWorkspace': 'node', 'files.massDeleteLimit': 'node' } })
    const own = WorkspaceSettingsSchema.parse({ version: 1, files: { deleteInWorkspace: 'allow', massDeleteLimit: 250 } })
    expect(resolveSettings(own, node)).toMatchObject({ files: { deleteInWorkspace: 'allow', massDeleteLimit: 250 }, sources: { 'files.deleteInWorkspace': 'workspace', 'files.massDeleteLimit': 'workspace' } })
  })

  it('is absent from a new workspace\'s file, and holds no mode outside the two, no limit outside 0 to 10000, and no other key', () => {
    expect(defaultSettings()).not.toHaveProperty('files')
    for (const files of [{ deleteInWorkspace: 'never' }, { massDeleteLimit: -1 }, { massDeleteLimit: 10_001 }, { massDeleteLimit: 1.5 }, { deleteOutside: 'allow' }]) {
      expect(() => WorkspaceSettingsSchema.parse({ version: 1, files }), JSON.stringify(files)).toThrow()
    }
    expect(WorkspaceSettingsSchema.parse({ version: 1, files: { massDeleteLimit: 10_000 } }).files).toEqual({ massDeleteLimit: 10_000 })
  })

  it('comes from the node\'s environment file alone, and a value the node refuses stops it, naming the variable', () => {
    const caller = { BUCKLE_DELETE_IN_WORKSPACE: 'ask', BUCKLE_MASS_DELETE_LIMIT: '5' }
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller }
    expect(loadConfig({ ...caller }, process.platform, layers).workspaceDefaults.files).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_DELETE_IN_WORKSPACE', 'BUCKLE_MASS_DELETE_LIMIT'])
    expect(() => loadConfig({ BUCKLE_DELETE_IN_WORKSPACE: 'sometimes' })).toThrow('Invalid BUCKLE_DELETE_IN_WORKSPACE: allow or ask')
    expect(() => loadConfig({ BUCKLE_MASS_DELETE_LIMIT: 'lots' })).toThrow('Invalid BUCKLE_MASS_DELETE_LIMIT: entries, 0 to 10000, 0 for no limit')
    expect(() => loadConfig({ BUCKLE_MASS_DELETE_LIMIT: '20000' })).toThrow('Invalid BUCKLE_MASS_DELETE_LIMIT')
  })

  it('reaches the runtime\'s configuration, as every other setting in force does', () => {
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: scratch() })).toMatchObject({ deleteInWorkspace: 'allow', massDeleteLimit: 100 })
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: scratch(), BUCKLE_DELETE_IN_WORKSPACE: 'ask', BUCKLE_MASS_DELETE_LIMIT: '7' })).toMatchObject({ deleteInWorkspace: 'ask', massDeleteLimit: 7 })
  })
})

describe('buckle workspace set files.*', () => {
  async function workspace() {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'delete-settings-admin-credential', BUCKLE_SANDBOX: 'none' })
    const output = captured()
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().files
    output.clear()
    return { buckle, output, stored, manager }
  }

  it('stores an own value, shows it with its source, and unset takes it out, with the block once it is empty', async () => {
    const { buckle, output, stored, manager } = await workspace()
    await buckle(['show'])
    expect(output.out()).toMatch(/files\.deleteInWorkspace +allow +built-in/)
    expect(output.out()).toMatch(/files\.massDeleteLimit +100 +built-in/)
    expect(output.out()).toMatch(/files\.deleteInWorkspace +allow or ask/)
    expect((await buckle(['set', 'files.deleteInWorkspace', 'Ask'])).exitCode).toBe(0)
    expect((await buckle(['set', 'files.massDeleteLimit', '0'])).exitCode).toBe(0)
    expect(stored()).toEqual({ deleteInWorkspace: 'ask', massDeleteLimit: 0 })
    output.clear()
    await buckle(['show'])
    expect(output.out()).toMatch(/files\.deleteInWorkspace +ask +workspace/)
    expect(output.out()).toMatch(/files\.massDeleteLimit +0 \(no limit\) +workspace/)
    expect((await buckle(['unset', 'files.deleteInWorkspace'])).exitCode).toBe(0)
    expect(stored()).toEqual({ massDeleteLimit: 0 })
    expect((await buckle(['unset', 'files.massDeleteLimit'])).exitCode).toBe(0)
    expect(stored()).toBeUndefined()
    await manager.close()
  })

  it.each([
    ['files.deleteInWorkspace', 'never', 'files.deleteInWorkspace is allow or ask'],
    ['files.massDeleteLimit', '-1', 'files.massDeleteLimit is entries, 0 to 10000, 0 for no limit'],
    ['files.massDeleteLimit', '10001', 'files.massDeleteLimit is entries'],
  ])('refuses %s %s, writing nothing', async (key, value, refusal) => {
    const { buckle, output, stored, manager } = await workspace()
    expect((await buckle(['set', key, value])).exitCode).toBe(1)
    expect(output.err()).toContain(refusal)
    expect(stored()).toBeUndefined()
    await manager.close()
  })
})

describe('buckle settings and the delete policy', () => {
  function node() {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\n`, { mode: 0o600 })
    const settings = async (argv: string[]) => {
      const output = captured()
      const result = await settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })
      vi.restoreAllMocks()
      return { ...result, out: output.out(), printed: output.out() + output.err() }
    }
    return { file, settings }
  }

  it('lists both among the workspace defaults, writes them, and refuses a value outside them', async () => {
    const { file, settings } = node()
    const shown = await settings(['show'])
    const defaults = shown.out.slice(shown.out.indexOf('Workspace defaults'))
    expect(defaults).toMatch(/delete-in-workspace\s+BUCKLE_DELETE_IN_WORKSPACE\s+allow\s+default/)
    expect(defaults).toMatch(/mass-delete-limit\s+BUCKLE_MASS_DELETE_LIMIT\s+100\s+default/)
    expect((await settings(['set', 'delete-in-workspace', 'ASK'])).exitCode).toBe(0)
    expect((await settings(['set', 'mass-delete-limit', ' 25 '])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('BUCKLE_DELETE_IN_WORKSPACE=ask\nBUCKLE_MASS_DELETE_LIMIT=25\n')
    expect(resolveSettings(WorkspaceSettingsSchema.parse({ version: 1 }), loadConfig(parseEnv(readFileSync(file, 'utf8'))).workspaceDefaults).files).toEqual({ deleteInWorkspace: 'ask', massDeleteLimit: 25 })
    const refused = await settings(['set', 'mass-delete-limit', 'many'])
    expect(refused.exitCode).toBe(1)
    expect(refused.printed).toContain('BUCKLE_MASS_DELETE_LIMIT is entries, 0 to 10000, 0 for no limit')
    expect((await settings(['set', 'delete-in-workspace', 'never'])).printed).toContain('BUCKLE_DELETE_IN_WORKSPACE is allow or ask')
  })
})
