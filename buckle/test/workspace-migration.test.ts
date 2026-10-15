import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { loadConfig } from '../common/runtime/config.js'
import { tokenDigest } from '../common/services/access/tokens.js'
import { MigrationError, REGISTRY_BACKUP } from '../common/services/workspaces/migration.js'
import { openWorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'

// The workspace-model brief, item 1, Q14 and Q15: a node set up before the workspace model moves onto it at its first
// start, once. Its own folder becomes workspace default; every token is kept as its sha256; each workspace's admin
// credential goes; what the node enforced on each workspace is kept in that workspace's workspace.json, exactly, or
// the move refuses and changes nothing.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const NODE_TOKEN = 'node-agent-token-fixture-for-migration'
const SITE_TOKEN = 'site-agent-token-fixture-for-migration'
const SITE_ADMIN = 'site-admin-token-fixture-for-migration'
const NODE_ADMIN = 'node-admin-token-fixture-for-migration'

interface Scene { root: string; state: string; folder: string; site: string; environment: Record<string, string> }

function scene(environment: Record<string, string> = {}): Scene {
  const root = mkdtempSync(join(tmpdir(), 'buckle-migration-'))
  roots.push(root)
  const state = join(root, 'state')
  const folder = join(root, 'project')
  const site = join(root, 'site')
  for (const directory of [folder, site]) mkdirSync(directory)
  mkdirSync(state, { mode: 0o700 })
  return { root, state, folder, site, environment: { BUCKLE_WORKSPACE_ROOT: folder, BUCKLE_STATE_DIR: state, BUCKLE_AUTH_TOKEN: NODE_TOKEN, BUCKLE_ADMIN_TOKEN: NODE_ADMIN, ...environment } }
}

function policy(change: (value: WorkspacePolicy) => void = () => {}): WorkspacePolicy {
  const value = emptyWorkspacePolicy()
  change(value)
  return value
}

/** A version 1 registry, as 0.1 wrote it: clear tokens, an admin credential, the registration policy. */
function version1(input: Scene, workspace: { policy?: WorkspacePolicy; enabled?: boolean; retiredAt?: string | null } = {}): string {
  const text = JSON.stringify({ version: 1, workspaces: [{
    id: 'site', name: 'Site', root: input.site, adminToken: SITE_ADMIN,
    tokens: [{ id: 'initial', token: SITE_TOKEN, label: 'Registered', createdAt: '2026-10-01T00:00:00.000Z' }],
    policy: workspace.policy ?? policy(), enabled: workspace.enabled ?? true, retiredAt: workspace.retiredAt ?? null, updatedAt: '2026-10-01T00:00:00.000Z',
  }] }, null, 2)
  writeFileSync(join(input.state, 'workspaces.json'), text)
  return text
}

const open = (input: Scene, extra: Record<string, string> = {}) => openWorkspaceManager({ config: loadConfig({ ...input.environment, ...extra }) })
const settings = (input: Scene, id: string) => openSettingsFile({ filePath: settingsPath(input.state, id) }).read()
const registry = (input: Scene) => readFileSync(join(input.state, 'workspaces.json'), 'utf8')

describe('moving a 0.1 node onto the workspace model', () => {
  it('stores the node\'s own folder as workspace default, and keeps every token as its digest alone', async () => {
    const input = scene()
    const before = version1(input)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const manager = await open(input)

    expect(JSON.parse(registry(input))).toMatchObject({ version: 2, workspaces: [
      { id: 'default', dir: input.folder, online: true, tokens: [{ id: 'node', sha256: tokenDigest(NODE_TOKEN) }] },
      { id: 'site', name: 'Site', dir: input.site, online: true, tokens: [{ id: 'initial', sha256: tokenDigest(SITE_TOKEN), label: 'Registered' }] },
    ] })
    for (const secret of [NODE_TOKEN, SITE_TOKEN, SITE_ADMIN]) expect(registry(input)).not.toContain(secret)
    expect(registry(input)).not.toContain('adminToken')
    expect(readFileSync(join(input.state, REGISTRY_BACKUP), 'utf8')).toBe(before)
    expect(manager.tokenOwner(`Bearer ${NODE_TOKEN}`)).toEqual({ workspaceId: 'default', tokenId: 'node' })
    expect(manager.tokenOwner(`Bearer ${SITE_TOKEN}`)).toEqual({ workspaceId: 'site', tokenId: 'initial' })
    // The admin credential is the node's alone (D83): a workspace's old one opens nothing.
    expect(manager.authenticateAdmin(`Bearer ${SITE_ADMIN}`)).toBe(false)
    expect(manager.authenticateAdmin(`Bearer ${NODE_ADMIN}`)).toBe(true)
  })

  it('reads a retired workspace as offline', async () => {
    const input = scene()
    version1(input, { retiredAt: '2026-10-02T00:00:00.000Z', enabled: false })
    expect((await open(input)).list().find(workspace => workspace.id === 'site')).toMatchObject({ online: false })
  })

  it('copies the environment\'s settings into each workspace, the stored policy unioned into default\'s', async () => {
    const input = scene({ BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,web', BUCKLE_APPROVAL_TIMEOUT_MS: '0', BUCKLE_COMMAND_DENY: 'curl *', BUCKLE_WORKSPACE_MOUNT: '/project' })
    writeFileSync(join(input.state, 'policy.json'), JSON.stringify({ version: 1, workspaces: { [input.folder]: policy(value => { value.commands.deny = ['wget *'] }) } }))
    version1(input)
    await open(input)

    const own = settings(input, 'default')
    expect(own.packs).toMatchObject({ enabled: ['fs', 'web'], shell: false })
    expect(own.approvalWaitMs).toBe(0)
    expect(own.policy.commands.deny).toEqual(['curl *', 'wget *'])
    expect(own.mounts).toEqual([{ kind: 'workspace', target: '/project', access: 'write' }])
    const site = settings(input, 'site')
    expect(site.packs).toMatchObject({ enabled: ['fs', 'web'], shell: false })
    expect(site.policy.commands.deny).toEqual(['curl *'])
    expect(site.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'write' }])
  })

  it('keeps a folder with no mount showing its real path, as the node showed it', async () => {
    const input = scene()
    await open(input)
    expect(settings(input, 'default').mounts).toEqual([])
  })

  // Q14: the node's lists were a ceiling over each registered workspace; one list per workspace keeps exactly what both admitted.
  it.each([
    ['the node\'s allow list where the workspace has none', { BUCKLE_COMMAND_ALLOW: 'pnpm *' }, policy(), { allow: ['pnpm *'] }],
    ['the workspace\'s narrower allow list', { BUCKLE_COMMAND_ALLOW: 'pnpm *;;git *' }, policy(value => { value.commands.allow = ['pnpm *'] }), { allow: ['pnpm *'] }],
    ['the node\'s narrower allow list', { BUCKLE_COMMAND_ALLOW: 'pnpm *' }, policy(value => { value.commands.allow = ['pnpm *', 'git *'] }), { allow: ['pnpm *'] }],
    ['both deny lists', { BUCKLE_COMMAND_DENY: 'curl *' }, policy(value => { value.commands.deny = ['rm *'] }), { deny: ['curl *', 'rm *'] }],
    ['the interpreters both allow', { BUCKLE_ALLOWED_INTERPRETERS: 'node' }, policy(value => { value.commands.allowedInterpreters = ['node', 'python3'] }), { allowedInterpreters: ['node'] }],
    ['no interpreter where the node allowed none', {}, policy(value => { value.commands.allowedInterpreters = ['node'] }), { allowedInterpreters: [] }],
  ] as const)('keeps %s', async (_case, environment, own, commands) => {
    const input = scene(environment)
    version1(input, { policy: own })
    await open(input)
    expect(settings(input, 'site').policy.commands).toMatchObject(commands)
  })

  it('refuses where no one list admits exactly what both did, naming the workspace and the lists, and changes nothing', async () => {
    const input = scene({ BUCKLE_NETWORK_ALLOW: 'a.example', BUCKLE_COMMAND_ALLOW: 'pnpm *' })
    const before = version1(input, { policy: policy(value => { value.network.allow = ['b.example']; value.commands.allow = ['git *'] }) })
    const failure = await open(input).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(MigrationError)
    expect((failure as Error).message).toContain('workspace site: the command allow lists and the approved URL lists')
    expect(registry(input)).toBe(before)
    for (const id of ['default', 'site']) expect(existsSync(settingsPath(input.state, id))).toBe(false)
  })

  // A registered workspace's switch took effect only while the node's own was on; with that gate gone (Q14) a switch
  // the gate held off would turn on, so it moves only where the node's was on.
  it.each([[true, true], [false, false]])('keeps a registered workspace\'s dangerously-allow switch only where the node\'s was on (node on: %s)', async (nodeOn, kept) => {
    const input = scene()
    version1(input)
    const on = { on: true, changedAt: '2026-10-01T00:00:00.000Z' }
    if (nodeOn) writeFileSync(join(input.state, 'dangerously-allow.json'), JSON.stringify({ version: 1, workspaces: { [input.folder]: on } }))
    mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
    writeFileSync(join(input.state, 'workspaces', 'site', 'dangerously-allow.json'), JSON.stringify({ version: 1, workspaces: { [input.site]: on } }))
    const manager = await open(input)

    expect((await manager.resolve('site')).runtime.policy.dangerouslyAllow().on).toBe(kept)
    expect((await manager.resolve('default')).runtime.policy.dangerouslyAllow().on).toBe(nodeOn)
  })

  it('moves grants from the folder they were kept under to the workspace\'s id', async () => {
    const input = scene()
    const grant = { id: 'grant-1', workspace: input.folder, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }
    writeFileSync(join(input.state, 'grants.json'), JSON.stringify({ version: 1, grants: [grant, { ...grant, id: 'grant-2', workspace: '/elsewhere' }] }))
    const manager = await open(input)

    expect((await manager.resolve('default')).runtime.grants.list().map(item => item.id)).toEqual(['grant-1'])
    expect(JSON.parse(readFileSync(join(input.state, 'grants.json'), 'utf8')).grants.map((item: { workspace: string }) => item.workspace)).toEqual(['default', '/elsewhere'])
  })

  it('reads the environment once: a later start\'s workspace settings change nothing', async () => {
    const input = scene({ BUCKLE_ALLOW_SHELL: 'false' })
    await open(input)
    await open(input, { BUCKLE_ALLOW_SHELL: 'true', BUCKLE_COMMAND_ALLOW: 'curl *' })
    expect(settings(input, 'default').packs.shell).toBe(false)
    expect(settings(input, 'default').policy.commands.allow).toEqual([])
  })

  it('refuses where the node\'s folder would overlap a registered workspace, and changes nothing', async () => {
    const input = scene()
    input.environment.BUCKLE_WORKSPACE_ROOT = input.site
    const before = version1(input)
    await expect(open(input)).rejects.toThrow('overlaps workspace site')
    expect(registry(input)).toBe(before)
  })

  it('gives a state directory that never served a folder no workspace at all', async () => {
    const input = scene()
    const fresh = { BUCKLE_STATE_DIR: input.state }
    const manager = await openWorkspaceManager({ config: loadConfig(fresh) })
    expect(manager.list()).toEqual([])
    expect(JSON.parse(registry(input))).toEqual({ version: 2, workspaces: [] })
  })
})
