import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { runCli } from './support/cli.js'
import { byName } from './support/workspaces.js'

// `buckle approvals --watch --all` through the CLI itself, at a terminal: the watch re-reads the online workspaces at
// each poll (finding 10 of the Phase 1 review, and its recheck). The unit tests of watchApprovals hand it a list of
// their own, so a watch that resolved the workspaces once passed them; this goes through runCli and the manager.

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
})
