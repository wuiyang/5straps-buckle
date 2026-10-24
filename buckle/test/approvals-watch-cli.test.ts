import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { runCli } from './support/cli.js'
import { byName, idOf } from './support/workspaces.js'

// `buckle approvals --watch --all` through the CLI itself, at a terminal: the watch re-reads the online workspaces at
// each poll, and closes what a workspace taken offline left open in its process (finding 10 of the Phase 1 review, and
// its recheck). The unit tests of watchApprovals hand it a list of their own; these go through runCli and the manager.

/** Every runtime this file's managers open, with the phase it was opened in and how often it was closed. */
const opened = vi.hoisted(() => ({ phase: 'owner', records: [] as Array<{ phase: string; workspaceId: string; closes: number }> }))
vi.mock('../common/services/workspaces/workspace-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/services/workspaces/workspace-runtime.js')>()
  return {
    ...actual,
    createRuntime: async (input: Parameters<typeof actual.createRuntime>[0]) => {
      const runtime = await actual.createRuntime(input)
      const record = { phase: opened.phase, workspaceId: runtime.workspaceId, closes: 0 }
      opened.records.push(record)
      const close = runtime.closeSessions
      Object.assign(runtime, { closeSessions: async () => { record.closes++; await close() } })
      return runtime
    },
  }
})

let base: string
let node: NodeConfig
let manager: WorkspaceManager
let out: string

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-watch-cli-')))
  for (const folder of ['one', 'two', 'three', 'outside']) mkdirSync(join(base, folder))
  node = loadConfig({ BUCKLE_STATE_DIR: join(base, 'state'), BUCKLE_ADMIN_TOKEN: 'watch-cli-admin-fixture', BUCKLE_SANDBOX: 'none' })
  manager = await openWorkspaceManager({ config: node })
  await manager.create({ name: 'Site one', dir: join(base, 'one') })
  await manager.create({ name: 'Site two', dir: join(base, 'two') })
  opened.records.length = 0
  opened.phase = 'owner'
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const stream of [process.stdout, process.stderr]) delete (stream as { isTTY?: boolean }).isTTY
  await manager.close()
  rmSync(base, { recursive: true, force: true })
})

/** A terminal on stdin, stdout, and stderr, so the watch asks at it instead of refusing. */
function terminal(): PassThrough {
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin })
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as never)
  for (const stream of [process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
  return stdin
}

async function ask(name: string, path: string): Promise<string> {
  const { runtime } = await byName(manager, name)
  const [request] = (await runtime.approvals.ask({
    tool: 'fs_write', sessionId: 'chat', call: { arguments: { path, content: 'x' }, cwd: '/workspace', description: `Write "${path}"`, effects: [`write ${path}`], complete: true },
    asks: [{ kind: 'ask', rule: 'write_scope', subject: path, reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })).requests
  return request!.token
}

/** Starts the watch the way an owner types it, and answers once it has said which workspaces it watches. */
async function startWatch(): Promise<() => Promise<number>> {
  terminal()
  opened.phase = 'watch'
  const running = runCli({ argv: ['approvals', '--watch', '--all'], config: node, confirm: null, cwd: join(base, 'outside') })
  await vi.waitFor(() => expect(out).toContain('Watching workspaces Site one, Site two for approvals.'), { timeout: 10_000, interval: 25 })
  return async () => {
    process.emit('SIGINT')
    return (await running).exitCode
  }
}

describe('buckle approvals --watch --all', () => {
  it('re-resolves the online workspaces at every poll: one registered after the watch began appears, and its ask is shown', async () => {
    const stop = await startWatch()
    await manager.create({ name: 'Site three', dir: join(base, 'three') })
    const token = await ask('Site three', '/outside/three.md')

    await vi.waitFor(() => expect(out).toContain('Now also watching workspace Site three.'), { timeout: 10_000, interval: 25 })
    await vi.waitFor(() => expect(out).toContain(`token: ${token}`), { timeout: 10_000, interval: 25 })
    expect(await stop()).toBe(0)
  }, 30_000)

  // D91 follow-up F6: where no thorough stage holds a key (here the workspace's judge is off), an unrated ask's line offers no approval.
  it('shows an unrated ask\'s judge line without the promise of an approval where the thorough stage cannot approve', async () => {
    const { runtime } = await byName(manager, 'Site one')
    const subject = 'python3 job.py'
    const [request] = (await runtime.approvals.ask({
      tool: 'shell_exec', sessionId: 'chat', call: { arguments: { command: 'python3', args: ['job.py'] }, cwd: '/workspace', description: 'Run "python3 job.py"', effects: ['exec python3 job.py'], complete: true, judge: [{ subject, onRequest: true }] },
      asks: [{ kind: 'ask', rule: 'destructive_command', subject, reason: 'An interpreter the policy does not allow', offeredScopes: ['once'] }],
    })).requests
    expect(runtime.judgeApproves()).toBe(false)
    const stop = await startWatch()
    await vi.waitFor(() => expect(out).toContain(`token: ${request!.token}`), { timeout: 10_000, interval: 25 })
    expect(out).toContain(`judge:    not asked; buckle approvals judge ${request!.token} --workspace 'Site one' asks it\n`)
    expect(out).not.toContain('--approve-if-safe')
    expect(await stop()).toBe(0)
  }, 30_000)

  it('says so when a workspace goes offline while it watches, and closes that workspace\'s runtime in its own process', async () => {
    await byName(manager, 'Site two')
    const stop = await startWatch()
    const watching = (name: string) => opened.records.filter(record => record.phase === 'watch' && record.workspaceId === idOf(manager, name))
    expect(watching('Site two')).toHaveLength(1)

    await manager.update(idOf(manager, 'Site two'), { online: false })
    await vi.waitFor(() => expect(out).toContain('Stopped watching workspace Site two, which is no longer online.'), { timeout: 10_000, interval: 25 })
    // The watch's own runtime for it is closed at a poll, not held until the watch exits.
    await vi.waitFor(() => expect(watching('Site two')[0]!.closes).toBe(1), { timeout: 10_000, interval: 25 })
    expect(watching('Site one')[0]!.closes).toBe(0)
    expect(await stop()).toBe(0)
  }, 30_000)
})
