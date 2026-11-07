import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeChangedError } from '../common/domain/permission/judged.js'
import { LockWaitError } from '../common/domain/tool.js'
import { logger } from '../common/runtime/log.js'
import { HistoryBusyError, openChangeHistory, type ChangeHistory } from '../common/services/history/journal.js'
import { createShellWorkspaceRecovery, runIsolatedShell } from '../common/services/shell/isolated-shell.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createPathView } from '../common/domain/path-view.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import { configFromEnvironment } from './support/workspace-config.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(options: { lockDeadlineMs?: number } = {}) {
  const root = mkdtempSync('/tmp/buckle-isolated-shell-'); roots.push(root)
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot)
  const state = join(root, 'state')
  const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30, ...options })
  const isolation = { directory: join(state, 'shell'), maxBytes: 1_000_000, history }
  const input = { isolation, sourceRoot, writableRoots: [sourceRoot], excluded: [state], details: { sessionId: 'caller', stageId: 'message', tool: 'shell_exec' } }
  return { root, sourceRoot, state, history, isolation, input }
}

describe('isolated shell publication', () => {
  it('keeps changes private until completion and publishes an undoable checkpoint', async () => {
    const { sourceRoot, history, input, isolation } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'before')
    await runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'file'), 'agent')
      expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('before')
    } })
    expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('agent')
    expect(await history.list()).toHaveLength(1)
    await history.restore((await history.list())[0]!.id)
    expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('before')
    expect(readdirSync(isolation.directory)).toEqual([])
  })

  it('keeps unrelated owner edits out of the agent checkpoint', async () => {
    const { sourceRoot, history, input } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'before')
    await runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'file'), 'agent')
      writeFileSync(join(sourceRoot, 'owner'), 'concurrent owner edit')
    } })
    expect((await history.list())[0]!.paths).toEqual([join(sourceRoot, 'file')])
    await history.restore((await history.list())[0]!.id)
    expect(readFileSync(join(sourceRoot, 'owner'), 'utf8')).toBe('concurrent owner edit')
  })

  it('retains a conflicted private copy without overwriting owner edits', async () => {
    const { sourceRoot, history, input, isolation } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'before')
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'file'), 'agent')
      writeFileSync(join(sourceRoot, 'file'), 'owner')
    } })).rejects.toThrow('owner review')
    expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('owner')
    expect(await history.list()).toEqual([])
    const retained = join(isolation.directory, readdirSync(isolation.directory)[0]!)
    expect(JSON.parse(readFileSync(join(retained, 'run.json'), 'utf8')).status).toBe('needs_review')
    expect(readFileSync(join(retained, 'workspace', 'file'), 'utf8')).toBe('agent')
  })

  it('does not copy credentials or permit new credential files to be published', async () => {
    const { sourceRoot, input } = await fixture()
    const credential = join(sourceRoot, '.env'); writeFileSync(credential, 'SYNTHETIC=private')
    await expect(runIsolatedShell({ ...input, excluded: [...input.excluded, credential], execute: async copy => {
      expect(existsSync(join(copy, '.env'))).toBe(false)
      writeFileSync(join(copy, 'credentials.json'), '{}')
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'credentials.json'))).toBe(false)
    expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC=private')
  })

  it('refuses removal of an owner directory containing an excluded credential', async () => {
    const { sourceRoot, input } = await fixture()
    const folder = join(sourceRoot, 'folder'); mkdirSync(folder)
    const credential = join(folder, '.env'); writeFileSync(credential, 'SYNTHETIC=private')
    await expect(runIsolatedShell({ ...input, excluded: [...input.excluded, credential], execute: async copy => {
      rmSync(join(copy, 'folder'), { recursive: true })
    } })).rejects.toThrow('owner review')
    expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC=private')
  })

  it('rejects changes outside the admitted working directory', async () => {
    const { sourceRoot, input } = await fixture()
    const allowed = join(sourceRoot, 'allowed'); mkdirSync(allowed)
    await expect(runIsolatedShell({ ...input, writableRoots: [allowed], execute: async copy => {
      writeFileSync(join(copy, 'outside'), 'agent')
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'outside'))).toBe(false)
  })

  it('refuses publication through an owner-replaced parent symlink', async () => {
    const { sourceRoot, root, input } = await fixture()
    mkdirSync(join(sourceRoot, 'folder'))
    const outside = join(root, 'outside'); mkdirSync(outside)
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'folder', 'new'), 'agent')
      rmSync(join(sourceRoot, 'folder'), { recursive: true })
      symlinkSync(outside, join(sourceRoot, 'folder'))
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('cleans private read-only directories without following their symlinks', async () => {
    const { sourceRoot, input, isolation } = await fixture()
    await runIsolatedShell({ ...input, execute: async copy => {
      mkdirSync(join(copy, 'readonly'))
      writeFileSync(join(copy, 'readonly', 'file'), 'agent')
      symlinkSync('readonly', join(copy, 'link'))
      chmodSync(join(copy, 'readonly'), 0o500)
    } })
    expect(readdirSync(isolation.directory)).toEqual([])
    expect(readFileSync(join(sourceRoot, 'readonly', 'file'), 'utf8')).toBe('agent')
    chmodSync(join(sourceRoot, 'readonly'), 0o700)
  })

  it('rejects new symbolic links out of the workspace', async () => {
    const { sourceRoot, input } = await fixture()
    await expect(runIsolatedShell({ ...input, execute: async copy => { symlinkSync('/outside', join(copy, 'escape')) } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'escape'))).toBe(false)
  })

  // Review H1 of B23-B25: a link is checked where it lands once every link it passes is followed.
  it('rejects a chained link that a lexical check reads as inside the workspace', async () => {
    const { sourceRoot, input } = await fixture()
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      mkdirSync(join(copy, 'a'))
      symlinkSync('..', join(copy, 'a', 'up'))
      // up is the workspace, so up/../state leaves it for Buckle's state directory; as text it names a/state.
      symlinkSync('up/../state/dangerously-allow.json', join(copy, 'a', 'x'))
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'a'))).toBe(false)
  })

  it('publishes a chained link that lands inside the workspace', async () => {
    const { sourceRoot, input } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'kept')
    await runIsolatedShell({ ...input, execute: async copy => {
      mkdirSync(join(copy, 'a'))
      symlinkSync('..', join(copy, 'a', 'up'))
      symlinkSync('up/file', join(copy, 'a', 'y'))
    } })
    expect(readFileSync(join(sourceRoot, 'a', 'y'), 'utf8')).toBe('kept')
  })

  it('rejects a new link that moves an existing link out of the workspace', async () => {
    const { sourceRoot, input } = await fixture()
    mkdirSync(join(sourceRoot, 'a', 'inner'), { recursive: true })
    symlinkSync('a/inner/../file', join(sourceRoot, 'y'))
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      rmSync(join(copy, 'a', 'inner'), { recursive: true })
      // Inside on its own; through it, y now climbs to the parent of the workspace.
      symlinkSync('..', join(copy, 'a', 'inner'))
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'a', 'inner'))).toBe(true)
  })

  // Review item 12 of the proof-of-possession fixes: an excluded path is not in the snapshot, so a link
  // through an owner's excluded link out of the root was read as passing a plain directory.
  it('rejects a new link through an excluded link that leaves the workspace', async () => {
    const { root, sourceRoot, input } = await fixture()
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(sourceRoot, '.hidden'))
    await expect(runIsolatedShell({ ...input, excluded: [...input.excluded, join(sourceRoot, '.hidden')], execute: async copy => {
      symlinkSync('.hidden/planted.txt', join(copy, 'x'))
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'x'))).toBe(false)
  })

  it('rejects a new link that climbs back out of a directory that does not exist', async () => {
    const { sourceRoot, input } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'kept')
    // The kernel answers ENOENT for nope/..; as text it named the file, and a later `nope` would decide where it lands.
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      symlinkSync('nope/../file', join(copy, 'x'))
    } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'x'))).toBe(false)
  })

  it('still publishes a new link through an excluded plain directory', async () => {
    const { sourceRoot, input } = await fixture()
    mkdirSync(join(sourceRoot, '.cache'))
    await runIsolatedShell({ ...input, excluded: [...input.excluded, join(sourceRoot, '.cache')], execute: async copy => {
      symlinkSync('.cache/entry', join(copy, 'y'))
    } })
    expect(lstatSync(join(sourceRoot, 'y')).isSymbolicLink()).toBe(true)
  })

  it('retains changes when execution fails before a final process result', async () => {
    const { sourceRoot, input, history } = await fixture()
    await expect(runIsolatedShell({ ...input, execute: async copy => { writeFileSync(join(copy, 'partial'), 'agent'); throw new Error('process interrupted') } })).rejects.toThrow('owner review')
    expect(existsSync(join(sourceRoot, 'partial'))).toBe(false)
    expect(await history.list()).toEqual([])
  })

  it('publishes known edits from a nonzero process exit so they remain undoable', async () => {
    const { sourceRoot, input, history } = await fixture()
    const result = await runIsolatedShell({ ...input, execute: async copy => { writeFileSync(join(copy, 'partial'), 'agent'); return { exitCode: 1 } } })
    expect(result.exitCode).toBe(1)
    await history.restore((await history.list())[0]!.id)
    expect(existsSync(join(sourceRoot, 'partial'))).toBe(false)
  })
})

it('mounts only the private copy as writable and uses the command as namespace PID 1', async () => {
  const { sourceRoot, isolation, state, history } = await fixture()
  const calls: ProcessRequest[] = []
  const pack = createShellPack({ paths: createPathView({ root: sourceRoot, mount: '/workspace' }), isolation, sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [sourceRoot], hiddenPaths: [state], readOnlyPaths: [], unavailableReason: null, runProcess: async request => {
    calls.push(request)
    const copyRoot = request.args[request.args.indexOf('--ro-bind') + 1]!
    writeFileSync(join(copyRoot, 'file'), 'sandbox result')
    return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
  } })
  const prepared = pack.tools[0]!.prepare({ command: 'true' })
  expect(prepared.managesHistory).toBe(true)
  await prepared.execute({ requestId: 'request', sessionId: 'caller', stageId: 'message', timeoutMs: 1000, signal: new AbortController().signal })
  expect(calls[0]!.args).toContain('--as-pid-1')
  expect(calls[0]!.args).toContain('--unshare-pid')
  expect(calls[0]!.args).toContain('--unshare-net')
  const binding = calls[0]!.args.indexOf('--bind')
  expect(calls[0]!.args[binding + 1]).not.toBe(sourceRoot)
  expect(calls[0]!.args[binding + 2]).toBe('/workspace')
  expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('sandbox result')
  // Review m2 of the Slice D tests review: the shell files its own checkpoint, so the call that made it is named there too.
  expect((await history.recent(1)).checkpoints[0]).toMatchObject({ stageId: 'message', tool: 'shell_exec', sessionId: 'caller', requestId: 'request', current: true })
})

describe('owner retained workspace recovery', () => {
  async function recoveryFixture() {
    const base = await fixture()
    const recovery = createShellWorkspaceRecovery({ ...base.isolation, sourceRoot: base.sourceRoot, retentionDays: 30 })
    return { ...base, recovery }
  }

  it('publishes an interrupted copy into an undoable checkpoint', async () => {
    const { input, sourceRoot, recovery, history } = await recoveryFixture()
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'recovered'), 'partial work')
      throw new Error('interrupted')
    } })).rejects.toThrow('owner review')
    const record = recovery.list()[0]!
    expect((await recovery.inspect(record.id)).paths).toEqual([join(sourceRoot, 'recovered')])
    const result = await recovery.publish(record.id)
    expect(result.checkpoint?.tool).toBe('owner_workspace_publish')
    expect(readFileSync(join(sourceRoot, 'recovered'), 'utf8')).toBe('partial work')
    expect(recovery.list()).toEqual([])
    await history.restore(result.checkpoint!.id)
    expect(existsSync(join(sourceRoot, 'recovered'))).toBe(false)
  })

  it('refuses inspect, publish and discard while another runtime holds the workspace', async () => {
    const { input, recovery } = await recoveryFixture()
    await runIsolatedShell({ ...input, execute: async () => {
      const id = recovery.list()[0]!.id
      await expect(recovery.inspect(id)).rejects.toThrow('active')
      await expect(recovery.publish(id)).rejects.toThrow('active')
      await expect(recovery.discard(id)).rejects.toThrow('active')
      expect(await recovery.prune()).toEqual({ removed: [] })
    } })
  })

  it('keeps owner conflicts unchanged until the retained copy is explicitly discarded', async () => {
    const { input, recovery, sourceRoot } = await recoveryFixture()
    writeFileSync(join(sourceRoot, 'file'), 'before')
    await expect(runIsolatedShell({ ...input, execute: async copy => {
      writeFileSync(join(copy, 'file'), 'agent')
      writeFileSync(join(sourceRoot, 'file'), 'owner')
    } })).rejects.toThrow('owner review')
    const id = recovery.list()[0]!.id
    await expect(recovery.publish(id)).rejects.toThrow('conflict')
    await recovery.discard(id)
    expect(readFileSync(join(sourceRoot, 'file'), 'utf8')).toBe('owner')
    expect(recovery.list()).toEqual([])
  })

  it('refuses replay of uncertain publication and never prunes unresolved work', async () => {
    const { input, recovery, isolation } = await recoveryFixture()
    await expect(runIsolatedShell({ ...input, execute: async () => { throw new Error('interrupted') } })).rejects.toThrow('owner review')
    const record = recovery.list()[0]!
    const metadata = join(isolation.directory, record.id, 'run.json')
    writeFileSync(metadata, JSON.stringify({ ...record, status: 'publishing', createdAt: '2000-01-01T00:00:00.000Z' }))
    await expect(recovery.publish(record.id)).rejects.toThrow('uncertain')
    expect(await recovery.prune()).toEqual({ removed: [] })
    writeFileSync(metadata, JSON.stringify({ ...record, status: 'published', createdAt: '2000-01-01T00:00:00.000Z' }))
    expect(await recovery.prune()).toEqual({ removed: [record.id] })
  })

  it('rejects traversal and cross-workspace metadata before touching files', async () => {
    const { input, recovery, isolation } = await recoveryFixture()
    await expect(recovery.discard('../outside')).rejects.toThrow()
    await expect(runIsolatedShell({ ...input, execute: async () => { throw new Error('interrupted') } })).rejects.toThrow('owner review')
    const record = recovery.list()[0]!
    writeFileSync(join(isolation.directory, record.id, 'run.json'), JSON.stringify({ ...record, sourceRoot: '/outside' }))
    await expect(recovery.discard(record.id)).rejects.toThrow('does not belong')
    expect(existsSync(join(isolation.directory, record.id))).toBe(true)
  })
})

describe('the hook a pass of the decision AI is confirmed in (fix brief 9, B31)', () => {
  it('is called once the copy is taken, before the program runs', async () => {
    const { sourceRoot, input, isolation } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'rated')
    const order: string[] = []
    await runIsolatedShell({ ...input, beforeRun: () => { order.push(`confirm ${readdirSync(isolation.directory).length}`) }, execute: async copy => { order.push(readFileSync(join(copy, 'file'), 'utf8')) } })
    expect(order).toEqual(['confirm 1', 'rated'])
  })

  it('stops the run where the hook refuses, with its own error, and removes the private copy', async () => {
    const { sourceRoot, input, isolation } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'x')
    const execute = vi.fn(async () => {})
    await expect(runIsolatedShell({ ...input, beforeRun: () => { throw new CodeChangedError() }, execute })).rejects.toBeInstanceOf(CodeChangedError)
    expect(execute).not.toHaveBeenCalled()
    expect(readdirSync(isolation.directory)).toEqual([])
  })
})

describe('the workspace write lock over the copy and the confirm step (D91 follow-ups, F4)', () => {
  // A brokered write takes the workspace's write lock (history.run), so the copy and the pass's confirm step take it too:
  // a write in flight lands before the copy, which then holds it and is what the confirm step reads, and none lands
  // between the copy and the confirm step, from this process or another holding the same history.
  it('waits for a brokered write that holds the lock, then copies and confirms what it wrote', async () => {
    const { sourceRoot, input, history } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'rated')
    const order: string[] = []
    let holding!: () => void
    let release!: () => void
    const locked = new Promise<void>(resolve => { holding = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const write = history.run({ ...input.details, tool: 'fs_write', roots: [sourceRoot] }, async () => {
      holding()
      await released
      writeFileSync(join(sourceRoot, 'file'), 'changed')
      order.push('write')
    })
    await locked
    let confirmed!: () => void
    const reached = new Promise<void>(resolve => { confirmed = resolve })
    const run = runIsolatedShell({ ...input, beforeRun: () => { order.push(`confirm ${readFileSync(join(sourceRoot, 'file'), 'utf8')}`); confirmed() }, execute: async copy => { order.push(`run ${readFileSync(join(copy, 'file'), 'utf8')}`) } })
    await Promise.race([reached, new Promise(resolve => setTimeout(resolve, 500))])
    expect(order).toEqual([])
    release()
    await Promise.all([write, run])
    expect(order).toEqual(['write', 'confirm changed', 'run changed'])
  })

  it('releases the lock before the program runs, so a brokered write during the run does not wait for it', async () => {
    const { sourceRoot, input, history } = await fixture({ lockDeadlineMs: 1_000 })
    writeFileSync(join(sourceRoot, 'file'), 'rated')
    await runIsolatedShell({ ...input, execute: async () => {
      await history.run({ ...input.details, tool: 'fs_write', roots: [sourceRoot] }, async () => { writeFileSync(join(sourceRoot, 'other'), 'brokered') })
    } })
    expect(readFileSync(join(sourceRoot, 'other'), 'utf8')).toBe('brokered')
  })

  it('answers busy, with nothing run and no private copy left, when the lock stays held past its wait', async () => {
    const { sourceRoot, input, history, isolation } = await fixture({ lockDeadlineMs: 100 })
    writeFileSync(join(sourceRoot, 'file'), 'rated')
    let release!: () => void
    let holding!: () => void
    const locked = new Promise<void>(resolve => { holding = resolve })
    const held = history.exclusive(() => new Promise<void>(resolve => { release = resolve; holding() }))
    await locked
    const execute = vi.fn(async () => {})
    const beforeRun = vi.fn()
    const failed = await runIsolatedShell({ ...input, beforeRun, execute }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(LockWaitError)
    expect((failed as LockWaitError).cause).toBeInstanceOf(HistoryBusyError)
    release()
    await held
    expect(beforeRun).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(readdirSync(isolation.directory)).toEqual([])
  })
})

describe('a credential file a brokered write makes while the copy waits (D91 follow-ups, F4 residue)', () => {
  // The shell pack scans for credential files before the copy waits for the write lock, so a write that held the lock
  // then (an owner's restore of a deleted .env) lands after the scan and before the copy.
  it('is left out of the copy, as the scan would have left it out, and the rest of that write is copied', async () => {
    const { sourceRoot, input, history } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'before')
    let holding!: () => void
    let release!: () => void
    const locked = new Promise<void>(resolve => { holding = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const write = history.run({ ...input.details, tool: 'owner_restore', roots: [sourceRoot] }, async () => {
      holding()
      await released
      writeFileSync(join(sourceRoot, '.env'), 'TOKEN=planted')
      mkdirSync(join(sourceRoot, '.ssh'))
      writeFileSync(join(sourceRoot, '.ssh', 'id_ed25519'), 'planted')
      writeFileSync(join(sourceRoot, 'file'), 'after')
    })
    await locked
    const seen: string[] = []
    const run = runIsolatedShell({ ...input, execute: async copy => {
      seen.push(readFileSync(join(copy, 'file'), 'utf8'), `.env ${existsSync(join(copy, '.env'))}`, `key ${existsSync(join(copy, '.ssh', 'id_ed25519'))}`)
    } })
    await new Promise(resolve => setTimeout(resolve, 200))
    release()
    await Promise.all([write, run])
    expect(seen).toEqual(['after', '.env false', 'key false'])
    expect(readFileSync(join(sourceRoot, '.env'), 'utf8')).toBe('TOKEN=planted')
  })
})

/** Holds `history`'s write lock, as a brokered write or a git push would, until `release`. */
async function holdLock(history: ChangeHistory) {
  let release!: () => void
  let holding!: () => void
  const locked = new Promise<void>(resolve => { holding = resolve })
  const held = history.exclusive(() => new Promise<void>(resolve => { release = resolve; holding() }))
  await locked
  return { held, release: () => release() }
}

describe('a wait for the write lock that ends before the copy (D91 follow-ups, F4 residue)', () => {
  // The wait comes before the copy and the confirm step, so nothing has run when it ends: it is no failure of the
  // preparation, and the call is settled as one that never started, as the invoker settles its own wait for the lock.
  it('answers a wait the call\'s signal cuts as a lock wait, nothing run, with no preparation failure logged', async () => {
    const { sourceRoot, input, history, isolation } = await fixture()
    writeFileSync(join(sourceRoot, 'file'), 'rated')
    const lock = await holdLock(history)
    const failures = vi.spyOn(logger, 'error')
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 100)
    const execute = vi.fn(async () => {})
    const beforeRun = vi.fn()
    const failed = await runIsolatedShell({ ...input, beforeRun, execute, signal: controller.signal }).catch((error: unknown) => error)
    lock.release()
    await lock.held
    expect(failed).toBeInstanceOf(LockWaitError)
    const logged = failures.mock.calls.map(([message]) => message)
    failures.mockRestore()
    expect(logged).not.toContain('Isolated shell preparation failed')
    expect(beforeRun).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(readdirSync(isolation.directory)).toEqual([])
  })

  describe('through the invoker', () => {
    const runtimes: CoreRuntime[] = []
    const histories: ChangeHistory[] = []
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
      for (const history of histories.splice(0)) await history.close()
    })

    /** shell_exec through the real invoker and the shell pack under isolation over `history`; the process is imitated. */
    async function isolatedCall(options: { lockDeadlineMs?: number; hang?: boolean } = {}) {
      const root = mkdtempSync('/tmp/buckle-isolated-invoke-'); roots.push(root)
      const workspace = join(root, 'workspace'); mkdirSync(workspace)
      const state = join(root, 'state')
      const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell' })
      const runtime = await createRuntime({ config }); runtimes.push(runtime)
      const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30, ...(options.lockDeadlineMs ? { lockDeadlineMs: options.lockDeadlineMs } : {}) }); histories.push(history)
      const spawned: Array<{ aborted: boolean }> = []
      const pack = createShellPack({
        paths: createPathView({ root: config.cwd, mount: '/workspace' }), isolation: { directory: join(root, 'isolated'), maxBytes: 1_000_000, history },
        sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [config.cwd], hiddenPaths: [state], readOnlyPaths: [], unavailableReason: null,
        runProcess: async request => {
          spawned.push({ aborted: request.signal?.aborted === true })
          // A program that runs until the call's timer stops it.
          if (options.hang) await new Promise(resolve => request.signal?.addEventListener('abort', resolve, { once: true }))
          return { exitCode: 0, signal: null, stdout: 'ran', stderr: '', truncated: false, timedOut: options.hang === true }
        },
      })
      vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockImplementation(args => pack.tools[0]!.prepare(args))
      await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: config.cwd, scope: 'always' })
      const send = (requestId: string, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => runtime.invoke({
        request: { requestId, approvalTokens: [], tool: 'shell_exec', args: { command: 'ls' }, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) },
        sessionId: 'agent', approvalWait: { mode: 'none' }, ...(extra.signal ? { signal: extra.signal } : {}),
      })
      return { history, spawned, send }
    }

    it('answers a wait busy past its bound as busy to retry, nothing run, and a re-send runs the call', async () => {
      const { history, spawned, send } = await isolatedCall({ lockDeadlineMs: 150 })
      const lock = await holdLock(history)
      const busy = await send('busy')
      lock.release()
      await lock.held
      expect(busy).toMatchObject({ outcome: 'error', error: { code: 'STATE_BUSY', retryable: true } })
      expect(spawned).toHaveLength(0)
      expect(await send('busy')).toMatchObject({ outcome: 'ok' })
      expect(spawned).toHaveLength(1)
    })

    it('settles a call its caller cancels during the wait as one that never started, so a re-send runs it', async () => {
      const { history, spawned, send } = await isolatedCall()
      const lock = await holdLock(history)
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('cancelled')), 100)
      await send('cancelled', { signal: controller.signal })
      lock.release()
      await lock.held
      expect(spawned).toHaveLength(0)
      expect(await send('cancelled')).toMatchObject({ outcome: 'ok' })
      expect(spawned).toHaveLength(1)
    })

    // The invoker's own wait for the lock is not timed, and the tool's timer starts once the lock is held: the copy's wait
    // is the same, so a call that waits longer than its timeout for a long write still runs, with its whole time to run.
    it('waits for the lock outside the call\'s timer, then runs with the time its timer had left', async () => {
      const { history, spawned, send } = await isolatedCall()
      const lock = await holdLock(history)
      setTimeout(() => lock.release(), 600)
      const response = await send('long-wait', { timeoutMs: 200 })
      await lock.held
      expect(response).toMatchObject({ outcome: 'ok', output: { stdout: 'ran' } })
      expect(spawned).toEqual([{ aborted: false }])
    })

    it('still stops a program at the time its timer had left once the wait ends', async () => {
      const { history, spawned, send } = await isolatedCall({ hang: true })
      const lock = await holdLock(history)
      setTimeout(() => lock.release(), 300)
      const response = await send('timed', { timeoutMs: 200 })
      await lock.held
      expect(response).toMatchObject({ outcome: 'ok', output: { timedOut: true } })
      expect(spawned).toEqual([{ aborted: false }])
    })
  })
})
