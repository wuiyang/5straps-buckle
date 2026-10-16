import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { ACTIVE_WORK_FRESH_MS, activeElsewhere, activeWorkDirectory } from '../common/services/workspaces/active-work.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { workspaceRegistryCommand, type NamePrompt } from '../cli/workspace.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'
import { byName, idOf, workspaceIdOf } from './support/workspaces.js'

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
/** A folder's workspace settings, under the id the folder derives (D85, Q15). */
const settings = (dir: string) => openSettingsFile({ filePath: settingsPath(state, workspaceIdOf(dir)) }).read()
const audit = () => readFileSync(join(state, 'actions.jsonl'), 'utf8')

describe('buckle workspace init', () => {
  it('serves the current directory, named and keyed after it, and prints its token once, kept as a digest alone', async () => {
    const token = await init(alpha)

    expect(registry().workspaces).toMatchObject([{ id: workspaceIdOf(alpha), name: 'alpha', dir: alpha, online: true, tokens: [{ label: 'Registered' }] }])
    expect(registryText()).not.toContain(token)
    expect(settings(alpha).mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'rw' }])
    expect(audit()).not.toContain(token)
  })

  it('takes --dir from where it runs, with --name, and derives the id from the folder', async () => {
    await init(base, ['--dir', 'beta', '--name', 'The site'])
    expect(registry().workspaces).toMatchObject([{ id: workspaceIdOf(beta), name: 'The site', dir: beta }])
    expect((await buckle(['init', '--id', 'site'], { cwd: alpha })).err).toContain('Unknown option')
  })

  it('refuses a folder inside one served already, and --workspace, which names no folder', async () => {
    await init(beta)
    const nested = await buckle(['init'], { cwd: join(beta, 'sub') })
    expect(nested.exitCode).toBe(1)
    expect(nested.err).toContain('A workspace folder must not hold, or sit inside, another workspace or Buckle state')
    expect((await buckle(['init', '--workspace', 'beta'], { cwd: alpha })).err).toContain('name its folder with --dir')
    expect(registry().workspaces.map(workspace => workspace.id)).toEqual([workspaceIdOf(beta)])
  })

  // D85, Q15: `add <dir> [--name <name>]` names the folder first; the 0.1 `add <id> --root <dir>` is gone with the typed id.
  it('takes add <dir> [--name <name>], the folder relative to where it runs', async () => {
    const result = await buckle(['add', 'alpha', '--name', 'The alpha site'], { cwd: base })
    expect(result.exitCode).toBe(0)
    expect(result.out).toMatch(/agent token {3}\S+/)
    expect(result.out).toContain("buckle workspace token create --workspace 'The alpha site'")
    expect(registry().workspaces).toMatchObject([{ id: workspaceIdOf(alpha), name: 'The alpha site', dir: alpha }])
    expect((await buckle(['add', 'old', '--root', alpha])).err).toContain('Usage: buckle workspace add <dir> [--name <name>]')
  })

  it('refuses every verb on a node with no admin credential', async () => {
    const result = await buckle(['init'], { cwd: alpha, config: loadConfig({ BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none' }) })
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('This node has no admin credential')
  })
})

// D85, Q15: a workspace's name is the handle the owner types; it is unique on the node, without regard to case, and
// a taken one is asked about at a terminal, or refused naming --name.
describe('a workspace\'s name', () => {
  /** Answers the name questions in order; the prompt is interactive unless told otherwise. */
  function scripted(answers: string[], interactive = true): NamePrompt & { asked: string[] } {
    const queue = [...answers]
    const asked: string[] = []
    return { interactive, asked, question: async text => { asked.push(text); return queue.shift() ?? '' }, close: () => {} }
  }
  async function command(argv: string[], prompt: NamePrompt, cwd = outside) {
    out = ''
    err = ''
    const workspaces = await openWorkspaceManager({ config: node() })
    try { return { ...await workspaceRegistryCommand({ config: node(), workspaces, argv, cwd, prompt }), out, err } } finally { await workspaces.close() }
  }

  it('is the folder\'s by default, unique without regard to case, and a taken one is refused naming --name where nobody can be asked', async () => {
    await init(alpha)
    const taken = await buckle(['init', '--name', 'ALPHA'], { cwd: beta })
    expect(taken.exitCode).toBe(1)
    expect(taken.err).toContain('A workspace is already named ALPHA; choose another name: name it with --name <name>')
    mkdirSync(join(base, 'other', 'alpha'), { recursive: true })
    const unasked = await buckle(['init', '--yes'], { cwd: join(base, 'other', 'alpha') })
    expect(unasked.exitCode).toBe(1)
    expect(unasked.err).toContain('A workspace is already named alpha; choose another name: name it with --name <name>')
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha'])
    expect((await buckle(['init', '--name', 'Beta site'], { cwd: beta })).exitCode).toBe(0)
    expect((await buckle(['set', 'name', 'beta SITE'], { cwd: alpha })).err).toContain('A workspace is already named beta SITE')
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha', 'Beta site'])
  })

  // Fix brief 4, findings 2 and 41: the folder's own name was checked only when the registry was written, after the
  // folder's records were, and the refusal was a raw schema dump over an orphan that the next add reported as taken up.
  describe.each([['node'], ['Node'], ['3f2a1c2e-8b4d-4f0a-9c7e-2d5b1a8f3c6e'], ['x'.repeat(121)]])('a folder named %s', (folderName) => {
    it('is refused before any record is written, naming --name, and registers under the name given instead', async () => {
      const folder = join(base, folderName)
      mkdirSync(folder)

      const refused = await buckle(['init'], { cwd: folder })
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('cannot be a workspace name')
      expect(refused.err).toContain('name it with --name <name>')
      expect(refused.err).not.toMatch(/"code"|workspaces\.\d/)
      expect(existsSync(join(state, 'workspaces'))).toBe(false)
      expect((await buckle(['list'])).out).toContain('No workspace yet')

      const named = await buckle(['init', '--name', 'nodejs'], { cwd: folder })
      expect(named.exitCode).toBe(0)
      expect(named.out).not.toContain('takes up the records')
      expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['nodejs'])
    })

    it('is asked about at a terminal, and registers under the answer', async () => {
      const folder = join(base, folderName)
      mkdirSync(folder)
      const prompt = scripted(['nodejs'])

      expect(await command(['add', folder], prompt)).toMatchObject({ exitCode: 0 })
      expect(prompt.asked).toHaveLength(1)
      expect(prompt.asked[0]).toContain('cannot be a workspace name')
      expect(registry().workspaces).toMatchObject([{ name: 'nodejs', dir: folder }])
    })
  })

  // Fix brief 4, finding 19: only the registry write trimmed a name, so 'Alpha ' passed the check against alpha.
  it('is compared as the registry holds it, without the spaces around it, and is never empty', async () => {
    await init(alpha)
    await init(beta)
    mkdirSync(join(base, 'gamma'))
    for (const argv of [['add', join(base, 'gamma'), '--name', 'Alpha '], ['add', join(base, 'gamma'), '--name', '  ALPHA'], ['rename', 'beta', 'alpha '], ['set', 'name', ' ALPHA', '--workspace', 'beta']]) {
      const refused = await buckle(argv)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('A workspace is already named')
    }
    for (const argv of [['add', join(base, 'gamma'), '--name', '   '], ['rename', 'beta', '   ']]) {
      const refused = await buckle(argv)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('A name is not empty')
    }
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha', 'beta'])
    expect((await buckle(['rename', 'beta', '  Beta site  '])).exitCode).toBe(0)
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha', 'Beta site'])
  })

  // Fix brief 4, findings 37 and 38: a name with a slash or a percent sign, or over 64 characters, could not be reached by
  // name over HTTP, or named in a signed request.
  it.each(['team/api', 'team\\api', '..', '100%', 'n'.repeat(65)])('refuses %j at add and at rename, naming what a name may be', async (name) => {
    await init(alpha)
    await init(beta)
    mkdirSync(join(base, 'gamma'))
    for (const argv of [['add', join(base, 'gamma'), '--name', name], ['rename', 'beta', name]]) {
      const refused = await buckle(argv)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toMatch(/cannot be a workspace name: A name (cannot hold|is at most)/)
    }
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha', 'beta'])
  })

  it('leaves no records behind when the registration fails after its settings were written', async () => {
    const failing = openWorkspaceManager({ config: node(), nodeRoots: { current: () => ({ untrustedRoots: [], rootsUnknown: null }), take: () => { throw new Error('the roots could not be taken') } } })
    const workspaces = await failing
    try {
      await expect(workspaces.create({ dir: alpha })).rejects.toThrow('the roots could not be taken')
      expect(existsSync(join(state, 'workspaces', workspaceIdOf(alpha)))).toBe(false)
    } finally { await workspaces.close() }
  })

  it('is asked for at a terminal until one is free, and Enter stops with nothing added', async () => {
    await init(alpha)
    mkdirSync(join(base, 'other', 'alpha'), { recursive: true })
    const prompt = scripted(['Alpha', 'The other alpha'])
    const added = await command(['add', join(base, 'other', 'alpha')], prompt)
    expect(added).toMatchObject({ exitCode: 0 })
    expect(prompt.asked).toEqual(['A workspace is already named alpha; choose another name. Another name, or Enter to stop: ', 'A workspace is already named Alpha; choose another name. Another name, or Enter to stop: '])
    expect(registry().workspaces.map(workspace => workspace.name)).toEqual(['alpha', 'The other alpha'])

    mkdirSync(join(base, 'third', 'alpha'), { recursive: true })
    const stopped = await command(['add', join(base, 'third', 'alpha')], scripted(['']))
    expect(stopped.exitCode).toBe(1)
    expect(stopped.err).toContain('No name given, so nothing was added; name it with --name <name>')
    const refused = await command(['add', join(base, 'third', 'alpha'), '--yes'], scripted(['never asked']))
    expect(refused.err).toContain('name it with --name <name>')
    expect(registry().workspaces).toHaveLength(2)
  })

  it('is what every verb and --workspace take, in any case, beside the id, and rename changes it with the id kept', async () => {
    await init(alpha, ['--name', 'The alpha site'])
    expect((await buckle(['show', '--workspace', 'the ALPHA site'])).out).toContain(`Workspace The alpha site (id ${workspaceIdOf(alpha)})`)
    expect((await buckle(['show', '--workspace', workspaceIdOf(alpha)])).out).toContain(`Workspace The alpha site (id ${workspaceIdOf(alpha)})`)
    expect((await buckle(['disable', 'The alpha site'])).out).toContain('Workspace The alpha site is offline')
    const renamed = await buckle(['rename', 'the alpha site', 'Alpha, renamed'])
    expect(renamed.exitCode).toBe(0)
    expect(renamed.out).toContain(`Workspace The alpha site is now named Alpha, renamed; its id ${workspaceIdOf(alpha)} is unchanged.`)
    expect(registry().workspaces).toMatchObject([{ id: workspaceIdOf(alpha), name: 'Alpha, renamed', online: false }])
    expect((await buckle(['enable', 'Alpha, renamed'])).exitCode).toBe(0)
    expect((await buckle(['rename', 'nothing', 'x'])).err).toContain('No workspace is named nothing')
    expect((await buckle(['rename', 'Alpha, renamed', 'node'])).err).toContain('node is reserved')
    expect(audit()).toContain('"detail":"rename The alpha site Alpha, renamed"')
  })
})

describe('the workspace a command means', () => {
  beforeEach(async () => { await init(alpha); await init(beta) })

  it('is the one --workspace names, else the one holding --dir, else the one holding the current directory', async () => {
    expect((await buckle(['show', '--workspace', 'beta'], { cwd: alpha })).out).toContain(`Workspace beta (id ${workspaceIdOf(beta)})`)
    expect((await buckle(['show', '--dir', join(beta, 'sub')], { cwd: alpha })).out).toContain(`Workspace beta (id ${workspaceIdOf(beta)})`)
    expect((await buckle(['show'], { cwd: join(beta, 'sub') })).out).toContain(`Workspace beta (id ${workspaceIdOf(beta)})`)
    expect((await buckle([], { cwd: alpha })).out).toContain(`Workspace alpha (id ${workspaceIdOf(alpha)})`)
  })

  // Finding 33 of the Phase 1 review: a --dir that does not exist yet was compared as typed, links unfollowed.
  it('is the one holding a --dir that does not exist yet, spelled through a link as without it', async () => {
    symlinkSync(beta, join(base, 'link-to-beta'))
    for (const dir of [join('link-to-beta', 'sub', 'not-yet'), join('beta', 'sub', 'not-yet')]) {
      expect((await buckle(['show', '--dir', dir], { cwd: base })).out).toContain(`Workspace beta (id ${workspaceIdOf(beta)})`)
    }
  })

  it('is refused, listing the ids, where nothing holds the directory, and where both flags are given', async () => {
    const nowhere = await buckle(['show'], { cwd: outside })
    expect(nowhere.exitCode).toBe(1)
    expect(nowhere.err).toContain('No workspace holds the current directory. Name one with --workspace <name> (alpha, beta)')
    expect((await buckle(['show', '--workspace', 'alpha', '--dir', beta])).err).toContain('not both')
  })
})

describe('buckle workspace list and show', () => {
  it('lists every workspace with its state, and shows one\'s settings with no token or digest in either', async () => {
    const token = await init(alpha)
    await init(beta)
    await buckle(['disable', 'beta'])

    const listed = await buckle(['list'])
    expect(listed.out).toMatch(/alpha\s+online\s+[0-9a-f-]{36}\s+/)
    expect(listed.out).toMatch(/beta\s+offline\s+[0-9a-f-]{36}\s+/)
    const json = await buckle(['list', '--json'])
    expect(JSON.parse(json.out)).toMatchObject([{ id: workspaceIdOf(alpha), name: 'alpha', online: true, tokens: 1 }, { id: workspaceIdOf(beta), name: 'beta', online: false }])

    const shown = await buckle(['show', '--json'], { cwd: alpha })
    expect(JSON.parse(shown.out)).toMatchObject({ id: workspaceIdOf(alpha), settings: { version: 1, packs: {} } })
    const text = await buckle(['show'], { cwd: alpha })
    expect(text.out).toContain('packs.shell')
    for (const printed of [listed.out, json.out, shown.out, text.out]) {
      expect(printed).not.toContain(token)
      expect(printed).not.toContain('sha256')
    }
  })

  // D85, Q3: each setting in force says where it comes from: the workspace's own, the node's default, or Buckle's.
  it('shows each setting in force with where it comes from, the file as stored under --json', async () => {
    const config = node({ BUCKLE_ALLOW_SHELL: 'false' })
    await init(alpha)
    expect((await buckle(['set', 'packs.hostGit', 'on'], { cwd: alpha, config })).exitCode).toBe(0)
    const text = await buckle(['show'], { cwd: alpha, config })
    expect(text.out).toMatch(/\n {2}mount {19}\/workspace +workspace\n/)
    expect(text.out).toMatch(/\n {2}packs\.shell {13}off +node default\n/)
    expect(text.out).toMatch(/\n {2}packs\.hostGit {11}on +workspace\n/)
    expect(text.out).toMatch(/\n {2}approvalWaitMs {10}15000 +built-in\n/)
    expect(text.out).toContain('Its policy lists, each with where it comes from: buckle policy show --workspace alpha.')
    const json = JSON.parse((await buckle(['show', '--json'], { cwd: alpha, config })).out) as { settings: { packs: object }; inForce: { packs: { shell: boolean }; sources: Record<string, string> } }
    expect(json.settings.packs).toEqual({ hostGit: true })
    expect(json.inForce).toMatchObject({ packs: { shell: false }, sources: { 'packs.shell': 'node', 'packs.hostGit': 'workspace', 'approvalWaitMs': 'built-in' } })
  })

  // D85, Q3 and Q14: buckle policy show names each list's source, and each deny entry's, the node's being its floor.
  it('shows the policy in force with where each list comes from, and the node\'s deny entries as its floor', async () => {
    const config = node({ BUCKLE_COMMAND_ALLOW: 'pnpm *', BUCKLE_COMMAND_DENY: 'curl *' })
    await init(alpha)
    const policy = (...words: string[]) => runCli({ argv: ['policy', ...words], config, confirm: null, cwd: alpha })
    expect((await policy('deny-command', 'rm *')).exitCode).toBe(0)
    expect((await policy('allow-url', 'docs.test')).exitCode).toBe(0)
    out = ''
    expect((await policy('show')).exitCode).toBe(0)
    expect(out).toContain('Mount     /workspace, the workspace\'s own\n')
    expect(out).toContain('Command allow list (only these may run), the node\'s default, from buckle.env\n  pnpm *\n')
    expect(out).toContain('Command deny list (refused outright)\n  curl *  the node\'s, for every workspace\n  rm *    the workspace\'s own\n')
    expect(out).toContain('Approved hosts and URLs (only these may be reached), the workspace\'s own\n  docs.test\n')
    expect(out).toContain('Allowed interpreters (read as ordinary commands; any other runs unknown code), Buckle\'s default\n  (none)\n')
    out = ''
    expect((await policy('show', '--json')).exitCode).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ sources: { 'mount': 'workspace', 'commands.allow': 'node', 'network.allow': 'workspace', 'commands.deny': { node: ['curl *'], workspace: ['rm *'] } } })
  })

  // Fix brief 4, finding 25: five of the labels were pinned by no test, and a mutant fixing each one passed the suite.
  it('names the node as the source of the mount, approved URLs, and destructive entries a workspace leaves to it, beside the workspace\'s own', async () => {
    const config = node({ BUCKLE_WORKSPACE_MOUNT: '/node', BUCKLE_NETWORK_ALLOW: 'node.test', BUCKLE_COMMAND_DESTRUCTIVE: 'git push *' })
    await init(alpha)
    const policy = (...words: string[]) => runCli({ argv: ['policy', ...words], config, confirm: null, cwd: alpha })
    expect((await buckle(['unset', 'mount'], { cwd: alpha, config })).exitCode).toBe(0)
    expect((await policy('destructive-command', 'rm -rf *')).exitCode).toBe(0)
    out = ''
    expect((await policy('show')).exitCode).toBe(0)
    expect(out).toContain('Mount     /node, the node\'s default, from buckle.env\n')
    expect(out).toContain('Approved hosts and URLs (only these may be reached), the node\'s default, from buckle.env\n  node.test\n')
    expect(out).toContain('Destructive additions')
    expect(out).toMatch(/git push \*\s+the node's, for every workspace\n\s+rm -rf \*\s+the workspace's own/)
    out = ''
    expect((await policy('show', '--json')).exitCode).toBe(0)
    expect(JSON.parse(out).sources).toMatchObject({ 'mount': 'node', 'network.allow': 'node', 'commands.destructive': { node: ['git push *'], workspace: ['rm -rf *'] } })
  })

  it('says how to start where the node has none', async () => {
    expect((await buckle(['list'])).out).toContain('No workspace yet: run buckle workspace init in the folder to serve.')
  })
})

describe('buckle workspace enable, disable and remove', () => {
  beforeEach(async () => { await init(alpha) })

  it('switches a workspace off and on, keeping its tokens and settings', async () => {
    // House rule: the Oxford comma in a list of three.
    expect((await buckle(['disable', 'alpha'])).out).toContain('Workspace alpha is offline: calls to it are refused, and its files, records, and tokens stay.')
    expect(registry().workspaces[0]).toMatchObject({ online: false, tokens: [expect.anything()] })
    expect((await buckle(['enable', 'alpha'])).out).toContain('Workspace alpha is online')
    expect(registry().workspaces[0]!.online).toBe(true)
    expect(audit()).toMatch(/"detail":"disable alpha"/)
  })

  it('forgets a workspace and keeps its records, which serving the folder again takes up, or deletes them with --purge; the folder stays', async () => {
    await buckle(['set', 'packs.shell', 'off'], { cwd: alpha })
    const removed = await buckle(['remove', 'alpha'])
    expect(removed.exitCode).toBe(0)
    expect(removed.out).toContain(`its records stay in the state directory under workspaces/${workspaceIdOf(alpha)}/: serving the folder again takes them up`)
    expect(registry().workspaces).toEqual([])
    expect(existsSync(settingsPath(state, workspaceIdOf(alpha)))).toBe(true)

    await init(alpha)
    expect(settings(alpha).packs.shell).toBe(false)

    expect((await buckle(['remove', 'alpha', '--purge'])).out).toContain('deleted its records')
    expect(existsSync(join(state, 'workspaces', workspaceIdOf(alpha)))).toBe(false)
    expect(existsSync(alpha)).toBe(true)
  })

  // Addendum to D85, Q15: a removal leaves a marker; adding the folder again takes the records up and clears it.
  it('leaves a removal marker, takes the folder up when added again, and clears the marker', async () => {
    const id = workspaceIdOf(alpha)
    await buckle(['set', 'packs.shell', 'off'], { cwd: alpha })
    expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
    expect(existsSync(join(state, 'workspaces', id, 'removed.json'))).toBe(true)

    const added = await buckle(['add', alpha])
    expect(added.exitCode).toBe(0)
    expect(added.out).toContain('takes up the records this folder left')
    expect(registry().workspaces).toMatchObject([{ id, name: 'alpha' }])
    expect(settings(alpha).packs.shell).toBe(false)
    expect(existsSync(join(state, 'workspaces', id, 'removed.json'))).toBe(false)
  })

  // Addendum to D85, Q15: --fresh starts a new id and leaves the removed records for prune, rather than taking them up.
  it('adds a removed folder fresh under a new id, leaving its old records behind', async () => {
    const id = workspaceIdOf(alpha)
    await buckle(['set', 'packs.shell', 'off'], { cwd: alpha })
    expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)

    const fresh = await buckle(['add', alpha, '--fresh', '--name', 'alpha fresh'])
    expect(fresh.exitCode).toBe(0)
    expect(fresh.out).not.toContain('takes up the records')
    const made = registry().workspaces[0]!
    expect(made.name).toBe('alpha fresh')
    expect(made.id).not.toBe(id)
    expect(openSettingsFile({ filePath: settingsPath(state, made.id) }).read().packs.shell).toBeUndefined()
    expect(existsSync(join(state, 'workspaces', id, 'removed.json'))).toBe(true)
  })

  // Fix brief 4, finding 32: a stray log in a workspace's directory is no records, so adding the folder takes nothing up.
  it('takes up nothing for a folder whose workspace directory holds only a log, and registers it afresh', async () => {
    const directory = join(state, 'workspaces', workspaceIdOf(beta))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'actions.jsonl'), '')

    const added = await buckle(['add', beta])
    expect(added.exitCode).toBe(0)
    expect(added.out).not.toContain('takes up the records')
    expect(registry().workspaces.map(workspace => [workspace.id, workspace.name])).toContainEqual([workspaceIdOf(beta), 'beta'])
  })

  // Fix brief 4, finding 3: a folder added fresh has a random id, so the next plain add took up the older records that
  // fresh had left, and the fresh workspace's own were orphaned.
  describe('a folder removed, added fresh, and removed again', () => {
    const markOf = (id: string) => openSettingsFile({ filePath: settingsPath(state, id) }).read().env.MARK
    let first: string
    let fresh: string

    beforeEach(async () => {
      first = workspaceIdOf(alpha)
      await buckle(['set', 'env.MARK', 'first'], { cwd: alpha })
      expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
      expect((await buckle(['add', alpha, '--fresh', '--name', 'alpha fresh'])).exitCode).toBe(0)
      fresh = registry().workspaces[0]!.id
      await buckle(['set', 'env.MARK', 'fresh'], { cwd: alpha })
      expect((await buckle(['remove', 'alpha fresh'])).exitCode).toBe(0)
    })

    it('takes up the records of the most recently removed registration when added again, and leaves the older ones to prune', async () => {
      const added = await buckle(['add', alpha])

      expect(added.out).toContain('takes up the records this folder left')
      expect(registry().workspaces).toMatchObject([{ id: fresh, name: 'alpha', dir: alpha }])
      expect(markOf(fresh)).toBe('fresh')
      const listed = await buckle(['prune'])
      expect(listed.out).toContain(`workspaces/${first}/`)
      expect(listed.out).not.toContain(`workspaces/${fresh}/`)
      expect(markOf(first)).toBe('first')
    })

    it('starts afresh under the id the folder derives once prune has deleted the records both left', async () => {
      expect((await buckle(['prune', '--yes'])).exitCode).toBe(0)
      expect(existsSync(join(state, 'workspaces', fresh))).toBe(false)
      expect((await buckle(['add', alpha])).out).not.toContain('takes up the records')
      expect(registry().workspaces).toMatchObject([{ id: first }])
      expect(markOf(first)).toBeUndefined()
    })
  })

  // Addendum to D85, Q15: prune lists the removed workspaces whose records are kept, and --yes deletes them.
  it('prunes the kept records of removed workspaces, and --yes deletes them', async () => {
    const id = workspaceIdOf(alpha)
    expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)

    const listed = await buckle(['prune'])
    expect(listed.exitCode).toBe(0)
    expect(listed.out).toContain('alpha')
    expect(listed.out).toContain(`workspaces/${id}/`)
    expect(existsSync(join(state, 'workspaces', id))).toBe(true)

    const pruned = await buckle(['prune', '--yes'])
    expect(pruned.out).toContain('Deleted the records of alpha')
    expect(existsSync(join(state, 'workspaces', id))).toBe(false)
    expect((await buckle(['prune'])).out).toContain('No removed workspace')
  })

  // Fix brief 4, findings 21 and 29: prune --yes deleted a removed workspace's records under a call another process marked
  // running in it, the case a purge that met a call tells the owner to prune for once the call ends.
  it('refuses prune --yes, naming the workspace, while another process marks a call running in it, and deletes once the mark stops being refreshed', async () => {
    const id = workspaceIdOf(alpha)
    expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
    const marks = activeWorkDirectory(state, id)
    mkdirSync(marks, { recursive: true })
    const mark = join(marks, String(process.pid + 1))
    writeFileSync(mark, '')

    const refused = await buckle(['prune', '--yes'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Workspace alpha has a call running, so no records were deleted; prune again once the call ends')
    expect(refused.err).not.toContain(base)
    expect(existsSync(join(state, 'workspaces', id, 'removed.json'))).toBe(true)
    // Listing is no deletion, and goes on.
    expect((await buckle(['prune'])).out).toContain('alpha')

    const stale = new Date(Date.now() - ACTIVE_WORK_FRESH_MS - 1_000)
    utimesSync(mark, stale, stale)
    expect((await buckle(['prune', '--yes'])).out).toContain('Deleted the records of alpha')
    expect(existsSync(join(state, 'workspaces', id))).toBe(false)
  })

  // Findings 6 and 16 of the Phase 1 review, and D85, Q15: the node's own folder is a workspace like any other, removed like any other.
  it('removes the workspace made of the node\'s own folder like any other', async () => {
    const legacy = node({ BUCKLE_WORKSPACE_ROOT: beta, BUCKLE_AUTH_TOKEN: LEGACY_AGENT })
    rmSync(state, { recursive: true, force: true })
    const removed = await buckle(['remove', 'beta'], { config: legacy })
    expect(removed.exitCode).toBe(0)
    expect(registry().workspaces).toEqual([])
  })

  // Finding 36 of the Phase 1 review, and D85, Q15: a folder registered again takes its records up, the switch among them,
  // which the owner is now told, and a policy named with it would be dropped, so that is refused.
  it('says what a folder registered again takes up, its switch named where on, and refuses a policy over it', async () => {
    const workspaces = await openWorkspaceManager({ config: node() })
    try {
      const { runtime } = await byName(workspaces, 'alpha')
      await runtime.policy.setDangerouslyAllow(true)
      expect((await buckle(['remove', 'alpha'])).exitCode).toBe(0)
      const strict = { ...emptyWorkspacePolicy(), commands: { allow: [], deny: ['curl *'] } }
      await expect(workspaces.create({ dir: alpha, policy: strict })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('buckle workspace remove alpha --purge') })
      expect(registry().workspaces).toEqual([])
    } finally { await workspaces.close() }
    const taken = await buckle(['init'], { cwd: alpha })
    expect(taken.exitCode).toBe(0)
    expect(taken.out).toContain('It takes up the records this folder left when its workspace was removed: its settings, grants, and history, and its dangerously-allow switch, which is ON.')
  })

  it('names the one name a verb takes', async () => {
    expect((await buckle(['enable'])).err).toContain('Usage: buckle workspace enable <name>')
    expect((await buckle(['remove', 'alpha', 'beta'])).err).toContain('Usage: buckle workspace remove <name>')
    expect((await buckle(['disable', 'nothing'])).err).toContain('No workspace is named nothing. The workspaces: alpha')
  })
})

// Findings 5 and 9 of the Phase 1 review: disable and remove run in the CLI's own process, which used to see no work at
// all, on disk or in the process serving the workspace.
describe('buckle workspace disable and remove, while the workspace has work', () => {
  beforeEach(async () => { await init(alpha) })
  const marks = () => activeWorkDirectory(state, workspaceIdOf(alpha))

  it('refuse while a shell result waits for review on disk, and delete nothing', async () => {
    const directory = stageShellResult()

    for (const verb of [['disable', 'alpha'], ['remove', 'alpha'], ['remove', 'alpha', '--purge']]) {
      const refused = await buckle(verb)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('Resolve active tools and staged work before')
    }
    expect(registry().workspaces[0]).toMatchObject({ id: workspaceIdOf(alpha), online: true })
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
    const alphaId = workspaceIdOf(alpha)
    rmSync(alpha, { recursive: true })
    const refused = await buckle(['remove', 'alpha', '--purge'])
    expect(refused.err).toContain('will not open, so its staged work cannot be checked before its records are deleted')
    expect(existsSync(settingsPath(state, alphaId))).toBe(true)
    expect((await buckle(['disable', 'alpha'])).exitCode).toBe(0)
  })

  it('are seen by the runtime serving a call, which marks it running until it answers', async () => {
    // A node entry point with nobody at a terminal: the gated call is held for the workspace's approval wait.
    const serving = await openWorkspaceManager({ config: node(), interaction: fixedInteraction() })
    try {
      await serving.updateSettings(idOf(serving, 'alpha'), settings => ({ ...settings, approvalWaitMs: 1_500 }))
      const { runtime } = await byName(serving, 'alpha')
      const held = runtime.invoke({ request: { requestId: 'held-write', tool: 'fs_write', args: { path: 'new.txt', content: 'x' }, approvalTokens: [] }, sessionId: 'serve' })
      await vi.waitFor(() => expect(existsSync(join(marks(), String(process.pid)))).toBe(true))
      expect(activeElsewhere({ directory: marks(), pid: process.pid + 1 })).toBe(true)
      expect(await held).toMatchObject({ outcome: 'approval_required' })
      expect(existsSync(join(marks(), String(process.pid)))).toBe(false)
    } finally { await serving.close() }
  })
})

// Recheck of the workspace-model fix round 1 (findings 5 and 9 left): buckle serve holds the workbench lock from its first look at the workbenches, which is no work.
describe('buckle workspace disable and remove, while buckle serve holds the workbench lock', () => {
  let serving: WorkspaceManager
  let runtime: BuckleRuntime
  beforeEach(async () => {
    await init(alpha)
    serving = await openWorkspaceManager({ config: node(), interaction: fixedInteraction() })
    runtime = (await byName(serving, 'alpha')).runtime
  })
  afterEach(async () => { await serving.close() })

  /** A workbench record serve owns, so the lock is held; closed by discarding it when `closed`. */
  async function holdLock(closed: boolean): Promise<void> {
    const id = randomUUID()
    await runtime.workbenches.provision({ id, token: 'workspace-cli-workbench-fixture-token-0000', projectId: 'project', chatId: 'chat', allowShell: false })
    if (closed) await runtime.workbenches.discard(id, 'owner')
    await expect(runtime.workbenches.hasActiveWork()).resolves.toBe(!closed)
  }

  it.each([[['disable', 'alpha']], [['remove', 'alpha']], [['remove', 'alpha', '--purge']]])('go ahead with %j when serve runs no call and every workbench is closed', async (verb) => {
    await holdLock(true)
    expect((await buckle(verb)).exitCode).toBe(0)
    expect(registry().workspaces.find(workspace => workspace.id === workspaceIdOf(alpha))?.online ?? false).toBe(false)
  })

  it('refuse while serve holds an open workbench, which is work whoever owns it', async () => {
    await holdLock(false)
    const refused = await buckle(['disable', 'alpha'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Resolve active tools and staged work before taking this workspace offline')
    expect(registry().workspaces[0]).toMatchObject({ id: workspaceIdOf(alpha), online: true })
  })

  // The mark is what tells serve's calls apart; this test process stands in for the CLI, so serve's mark is another pid's.
  it('refuse while serve runs a call, which its mark tells, and go ahead once the mark stops being refreshed', async () => {
    await holdLock(true)
    const marks = activeWorkDirectory(state, workspaceIdOf(alpha))
    mkdirSync(marks, { recursive: true })
    const mark = join(marks, String(process.pid + 1))
    writeFileSync(mark, '')
    const refused = await buckle(['disable', 'alpha'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Resolve active tools and staged work before taking this workspace offline')
    const stale = new Date(Date.now() - ACTIVE_WORK_FRESH_MS - 1_000)
    utimesSync(mark, stale, stale)
    expect((await buckle(['disable', 'alpha'])).exitCode).toBe(0)
  })
})

/** A shell result of workspace alpha waiting for review on disk, as an isolated shell leaves it; its folder. */
function stageShellResult(): string {
  const id = `shell-${randomUUID()}`
  const directory = join(state, 'workspaces', workspaceIdOf(alpha), 'isolated-shell', workspaceStateKey(alpha), id)
  mkdirSync(join(directory, 'workspace'), { recursive: true })
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ id, sessionId: 's', stageId: 'st', tool: 'shell_exec', sourceRoot: alpha, copyRoot: join(directory, 'workspace'), writableRoots: [alpha], excluded: [], createdAt: new Date().toISOString(), status: 'needs_review' }))
  return directory
}

// Fix brief 2, R1: disable opened the workspace's runtime to look for work and left it open, so a disabled workspace's
// browser, terminals, and language servers stayed open in the process that disabled it, and in the HTTP process.
describe('the runtime of a workspace taken offline', () => {
  let manager: WorkspaceManager
  beforeEach(async () => {
    await init(alpha)
    manager = await openWorkspaceManager({ config: node() })
  })
  afterEach(async () => { await manager.close() })
  const opened = async () => (await manager.opened()).map(runtime => runtime.workspaceId)

  it('closes in the process that took it offline, and opens anew once the workspace is enabled', async () => {
    const { runtime } = await byName(manager, 'alpha')
    const closed = vi.spyOn(runtime, 'closeSessions')
    expect(await opened()).toEqual([workspaceIdOf(alpha)])

    await manager.update(idOf(manager, 'alpha'), { online: false })
    expect(await opened()).toEqual([])
    expect(closed).toHaveBeenCalledTimes(1)

    await manager.update(idOf(manager, 'alpha'), { online: true })
    expect((await byName(manager, 'alpha')).runtime).not.toBe(runtime)
    expect(await opened()).toEqual([workspaceIdOf(alpha)])
  })

  it('is opened for the check alone and closed with it, whether the workspace goes offline or the change is refused', async () => {
    expect(await opened()).toEqual([])
    await manager.update(idOf(manager, 'alpha'), { online: false })
    expect(await opened()).toEqual([])

    await manager.update(idOf(manager, 'alpha'), { online: true })
    stageShellResult()
    await expect(manager.update(idOf(manager, 'alpha'), { online: false })).rejects.toMatchObject({ status: 409, message: 'Resolve active tools and staged work before taking this workspace offline' })
    expect(await opened()).toEqual([])
    expect(registry().workspaces[0]).toMatchObject({ id: workspaceIdOf(alpha), online: true })
  })
})

// Recheck of findings 5 and 9: a call can begin between the check that allows the change and the registry write.
describe('the runtime of a workspace a call began in after the check allowed the change', () => {
  let manager: WorkspaceManager
  let runtime: BuckleRuntime
  beforeEach(async () => {
    await init(alpha)
    manager = await openWorkspaceManager({ config: node() })
    runtime = (await byName(manager, 'alpha')).runtime
    // The check sees no work; the call has begun by the time the registry has changed.
    vi.spyOn(runtime, 'hasActiveWork').mockResolvedValueOnce(false).mockResolvedValue(true)
  })
  afterEach(async () => { await manager.close() })
  const opened = async () => (await manager.opened()).map(open => open.workspaceId)

  it('stays open when the workspace is taken offline, the log saying so, and closes once the call ends', async () => {
    const closed = vi.spyOn(runtime, 'closeSessions')
    const warn = vi.spyOn(logger, 'warn')
    await manager.update(idOf(manager, 'alpha'), { online: false })

    expect(registry().workspaces[0]).toMatchObject({ id: workspaceIdOf(alpha), online: false })
    expect(closed).not.toHaveBeenCalled()
    expect(await opened()).toEqual([workspaceIdOf(alpha)])
    expect(warn.mock.calls.some(([message]) => String(message).includes('A call began in a workspace while it was taken offline'))).toBe(true)

    await manager.closeUnserved()
    expect(closed).not.toHaveBeenCalled()
    vi.mocked(runtime.hasActiveWork).mockResolvedValue(false)
    await manager.closeUnserved()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(await opened()).toEqual([])
  })

  it('stays open when the workspace is removed, and its records are kept, not purged, under that call', async () => {
    const closed = vi.spyOn(runtime, 'closeSessions')
    await expect(manager.remove(idOf(manager, 'alpha'), { purge: true })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('its records are kept; run buckle workspace prune') })

    expect(registry().workspaces).toEqual([])
    expect(closed).not.toHaveBeenCalled()
    expect(existsSync(settingsPath(state, workspaceIdOf(alpha)))).toBe(true)
    expect((await manager.prune()).map(removed => removed.id)).toEqual([workspaceIdOf(alpha)])
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
    await init(older, ['--name', 'site'])
    // The serving node, a process of its own, opened the workspace before the owner's commands ran.
    serving = await openWorkspaceManager({ config: node() })
    expect(await readWhich()).toBe('OLD')
  })
  afterEach(async () => { await serving.close() })

  async function readWhich(): Promise<unknown> {
    const { runtime } = await byName(serving, 'site')
    const response = await runtime.invoke({ request: { requestId: `which-${Math.random()}`, tool: 'fs_read', args: { path: 'which.txt' }, approvalTokens: [] }, sessionId: 'serve' })
    return response.outcome === 'ok' ? (response.output as { content: string }).content : response
  }

  it.each([[[]], [['--purge']]])('serves the new registration from its own folder (remove %j)', async (removal) => {
    expect((await buckle(['remove', 'site', ...removal])).exitCode).toBe(0)
    await init(newer, ['--name', 'site'])
    expect(await readWhich()).toBe('NEW')
    expect((await byName(serving, 'site')).config.cwd).toBe(newer)
  })

  // Recheck of the workspace-model fix round 1 (finding 2 left): the stamp is what tells this registration from the earlier one when the folder, and so the id, is the same.
  it('serves a new registration of the same folder from records of its own, after the earlier ones were purged', async () => {
    const earlier = (await byName(serving, 'site')).runtime
    const closed = vi.spyOn(earlier, 'closeSessions')
    expect((await buckle(['remove', 'site', '--purge'])).exitCode).toBe(0)
    expect(existsSync(settingsPath(state, workspaceIdOf(older)))).toBe(false)
    await init(older)
    expect(await readWhich()).toBe('OLD')
    const { runtime } = await byName(serving, 'site')
    expect(runtime).not.toBe(earlier)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(existsSync(settingsPath(state, workspaceIdOf(older)))).toBe(true)
  })

  // The same folder registered again has the same id (D85, Q15), so the runtime of its earlier registration is the one that waits.
  it('refuses a call while the earlier registration\'s runtime has work, naming no path', async () => {
    const { runtime } = await byName(serving, 'site')
    vi.spyOn(runtime, 'hasActiveWork').mockResolvedValue(true)
    expect((await buckle(['remove', 'site'])).exitCode).toBe(0)
    await init(older, ['--name', 'site'])
    const refused = await serving.resolve(workspaceIdOf(older)).catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 409 })
    expect(String((refused as Error).message)).toContain('registered again while work under its earlier registration is active')
    expect(String((refused as Error).message)).not.toContain(base)
  })

  it('closes the runtime of a workspace removed or taken offline, once it has no work, when serve looks at the registry', async () => {
    const { runtime } = await byName(serving, 'site')
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

  // Phase 3, item 7: where a service runs the node, a node setting's restart is buckle service restart.
  it('names buckle service restart for a node setting where a service runs this node, and buckle serve otherwise', async () => {
    expect((await set('host', '0.0.0.0')).err).toContain('change it in the node\'s buckle.env, and restart buckle serve.')
    const config = join(base, 'config')
    mkdirSync(join(config, 'systemd', 'user'), { recursive: true })
    writeFileSync(join(config, 'systemd', 'user', 'buckle.service'), `[Service]\nExecStart="/usr/bin/node" "/opt/main.js" serve --service systemd --state-dir "${state}"\n`)
    vi.stubEnv('XDG_CONFIG_HOME', config)
    try {
      expect((await set('host', '0.0.0.0')).err).toContain(process.platform === 'linux' ? 'change it in the node\'s buckle.env, and run buckle service restart.' : 'and restart buckle serve.')
    } finally { vi.unstubAllEnvs() }
  })

  it('changes one setting in workspace.json, a revision at a time, and unset takes it out', async () => {
    const before = settings(alpha).revision
    expect((await set('packs.shell', 'off')).exitCode).toBe(0)
    expect(settings(alpha)).toMatchObject({ revision: before + 1, packs: { shell: false } })
    expect((await set('approvalWaitMs', '0')).exitCode).toBe(0)
    expect((await set('packs.enabled', 'fs, web')).exitCode).toBe(0)
    expect((await set('packs.hostGit', 'on')).exitCode).toBe(0)
    expect((await set('mount', '/alpha')).exitCode).toBe(0)
    expect(settings(alpha)).toMatchObject({ approvalWaitMs: 0, packs: { enabled: ['fs', 'web'], hostGit: true }, mounts: [{ kind: 'workspace', target: '/alpha', access: 'rw' }] })

    for (const key of ['packs.shell', 'packs.enabled', 'approvalWaitMs', 'mount']) expect((await buckle(['unset', key], { cwd: alpha })).exitCode).toBe(0)
    const left = settings(alpha)
    expect(left.packs).toEqual({ hostGit: true })
    for (const key of ['approvalWaitMs', 'mounts'] as const) expect(left).not.toHaveProperty(key)
  })

  // D85, Q3: a key the workspace leaves unset is the node's, else Buckle's, and set it is the workspace's own.
  it('takes the node\'s value for a key it unsets, and its own over the node\'s', async () => {
    const config = node({ BUCKLE_ALLOW_SHELL: 'false', BUCKLE_WORKSPACE_MOUNT: '/node-mount' })
    const inForce = async () => {
      const workspaces = await openWorkspaceManager({ config })
      try { return (await byName(workspaces, 'alpha')).config } finally { await workspaces.close() }
    }
    expect((await buckle(['set', 'packs.shell', 'on'], { cwd: alpha, config })).exitCode).toBe(0)
    expect(await inForce()).toMatchObject({ enableShell: true, policy: { mount: '/workspace' } })
    for (const key of ['packs.shell', 'mount']) expect((await buckle(['unset', key], { cwd: alpha, config })).out).toContain(`${key} is unset, so the node's value applies`)
    expect(await inForce()).toMatchObject({ enableShell: false, policy: { mount: '/node-mount' } })
    // A policy write changes the lists alone, so where the folder shows stays the node's.
    expect((await runCli({ argv: ['policy', 'deny-command', 'curl *'], config, confirm: null, cwd: alpha })).exitCode).toBe(0)
    expect(settings(alpha)).not.toHaveProperty('mounts')
    expect(await inForce()).toMatchObject({ policy: { mount: '/node-mount', commands: { deny: ['curl *'] } } })
  })

  it('renames the workspace', async () => {
    expect((await set('name', 'Alpha site')).exitCode).toBe(0)
    expect(registry().workspaces[0]!.name).toBe('Alpha site')
  })

  it.each([
    [['packs.shell', 'maybe'], 'packs.shell is on or off'],
    [['packs.enabled', 'fs,rocket'], 'Unknown pack rocket'],
    [['approvalWaitMs', 'soon'], 'approvalWaitMs is milliseconds'],
    // Phase 2 item 6: the browser's settings are the workspace's, each checked before anything is written.
    [['browser.idleTimeoutMs', '0'], 'browser.idleTimeoutMs is milliseconds, 60000 (a minute) to 86400000 (a day); 0 is refused'],
    [['browser.idleTimeoutMs', '86400001'], 'browser.idleTimeoutMs is milliseconds'],
    [['browser.headed', 'maybe'], 'browser.headed is on or off'],
    [['browser.profile', 'profiles/mine'], 'browser.profile must be an absolute path'],
    [['browser.cdp', 'chrome'], 'Invalid browser.cdp'],
    [['mounts', '/elsewhere'], 'mounts change with buckle workspace mount add <local>:<sandbox>[:ro]'],
    [['mount', 'elsewhere'], 'mount is an absolute path with plain segments'],
    // D85, Q3: a node setting is the node's, named with the command or file that changes it.
    [['host', '0.0.0.0'], 'host is a node setting (BUCKLE_HOST), the same for every workspace, so no workspace sets it. buckle settings set does not write it'],
    [['BUCKLE_ADMIN_TOKEN', 'x'], 'BUCKLE_ADMIN_TOKEN is a node setting (BUCKLE_ADMIN_TOKEN), the same for every workspace'],
    [['experimental-admin-http', 'on'], 'experimental-admin-http is a node setting (BUCKLE_EXPERIMENTAL_ADMIN_HTTP), the same for every workspace, so no workspace sets it: buckle settings set experimental-admin-http <value> changes it.'],
    [['BUCKLE_ALLOW_SHELL', 'off'], 'BUCKLE_ALLOW_SHELL is the node\'s default for every workspace (BUCKLE_ALLOW_SHELL); buckle settings set shell <value> changes it there. This workspace\'s own is packs.shell: buckle workspace set packs.shell on|off.'],
    [['command-deny', 'curl *'], 'This workspace\'s own is policy.commands.deny: buckle policy deny-command <glob>, which adds to the node\'s.'],
    // The node's mounts and browser are workspace defaults too, each naming the workspace's own key, not "no workspace sets it".
    [['BUCKLE_BROWSER_CDP', '9222'], 'BUCKLE_BROWSER_CDP is the node\'s default for every workspace (BUCKLE_BROWSER_CDP); buckle settings set browser-cdp <value> changes it there. This workspace\'s own is browser.cdp: buckle workspace set browser.cdp <port or URL>.'],
    [['BUCKLE_BROWSER_HEADED', 'on'], 'This workspace\'s own is browser.headed: buckle workspace set browser.headed on|off.'],
    [['BUCKLE_MOUNTS', '[]'], 'This workspace\'s own is mounts: buckle workspace mount add <local>:<sandbox>[:ro].'],
    [['mount', '/usr/project'], 'Cannot mount the workspace under /usr'],
    [['packs.shell'], 'Usage: buckle workspace set <key> <value>'],
  ])('refuses %j, saying why, and writes nothing', async (words, reason) => {
    const before = settings(alpha)
    const result = await set(...words)
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(reason)
    expect(settings(alpha)).toEqual(before)
  })

  it('refuses the environment pack while the node has no BUCKLE_ENV_VALIDATOR_COMMAND, naming it', async () => {
    const result = await set('packs.enabled', 'fs,environment')
    expect(result.err).toContain('environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)')
    expect(settings(alpha).packs.enabled).toBeUndefined()
  })

  it('sets a variable the workspace\'s commands see, never echoing or auditing its value, and unsets it', async () => {
    const result = await set('env.NODE_ENV', 'workspace-cli-variable-value')
    expect(result.exitCode).toBe(0)
    expect(settings(alpha).env).toEqual({ NODE_ENV: 'workspace-cli-variable-value' })
    expect(result.out).not.toContain('workspace-cli-variable-value')
    expect(audit()).not.toContain('workspace-cli-variable-value')
    expect(audit()).toContain('set alpha env.NODE_ENV')
    // The runtime that serves the workspace gives them to its shell commands (Q13).
    const workspaces = await openWorkspaceManager({ config: node() })
    try {
      expect((await byName(workspaces, 'alpha')).config.commandEnvironment).toEqual({ NODE_ENV: 'workspace-cli-variable-value' })
    } finally { await workspaces.close() }
    expect((await buckle(['unset', 'env.NODE_ENV'], { cwd: alpha })).exitCode).toBe(0)
    expect(settings(alpha).env).toEqual({})
  })

  // A DevTools URL can carry a token and Chromium arguments a proxy password: the node's audit log keeps the key alone, as for a variable.
  it('audits a browser setting by its key, never its value', async () => {
    const cdp = 'wss://chrome.example.com/devtools/browser/abc?token=workspace-cli-devtools-token'
    expect((await set('browser.cdp', cdp)).exitCode).toBe(0)
    expect((await buckle(['unset', 'browser.cdp'], { cwd: alpha })).exitCode).toBe(0)
    const args = '--proxy-server=http://user:workspace-cli-proxy-pass@proxy.example:8080'
    expect((await set('browser.args', args)).exitCode).toBe(0)
    const profile = join(base, 'workspace-cli-profile-folder')
    expect((await set('browser.profile', profile)).exitCode).toBe(0)
    expect(settings(alpha).browser).toMatchObject({ args, profile })
    for (const secret of ['workspace-cli-devtools-token', 'workspace-cli-proxy-pass', 'workspace-cli-profile-folder']) expect(audit()).not.toContain(secret)
    for (const entry of ['set alpha browser.cdp', 'unset alpha browser.cdp', 'set alpha browser.args', 'set alpha browser.profile']) expect(audit()).toContain(entry)
    // A setting that holds no credential still records what it was set to.
    expect((await set('browser.headed', 'on')).exitCode).toBe(0)
    expect(audit()).toContain('set alpha browser.headed on')
  })

  it.each(['BUCKLE_ADMIN_TOKEN', 'PATH', 'HOME', 'lower case'])('refuses the variable %s, which Buckle itself owns or is no variable name', async (name) => {
    const result = await set(`env.${name}`, 'value')
    expect(result.exitCode).toBe(1)
    expect(settings(alpha).env).toEqual({})
  })

  // Q13: a credential-like name is taken, with a one-time warning, and the value is stored.
  it.each(['API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD'])('takes the credential-like variable %s and warns about it', async (name) => {
    const result = await set(`env.${name}`, 'an-ordinary-value')
    expect(result.exitCode).toBe(0)
    expect(result.out).toContain('looks like a credential')
    expect(result.out).toContain('plain text in workspace.json')
    expect(settings(alpha).env).toEqual({ [name]: 'an-ordinary-value' })
  })

  // Finding 26 of the Phase 1 review: only an exact admin or workspace token was refused; the node holds more secrets.
  it('refuses a value holding one of this node\'s credentials, anywhere in it, without printing it', async () => {
    const token = await init(beta)
    const secrets = { BUCKLE_FORGE_GITHUB_TOKEN: 'forge-token-fixture-0123456789', BUCKLE_BRAVE_SEARCH_API_KEY: 'brave-key-fixture-0123456789', BUCKLE_REPORT_URL: 'https://rings.test/api/v1/buckle-reports', BUCKLE_REPORT_TOKEN: 'report-token-fixture-0123456789', BUCKLE_RINGS_APPROVAL_KEY: Buffer.alloc(32, 7).toString('base64url'), BUCKLE_APPROVAL_WEBHOOK: 'https://relay.test/approvals?key=webhook-secret-fixture' }
    const config = node(secrets)
    const values = [ADMIN, `${ADMIN}\n`, `Bearer ${ADMIN}`, token, ` ${token}`, `https://x:${token}@host/`, ...Object.values(secrets).filter(value => !value.includes('rings.test')), `prefix-${secrets.BUCKLE_FORGE_GITHUB_TOKEN}`]
    for (const value of values) {
      const result = await buckle(['set', 'env.HARMLESS_NAME', value], { cwd: alpha, config })
      expect(result.exitCode).toBe(1)
      expect(result.err).toContain('no secret reaches a command Buckle runs')
      expect(result.err).not.toContain(value.trim())
    }
    expect(settings(alpha).env).toEqual({})
    expect((await buckle(['set', 'env.HARMLESS_NAME', 'an ordinary value'], { cwd: alpha, config })).exitCode).toBe(0)
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

// Phase 2 item 1 (D84 (3), D85 Q1 and Q6): the owner's mounts, after Docker's -v, read-write unless :ro.
describe('buckle workspace mount', () => {
  async function mounted(): Promise<{ data: string; docs: string }> {
    await init(alpha)
    const data = join(outside, 'data')
    const docs = join(outside, 'docs')
    for (const folder of [data, docs]) mkdirSync(folder)
    return { data, docs }
  }
  const owners = () => (settings(alpha).mounts ?? []).filter(entry => !('kind' in entry))

  it('adds a folder at a sandbox path, read-write unless :ro or --read-only, named as the disk names it', async () => {
    const { data, docs } = await mounted()
    symlinkSync(docs, join(outside, 'docs-link'))
    expect(await buckle(['mount', 'add', `${data}:/data`], { cwd: alpha })).toMatchObject({ exitCode: 0, out: `Workspace alpha: /data shows ${data}, read-write. It applies once the workspace has no active work.\n` })
    expect(await buckle(['mount', 'add', 'docs-link:/srv/docs:ro'], { cwd: outside, config: node() }).then(result => result.exitCode)).toBe(1)
    expect((await buckle(['mount', 'add', '../outside/docs-link:/srv/docs:ro'], { cwd: alpha })).exitCode).toBe(0)
    expect((await buckle(['mount', 'add', `${join(outside, 'note.txt')}:/note`], { cwd: alpha })).err).toContain('must be an existing folder or file')
    writeFileSync(join(outside, 'note.txt'), 'shared')
    expect((await buckle(['mount', 'add', '--read-only', `${join(outside, 'note.txt')}:/tmp/home/note.txt`], { cwd: alpha })).exitCode).toBe(0)
    expect(settings(alpha).mounts).toEqual([
      { kind: 'workspace', target: '/workspace', access: 'rw' },
      { source: data, target: '/data', access: 'rw' },
      { source: docs, target: '/srv/docs', access: 'ro' },
      { source: join(outside, 'note.txt'), target: '/tmp/home/note.txt', access: 'ro' },
    ])
    expect(audit()).toContain(`mount add alpha ${data}:/data:rw`)
  })

  it('lists the table as source:target:access, the folder first, and the node\'s mounts it takes while it has none, marked', async () => {
    const { data } = await mounted()
    const scratchRoot = join(outside, 'scratch')
    mkdirSync(scratchRoot)
    const config = node({ BUCKLE_SCRATCH_ROOTS: scratchRoot })
    expect((await buckle(['mount', 'list'], { cwd: alpha, config })).out).toBe(`${alpha}:/workspace:rw\n${scratchRoot}:${scratchRoot}:rw  (node scratch root)\n`)
    await buckle(['mount', 'add', `${data}:/data:ro`], { cwd: alpha, config })
    expect((await buckle(['mount', 'list'], { cwd: alpha, config })).out).toBe(`${alpha}:/workspace:rw\n${data}:/data:ro\n`)
    expect(JSON.parse((await buckle(['mount', 'list', '--json'], { cwd: alpha, config })).out)).toEqual([
      { source: alpha, target: '/workspace', access: 'rw', from: 'folder' },
      { source: data, target: '/data', access: 'ro', from: 'workspace' },
    ])
    expect((await buckle(['show'], { cwd: alpha, config })).out).toMatch(/ {2}mounts {18}.+:\/data:ro +workspace/)
  })

  it('removes a mount by its sandbox path, never the folder\'s own entry or one of the node\'s', async () => {
    const { data } = await mounted()
    const scratchRoot = join(outside, 'scratch')
    mkdirSync(scratchRoot)
    const config = node({ BUCKLE_SCRATCH_ROOTS: scratchRoot })
    expect((await buckle(['mount', 'remove', '/workspace'], { cwd: alpha, config })).err).toContain('/workspace is where workspace alpha\'s folder shows, which stays')
    expect((await buckle(['mount', 'remove', scratchRoot], { cwd: alpha, config })).err).toContain('is one of the node\'s mounts (BUCKLE_MOUNTS or BUCKLE_SCRATCH_ROOTS in buckle.env)')
    await buckle(['mount', 'add', `${data}:/data`], { cwd: alpha, config })
    expect((await buckle(['mount', 'remove', '/elsewhere'], { cwd: alpha, config })).err).toContain('No mount of workspace alpha shows at /elsewhere; its mounts show at /data')
    expect((await buckle(['mount', 'remove', '/data'], { cwd: alpha, config })).out).toBe(`Workspace alpha: /data no longer shows ${data}. It applies once the workspace has no active work.\n`)
    expect(settings(alpha).mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'rw' }])
  })

  it.each([
    ['a target the sandbox keeps', (data: string) => `${data}:/etc/data`, 'for the host\'s own programs'],
    ['/tmp', (data: string) => `${data}:/tmp`, 'for the host\'s own programs'],
    ['/proc', (data: string) => `${data}:/proc/x`, 'for the host\'s own programs'],
    ['a target inside the folder\'s', (data: string) => `${data}:/workspace/data`, 'where the workspace\'s folder shows'],
    ['the root', (data: string) => `${data}:/`, 'is not an absolute sandbox path'],
    ['a source inside the state directory', () => `${state}:/state`, 'must not hold, or sit inside, Buckle\'s state'],
    ['the workspace\'s own folder', () => `${alpha}:/again`, 'the workspace\'s own folder'],
    ['a source the folder holds', () => `${join(alpha, 'node_modules')}:/inner`, 'the workspace\'s own folder'],
    ['a folder holding the state and the workspace', () => `${base}:/above`, 'Buckle\'s state'],
    ['the Node install shared writable', () => `${join(process.execPath, '..', '..')}:/node`, 'every sandbox runs programs from'],
  ])('refuses %s, writing nothing', async (_name, spec, reason) => {
    const { data } = await mounted()
    mkdirSync(join(alpha, 'node_modules'))
    const before = settings(alpha)
    const result = await buckle(['mount', 'add', spec(data)], { cwd: alpha })
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(reason)
    expect(settings(alpha)).toEqual(before)
  })

  // The state lies outside the source here, so only the workspace-folder check can refuse it.
  it.each([['read-write', ''], ['read-only', ':ro']])('refuses a folder holding the workspace\'s own, though the state lies elsewhere (%s), writing nothing', async (_access, suffix) => {
    const code = join(outside, 'code')
    const site = join(code, 'site')
    mkdirSync(site, { recursive: true })
    await init(site)
    const before = settings(site)
    const result = await buckle(['mount', 'add', `${code}:/code${suffix}`], { cwd: site })
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('must not hold, or sit inside, the workspace\'s own folder')
    expect(result.err).not.toContain('Buckle\'s state')
    expect(settings(site)).toEqual(before)
  })

  it('holds a workspace to 32 mounts of its own, not counting its folder, saying so plainly at the 33rd', { timeout: 60_000 }, async () => {
    await mounted()
    const folders = Array.from({ length: 33 }, (_, index) => {
      const folder = join(outside, `mount-${index}`)
      mkdirSync(folder)
      return folder
    })
    for (const [index, folder] of folders.slice(0, 32).entries()) expect((await buckle(['mount', 'add', `${folder}:/m${index}`], { cwd: alpha })).exitCode).toBe(0)
    const before = settings(alpha)
    const refused = await buckle(['mount', 'add', `${folders[32]}:/m32`], { cwd: alpha })
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('A workspace holds at most 32 mounts of its own, not counting its folder; remove one first with buckle workspace mount remove <sandbox-path>')
    expect(refused.err).not.toContain('Too big')
    expect(settings(alpha)).toEqual(before)
    // Room made, it goes in.
    expect((await buckle(['mount', 'remove', '/m0'], { cwd: alpha })).exitCode).toBe(0)
    expect((await buckle(['mount', 'add', `${folders[32]}:/m32`], { cwd: alpha })).exitCode).toBe(0)
  })

  it('shares the Node install read-only, and refuses a second mount at a taken target or over a mounted source', async () => {
    const { data, docs } = await mounted()
    expect((await buckle(['mount', 'add', `${join(process.execPath, '..', '..')}:/node:ro`], { cwd: alpha })).exitCode).toBe(0)
    await buckle(['mount', 'add', `${data}:/data`], { cwd: alpha })
    expect((await buckle(['mount', 'add', `${docs}:/data`], { cwd: alpha })).err).toContain('A mount already shows at /data')
    expect((await buckle(['mount', 'add', `${docs}:/data/docs`], { cwd: alpha })).err).toContain('where another mount shows')
    mkdirSync(join(data, 'inner'))
    expect((await buckle(['mount', 'add', `${join(data, 'inner')}:/inner`], { cwd: alpha })).err).toContain('the source of the mount at /data')
  })

  it('refuses a mount while the folder shows its real path, and taking the folder\'s mount away while it has mounts', async () => {
    const { data } = await mounted()
    await buckle(['set', 'mount', '/workspace'], { cwd: alpha })
    await buckle(['mount', 'add', `${data}:/data`], { cwd: alpha })
    const unset = await buckle(['unset', 'mount'], { cwd: alpha })
    expect(unset.exitCode).toBe(1)
    expect(unset.err).toContain('This workspace has 1 mount of its own, which need its folder mounted: remove it first with buckle workspace mount remove <sandbox-path>')
    const policy = await runCli({ argv: ['policy', 'unmount'], config: node(), confirm: null, cwd: alpha })
    expect(policy.exitCode).toBe(1)
    expect(err).toContain('which need its folder mounted')
    expect((await runCli({ argv: ['policy', 'mount', '/data'], config: node(), confirm: null, cwd: alpha })).exitCode).toBe(1)
    expect(err).toContain('a mount of this workspace stands there')
    await buckle(['mount', 'remove', '/data'], { cwd: alpha })
    expect((await runCli({ argv: ['policy', 'unmount'], config: node(), confirm: null, cwd: alpha })).exitCode).toBe(0)
    expect((await buckle(['mount', 'add', `${data}:/data`], { cwd: alpha })).err).toContain('A mount needs the workspace\'s folder mounted')
    expect(owners()).toEqual([])
  })

  it('takes no spelling it cannot read as a mount', async () => {
    await mounted()
    for (const words of [['add'], ['add', '/data'], ['add', 'a:/b', 'c:/d'], ['add', '--read-only', 'a:/b:rw'], ['remove'], ['list', 'x'], ['grow']]) {
      expect((await buckle(['mount', ...words], { cwd: alpha })).exitCode).toBe(1)
    }
  })
})
