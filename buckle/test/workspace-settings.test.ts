import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { PolicyError } from '../common/domain/policy.js'
import { credentialLikeName, defaultSettings, openSettingsFile, resolveSettings, variableNameRefusal, WorkspaceSettingsConflictError, WorkspaceSettingsError, WorkspaceSettingsInvalidError, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { loadConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// The workspace-model brief, item 2: each workspace's settings in its own workspace.json, a strict document the
// owner's CLI writes through the locked store, holding no credential.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-settings-'))
  roots.push(root)
  return root
}

describe('a workspace\'s settings', () => {
  // D85, Q3: a new workspace sets where its folder shows and nothing else, so every other setting is the node's, else Buckle's.
  it('start with the folder at /workspace, and every other setting unset', () => {
    expect(defaultSettings()).toEqual({
      version: 1, revision: 0, updatedAt: null,
      policy: emptyWorkspacePolicy(),
      mounts: [{ kind: 'workspace', target: '/workspace', access: 'write' }],
      env: {}, packs: {}, browser: {},
    })
    expect(resolveSettings(defaultSettings(), loadConfig({}).workspaceDefaults)).toMatchObject({
      mount: '/workspace',
      packs: { enabled: null, shell: true, code: true, hostGit: false, hostLsp: false },
      browser: { idleTimeoutMs: 300_000, headed: false },
      approvalWaitMs: 15_000,
      sources: { 'mount': 'workspace', 'packs.shell': 'built-in', 'approvalWaitMs': 'built-in' },
    })
  })

  // D85, Q3: per key, the workspace's own value, else the node's buckle.env value, else the built-in default.
  it('resolve each key as the workspace\'s, else the node\'s, else Buckle\'s, naming where each came from', () => {
    const node = loadConfig({ BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '0', BUCKLE_WORKSPACE_MOUNT: '/node' }).workspaceDefaults
    const own = WorkspaceSettingsSchema.parse({ version: 1, packs: { hostGit: false }, approvalWaitMs: 2_000 })
    expect(resolveSettings(own, node)).toMatchObject({
      mount: '/node', approvalWaitMs: 2_000,
      packs: { enabled: ['fs', 'shell'], shell: false, code: true, hostGit: false },
      sources: { 'mount': 'node', 'approvalWaitMs': 'workspace', 'packs.enabled': 'node', 'packs.shell': 'node', 'packs.code': 'built-in', 'packs.hostGit': 'workspace' },
    })
    // An empty value in buckle.env names nothing, as the node read it before.
    expect(resolveSettings(own, loadConfig({ BUCKLE_ALLOW_SHELL: '', BUCKLE_PACKS: '' }).workspaceDefaults)).toMatchObject({ packs: { enabled: null, shell: true }, sources: { 'packs.shell': 'built-in' } })
  })

  // D85, Q3: each workspace has its own variables, set over the node's key by key, its own winning.
  it('merge the workspace\'s variables over the node\'s key by key, its own winning', () => {
    const node = { ...loadConfig({}).workspaceDefaults, env: { REGION: 'node-region', LANG_HINT: 'en' } }
    const own = WorkspaceSettingsSchema.parse({ version: 1, env: { REGION: 'workspace-region', STAGE: 'dev' } })
    expect(resolveSettings(own, node).env).toEqual({ REGION: 'workspace-region', LANG_HINT: 'en', STAGE: 'dev' })
  })

  // D85, Q14: the tool lists resolve as the others do; the node's environment names none today, so this is the layer alone.
  it('resolve the tool lists as the others: the node\'s allowed tools where the workspace names none, its denied tools over the workspace\'s', () => {
    const base = loadConfig({}).workspaceDefaults
    const node = { ...base, policy: { ...base.policy, tools: { allow: ['fs_read', 'fs_list'], deny: ['shell_exec'] } } }
    expect(resolveSettings(WorkspaceSettingsSchema.parse({ version: 1 }), node).policy.tools).toEqual({ allow: ['fs_read', 'fs_list'], deny: ['shell_exec'] })
    const own = resolveSettings(WorkspaceSettingsSchema.parse({ version: 1, policy: { ...emptyWorkspacePolicy(), tools: { allow: [], deny: ['fs_write'] } } }), node)
    expect(own.policy.tools).toEqual({ allow: [], deny: ['shell_exec', 'fs_write'] })
    expect(own.sources).toMatchObject({ 'policy.tools.allow': 'workspace', 'policy.tools.deny': 'node' })
  })

  it('refuse a node setting the node would not read, naming the variable', () => {
    expect(() => loadConfig({ BUCKLE_COMMAND_DENY: 'curl ((' })).toThrow(/^Invalid BUCKLE_COMMAND_DENY: /)
    expect(() => loadConfig({ BUCKLE_WORKSPACE_MOUNT: '/usr/project' })).toThrow('Invalid BUCKLE_WORKSPACE_MOUNT: Cannot mount the workspace under /usr')
  })

  it.each([
    ['a key it does not know', { version: 1, tokens: [] }],
    ['the mount inside the policy, which mounts holds', { version: 1, policy: { ...emptyWorkspacePolicy(), mount: '/workspace' } }],
    ['a pack Buckle does not have', { version: 1, packs: { enabled: ['fs', 'teleport'] } }],
    ['an idle timeout under a minute', { version: 1, browser: { idleTimeoutMs: 59_999 } }],
    ['an idle timeout of 0', { version: 1, browser: { idleTimeoutMs: 0 } }],
    ['an idle timeout over a day', { version: 1, browser: { idleTimeoutMs: 86_400_001 } }],
    ['a second mount, before the mount phase', { version: 1, mounts: [{ kind: 'workspace', target: '/workspace', access: 'write' }, { kind: 'workspace', target: '/other', access: 'write' }] }],
    ['a mount under a folder the sandbox needs', { version: 1, mounts: [{ kind: 'workspace', target: '/usr/project', access: 'write' }] }],
    // Finding 25 of the Phase 1 review: a misspelled list used to be dropped, loosening the policy.
    ['a misspelled policy key', { version: 1, policy: { ...emptyWorkspacePolicy(), comands: { deny: ['git push*'] } } }],
    ['a misspelled command list', { version: 1, policy: { ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], Deny: ['git push*'] } } }],
    ['a misspelled URL list', { version: 1, policy: { ...emptyWorkspacePolicy(), network: { alow: ['https://only.example/**'] } } }],
  ])('refuse %s', (_case, document) => {
    expect(WorkspaceSettingsSchema.safeParse(document).success).toBe(false)
  })

  it('take an idle timeout of one minute and of one day', () => {
    for (const idleTimeoutMs of [60_000, 86_400_000]) expect(WorkspaceSettingsSchema.parse({ version: 1, browser: { idleTimeoutMs } }).browser.idleTimeoutMs).toBe(idleTimeoutMs)
  })
})

// Q13: a workspace's variables are plain settings for its commands; no secret reaches a command Buckle runs.
describe('a workspace variable\'s name', () => {
  // Q13: a credential-like name is taken but flagged (credentialLikeName), not refused.
  it.each(['GITHUB_TOKEN', 'NPM_AUTH_TOKEN', 'API_KEY', 'OPENAI_API_KEY', 'SSH_KEY', 'DB_PASSWORD', 'CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'KEYS'])('is taken but flagged as credential-like: %s', (name) => {
    expect(variableNameRefusal(name)).toBeNull()
    expect(credentialLikeName(name)).toBe(true)
  })

  it.each(['BUCKLE_ALLOW_SHELL', 'buckle_packs'])('is refused as a Buckle setting: %s', (name) => {
    expect(variableNameRefusal(name)).toContain('names a Buckle setting')
  })

  it.each(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'])('is refused where Buckle sets it for every command: %s', (name) => {
    expect(variableNameRefusal(name)).toContain('set by Buckle for every command')
  })

  it.each(['NODE_ENV', 'RUST_LOG', 'MONKEY', 'KEYBOARD_LAYOUT', 'LANG'])('is taken when it is a plain name: %s', (name) => {
    expect(variableNameRefusal(name)).toBeNull()
  })

  it.each(['1ABC', 'A-B', 'A B', ''])('is refused when it is no variable name: %j', (name) => {
    expect(variableNameRefusal(name)).toContain('is not a variable name')
  })
})

describe('the settings file', () => {
  it('reads as the defaults until something is written, and counts each write', async () => {
    const file = openSettingsFile({ filePath: join(scratch(), 'workspaces', 'site', 'workspace.json') })
    expect(file.read()).toEqual(defaultSettings())
    const written = await file.update(settings => ({ ...settings, approvalWaitMs: 60_000 }))
    expect(written).toMatchObject({ revision: 1, approvalWaitMs: 60_000, updatedAt: expect.any(String) })
    expect(file.read()).toEqual(written)
  })

  it('refuses a policy that does not compile, and a browser setting the node refuses, and keeps what was there', async () => {
    const filePath = join(scratch(), 'workspace.json')
    const file = openSettingsFile({ filePath })
    await file.update(settings => settings)
    const before = readFileSync(filePath, 'utf8')
    await expect(file.update(settings => ({ ...settings, policy: { ...settings.policy, network: { allow: ['*.127.0.0.1'] } } }))).rejects.toThrow(PolicyError)
    await expect(file.update(settings => ({ ...settings, browser: { ...settings.browser, cdp: '9222', profile: '/srv/profile' } }))).rejects.toThrow(WorkspaceSettingsInvalidError)
    await expect(file.update(settings => ({ ...settings, browser: { ...settings.browser, cdp: '9222', profile: '/srv/profile' } }))).rejects.toThrow('browser.cdp cannot be set with browser.profile')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  it('refuses a write against a revision another terminal moved past', async () => {
    const filePath = join(scratch(), 'workspace.json')
    const first = openSettingsFile({ filePath })
    const second = openSettingsFile({ filePath })
    await first.update(settings => ({ ...settings, approvalWaitMs: 1_000 }), 0)
    await expect(second.update(settings => ({ ...settings, approvalWaitMs: 2_000 }), 0)).rejects.toThrow(WorkspaceSettingsConflictError)
    expect(first.read().approvalWaitMs).toBe(1_000)
  })

  it('names the file and the fields of a document it cannot read, never a value', () => {
    const filePath = join(scratch(), 'workspace.json')
    writeFileSync(filePath, JSON.stringify({ version: 1, approvalWaitMs: 'a-value-never-shown' }))
    const read = () => openSettingsFile({ filePath }).read()
    expect(read).toThrow(WorkspaceSettingsError)
    expect(read).toThrow(`${filePath} at approvalWaitMs`)
    expect(read).not.toThrow('a-value-never-shown')
  })
})

describe('a workspace\'s runtime on its settings', () => {
  it('takes its packs, its approval wait, its policy, and where its folder shows from workspace.json', async () => {
    const root = scratch()
    for (const directory of ['default', 'site']) mkdirSync(join(root, directory))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state') })
    const manager = await workspacesOf(config)
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => ({
      ...settings,
      packs: { ...settings.packs, shell: false, code: false },
      approvalWaitMs: 0,
      policy: { ...settings.policy, commands: { ...settings.policy.commands, deny: ['curl *'] } },
      mounts: [{ kind: 'workspace', target: '/site', access: 'write' }],
    }))
    const { config: site, runtime } = await byName(manager, 'site')

    expect(site).toMatchObject({ enableShell: false, allowCode: false, approvalTimeoutMs: null })
    expect(runtime.manifest().packs.find(pack => pack.id === 'shell')?.unavailableReason).toBe('Shell tools are turned off in this workspace: its setting packs.shell is off')
    expect(runtime.policy.effective()).toMatchObject({ commands: { deny: ['curl *'] }, mount: '/site' })
    expect(runtime.paths().displayRoot).toBe('/site')
  })

  // D85, Q3: a setting a workspace leaves unset is the node's as buckle.env says it at each start; its own stays its own.
  it('takes a setting it leaves unset from buckle.env as it reads at each start, and keeps its own over it', async () => {
    const root = scratch()
    mkdirSync(join(root, 'site'))
    const environment = { BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none' }
    const first = await workspacesOf(loadConfig({ ...environment, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '5000' }))
    await registerWorkspace(first, { id: 'site', dir: join(root, 'site') })
    expect((await byName(first, 'site')).config).toMatchObject({ enableShell: false, approvalTimeoutMs: 5_000 })
    await first.updateSettings(idOf(first, 'site'), settings => ({ ...settings, approvalWaitMs: 7_000 }))
    await first.close()

    // buckle.env changed, and the node started again.
    const second = await workspacesOf(loadConfig({ ...environment, BUCKLE_ALLOW_SHELL: 'true', BUCKLE_APPROVAL_TIMEOUT_MS: '9000' }))
    expect((await byName(second, 'site')).config).toMatchObject({ enableShell: true, approvalTimeoutMs: 7_000 })
    await second.close()
  })

  // Finding 43 of the Phase 1 review: the node's path settings reached workspace default alone, which a node set up
  // fresh does not have, though the docs give them to every workspace; until the mount table holds them, each has them.
  it('takes the node\'s scratch roots, mounts, skill folders, and strict-writes setting, on a node with no workspace default', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(join(folder, 'scratch'), { recursive: true })
    mkdirSync(join(root, 'skills'))
    const node = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_SCRATCH_ROOTS: join(folder, 'scratch'), BUCKLE_SKILLS_DIRS: join(root, 'skills'), BUCKLE_STRICT_WRITES: 'true', BUCKLE_MOUNTS: '[{"source":"/etc/hostname","target":"/etc/hostname","readOnly":true}]' })
    const manager = await workspacesOf(node)
    await registerWorkspace(manager, { id: 'site', dir: folder })
    const { config, runtime } = await byName(manager, 'site')

    expect(config).toMatchObject({ scratchRoots: node.scratchRoots, sandboxMounts: node.sandboxMounts, skillDirectories: node.skillDirectories, strictWrites: true })
    const written = await runtime.invoke({ request: { requestId: 'scratch-write', tool: 'fs_write', args: { path: 'scratch/a.txt', content: 'x' }, approvalTokens: [] }, sessionId: 'site' })
    expect(written).toMatchObject({ outcome: 'ok' })
    await manager.close()
  })
})
