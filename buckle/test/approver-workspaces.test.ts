import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { openWorkspaceManager, WorkspaceError, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { withMount } from '../common/services/workspaces/workspace-settings.js'
import { describeOnline, watchOnline } from '../server/roster.js'
import { logger } from '../common/runtime/log.js'
import { runCli } from './support/cli.js'
import { byName, idOf } from './support/workspaces.js'

// The workspace-model brief, item 4, item 6, Q9, and D85, Q15: every ask names its workspace by name; `buckle approvals`,
// its watch, and `buckle approve` default to the workspace holding the current directory, take --workspace or --dir for
// another, and --all for every online one; `buckle serve` lists the online workspaces at start and after each change.

let base: string
let node: NodeConfig
let manager: WorkspaceManager
let out: string
let err: string

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-approver-')))
  for (const folder of ['one', 'two', 'outside']) mkdirSync(join(base, folder))
  node = loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'approver-admin-fixture', BUCKLE_SANDBOX: 'none' })
  manager = await openWorkspaceManager({ config: node })
  await manager.create({ name: 'Site one', dir: join(base, 'one') })
  await manager.create({ name: 'Site two', dir: join(base, 'two'), settings: settings => ({ ...settings, policy: { ...settings.policy, network: { allow: ['example.com', '*.example.org'] } } }) })
  out = ''
  err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.close()
  rmSync(base, { recursive: true, force: true })
})

/** An ask waiting in the workspace named `name`, as a call made there leaves one. */
async function ask(name: string, path: string): Promise<string> {
  const { runtime } = await byName(manager, name)
  const [request] = (await runtime.approvals.ask({
    tool: 'fs_write', sessionId: 'chat', call: { arguments: { path, content: 'x' }, cwd: '/workspace', description: `Write "${path}"`, effects: [`write ${path}`], complete: true },
    asks: [{ kind: 'ask', rule: 'write_scope', subject: path, reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })).requests
  return request!.token
}

async function buckle(argv: string[], cwd = join(base, 'outside')): Promise<{ exitCode: number; out: string; err: string }> {
  out = ''
  err = ''
  const { exitCode } = await runCli({ argv, config: node, confirm: async () => true, cwd })
  return { exitCode, out, err }
}

describe('buckle approvals naming no workspace', () => {
  it('lists every online workspace\'s asks under its name, each with the command that answers it, the name quoted as a shell word', async () => {
    const first = await ask('Site one', '/outside/one.md')
    const second = await ask('Site two', '/outside/two.md')

    const listed = await buckle(['approvals', '--all'])
    expect(listed.exitCode).toBe(0)
    expect(listed.out).toContain('Workspace Site one:')
    expect(listed.out).toContain('Workspace Site two:')
    expect(listed.out).toContain(`buckle approve ${first} --scope session --workspace 'Site one'`)
    expect(listed.out).toContain(`buckle approve ${second} --scope session --workspace 'Site two'`)
    expect(listed.out).toContain('  workspace: Site two')
    expect(listed.out.indexOf(second)).toBeGreaterThan(listed.out.indexOf('Workspace Site two:'))

    const json = JSON.parse((await buckle(['approvals', '--json', '--all'])).out) as Array<{ token: string; workspaceId: string; workspaceName: string }>
    expect(json.map(entry => [entry.token, entry.workspaceId, entry.workspaceName])).toEqual([[first, idOf(manager, 'Site one'), 'Site one'], [second, idOf(manager, 'Site two'), 'Site two']])
    // The list over several workspaces is the node's to audit.
    expect(readFileSync(actionsPath(node), 'utf8')).toContain('"tool":"cli_approvals"')
  })

  it('narrows to the workspace --workspace names, by name in any case or by id, or --dir names', async () => {
    const first = await ask('Site one', '/outside/one.md')
    const second = await ask('Site two', '/outside/two.md')
    for (const flags of [['--workspace', idOf(manager, 'Site two')], ['--workspace', 'Site two'], ['--workspace', 'site TWO'], ['--dir', join(base, 'two')]]) {
      const listed = await buckle(['approvals', ...flags])
      expect(listed.out).toContain(second)
      expect(listed.out).not.toContain(first)
    }
  })

  it('says nothing waits in any of them, naming each', async () => {
    expect((await buckle(['approvals', '--all'])).out).toBe('Nothing is waiting for a decision in any online workspace (Site one, Site two).\n')
  })

  it('leaves out a workspace switched offline', async () => {
    const second = await ask('Site two', '/outside/two.md')
    await manager.update(idOf(manager, 'Site two'), { online: false })
    expect((await buckle(['approvals', '--all'])).out).not.toContain(second)
  })

  it('defaults to the workspace holding the current directory, listing it alone', async () => {
    const first = await ask('Site one', '/outside/one.md')
    const second = await ask('Site two', '/outside/two.md')
    const listed = await buckle(['approvals'], join(base, 'one'))
    expect(listed.exitCode).toBe(0)
    expect(listed.out).toContain(first)
    expect(listed.out).not.toContain(second)
  })

  it('refuses from a directory no workspace holds, naming --workspace and --all and no folder', async () => {
    const refused = await buckle(['approvals'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('No workspace holds the current directory')
    expect(refused.err).toContain('--workspace <name>')
    expect(refused.err).toContain('--all')
    expect(refused.err).not.toContain(join(base, 'outside'))
    expect(readFileSync(actionsPath(node), 'utf8')).toContain('"tool":"cli_approvals"')
  })
})

describe('buckle approve naming no workspace', () => {
  it('answers the ask in the workspace whose queue holds it, audited in that workspace\'s log', async () => {
    await ask('Site one', '/outside/one.md')
    const second = await ask('Site two', '/outside/two.md')

    const approved = await buckle(['approve', second, '--scope', 'once', '--all'])
    expect(approved.exitCode).toBe(0)
    expect(approved.out).toContain('fs_write needs approval in workspace Site two')
    expect(approved.out).toContain(`Approved ${second} in workspace Site two`)
    const { runtime, config } = await byName(manager, 'Site two')
    expect(runtime.approvals.pending()).toEqual([])
    expect(readFileSync(actionsPath(config), 'utf8')).toContain('"tool":"cli_approve"')
    // D85, Q15: the workspace's entries carry its name beside its id.
    expect(runtime.actions.read(5).filter(entry => entry.tool === 'cli_approve').map(entry => [entry.workspaceId, entry.workspaceName])).toEqual([[idOf(manager, 'Site two'), 'Site two'], [idOf(manager, 'Site two'), 'Site two']])
    expect((await byName(manager, 'Site one')).runtime.approvals.pending()).toHaveLength(1)
  })

  it('shows one ask whole wherever it waits', async () => {
    const second = await ask('Site two', '/outside/two.md')
    const shown = await buckle(['approvals', 'show', second, '--all'])
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toContain('  workspace: Site two')
  })

  it('refuses a token no online workspace holds waiting, naming them and how to repeat a decision', async () => {
    const refused = await buckle(['approve', 'no-such-token', '--deny', '--all'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Nothing named no-such-token is waiting in any online workspace (Site one, Site two); to repeat a decision already recorded, name its workspace with --workspace <name>')
  })
})

// Finding 31 of the Phase 1 review: a refusal over several workspaces, or before any is chosen, was audited nowhere.
describe('an approver\'s command refused before any workspace answers it', () => {
  it.each([
    [['approve', 'bogus-token', '--deny'], 'cli_approve'],
    [['approve'], 'cli_approve'],
    [['approvals', 'show', 'bogus-token'], 'cli_approvals'],
    [['approve', 'bogus-token', '--workspace', 'nosuch'], 'cli_approve'],
  ])('%j is recorded in the node\'s log, an attempt and a failed result', async (argv, tool) => {
    expect((await buckle(argv)).exitCode).toBe(1)
    const entries = createFileActionLog(actionsPath(node)).read(20).filter(entry => entry.tool === tool)
    expect(entries.map(entry => [entry.event, entry.outcome])).toEqual([['attempt', 'started'], ['result', 'error']])
  })
})

// Fix brief 4, finding 31: check-url refused before a workspace was chosen was recorded nowhere, and read as an unreadable
// node. Its exit 1 means denied, so each refusal takes its bad-input code 2.
describe('buckle check-url refused before a workspace is chosen', () => {
  const attemptAndResult = [['attempt', 'started'], ['result', 'error']]
  const logged = () => createFileActionLog(actionsPath(node)).read(40).filter(entry => entry.tool === 'cli_check-url').map(entry => [entry.event, entry.outcome])

  it.each([
    [['https://example.com'], 'No workspace holds the current directory. Name one with --workspace <name>'],
    [['https://example.com', '--workspace', 'nosuch'], 'No workspace is named nosuch'],
    [['https://example.com', '--dir', '../outside'], 'No workspace holds that directory'],
    [['https://example.com', '--workspace'], '--workspace needs a value'],
  ])('exits 2 with the plain reason, recorded under the node scope: %j', async (words, why) => {
    const refused = await buckle(['check-url', ...words])
    expect(refused.exitCode).toBe(2)
    expect(refused.err).toContain(why)
    expect(refused.err).not.toContain('Cannot read this node\'s policy or state')
    expect(logged()).toEqual(attemptAndResult)
  })
})

// Recheck of finding 31: three more refusals of an owner's command that the audit log kept nowhere. The node's log holds
// each as an attempt and a failed result, as docs/audit-log.md says of every refusal.
describe('an owner\'s command refused before it names a workspace, under the node scope', () => {
  const nodeEntries = (tool: string) => createFileActionLog(actionsPath(node)).read(40).filter(entry => entry.tool === tool).map(entry => [entry.event, entry.outcome])
  const recorded = [['attempt', 'started'], ['result', 'error']]

  it('records a command naming no online workspace', async () => {
    await manager.update(idOf(manager, 'Site one'), { online: false })
    await manager.update(idOf(manager, 'Site two'), { online: false })
    for (const argv of [['approve', 'bogus-token', '--deny', '--all'], ['approvals', '--all']]) {
      const refused = await buckle(argv)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('No workspace is online')
    }
    expect(nodeEntries('cli_approve')).toEqual(recorded)
    expect(nodeEntries('cli_approvals')).toEqual(recorded)
  })

  it.each([
    [['approve', 'bogus-token', '--workspace', 'Site one', '--dir', 'two'], 'cli_approve', 'Name the workspace with --workspace or --dir, not both'],
    [['approvals', '--workspace'], 'cli_approvals', '--workspace needs a value'],
    [['approve', 'bogus-token', '--workspace', 'Site one', '--workspace', 'Site two'], 'cli_approve', '--workspace is given twice'],
    [['policy', 'show', '--dir'], 'cli_policy', '--dir needs a value'],
  ])('records a target flag the command cannot use: %j', async (argv, tool, why) => {
    const refused = await buckle(argv)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain(why)
    expect(nodeEntries(tool)).toEqual(recorded)
  })

  // Fix brief 4, findings 33 and 34: --all beside a named workspace was ignored, and the usage texts left --all out.
  it.each([
    [['approvals', '--all', '--workspace', 'Site one'], 'cli_approvals'],
    [['approvals', '--all', '--dir', 'one'], 'cli_approvals'],
    [['approve', 'bogus-token', '--all', '--workspace', 'Site one'], 'cli_approve'],
    [['approve', 'bogus-token', '--deny', '--all', '--dir', 'two'], 'cli_approve'],
  ])('refuses --all beside a workspace it names, recording it: %j', async (argv, tool) => {
    await ask('Site two', '/outside/two.md')
    const refused = await buckle(argv)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Name one workspace with --workspace or --dir, or pass --all, not both')
    expect(refused.out).toBe('')
    expect(nodeEntries(tool)).toEqual(recorded)
  })

  it.each([
    [['approve', 'bogus-token', '--bogus'], '[--workspace <name> | --all]'],
    [['approvals', '--bogus'], '[--workspace <name> | --all]'],
  ])('names --all in the usage it answers an unknown option with: %j', async (argv, flags) => {
    const refused = await buckle(argv, join(base, 'one'))
    expect(refused.err).toContain(flags)
  })

  it.each([
    [['approve', 'bogus-token', '--bogus', '--all'], 'Usage: buckle approve'],
    [['approvals', '--bogus', '--all'], 'Usage: buckle approvals'],
  ])('answers an unknown option over several workspaces with the usage, and records it: %j', async (argv, usage) => {
    const refused = await buckle(argv)
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain("Unknown option '--bogus'")
    expect(refused.err).toContain(usage)
    expect(nodeEntries(argv[0] === 'approve' ? 'cli_approve' : 'cli_approvals')).toEqual(recorded)
  })

  it.each([
    [['approve', 'bogus-token', '--bogus'], 'cli_approve', 'Usage: buckle approve'],
    [['approvals', '--bogus'], 'cli_approvals', 'Usage: buckle approvals'],
  ])('answers an unknown option in one workspace the same way, recorded in that workspace\'s log: %j', async (argv, tool, usage) => {
    const refused = await buckle(argv, join(base, 'one'))
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain("Unknown option '--bogus'")
    expect(refused.err).toContain(usage)
    const { runtime } = await byName(manager, 'Site one')
    expect(runtime.actions.read(20).filter(entry => entry.tool === tool).map(entry => [entry.event, entry.outcome])).toEqual(recorded)
  })
})

// Finding 10 of the Phase 1 review: a watch begun with one online workspace took the one-workspace path, and never asked
// in a workspace that came online later; it follows the online workspaces however many there are at its start.
describe('buckle approvals --watch naming no workspace', () => {
  it('follows every online workspace even where one is online at its start, audited in the node\'s log', async () => {
    await manager.update(idOf(manager, 'Site two'), { online: false })
    const refused = await buckle(['approvals', '--watch', '--all'])
    // Without a terminal it asks nothing; the way it refuses shows the path it took.
    expect(refused.err).toContain('needs a terminal to ask in')
    expect(refused.err).not.toContain('--workspace one')
    expect(readFileSync(actionsPath(node), 'utf8')).toContain('"tool":"cli_approvals"')
  })

  it('refuses a watch from a directory no workspace holds, naming --workspace and --all', async () => {
    const refused = await buckle(['approvals', '--watch'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('No workspace holds the current directory')
    expect(refused.err).toContain('--all')
  })
})

describe('the workspaces buckle serve lists', () => {
  it('names each online one with where its folder shows, its URL mode, and the packs it offers', async () => {
    await manager.update(idOf(manager, 'Site one'), { online: true })
    const text = await describeOnline(manager)
    expect(text).toContain('Serving 2 workspaces:')
    expect(text).toContain(`  Site one\n    id      ${idOf(manager, 'Site one')}\n    folder  /workspace from ${join(base, 'one')}\n    URLs    no approved list\n    packs   `)
    expect(text).toContain(`  Site two\n    id      ${idOf(manager, 'Site two')}`)
    expect(text).toContain('    URLs    an approved list of 2 entries')
    expect(text).toMatch(/packs {3}.*\bfs\b/)
  })

  // The CLI display slice, C3: the folder from its source, a mount's target and source, and why a workspace would not open
  // are escaped as its name is.
  it('escapes the folder from its source, a mount\'s target and source, and the reason a workspace would not open', async () => {
    const hostile = '/srv/a\u001b[2Jb\u009b'
    const shown = '/srv/a\\u001b[2Jb\\u009b'
    const runtime = { takeUpSettings: async () => {}, manifest: () => ({ packs: [] }), policy: { effective: () => ({ mount: '/workspace', network: { allow: [] } }) }, paths: () => ({ mounts: [{ source: hostile, target: '/data\u202e', access: 'ro', scratch: false }] }) }
    const listing = (resolve: () => Promise<unknown>) => describeOnline({ list: () => [{ id: 'w-1', name: 'Site', dir: hostile, online: true }], resolve } as unknown as WorkspaceManager)
    const listed = await listing(async () => ({ runtime }))
    expect(listed).toContain(`    folder  /workspace from ${shown}\n`)
    expect(listed).toContain(`    mount   /data\\u202e from ${shown}, read-only\n`)
    const refused = await listing(async () => { throw new Error(`cannot read ${hostile}`) })
    expect(refused).toContain(`could not open, so it answers each call with the reason: cannot read ${shown}`)
  })

  // Fix brief 1, H7: the rest of the list's text the owner's state carries: the mount target, the folder at its real path,
  // a scratch root, and the note a workspace waiting on its settings shows.
  it('escapes the mount target of the folder row, the folder at its real path, a scratch root, and the note', async () => {
    const hostile = '/srv/a\u001b[2Jb\u009b\u202e'
    const shown = '/srv/a\\u001b[2Jb\\u009b\\u202e'
    const runtime = (mount: string | null, waits: boolean) => ({
      takeUpSettings: async () => { if (waits) throw new WorkspaceError('wait\u001b[2J\u202e', 409) },
      manifest: () => ({ packs: [] }),
      policy: { effective: () => ({ mount, network: { allow: [] } }) },
      paths: () => ({ mounts: [{ source: hostile, target: hostile, access: 'rw', scratch: true }] }),
    })
    const listing = (mount: string | null, waits: boolean) => describeOnline({ list: () => [{ id: 'w-1', name: 'Site', dir: hostile, online: true }], resolve: async () => ({ runtime: runtime(mount, waits) }) } as unknown as WorkspaceManager)
    const mounted = await listing('/w\u202e', true)
    expect(mounted).toContain(`    folder  /w\\u202e from ${shown}\n`)
    expect(mounted).toContain(`    mount   ${shown}, a scratch root, read-write\n`)
    expect(mounted).toContain('    note    wait\\u001b[2J\\u202e\n')
    expect(await listing(null, false)).toContain(`    folder  ${shown}, at its real path\n`)
    for (const text of [mounted, await listing(null, false)]) expect(text).not.toMatch(/[\u001b\u009b\u202e]/)
  })

  // Phase 2 item 1: every mount of the table, at its target from its source; the system folders are never listed (Q1).
  it('names each mount of a workspace, where it shows and from where, and how it is shared', async () => {
    mkdirSync(join(base, 'data'), { recursive: true })
    await manager.addMount(idOf(manager, 'Site two'), { source: join(base, 'data'), target: '/data', access: 'ro' })
    const text = await describeOnline(manager)
    expect(text).toContain(`    mount   /data from ${realpathSync(join(base, 'data'))}, read-only\n`)
    expect(text).not.toMatch(/mount {3}\/usr/)
  })

  it('lists them again after a change, and stops when asked', async () => {
    const written: string[] = []
    const stop = watchOnline({ workspaces: manager, write: text => void written.push(text), intervalMs: 20 })
    try {
      await manager.update(idOf(manager, 'Site two'), { online: false })
      await vi.waitFor(() => expect(written.join('')).toContain('Workspaces changed.\nServing 1 workspace:\n  Site one\n'))
      expect(written.join('')).not.toContain('Site two')
    } finally { stop() }
    const count = written.length
    await manager.update(idOf(manager, 'Site two'), { online: true })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(written).toHaveLength(count)
  })

  // Finding 2 of the Phase 1 review: what a workspace taken offline or removed left open ends at serve's next look.
  it('closes the runtime of a workspace taken offline at its next look, while the others stay open', async () => {
    await byName(manager, 'Site one')
    await byName(manager, 'Site two')
    const stop = watchOnline({ workspaces: manager, write: () => {}, intervalMs: 20 })
    try {
      await manager.update(idOf(manager, 'Site two'), { online: false })
      await vi.waitFor(async () => expect((await manager.opened()).map(runtime => runtime.workspaceId)).toEqual([idOf(manager, 'Site one')]))
    } finally { stop() }
  })

  // D85, Q3: the listing says what is in force, the node's value where the workspace sets none of its own.
  it('names where a folder shows as in force, the node\'s mount where the workspace names none', async () => {
    const other = await openWorkspaceManager({ config: loadConfig({ BUCKLE_STATE_DIR: join(base, 'state-node'), BUCKLE_ADMIN_TOKEN: 'approver-admin-fixture', BUCKLE_SANDBOX: 'none', BUCKLE_WORKSPACE_MOUNT: '/node-mount' }) })
    try {
      await other.create({ name: 'Site three', dir: join(base, 'outside'), settings: settings => withMount(settings, undefined) })
      expect(await describeOnline(other)).toContain(`    folder  /node-mount from ${join(base, 'outside')}\n`)
    } finally { await other.close() }
  })

  it('says how to serve one where none is online', async () => {
    for (const name of ['Site one', 'Site two']) await manager.update(idOf(manager, name), { online: false })
    expect(await describeOnline(manager)).toBe('No workspace is online: buckle workspace init serves a folder, and buckle workspace enable <id> serves one again.\n')
    expect(existsSync(join(base, 'state', 'workspaces.json'))).toBe(true)
  })
})

// Phase 1b item 3 (Q2): a watcher on the registry folder re-lists at once; the poll is the fallback.
describe('the registry watcher buckle serve runs', () => {
  it('re-lists on a registry change before the poll would, and stops when asked', async () => {
    const written: string[] = []
    // A poll far longer than the wait, so only the folder watcher can re-list within it.
    const stop = watchOnline({ workspaces: manager, write: text => void written.push(text), intervalMs: 60_000, watchPath: join(base, 'state') })
    try {
      await manager.update(idOf(manager, 'Site two'), { online: false })
      await vi.waitFor(() => expect(written.join('')).toContain('Workspaces changed.'), { timeout: 5_000, interval: 50 })
      expect(written.join('')).not.toContain('Site two')
    } finally { stop() }
  })

  it('logs once and keeps polling when the registry watcher cannot start', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const written: string[] = []
    const stop = watchOnline({ workspaces: manager, write: text => void written.push(text), intervalMs: 20, watchPath: join(base, 'no-such-directory') })
    try {
      expect(warn.mock.calls.some(([message]) => String(message).includes('registry watcher could not start'))).toBe(true)
      await manager.update(idOf(manager, 'Site two'), { online: false })
      // The poll still re-lists the change.
      await vi.waitFor(() => expect(written.join('')).toContain('Workspaces changed.'), { timeout: 5_000, interval: 50 })
    } finally { stop() }
  })
})
