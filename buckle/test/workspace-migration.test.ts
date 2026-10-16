import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { generateSigningKey, signingKeyFromPem, signRequest } from '@5straps/protocol/signed-request'
import { openFileNonceStore } from '../common/adapters/approval/file-nonce-store.js'
import { createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { createRequestVerifier } from '../common/services/access/signed-requests.js'
import { StateFileError } from '../common/adapters/json-file-store.js'
import { readStoredPolicies } from '../common/adapters/policy-store/file-policy-store.js'
import { loadConfig } from '../common/runtime/config.js'
import { tokenDigest } from '../common/services/access/tokens.js'
import { logger } from '../common/runtime/log.js'
import { migrateNode, MigrationError, REGISTRY_BACKUP } from '../common/services/workspaces/migration.js'
import { openWorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { workspaceIdFor } from '../common/services/workspaces/workspace-id.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { byName, workspaceIdOf } from './support/workspaces.js'

// The workspace-model brief, item 1, and D85, Q3, Q14, and Q15: a node set up before the workspace model moves onto it at
// its first start, once. Its own folder becomes a workspace named after the folder, with an id derived from it, and its
// records move to the workspace's own directory; every token is kept as its sha256; each workspace's admin credential
// goes; each workspace.json holds what was the workspace's own, and the node's settings stay in its environment file as
// every workspace's defaults, copied into none.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const NODE_TOKEN = 'node-agent-token-fixture-for-migration'
const SITE_TOKEN = 'site-agent-token-fixture-for-migration'
const SITE_ADMIN = 'site-admin-token-fixture-for-migration'
const NODE_ADMIN = 'node-admin-token-fixture-for-migration'

interface Scene { root: string; state: string; folder: string; site: string; environment: Record<string, string> }

function scene(environment: Record<string, string> = {}): Scene {
  // A real path: the move names each folder as the disk does, and on macOS the temp folder is reached through a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-migration-')))
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
/** The ids the node's folder and the registered site derive (D85, Q15), which their records are keyed by. */
const ownId = (input: Scene) => workspaceIdOf(input.folder)
const siteId = (input: Scene) => workspaceIdOf(input.site)
const registry = (input: Scene) => readFileSync(join(input.state, 'workspaces.json'), 'utf8')

describe('moving a 0.1 node onto the workspace model', () => {
  it('stores the node\'s own folder as a workspace named after it, keyed by the id it derives, and keeps every token as its digest alone', async () => {
    const input = scene()
    const before = version1(input)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const manager = await open(input)

    expect(JSON.parse(registry(input))).toMatchObject({ version: 2, workspaces: [
      { id: ownId(input), name: 'project', dir: input.folder, online: true, tokens: [{ id: 'node', sha256: tokenDigest(NODE_TOKEN) }] },
      // D85, Q15: the node's folder is named after it, and a registered workspace after its 0.1 id, the handle its MCP configs name.
      { id: siteId(input), name: 'site', dir: input.site, online: true, tokens: [{ id: 'initial', sha256: tokenDigest(SITE_TOKEN), label: 'Registered' }] },
    ] })
    for (const secret of [NODE_TOKEN, SITE_TOKEN, SITE_ADMIN]) expect(registry(input)).not.toContain(secret)
    expect(registry(input)).not.toContain('adminToken')
    expect(readFileSync(join(input.state, REGISTRY_BACKUP), 'utf8')).toBe(before)
    expect(manager.tokenOwner(`Bearer ${NODE_TOKEN}`)).toEqual({ workspaceId: ownId(input), tokenId: 'node' })
    expect(manager.tokenOwner(`Bearer ${SITE_TOKEN}`)).toEqual({ workspaceId: siteId(input), tokenId: 'initial' })
    // The records of the node's folder are in its own directory now (D85, Q15); the registered site's moved beside its 0.1 folder.
    expect(existsSync(settingsPath(input.state, ownId(input)))).toBe(true)
    expect(existsSync(settingsPath(input.state, siteId(input)))).toBe(true)
    // The admin credential is the node's alone (D83): a workspace's old one opens nothing.
    expect(manager.authenticateAdmin(`Bearer ${SITE_ADMIN}`)).toBe(false)
    expect(manager.authenticateAdmin(`Bearer ${NODE_ADMIN}`)).toBe(true)
  })

  it('says what a registered workspace was shown as before, where that was not its id, and how to rename it', async () => {
    const input = scene()
    version1(input)
    const notices = vi.spyOn(logger, 'warn')
    await open(input)
    expect(notices.mock.calls.map(([message]) => String(message))).toContainEqual('Workspace site was shown as Site before; its name is now site, the handle --workspace takes, and buckle workspace rename site <name> gives it another.')
  })

  it('reads a retired workspace as offline', async () => {
    const input = scene()
    version1(input, { retiredAt: '2026-10-02T00:00:00.000Z', enabled: false })
    expect((await open(input)).list().find(workspace => workspace.id === siteId(input))).toMatchObject({ online: false })
  })

  // D85, Q3 and Q14: the move copies no node setting into any workspace.json and intersects nothing; a registered
  // workspace's scalars were never its own, so they stay unset and follow the node's.
  it('copies none of the environment\'s settings into a workspace, leaving each workspace\'s own alone, and every other setting the node\'s', async () => {
    const input = scene({ BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,web', BUCKLE_APPROVAL_TIMEOUT_MS: '0', BUCKLE_COMMAND_DENY: 'curl *', BUCKLE_WORKSPACE_MOUNT: '/project' })
    writeFileSync(join(input.state, 'policy.json'), JSON.stringify({ version: 1, workspaces: { [input.folder]: policy(value => { value.commands.deny = ['wget *'] }) } }))
    version1(input)
    const notices = vi.spyOn(logger, 'warn')
    const manager = await open(input)

    expect(notices.mock.calls.map(([message]) => String(message)).filter(message => message.includes('copied'))).toEqual([])
    const own = settings(input, ownId(input))
    expect(own.packs).toEqual({})
    expect(own).not.toHaveProperty('approvalWaitMs')
    expect(own).not.toHaveProperty('mounts')
    expect(own.policy.commands).toMatchObject({ allow: [], deny: ['wget *'] })
    const site = settings(input, siteId(input))
    expect(site.packs).toEqual({})
    expect(site).not.toHaveProperty('approvalWaitMs')
    expect(site.policy.commands).toMatchObject({ allow: [], deny: [] })
    expect(site.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'write' }])
    // In force, each takes the node's settings, and the node's deny list over its own.
    expect((await byName(manager, 'project')).config).toMatchObject({ enableShell: false, enabledPacks: ['fs', 'web'], approvalTimeoutMs: null, policy: { mount: '/project', commands: { deny: ['curl *', 'wget *'] } } })
    expect((await byName(manager, 'site')).config).toMatchObject({ enableShell: false, enabledPacks: ['fs', 'web'], approvalTimeoutMs: null, policy: { mount: '/workspace', commands: { deny: ['curl *'] } } })
  })

  it('keeps a folder with no mount of its own showing where the node says, its real path where the node names none', async () => {
    const input = scene()
    const manager = await open(input)
    expect(settings(input, ownId(input))).not.toHaveProperty('mounts')
    expect((await byName(manager, 'project')).config.policy.mount).toBeNull()
  })

  // D85, Q14: a workspace's own lists are kept as they were, and the node's stay the node's; nothing is intersected.
  it.each([
    ['no allow list of its own, which takes the node\'s', { BUCKLE_COMMAND_ALLOW: 'pnpm *' }, policy(), { allow: [] }, { allow: ['pnpm *'] }],
    ['its own allow list, which it uses alone', { BUCKLE_COMMAND_ALLOW: 'pnpm *;;git *' }, policy(value => { value.commands.allow = ['make *'] }), { allow: ['make *'] }, { allow: ['make *'] }],
    ['its own deny list, under the node\'s', { BUCKLE_COMMAND_DENY: 'curl *' }, policy(value => { value.commands.deny = ['rm *'] }), { deny: ['rm *'] }, { deny: ['curl *', 'rm *'] }],
    ['its own interpreters, which it uses alone', { BUCKLE_ALLOWED_INTERPRETERS: 'python3', BUCKLE_COMMAND_DENY: 'curl *' }, policy(value => { value.commands.allowedInterpreters = ['node'] }), { allowedInterpreters: ['node'] }, { allowedInterpreters: ['node'], deny: ['curl *'] }],
    ['no interpreter list of its own, which takes the node\'s', { BUCKLE_ALLOWED_INTERPRETERS: 'python3', BUCKLE_COMMAND_DENY: 'curl *' }, policy(), { deny: [] }, { allowedInterpreters: ['python3'], deny: ['curl *'] }],
  ] as const)('moves a registered workspace with %s, refusing nothing', async (_case, environment, own, stored, inForce) => {
    const input = scene(environment)
    version1(input, { policy: own })
    const manager = await open(input)
    expect(settings(input, siteId(input)).policy.commands).toMatchObject(stored)
    expect((await byName(manager, 'site')).runtime.policy.effective().commands).toMatchObject(inForce)
  })

  it('says where a workspace\'s own allow-type lists now stand alone beside the node\'s, which were a ceiling over them', async () => {
    const input = scene({ BUCKLE_NETWORK_ALLOW: 'a.example', BUCKLE_COMMAND_ALLOW: 'pnpm *' })
    version1(input, { policy: policy(value => { value.network.allow = ['b.example']; value.commands.allow = ['git *'] }) })
    const notices = vi.spyOn(logger, 'warn')
    const manager = await open(input)

    expect(notices.mock.calls.map(([message]) => String(message))).toContainEqual('Workspace site keeps its own command allow list and approved URL list, which it now uses alone: the node\'s BUCKLE_COMMAND_ALLOW and BUCKLE_NETWORK_ALLOW apply only to a workspace without one of its own (docs/workspaces-02.md). Add to its list with buckle policy where it needs what the node\'s admitted.')
    expect((await byName(manager, 'site')).runtime.policy.effective()).toMatchObject({ commands: { allow: ['git *'] }, network: { allow: ['b.example'] } })
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

    expect((await byName(manager, 'site')).runtime.policy.dangerouslyAllow().on).toBe(kept)
    expect((await byName(manager, 'project')).runtime.policy.dangerouslyAllow().on).toBe(nodeOn)
  })

  it('moves grants from the folder they were kept under to the workspace\'s id', async () => {
    const input = scene()
    const grant = { id: 'grant-1', workspace: input.folder, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }
    writeFileSync(join(input.state, 'grants.json'), JSON.stringify({ version: 1, grants: [grant, { ...grant, id: 'grant-2', workspace: '/elsewhere' }] }))
    const manager = await open(input)

    expect((await byName(manager, 'project')).runtime.grants.list().map(item => item.id)).toEqual(['grant-1'])
    // Moved to the workspace's own directory, keyed by its id (D85, Q15); the node's directory keeps the copy for going back alone.
    expect(existsSync(join(input.state, 'grants.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(input.state, 'workspaces', ownId(input), 'grants.json'), 'utf8')).grants.map((item: { workspace: string }) => item.workspace)).toEqual([ownId(input), '/elsewhere'])
  })

  // D85, Q3: the node's settings stay in its environment, so a later start's apply where a workspace sets none.
  it('leaves the node\'s settings in its environment, so a later start\'s apply where a workspace sets none of its own', async () => {
    const input = scene({ BUCKLE_ALLOW_SHELL: 'false' })
    await open(input)
    const later = await open(input, { BUCKLE_ALLOW_SHELL: 'true', BUCKLE_COMMAND_ALLOW: 'curl *' })
    expect(settings(input, ownId(input)).packs).toEqual({})
    expect((await byName(later, 'project')).config).toMatchObject({ enableShell: true, policy: { commands: { allow: ['curl *'] } } })
  })

  it('refuses where the node\'s folder would overlap a registered workspace, and changes nothing', async () => {
    const input = scene()
    input.environment.BUCKLE_WORKSPACE_ROOT = input.site
    const before = version1(input)
    await expect(open(input)).rejects.toThrow('overlaps workspace site')
    expect(registry(input)).toBe(before)
  })

  it.each([
    ['a list that is no list', '{"version": 1, "workspaces": "not a list"}'],
    ['an entry missing its fields', '{"version": 1, "workspaces": [{"id": "site"}]}'],
  ])('refuses a version 1 registry holding %s as a registry that will not read, and changes nothing', async (_label, text) => {
    const input = scene()
    writeFileSync(join(input.state, 'workspaces.json'), text)
    await expect(open(input)).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRY_UNREADABLE', status: 409 })
    expect(registry(input)).toBe(text)
    expect(existsSync(join(input.state, REGISTRY_BACKUP))).toBe(false)
  })

  // Finding 34 of the Phase 1 review: the first command after an upgrade may be an agent client's `buckle mcp`, whose
  // MCP config env would otherwise become every workspace's settings for good.
  describe('reading the node\'s environment file alone', () => {
    const FILE = { BUCKLE_ALLOW_SHELL: 'false', BUCKLE_COMMAND_DENY: 'curl *', BUCKLE_NETWORK_ALLOW: 'api.example.com' }
    function fromFile(input: Scene, caller: Record<string, string>) {
      const values = { ...input.environment, ...FILE }
      const path = join(input.root, 'buckle.env')
      return openWorkspaceManager({ config: loadConfig({ ...values, ...caller }, process.platform, { file: { path, values }, caller }) })
    }

    // D85, Q3: the move writes none of the node's settings into a workspace.json, so a caller's env, an ordinary override
    // of a node setting for that command, can make none of them a workspace's for good, and refuses nothing.
    it('writes none of the file\'s settings, nor the caller\'s, into a workspace, and moves a caller that sets a workspace key otherwise', async () => {
      const input = scene()
      version1(input)
      await fromFile(input, { BUCKLE_STATE_DIR: input.state, BUCKLE_ALLOW_SHELL: 'true', BUCKLE_NETWORK_ALLOW: '', BUCKLE_PACKS: 'fs' })
      expect(settings(input, siteId(input))).toMatchObject({ packs: {}, policy: { commands: { allow: [], deny: [] }, network: { allow: [] } } })
      expect(JSON.parse(registry(input))).toMatchObject({ version: 2 })
    })

    it('refuses a 0.1 node whose token and folder its caller names but its file does not, rather than leave it no workspace', async () => {
      const input = scene()
      const path = join(input.root, 'buckle.env')
      const values = { BUCKLE_SERVER_NAME: 'Set up in the shell' }
      const caller = { BUCKLE_STATE_DIR: input.state, BUCKLE_AUTH_TOKEN: NODE_TOKEN, BUCKLE_WORKSPACE_ROOT: input.folder }
      await expect(openWorkspaceManager({ config: loadConfig({ ...values, ...caller }, process.platform, { file: { path, values }, caller }) }))
        .rejects.toThrow('BUCKLE_AUTH_TOKEN, BUCKLE_WORKSPACE_ROOT are set in this command\'s environment to another value than')
      expect(existsSync(join(input.state, 'workspaces.json'))).toBe(false)
    })

    // Fix brief 4, finding 8: 0.1 enforced a deny list its caller's env set over the file, and the move dropped it with a warning alone.
    it.each([
      ['another deny entry', { BUCKLE_COMMAND_DENY: 'wget *' }, ['BUCKLE_COMMAND_DENY']],
      ['an empty deny list', { BUCKLE_COMMAND_DENY: '' }, ['BUCKLE_COMMAND_DENY']],
      ['a destructive list the file has not', { BUCKLE_COMMAND_DESTRUCTIVE: 'make deploy*' }, ['BUCKLE_COMMAND_DESTRUCTIVE']],
      ['both lists otherwise', { BUCKLE_COMMAND_DENY: 'curl *;;wget *', BUCKLE_COMMAND_DESTRUCTIVE: 'make deploy*' }, ['BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE']],
    ])('refuses a move whose caller sets %s, naming the keys and the repair, never a value, and changes nothing', async (_case, lists, keys) => {
      const input = scene()
      const before = version1(input)
      const refused = await fromFile(input, { BUCKLE_STATE_DIR: input.state, ...lists }).catch((error: unknown) => error)

      expect(refused).toBeInstanceOf(MigrationError)
      const message = (refused as Error).message
      expect(message).toContain(`${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} set in this command's environment to other entries than the node's environment file holds`)
      for (const key of keys) expect(message).toContain(`buckle settings set ${key} '<globs separated by ;;>'`)
      for (const value of ['curl', 'wget', 'make deploy', input.root]) expect(message).not.toContain(value)
      expect(registry(input)).toBe(before)
      expect(existsSync(join(input.state, REGISTRY_BACKUP))).toBe(false)
    })

    it('moves a caller whose deny list holds the file\'s entries, spelled otherwise', async () => {
      const input = scene()
      version1(input)
      await fromFile(input, { BUCKLE_STATE_DIR: input.state, BUCKLE_COMMAND_DENY: ' curl * ;;', BUCKLE_COMMAND_DESTRUCTIVE: '' })
      expect(JSON.parse(registry(input))).toMatchObject({ version: 2 })
    })

    it('leaves a node that served nothing as it is, whatever workspace key its caller sets', async () => {
      const input = scene()
      const path = join(input.root, 'buckle.env')
      const values = { BUCKLE_SERVER_NAME: 'Fresh node' }
      const caller = { BUCKLE_STATE_DIR: input.state, BUCKLE_ALLOW_SHELL: 'false' }
      const manager = await openWorkspaceManager({ config: loadConfig({ ...values, ...caller }, process.platform, { file: { path, values }, caller }) })
      expect(manager.list()).toEqual([])
    })
  })

  // Findings 3, 17, 18, and 19 of the Phase 1 review: the move reads and checks everything before it writes anything.
  describe('checking everything before it writes', () => {
    const LONG = `${'project folder '.repeat(8)}with a long name`.trim()

    it('cuts a folder name the registry would refuse at a word\'s end, saying so, so the registry it writes reads', async () => {
      const input = scene()
      const folder = join(input.root, LONG)
      mkdirSync(folder)
      input.environment.BUCKLE_WORKSPACE_ROOT = folder
      version1(input)
      const notices = vi.spyOn(logger, 'warn')
      const manager = await open(input)
      const name = manager.list().find(workspace => workspace.id === workspaceIdOf(folder))!.name
      expect(name).toBe('project folder '.repeat(8).trim())
      expect(notices.mock.calls.some(([message]) => String(message).includes(`The node's folder ${folder}'s name was ${LONG.length} characters, more than the 120 a workspace name holds, so it is named ${name}`))).toBe(true)
      await expect(open(input)).resolves.toBeDefined()
    })

    // Recheck of the workspace-model fix round 1 (the name cut): LONG above ends its 120th character on a space, so a plain 120-character cut passes it too.
    it.each([
      ['a name whose 120th character falls inside a word, cut at the word before', `${'alpha beta gamma '.repeat(7)}deltaepsilonzeta`, 'alpha beta gamma '.repeat(7).trim()],
      ['a name with no separator at all, cut at 120 characters', 'x'.repeat(130), 'x'.repeat(120)],
      ['a name whose only separator is in its first half, cut at 120 characters', `ab ${'x'.repeat(130)}`, `ab ${'x'.repeat(117)}`],
    ])('cuts %s', async (_label, folderName, expected) => {
      const input = scene()
      const folder = join(input.root, folderName)
      mkdirSync(folder)
      input.environment.BUCKLE_WORKSPACE_ROOT = folder
      version1(input)
      const notices = vi.spyOn(logger, 'warn')
      const manager = await open(input)
      const name = manager.list().find(workspace => workspace.id === workspaceIdOf(folder))!.name
      expect(name).toBe(expected)
      expect(notices.mock.calls.some(([message]) => String(message).includes(`was ${folderName.length} characters, more than the 120 a workspace name holds, so it is named ${expected}`))).toBe(true)
    })

    // Fix brief 4, finding 2: the question said a registered workspace was named node already, when none was.
    it.each([
      ['node', 'node is reserved'],
      ['3f2a1c2e-8b4d-4f0a-9c7e-2d5b1a8f3c6e', 'cannot be a workspace name'],
    ])('asks for another name for a node folder called %s, saying why its own cannot be used, and takes the answer', async (folderName, why) => {
      const input = scene()
      const folder = join(input.root, folderName)
      mkdirSync(folder)
      input.environment.BUCKLE_WORKSPACE_ROOT = folder
      version1(input)
      const asked: string[] = []
      await migrateNode({ node: loadConfig(input.environment), askName: async (question) => { asked.push(question); return 'the node folder' } })

      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain(why)
      expect(asked[0]).not.toContain('a registered workspace is named')
      expect(JSON.parse(registry(input)).workspaces.map((workspace: { name: string }) => workspace.name)).toEqual(['the node folder', 'site'])
    })

    it('falls back to the folder\'s name with the start of its id, saying why in the note, where nobody can be asked', async () => {
      const input = scene()
      const folder = join(input.root, 'node')
      mkdirSync(folder)
      input.environment.BUCKLE_WORKSPACE_ROOT = folder
      version1(input)
      const notices = vi.spyOn(logger, 'warn')
      const manager = await open(input)

      const fallback = `node-${workspaceIdOf(folder).slice(0, 8)}`
      expect(manager.list().find(workspace => workspace.id === workspaceIdOf(folder))!.name).toBe(fallback)
      const note = notices.mock.calls.map(([message]) => String(message)).find(message => message.startsWith(`The node's folder ${folder} is workspace ${fallback}:`))
      expect(note).toContain('node is reserved')
      expect(note).not.toContain('a registered workspace is named')
    })

    // Fix brief 4, finding 37: a node folder called a%b was named so, and no HTTP route reaches it by that name.
    it.each([['a%b', 'a-b'], ['100%', '100']])('names a node folder called %s %s, saying so, since a route cannot carry the first', async (folderName, expected) => {
      const input = scene()
      const folder = join(input.root, folderName)
      mkdirSync(folder)
      input.environment.BUCKLE_WORKSPACE_ROOT = folder
      version1(input)
      const notices = vi.spyOn(logger, 'warn')
      const manager = await open(input)

      expect(manager.list().find(workspace => workspace.id === workspaceIdOf(folder))!.name).toBe(expected)
      expect(notices.mock.calls.some(([message]) => String(message).includes('held a character no route can carry in a name') && String(message).includes(`so it is named ${expected}`))).toBe(true)
    })

    it('refuses a record the registry would not read, naming its field, and changes nothing', async () => {
      const input = scene()
      const text = version1(input).replace('"label": "Registered"', `"label": "${'x'.repeat(121)}"`)
      writeFileSync(join(input.state, 'workspaces.json'), text)
      const failure = await open(input).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MigrationError)
      expect((failure as Error).message).toContain('workspaces.1.tokens.0.label')
      expect(registry(input)).toBe(text)
      for (const id of [ownId(input), siteId(input)]) expect(existsSync(settingsPath(input.state, id))).toBe(false)
    })

    it('refuses a records file that will not read before it moves anything, naming it, as a refusal to move rather than an unreadable registry', async () => {
      const input = scene()
      const before = version1(input)
      const grant = { id: 'grant-1', workspace: input.folder, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }
      const grants = JSON.stringify({ version: 1, grants: [grant] })
      writeFileSync(join(input.state, 'grants.json'), grants)
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', 'site', 'grants.json'), '{ not json')

      const failure = await open(input).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MigrationError)
      expect((failure as Error).message).toContain(join(input.state, 'workspaces', 'site', 'grants.json'))
      expect((failure as Error).message).toContain('Nothing was changed')
      expect(registry(input)).toBe(before)
      expect(readFileSync(join(input.state, 'grants.json'), 'utf8')).toBe(grants)
      expect(existsSync(settingsPath(input.state, ownId(input)))).toBe(false)
    })

    it('runs again to the same end after a move a crash stopped partway, finding the node folder\'s records moved and keyed by its id already', async () => {
      const input = scene()
      version1(input)
      const on = { on: true, changedAt: '2026-10-01T00:00:00.000Z' }
      // The node folder's part was written: its switch moved to its own directory under its id; the registry is still version 1, and site's switch still under its folder.
      mkdirSync(join(input.state, 'workspaces', ownId(input)), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', ownId(input), 'dangerously-allow.json'), JSON.stringify({ version: 1, workspaces: { [ownId(input)]: on } }))
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', 'site', 'dangerously-allow.json'), JSON.stringify({ version: 1, workspaces: { [input.site]: on } }))
      const manager = await open(input)

      expect((await byName(manager, 'site')).runtime.policy.dangerouslyAllow().on).toBe(true)
      expect((await byName(manager, 'project')).runtime.policy.dangerouslyAllow().on).toBe(true)
      // The site's records moved beside its 0.1 folder, which keeps nothing but what stays for going back.
      expect(existsSync(join(input.state, 'workspaces', siteId(input), 'dangerously-allow.json'))).toBe(true)
      expect(existsSync(join(input.state, 'workspaces', 'site', 'dangerously-allow.json'))).toBe(false)
    })

    it('finds a registered workspace\'s records under its folder as the disk names it, through a link', async () => {
      const input = scene()
      const link = join(input.root, 'site-link')
      symlinkSync(input.site, link)
      version1(input)
      writeFileSync(join(input.state, 'workspaces.json'), registry(input).replace(JSON.stringify(input.site), JSON.stringify(link)))
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', 'site', 'policy.json'), JSON.stringify({ version: 1, workspaces: { [input.site]: policy(value => { value.commands.deny = ['curl *'] }) } }))
      const manager = await open(input)

      expect(manager.list().find(workspace => workspace.id === siteId(input))!.dir).toBe(input.site)
      expect(settings(input, siteId(input)).policy.commands.deny).toEqual(['curl *'])
    })

    it.each([
      ['darwin', ['curl *']],
      ['linux', []],
    ] as const)('on %s, finds records kept under another case of the folder only where the volume ignores case', async (platform, deny) => {
      const input = scene()
      version1(input)
      const renamed = join(input.root, 'SITE')
      writeFileSync(join(input.state, 'workspaces.json'), registry(input).replace(JSON.stringify(input.site), JSON.stringify(renamed)))
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', 'site', 'policy.json'), JSON.stringify({ version: 1, workspaces: { [input.site]: policy(value => { value.commands.deny = ['curl *'] }) } }))
      await migrateNode({ node: loadConfig(input.environment), platform })
      // The id derives from the spelling the disk answers, or the registry's where (as here) the disk has no such folder.
      expect(settings(input, workspaceIdFor(renamed)).policy.commands.deny).toEqual(deny)
    })

    it('refuses two keys naming the one folder where the volume ignores case, and changes nothing', async () => {
      const input = scene()
      const before = version1(input)
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      writeFileSync(join(input.state, 'workspaces', 'site', 'policy.json'), JSON.stringify({ version: 1, workspaces: { [input.site]: policy(), [input.site.toUpperCase()]: policy() } }))
      await expect(migrateNode({ node: loadConfig(input.environment), platform: 'darwin' })).rejects.toThrow('keeps records under 2 spellings of one folder')
      expect(registry(input)).toBe(before)
    })

    it('refuses a folder inside the state directory as workspace default\'s, as buckle workspace init does, and changes nothing', async () => {
      const input = scene()
      const inside = join(input.state, 'history')
      mkdirSync(inside)
      input.environment.BUCKLE_WORKSPACE_ROOT = inside
      await expect(open(input)).rejects.toThrow(`which overlaps the state directory ${input.state}`)
      expect(existsSync(join(input.state, 'workspaces.json'))).toBe(false)
    })
  })

  // Findings 4, 14, 15, 20, and 22 of the Phase 1 review, fix brief A3: an older Buckle refuses the moved node, and
  // the v1 copies take the node back to 0.1 as it was.
  // Fix brief 4, findings 4 and 36: 0.1 enrolled a device key for a workspace by its 0.1 id, `default` for the node's
  // folder, which the move replaced with a UUID, so every such key stopped signing and could not be enrolled again.
  describe('device keys enrolled for a workspace under 0.1', () => {
    const nodeKey = generateSigningKey().keyId
    /** Whether the key signs an approval decision the node takes for the workspace with this id. */
    async function signsApproval(input: Scene, device: ReturnType<typeof generateSigningKey>, workspaceId: string): Promise<boolean> {
      const keys = createFileClientKeys({ filePath: join(input.state, 'client-keys.json') })
      const nonces = await openFileNonceStore({ filePath: join(input.root, `nonces-${workspaceId}.json`) })
      const verifier = createRequestVerifier({ keys, nonces, serverId: 'node-1', nodeKeyId: nodeKey })
      const path = `/workspaces/${workspaceId}/setup/approvals`
      const body = JSON.stringify({ token: 'ask', approved: true, scope: 'once' })
      const authorization = signRequest({ key: signingKeyFromPem(device.privateKeyPem), purpose: 'buckle-approval', node: 'node-1', nodeKey, workspace: workspaceId, method: 'POST', path, body, now: Date.now() })
      return (await verifier.verify({ authorization, purpose: 'buckle-approval', workspaceId, registry: false, method: 'POST', path, body: Buffer.from(body) })).ok
    }

    it('sign an approval for the workspace\'s id after the move, a copy keeping them as 0.1 named them', async () => {
      const input = scene()
      version1(input)
      const file = join(input.state, 'client-keys.json')
      const [own, site, whole] = [generateSigningKey(), generateSigningKey(), generateSigningKey()]
      const enrolled = createFileClientKeys({ filePath: file })
      await enrolled.enroll({ publicKey: own.publicKey, label: 'phone', purpose: 'approval', workspace: 'default' })
      await enrolled.enroll({ publicKey: site.publicKey, label: 'laptop', purpose: 'approval', workspace: 'site' })
      await enrolled.enroll({ publicKey: whole.publicKey, label: 'desk', purpose: 'approval', workspace: 'node' })
      const before = readFileSync(file, 'utf8')
      const notices = vi.spyOn(logger, 'warn')
      await open(input)

      expect(await signsApproval(input, own, ownId(input))).toBe(true)
      expect(await signsApproval(input, site, siteId(input))).toBe(true)
      expect(await signsApproval(input, own, siteId(input))).toBe(false)
      expect(createFileClientKeys({ filePath: file }).list().map(key => key.workspace)).toEqual([ownId(input), siteId(input), 'node'])
      expect(readFileSync(join(input.state, 'client-keys.v1.json'), 'utf8')).toBe(before)
      expect(statSync(join(input.state, 'client-keys.v1.json')).mode & 0o777).toBe(0o600)
      expect(notices.mock.calls.map(([message]) => String(message))).toContainEqual('Each device key enrolled for a workspace now names the workspace\'s id, so it keeps signing for it; client-keys.v1.json in the state directory keeps the keys as 0.1 named them, for going back to 0.1.')
    })

    it('are left alone, with no copy, where every key is the whole node\'s', async () => {
      const input = scene()
      version1(input)
      const whole = generateSigningKey()
      await createFileClientKeys({ filePath: join(input.state, 'client-keys.json') }).enroll({ publicKey: whole.publicKey, label: 'desk', purpose: 'approval', workspace: 'node' })
      await open(input)
      expect(await signsApproval(input, whole, ownId(input))).toBe(true)
      expect(existsSync(join(input.state, 'client-keys.v1.json'))).toBe(false)
    })

    it('refuse the move, changing nothing, where the list will not read', async () => {
      const input = scene()
      const text = version1(input)
      writeFileSync(join(input.state, 'client-keys.json'), '{ not json')
      await expect(open(input)).rejects.toThrow(MigrationError)
      expect(registry(input)).toBe(text)
    })
  })

  describe('leaving an older Buckle nothing to start on, and copies to go back with', () => {
    function withFile(input: Scene, extra = '') {
      vi.stubEnv('HOME', input.root)
      const path = join(input.root, 'buckle.env')
      writeFileSync(path, `# a 0.1 node\nBUCKLE_SERVER_NAME=Fixture node\nBUCKLE_AUTH_TOKEN=${NODE_TOKEN}\nBUCKLE_WORKSPACE_ROOT=${input.folder}\n${extra}`, { mode: 0o600 })
      const values = Object.fromEntries(Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter(([name]) => name.startsWith('BUCKLE_'))) as Record<string, string>
      const config = loadConfig({ ...values, BUCKLE_STATE_DIR: input.state }, process.platform, { file: { path, values }, caller: { BUCKLE_STATE_DIR: input.state } })
      return { path, config }
    }
    afterEach(() => { vi.unstubAllEnvs() })

    it('takes BUCKLE_AUTH_TOKEN out of buckle.env once it is default\'s token node, and puts a policy.json 0.1 cannot read in place', async () => {
      const input = scene()
      const { path, config } = withFile(input)
      const stored = JSON.stringify({ version: 1, workspaces: { [input.folder]: policy(value => { value.commands.deny = ['wget *'] }) } })
      writeFileSync(join(input.state, 'policy.json'), stored)
      const notices = vi.spyOn(logger, 'warn')
      const manager = await openWorkspaceManager({ config })

      expect(manager.tokenOwner(`Bearer ${NODE_TOKEN}`)).toEqual({ workspaceId: ownId(input), tokenId: 'node' })
      expect(readFileSync(path, 'utf8')).toBe(`# a 0.1 node\nBUCKLE_SERVER_NAME=Fixture node\nBUCKLE_WORKSPACE_ROOT=${input.folder}\n`)
      // 0.1 read policy.json with this same reader, version 1 alone, and refused to start on anything else.
      expect(() => readStoredPolicies(join(input.state, 'policy.json'))).toThrow(StateFileError)
      expect(settings(input, ownId(input)).policy.commands.deny).toEqual(['wget *'])
      const told = notices.mock.calls.map(([message]) => String(message))
      expect(told).toContainEqual(expect.stringContaining(`BUCKLE_AUTH_TOKEN is now token node of workspace project, so agents configured with it keep working, and it was taken out of ${path}`))
      expect(told).toContainEqual(expect.stringContaining('buckle workspace token create --workspace project, give agents the new token, then buckle workspace token revoke node --workspace project'))
      expect(told).toContainEqual(expect.stringContaining('An older Buckle sharing this state directory now refuses to start'))
      expect(told).toContainEqual(expect.stringContaining(`the node's own folder ${input.folder} is workspace project (id ${ownId(input)}), with its records in workspaces/${ownId(input)}/ in the state directory`))
      // What docs/workspaces-02.md says of going back: the four copies, the stub, the token out of the file, and its digest alone kept.
      expect(told).toContainEqual(expect.stringContaining('The registry and policy files it changed are kept as workspaces.v1.json and policy.v1.json in the state directory, with grants.v1.json and dangerously-allow.v1.json beside where each grants and switch file it moved was, for going back to 0.1'))
      expect(told).toContainEqual(expect.stringContaining('policy.json is a version 2 file it cannot read'))
      expect(told).toContainEqual(expect.stringContaining('Buckle keeps the token as its digest alone, with no copy of its value: to go back to 0.1, set BUCKLE_AUTH_TOKEN again from an agent\'s own configuration'))
      expect(told.join('\n')).not.toContain(NODE_TOKEN)
    })

    it('keeps owner-only copies of every file it changed, which moved back give 0.1 the node as it was', async () => {
      const input = scene()
      const { config } = withFile(input)
      const registryBefore = version1(input)
      const on = { on: true, changedAt: '2026-10-01T00:00:00.000Z' }
      const grant = { id: 'grant-1', workspace: input.folder, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }
      const before = {
        'grants.json': JSON.stringify({ version: 1, grants: [grant] }),
        'dangerously-allow.json': JSON.stringify({ version: 1, workspaces: { [input.folder]: on } }),
        [join('workspaces', 'site', 'grants.json')]: JSON.stringify({ version: 1, grants: [{ ...grant, workspace: input.site }] }),
        [join('workspaces', 'site', 'dangerously-allow.json')]: JSON.stringify({ version: 1, workspaces: { [input.site]: on } }),
      }
      mkdirSync(join(input.state, 'workspaces', 'site'), { recursive: true })
      for (const [file, text] of Object.entries(before)) writeFileSync(join(input.state, file), text)
      await openWorkspaceManager({ config })

      const copies = { 'workspaces.v1.json': registryBefore, 'policy.v1.json': '{"version":1,"workspaces":{}}\n', ...Object.fromEntries(Object.entries(before).map(([file, text]) => [file.replace('.json', '.v1.json'), text])) }
      for (const [copy, text] of Object.entries(copies)) {
        expect(readFileSync(join(input.state, copy), 'utf8')).toBe(text)
        expect(statSync(join(input.state, copy)).mode & 0o777).toBe(0o600)
      }
      // The live files moved to each workspace's own directory, rekeyed; the copies stay where 0.1 read the files.
      expect(existsSync(join(input.state, 'grants.json'))).toBe(false)
      expect(readFileSync(join(input.state, 'workspaces', ownId(input), 'grants.json'), 'utf8')).not.toBe(before['grants.json'])
      expect(existsSync(join(input.state, 'workspaces', 'site', 'grants.json'))).toBe(false)
      expect(readFileSync(join(input.state, 'workspaces', siteId(input), 'grants.json'), 'utf8')).toContain(siteId(input))
    })

    it('keeps an empty version 1 registry for a node that had none, which 0.1 reads as it read no file', async () => {
      const input = scene()
      const { config } = withFile(input)
      await openWorkspaceManager({ config })
      expect(JSON.parse(readFileSync(join(input.state, REGISTRY_BACKUP), 'utf8'))).toEqual({ version: 1, workspaces: [] })
    })

    it('reads the policy 0.1 stored from its copy when a move a crash stopped already put the stub in place', async () => {
      const input = scene()
      const { config } = withFile(input)
      writeFileSync(join(input.state, 'policy.v1.json'), JSON.stringify({ version: 1, workspaces: { [input.folder]: policy(value => { value.commands.deny = ['wget *'] }) } }))
      writeFileSync(join(input.state, 'policy.json'), JSON.stringify({ version: 2, note: 'moved' }))
      await openWorkspaceManager({ config })
      expect(settings(input, ownId(input)).policy.commands.deny).toEqual(['wget *'])
      expect(JSON.parse(readFileSync(join(input.state, 'policy.v1.json'), 'utf8')).workspaces[input.folder].commands.deny).toEqual(['wget *'])
    })

    // Findings 1 and 13: the BUCKLE_WORKSPACE_ROOT line 0.1's buckle init wrote is migration input only.
    it('says, at the move and at each later start, that buckle.env\'s BUCKLE_WORKSPACE_ROOT never steers buckle mcp, naming the two steps', async () => {
      const input = scene()
      const { path, config } = withFile(input)
      const notices = vi.spyOn(logger, 'warn')
      await openWorkspaceManager({ config })
      await openWorkspaceManager({ config })
      const said = notices.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith(`${path} sets BUCKLE_WORKSPACE_ROOT`))
      expect(said).toHaveLength(2)
      // Recheck of the workspace-model fix round 1 (the way back): unsetting the line drops the folder the way back to 0.1 needs, so the notice says when to.
      expect(said[0]).toContain('Add --workspace <name> to your MCP configs, then, once you no longer need the way back to 0.1, run buckle settings unset root.')
      expect(config.callerWorkspaceRoot).toBeUndefined()
      expect(loadConfig({}, process.platform, { file: { path, values: { BUCKLE_WORKSPACE_ROOT: input.folder } }, caller: { BUCKLE_WORKSPACE_ROOT: input.site } }).callerWorkspaceRoot).toBe(input.site)
    })

    it('warns at each later start where BUCKLE_AUTH_TOKEN is set again, naming the rotation, as the node does not read it', async () => {
      const input = scene()
      await open(input)
      const notices = vi.spyOn(logger, 'warn')
      await open(input, { BUCKLE_AUTH_TOKEN: 'rotated-the-0.1-way-fixture' })
      expect(notices.mock.calls.map(([message]) => String(message))).toContainEqual(expect.stringContaining('BUCKLE_AUTH_TOKEN is set in the environment, but a node on the workspace model does not read it'))
      expect(notices.mock.calls.join('\n')).toContain('buckle workspace token revoke node --workspace project')
    })
  })

  it('gives a state directory that never served a folder no workspace at all, though a node command wrote the audit log', async () => {
    const input = scene()
    const fresh = { BUCKLE_STATE_DIR: input.state }
    // `buckle init` audits itself before it opens the registry, so the log alone must not make the cwd a workspace.
    writeFileSync(join(input.state, 'actions.jsonl'), '')
    const manager = await openWorkspaceManager({ config: loadConfig(fresh) })
    expect(manager.list()).toEqual([])
    expect(JSON.parse(registry(input))).toEqual({ version: 2, workspaces: [] })
  })
})
