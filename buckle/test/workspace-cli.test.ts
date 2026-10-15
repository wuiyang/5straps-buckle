import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { ACTIVE_WORK_FRESH_MS, activeElsewhere, activeWorkDirectory } from '../common/services/workspaces/active-work.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'

// The workspace-model brief, item 4: buckle workspace init, list, show, enable, disable, remove, set, unset and token,
// each on the workspace --workspace or --dir names or else the one holding the current directory (D83 (2) to (6)).

const ADMIN = 'workspace-cli-admin-credential-fixture'
const LEGACY_AGENT = 'workspace-cli-legacy-agent-token-fixture'
let base: string
let state: string
let alpha: string
let beta: string
let outside: string
let out: string
let err: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-workspace-cli-')))
  state = join(base, 'state')
  alpha = join(base, 'alpha')
  beta = join(base, 'beta')
  outside = join(base, 'outside')
  for (const folder of [alpha, beta, outside, join(beta, 'sub')]) mkdirSync(folder, { recursive: true })
  out = ''
  err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }) })

function node(environment: Record<string, string> = {}): NodeConfig {
  return loadConfig({ BUCKLE_STATE_DIR: state, BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_SANDBOX: 'none', ...environment })
}

async function buckle(argv: string[], options: { cwd?: string; config?: NodeConfig } = {}): Promise<{ exitCode: number; out: string; err: string }> {
  out = ''
  err = ''
  const { exitCode } = await runCli({ argv: ['workspace', ...argv], config: options.config ?? node(), confirm: null, cwd: options.cwd ?? outside })
  return { exitCode, out, err }
}

/** `buckle workspace init` in `dir`, answering the token it printed once. */
async function init(dir: string, extra: string[] = []): Promise<string> {
  const result = await buckle(['init', ...extra], { cwd: dir })
  expect(result).toMatchObject({ exitCode: 0, err: '' })
  return /agent token {3}(\S+)/.exec(result.out)![1]!
}

const registryText = () => readFileSync(join(state, 'workspaces.json'), 'utf8')
const registry = () => JSON.parse(registryText()) as { workspaces: { id: string; name: string; dir: string; online: boolean; tokens: { id: string; label: string }[] }[] }
const settings = (id: string) => openSettingsFile({ filePath: settingsPath(state, id) }).read()
const audit = () => readFileSync(join(state, 'actions.jsonl'), 'utf8')

describe('buckle workspace init', () => {
  it('serves the current directory, named and keyed after it, and prints its token once, kept as a digest alone', async () => {
    const token = await init(alpha)

    expect(registry().workspaces).toMatchObject([{ id: 'alpha', name: 'alpha', dir: alpha, online: true, tokens: [{ label: 'Registered' }] }])
    expect(registryText()).not.toContain(token)
    expect(settings('alpha').mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'write' }])
    expect(audit()).not.toContain(token)
  })

  it('takes --dir from where it runs, with --id and --name', async () => {
    await init(base, ['--dir', 'beta', '--id', 'site', '--name', 'The site'])
    expect(registry().workspaces).toMatchObject([{ id: 'site', name: 'The site', dir: beta }])
  })

  it('refuses a folder inside one served already, and --workspace, which names no folder', async () => {
    await init(beta)
    const nested = await buckle(['init'], { cwd: join(beta, 'sub') })
    expect(nested.exitCode).toBe(1)
    expect(nested.err).toContain('A workspace folder must not hold, or sit inside, another workspace or Buckle state')
    expect((await buckle(['init', '--workspace', 'beta'], { cwd: alpha })).err).toContain('name its folder with --dir')
    expect(registry().workspaces.map(workspace => workspace.id)).toEqual(['beta'])
  })

  it('keeps add <id> --root <dir>, the 0.1 spelling, for one release', async () => {
    const result = await buckle(['add', 'old', '--root', alpha])
    expect(result.exitCode).toBe(0)
    expect(result.out).toMatch(/agent token {3}\S+/)
    expect(registry().workspaces).toMatchObject([{ id: 'old', name: 'old', dir: alpha }])
  })

  it('refuses every verb on a node with no admin credential', async () => {
    const result = await buckle(['init'], { cwd: alpha, config: loadConfig({ BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none' }) })
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('This node has no admin credential')
  })
})

describe('the workspace a command means', () => {
  beforeEach(async () => { await init(alpha); await init(beta) })

  it('is the one --workspace names, else the one holding --dir, else the one holding the current directory', async () => {
    expect((await buckle(['show', '--workspace', 'beta'], { cwd: alpha })).out).toContain('Workspace beta (beta)')
    expect((await buckle(['show', '--dir', join(beta, 'sub')], { cwd: alpha })).out).toContain('Workspace beta (beta)')
    expect((await buckle(['show'], { cwd: join(beta, 'sub') })).out).toContain('Workspace beta (beta)')
    expect((await buckle([], { cwd: alpha })).out).toContain('Workspace alpha (alpha)')
  })

  // Finding 33 of the Phase 1 review: a --dir that does not exist yet was compared as typed, links unfollowed.
  it('is the one holding a --dir that does not exist yet, spelled through a link as without it', async () => {
    symlinkSync(beta, join(base, 'link-to-beta'))
    for (const dir of [join('link-to-beta', 'sub', 'not-yet'), join('beta', 'sub', 'not-yet')]) {
      expect((await buckle(['show', '--dir', dir], { cwd: base })).out).toContain('Workspace beta (beta)')
    }
  })

  it('is refused, listing the ids, where nothing holds the directory, and where both flags are given', async () => {
    const nowhere = await buckle(['show'], { cwd: outside })
    expect(nowhere.exitCode).toBe(1)
    expect(nowhere.err).toContain('No workspace holds the current directory. Name one with --workspace <id> (alpha, beta)')
    expect((await buckle(['show', '--workspace', 'alpha', '--dir', beta])).err).toContain('not both')
  })
})

describe('buckle workspace list and show', () => {
  it('lists every workspace with its state, and shows one\'s settings with no token or digest in either', async () => {
    const token = await init(alpha)
    await init(beta)
    await buckle(['disable', 'beta'])

    const listed = await buckle(['list'])
    expect(listed.out).toMatch(/alpha\s+online\s+alpha\s+/)
    expect(listed.out).toMatch(/beta\s+offline\s+beta\s+/)
    const json = await buckle(['list', '--json'])
    expect(JSON.parse(json.out)).toMatchObject([{ id: 'alpha', online: true, tokens: 1 }, { id: 'beta', online: false }])

    const shown = await buckle(['show', '--json'], { cwd: alpha })
    expect(JSON.parse(shown.out)).toMatchObject({ id: 'alpha', settings: { version: 1, packs: { shell: true } } })
    const text = await buckle(['show'], { cwd: alpha })
    expect(text.out).toContain('packs.shell')
    for (const printed of [listed.out, json.out, shown.out, text.out]) {
      expect(printed).not.toContain(token)
      expect(printed).not.toContain('sha256')
    }
  })

  it('says how to start where the node has none', async () => {
    expect((await buckle(['list'])).out).toContain('No workspace yet: run buckle workspace init in the folder to serve.')
  })
})

describe('buckle workspace enable, disable and remove', () => {
  beforeEach(async () => { await init(alpha) })

  it('switches a workspace off and on, keeping its tokens and settings', async () => {
    expect((await buckle(['disable', 'alpha'])).out).toContain('Workspace alpha is offline')
    expect(registry().workspaces[0]).toMatchObject({ online: false, tokens: [expect.anything()] })
    expect((await buckle(['enable', 'alpha'])).out).toContain('Workspace alpha is online')
    expect(registry().workspaces[0]!.online).toBe(true)
    expect(audit()).toMatch(/"detail":"disable alpha"/)
  })

  it('forgets a workspace and keeps its records, which init takes up again, or deletes them with --purge; the folder stays', async () => {
    await buckle(['set', 'packs.shell', 'off'], { cwd: alpha })
    expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
    expect(registry().workspaces).toEqual([])
    expect(existsSync(settingsPath(state, 'alpha'))).toBe(true)

    await init(alpha, ['--id', 'alpha'])
    expect(settings('alpha').packs.shell).toBe(false)

    expect((await buckle(['remove', 'alpha', '--purge'])).out).toContain('deleted its records')
    expect(existsSync(join(state, 'workspaces', 'alpha'))).toBe(false)
    expect(existsSync(alpha)).toBe(true)
  })

  // Findings 6 and 16 of the Phase 1 review: migration alone makes the id default, so a removed default could never be
  // taken up again, though the CLI said it could.
  it.each([[[]], [['--purge']]])('refuses to remove workspace default, whose id nothing registers again, pointing to disable (%j)', async (purge) => {
    const legacy = node({ BUCKLE_WORKSPACE_ROOT: beta, BUCKLE_AUTH_TOKEN: LEGACY_AGENT })
    rmSync(state, { recursive: true, force: true })
    const refused = await buckle(['remove', 'default', ...purge], { config: legacy })
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Stop serving it with buckle workspace disable default')
    expect(registry().workspaces.map(workspace => workspace.id)).toEqual(['default'])
  })

  // Finding 36 of the Phase 1 review: a registration under a removed workspace's id takes its records up, the switch
  // among them, which the owner is now told, and a policy named with it would be dropped, so that is refused.
  it('says what a registration under a removed workspace\'s id takes up, its switch named where on, and refuses a policy over it', async () => {
    const workspaces = await openWorkspaceManager({ config: node() })
    try {
      const { runtime } = await workspaces.resolve('alpha')
      await runtime.policy.setDangerouslyAllow(true)
      expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
      const strict = { ...emptyWorkspacePolicy(), commands: { allow: [], deny: ['curl *'] } }
      await expect(workspaces.create({ id: 'alpha', dir: beta, policy: strict })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('buckle workspace remove alpha --purge') })
      expect(registry().workspaces).toEqual([])
    } finally { await workspaces.close() }
    const taken = await buckle(['init', '--id', 'alpha'], { cwd: beta })
    expect(taken.exitCode).toBe(0)
    expect(taken.out).toContain('It takes up the records workspace alpha left when it was removed: its settings, grants, and history, and its dangerously-allow switch, which is ON.')
  })

  it('names the one id a verb takes', async () => {
    expect((await buckle(['enable'])).err).toContain('Usage: buckle workspace enable <id>')
    expect((await buckle(['remove', 'alpha', 'beta'])).err).toContain('Usage: buckle workspace remove <id>')
    expect((await buckle(['disable', 'nothing'])).exitCode).toBe(1)
  })
})

// Findings 5 and 9 of the Phase 1 review: disable and remove run in the CLI's own process, which used to see no work at
// all, on disk or in the process serving the workspace.
describe('buckle workspace disable and remove, while the workspace has work', () => {
  beforeEach(async () => { await init(alpha) })
  const marks = () => activeWorkDirectory(state, 'alpha')

  it('refuse while a shell result waits for review on disk, and delete nothing', async () => {
    const id = `shell-${randomUUID()}`
    const directory = join(state, 'workspaces', 'alpha', 'isolated-shell', workspaceStateKey(alpha), id)
    mkdirSync(join(directory, 'workspace'), { recursive: true })
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ id, sessionId: 's', stageId: 'st', tool: 'shell_exec', sourceRoot: alpha, copyRoot: join(directory, 'workspace'), writableRoots: [alpha], excluded: [], createdAt: new Date().toISOString(), status: 'needs_review' }))

    for (const verb of [['disable', 'alpha'], ['remove', 'alpha'], ['remove', 'alpha', '--purge']]) {
      const refused = await buckle(verb)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('Resolve active tools and staged work before')
    }
    expect(registry().workspaces[0]).toMatchObject({ id: 'alpha', online: true })
    expect(existsSync(join(directory, 'run.json'))).toBe(true)
  })

  it('refuse while another process marks calls running there, and go ahead once that mark stops being refreshed', async () => {
    mkdirSync(marks(), { recursive: true })
    const mark = join(marks(), String(process.pid + 1))
    writeFileSync(mark, '')
    expect((await buckle(['disable', 'alpha'])).err).toContain('Resolve active tools and staged work before taking this workspace offline')
    expect((await buckle(['remove', 'alpha', '--purge'])).exitCode).toBe(1)
    const stale = new Date(Date.now() - ACTIVE_WORK_FRESH_MS - 1_000)
    utimesSync(mark, stale, stale)
    expect((await buckle(['disable', 'alpha'])).exitCode).toBe(0)
  })

  it('refuse --purge of a workspace that will not open, as its staged work cannot be checked, and take it offline anyway', async () => {
    rmSync(alpha, { recursive: true })
    const refused = await buckle(['remove', 'alpha', '--purge'])
    expect(refused.err).toContain('will not open, so its staged work cannot be checked before its records are deleted')
    expect(existsSync(settingsPath(state, 'alpha'))).toBe(true)
    expect((await buckle(['disable', 'alpha'])).exitCode).toBe(0)
  })

  it('are seen by the runtime serving a call, which marks it running until it answers', async () => {
    // A node entry point with nobody at a terminal: the gated call is held for the workspace's approval wait.
    const serving = await openWorkspaceManager({ config: node(), interaction: fixedInteraction() })
    try {
      await serving.updateSettings('alpha', settings => ({ ...settings, approvalWaitMs: 1_500 }))
      const { runtime } = await serving.resolve('alpha')
      const held = runtime.invoke({ request: { requestId: 'held-write', tool: 'fs_write', args: { path: 'new.txt', content: 'x' }, approvalTokens: [] }, sessionId: 'serve' })
      await vi.waitFor(() => expect(existsSync(join(marks(), String(process.pid)))).toBe(true))
      expect(activeElsewhere({ directory: marks(), pid: process.pid + 1 })).toBe(true)
      expect(await held).toMatchObject({ outcome: 'approval_required' })
      expect(existsSync(join(marks(), String(process.pid)))).toBe(false)
    } finally { await serving.close() }
  })
})

// Finding 2 of the Phase 1 review: buckle serve kept the runtime of a workspace another process removed, and served a
// new registration of the same id from the removed folder.
describe('a workspace removed and registered again while buckle serve runs', () => {
  let serving: WorkspaceManager
  let older: string
  let newer: string
  beforeEach(async () => {
    older = join(base, 'old', 'site')
    newer = join(base, 'new', 'site')
    for (const [folder, text] of [[older, 'OLD'], [newer, 'NEW']] as const) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'which.txt'), text)
    }
    await init(older, ['--id', 'site'])
    // The serving node, a process of its own, opened the workspace before the owner's commands ran.
    serving = await openWorkspaceManager({ config: node() })
    expect(await readWhich()).toBe('OLD')
  })
  afterEach(async () => { await serving.close() })

  async function readWhich(): Promise<unknown> {
    const { runtime } = await serving.resolve('site')
    const response = await runtime.invoke({ request: { requestId: `which-${Math.random()}`, tool: 'fs_read', args: { path: 'which.txt' }, approvalTokens: [] }, sessionId: 'serve' })
    return response.outcome === 'ok' ? (response.output as { content: string }).content : response
  }

  it.each([[[], ['--id', 'site']], [['--purge'], []]])('serves the new registration from its own folder (remove %j)', async (removal, again) => {
    expect((await buckle(['remove', 'site', ...removal])).exitCode).toBe(0)
    await init(newer, again)
    expect(await readWhich()).toBe('NEW')
    expect((await serving.resolve('site')).config.cwd).toBe(newer)
  })

  it('serves a new registration of the same folder from records of its own, after the earlier ones were purged', async () => {
    expect((await buckle(['remove', 'site', '--purge'])).exitCode).toBe(0)
    await init(older)
    expect(await readWhich()).toBe('OLD')
  })

  it('refuses a call while the earlier registration\'s runtime has work, naming no path', async () => {
    const { runtime } = await serving.resolve('site')
    vi.spyOn(runtime, 'hasActiveWork').mockResolvedValue(true)
    expect((await buckle(['remove', 'site'])).exitCode).toBe(0)
    await init(newer, ['--id', 'site'])
    const refused = await serving.resolve('site').catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 409 })
    expect(String((refused as Error).message)).toContain('registered again while work under its earlier registration is active')
    expect(String((refused as Error).message)).not.toContain(base)
  })

  it('closes the runtime of a workspace removed or taken offline, once it has no work, when serve looks at the registry', async () => {
    const { runtime } = await serving.resolve('site')
    const closed = vi.spyOn(runtime, 'closeSessions')
    expect((await buckle(['disable', 'site'])).exitCode).toBe(0)
    await serving.closeUnserved()
    expect(await serving.opened()).toEqual([])
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('buckle workspace set and unset', () => {
  beforeEach(async () => { await init(alpha) })
  const set = (...words: string[]) => buckle(['set', ...words], { cwd: alpha })

  it('changes one setting in workspace.json, a revision at a time, and unset puts the default back', async () => {
    const before = settings('alpha').revision
    expect((await set('packs.shell', 'off')).exitCode).toBe(0)
    expect(settings('alpha')).toMatchObject({ revision: before + 1, packs: { shell: false } })
    expect((await set('approvalWaitMs', '0')).exitCode).toBe(0)
    expect((await set('packs.enabled', 'fs, web')).exitCode).toBe(0)
    expect((await set('packs.hostGit', 'on')).exitCode).toBe(0)
    expect(settings('alpha')).toMatchObject({ approvalWaitMs: 0, packs: { enabled: ['fs', 'web'], hostGit: true } })

    for (const key of ['packs.shell', 'packs.enabled', 'approvalWaitMs']) expect((await buckle(['unset', key], { cwd: alpha })).exitCode).toBe(0)
    expect(settings('alpha')).toMatchObject({ approvalWaitMs: 15_000, packs: { enabled: null, shell: true } })
  })

  it('renames the workspace', async () => {
    expect((await set('name', 'Alpha site')).exitCode).toBe(0)
    expect(registry().workspaces[0]!.name).toBe('Alpha site')
  })

  it.each([
    [['packs.shell', 'maybe'], 'packs.shell is on or off'],
    [['packs.enabled', 'fs,rocket'], 'Unknown pack rocket'],
    [['approvalWaitMs', 'soon'], 'approvalWaitMs is milliseconds'],
    // Phase 2 item 6 reads the browser block per workspace; until then nothing writes a value that would not apply.
    [['browser.idleTimeoutMs', '600000'], 'browser.idleTimeoutMs does not take effect yet: the browser runs on the node\'s BUCKLE_BROWSER_CDP'],
    [['browser.headed', 'on'], 'browser.headed does not take effect yet'],
    [['mounts', '/elsewhere'], 'mounts is no workspace setting'],
    [['packs.shell'], 'Usage: buckle workspace set <key> <value>'],
  ])('refuses %j, saying why, and writes nothing', async (words, reason) => {
    const before = settings('alpha')
    const result = await set(...words)
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(reason)
    expect(settings('alpha')).toEqual(before)
  })

  it('refuses the environment pack while the node has no BUCKLE_ENV_VALIDATOR_COMMAND, naming it', async () => {
    const result = await set('packs.enabled', 'fs,environment')
    expect(result.err).toContain('environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)')
    expect(settings('alpha').packs.enabled).toBeNull()
  })

  it('sets a variable the workspace\'s commands see, never echoing or auditing its value, and unsets it', async () => {
    const result = await set('env.NODE_ENV', 'workspace-cli-variable-value')
    expect(result.exitCode).toBe(0)
    expect(settings('alpha').env).toEqual({ NODE_ENV: 'workspace-cli-variable-value' })
    expect(result.out).not.toContain('workspace-cli-variable-value')
    expect(audit()).not.toContain('workspace-cli-variable-value')
    expect(audit()).toContain('set alpha env.NODE_ENV')
    // The runtime that serves the workspace gives them to its shell commands (Q13).
    const workspaces = await openWorkspaceManager({ config: node() })
    try {
      expect((await workspaces.resolve('alpha')).config.commandEnvironment).toEqual({ NODE_ENV: 'workspace-cli-variable-value' })
    } finally { await workspaces.close() }
    expect((await buckle(['unset', 'env.NODE_ENV'], { cwd: alpha })).exitCode).toBe(0)
    expect(settings('alpha').env).toEqual({})
  })

  it.each(['API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'BUCKLE_ADMIN_TOKEN', 'PATH', 'HOME', 'lower case'])('refuses the variable %s, which a credential or Buckle itself owns', async (name) => {
    const result = await set(`env.${name}`, 'value')
    expect(result.exitCode).toBe(1)
    expect(settings('alpha').env).toEqual({})
  })

  it('refuses a value that is one of this node\'s credentials, without printing it', async () => {
    const token = await init(beta)
    for (const value of [ADMIN, token]) {
      const result = await set('env.HARMLESS_NAME', value)
      expect(result.exitCode).toBe(1)
      expect(result.err).toContain('no secret reaches a command Buckle runs')
      expect(result.err).not.toContain(value)
    }
    expect(settings('alpha').env).toEqual({})
  })
})

describe('buckle workspace token', () => {
  beforeEach(async () => { await init(alpha) })

  it('mints a token shown once, lists tokens without them, and revokes one, but never the last', async () => {
    const created = await buckle(['token', 'create', '--label', 'ci'], { cwd: alpha })
    expect(created.exitCode).toBe(0)
    const token = /agent token {3}(\S+)/.exec(created.out)![1]!
    expect(registryText()).not.toContain(token)
    expect(audit()).not.toContain(token)

    const listed = await buckle(['token', 'list'], { cwd: alpha })
    const tokens = JSON.parse(listed.out) as { id: string; label: string }[]
    expect(tokens.map(item => item.label)).toEqual(['Registered', 'ci'])
    expect(listed.out).not.toContain(token)

    expect((await buckle(['token', 'revoke', tokens[1]!.id], { cwd: alpha })).out).toContain(`Revoked ${tokens[1]!.id}`)
    const last = await buckle(['token', 'revoke', tokens[0]!.id], { cwd: alpha })
    expect(last.exitCode).toBe(1)
    expect(registry().workspaces[0]!.tokens).toHaveLength(1)
    expect((await buckle(['token', 'revoke', 'no-such-token'], { cwd: alpha })).err).toContain('holds no token no-such-token')
  })

  // Finding 32 of the Phase 1 review: the 0.1 id beside a flag was dropped, and the token minted in the flag's workspace.
  it.each([
    [['token', 'add', 'alpha', '--label', 'for-alpha', '--workspace', 'beta']],
    [['token', 'add', 'alpha', '--dir', 'beta']],
    [['token', 'list', 'alpha', '--workspace', 'beta']],
    [['token', 'revoke', 'alpha', 'initial', '--workspace', 'beta']],
  ])('refuses %j, which names the workspace twice, and mints or revokes nothing', async (argv) => {
    await init(beta)
    const before = registryText()
    const refused = await buckle(argv, { cwd: base })
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Name the workspace once')
    expect(registryText()).toBe(before)
  })

  it('keeps the 0.1 spellings, which name the workspace first, for one release', async () => {
    const added = await buckle(['token', 'add', 'alpha', '--label', 'legacy'])
    expect(added.exitCode).toBe(0)
    const listed = JSON.parse((await buckle(['token', 'list', 'alpha'])).out) as { id: string; label: string }[]
    const legacy = listed.find(item => item.label === 'legacy')!
    expect((await buckle(['token', 'revoke', 'alpha', legacy.id])).exitCode).toBe(0)
    expect(registry().workspaces[0]!.tokens.map(item => item.label)).toEqual(['Registered'])
  })
})
