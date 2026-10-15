import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { describeOnline, watchOnline } from '../server/roster.js'
import { runCli } from './support/cli.js'

// The workspace-model brief, item 6 and Q9: every ask names its workspace by id and name, `buckle approvals`, its
// watch, and `buckle approve` cover every online workspace unless --workspace or --dir names one, and `buckle serve`
// lists the online workspaces at start and after each change.

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
  await manager.create({ id: 'one', name: 'Site one', dir: join(base, 'one') })
  await manager.create({ id: 'two', name: 'Site two', dir: join(base, 'two'), settings: settings => ({ ...settings, policy: { ...settings.policy, network: { allow: ['example.com', '*.example.org'] } } }) })
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

/** An ask waiting in workspace `id`, as a call made there leaves one. */
async function ask(id: string, path: string): Promise<string> {
  const { runtime } = await manager.resolve(id)
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
  it('lists every online workspace\'s asks under its id and name, each with the command that answers it', async () => {
    const first = await ask('one', '/outside/one.md')
    const second = await ask('two', '/outside/two.md')

    const listed = await buckle(['approvals'])
    expect(listed.exitCode).toBe(0)
    expect(listed.out).toContain('Workspace one (Site one):')
    expect(listed.out).toContain('Workspace two (Site two):')
    expect(listed.out).toContain(`buckle approve ${first} --scope session --workspace one`)
    expect(listed.out).toContain(`buckle approve ${second} --scope session --workspace two`)
    expect(listed.out).toContain('  workspace: two (Site two)')
    expect(listed.out.indexOf(second)).toBeGreaterThan(listed.out.indexOf('Workspace two (Site two):'))

    const json = JSON.parse((await buckle(['approvals', '--json'])).out) as Array<{ token: string; workspaceId: string; workspaceName: string }>
    expect(json.map(entry => [entry.token, entry.workspaceId, entry.workspaceName])).toEqual([[first, 'one', 'Site one'], [second, 'two', 'Site two']])
    // The list over several workspaces is the node's to audit.
    expect(readFileSync(actionsPath(node), 'utf8')).toContain('"tool":"cli_approvals"')
  })

  it('narrows to the workspace --workspace or --dir names', async () => {
    const first = await ask('one', '/outside/one.md')
    const second = await ask('two', '/outside/two.md')
    for (const flags of [['--workspace', 'two'], ['--dir', join(base, 'two')]]) {
      const listed = await buckle(['approvals', ...flags])
      expect(listed.out).toContain(second)
      expect(listed.out).not.toContain(first)
    }
  })

  it('says nothing waits in any of them, naming each', async () => {
    expect((await buckle(['approvals'])).out).toBe('Nothing is waiting for a decision in any online workspace (one, two).\n')
  })

  it('leaves out a workspace switched offline', async () => {
    const second = await ask('two', '/outside/two.md')
    await manager.update('two', { online: false })
    expect((await buckle(['approvals'])).out).not.toContain(second)
  })
})

describe('buckle approve naming no workspace', () => {
  it('answers the ask in the workspace whose queue holds it, audited in that workspace\'s log', async () => {
    await ask('one', '/outside/one.md')
    const second = await ask('two', '/outside/two.md')

    const approved = await buckle(['approve', second, '--scope', 'once'])
    expect(approved.exitCode).toBe(0)
    expect(approved.out).toContain('fs_write needs approval in workspace two (Site two)')
    expect(approved.out).toContain(`Approved ${second} in workspace two`)
    const { runtime, config } = await manager.resolve('two')
    expect(runtime.approvals.pending()).toEqual([])
    expect(readFileSync(actionsPath(config), 'utf8')).toContain('"tool":"cli_approve"')
    expect((await manager.resolve('one')).runtime.approvals.pending()).toHaveLength(1)
  })

  it('shows one ask whole wherever it waits', async () => {
    const second = await ask('two', '/outside/two.md')
    const shown = await buckle(['approvals', 'show', second])
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toContain('  workspace: two (Site two)')
  })

  it('refuses a token no online workspace holds waiting, naming them and how to repeat a decision', async () => {
    const refused = await buckle(['approve', 'no-such-token', '--deny'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('Nothing named no-such-token is waiting in any online workspace (one, two); to repeat a decision already recorded, name its workspace with --workspace <id>')
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

// Finding 10 of the Phase 1 review: a watch begun with one online workspace took the one-workspace path, and never asked
// in a workspace that came online later; it follows the online workspaces however many there are at its start.
describe('buckle approvals --watch naming no workspace', () => {
  it('follows every online workspace even where one is online at its start, audited in the node\'s log', async () => {
    await manager.update('two', { online: false })
    const refused = await buckle(['approvals', '--watch'])
    // Without a terminal it asks nothing; the way it refuses shows the path it took.
    expect(refused.err).toContain('needs a terminal to ask in')
    expect(refused.err).not.toContain('--workspace one')
    expect(readFileSync(actionsPath(node), 'utf8')).toContain('"tool":"cli_approvals"')
  })
})

describe('the workspaces buckle serve lists', () => {
  it('names each online one with where its folder shows, its URL mode, and the packs it offers', async () => {
    await manager.update('one', { online: true })
    const text = await describeOnline(manager)
    expect(text).toContain('Serving 2 workspaces:')
    expect(text).toContain(`  one (Site one)\n    folder  /workspace from ${join(base, 'one')}\n    URLs    no approved list\n    packs   `)
    expect(text).toContain('  two (Site two)')
    expect(text).toContain('    URLs    an approved list of 2 entries')
    expect(text).toMatch(/packs {3}.*\bfs\b/)
  })

  it('lists them again after a change, and stops when asked', async () => {
    const written: string[] = []
    const stop = watchOnline({ workspaces: manager, write: text => void written.push(text), intervalMs: 20 })
    try {
      await manager.update('two', { online: false })
      await vi.waitFor(() => expect(written.join('')).toContain('Workspaces changed.\nServing 1 workspace:\n  one (Site one)'))
      expect(written.join('')).not.toContain('two (Site two)')
    } finally { stop() }
    const count = written.length
    await manager.update('two', { online: true })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(written).toHaveLength(count)
  })

  // Finding 2 of the Phase 1 review: what a workspace taken offline or removed left open ends at serve's next look.
  it('closes the runtime of a workspace taken offline at its next look, while the others stay open', async () => {
    await manager.resolve('one')
    await manager.resolve('two')
    const stop = watchOnline({ workspaces: manager, write: () => {}, intervalMs: 20 })
    try {
      await manager.update('two', { online: false })
      await vi.waitFor(async () => expect((await manager.opened()).map(runtime => runtime.workspaceId)).toEqual(['one']))
    } finally { stop() }
  })

  it('says how to serve one where none is online', async () => {
    for (const id of ['one', 'two']) await manager.update(id, { online: false })
    expect(await describeOnline(manager)).toBe('No workspace is online: buckle workspace init serves a folder, and buckle workspace enable <id> serves one again.\n')
    expect(existsSync(join(base, 'state', 'workspaces.json'))).toBe(true)
  })
})
