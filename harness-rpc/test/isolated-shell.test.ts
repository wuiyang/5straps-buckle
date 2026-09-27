import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { createShellWorkspaceRecovery, runIsolatedShell } from '../common/services/shell/isolated-shell.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { createPathView } from '../common/domain/path-view.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync('/tmp/buckle-isolated-shell-'); roots.push(root)
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot)
  const state = join(root, 'state')
  const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30 })
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
  expect((await history.list())[0]!.stageId).toBe('message')
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
