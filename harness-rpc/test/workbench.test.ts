import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'
import type { PtyProcess, PtySpawnRequest } from '../common/types/ports/pty-process.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { createWorkbenchManager, type WorkbenchManager } from '../common/services/workbench/manager.js'
import { workbenchHash } from '../common/services/workbench/storage.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fakePty() {
  const data = new Set<(data: string) => void>()
  const exit = new Set<(code: number) => void>()
  const input: string[] = []
  let size = [0, 0]
  const process: PtyProcess = {
    write(value) { input.push(value) },
    resize(cols, rows) { size = [cols, rows] },
    async stop() { for (const listener of exit) listener(0) },
    onData(listener) { data.add(listener); return () => data.delete(listener) },
    onExit(listener) { exit.add(listener); return () => exit.delete(listener) },
  }
  return { process, input, get size() { return size }, output(value: string) { for (const listener of data) listener(value) } }
}
async function fixture() {
  const root = mkdtempSync('/tmp/buckle-workbench-')
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot)
  const state = join(root, 'state'); mkdirSync(state)
  writeFileSync(join(sourceRoot, 'note.txt'), 'original')
  writeFileSync(join(sourceRoot, '.env'), 'SYNTHETIC_PRIVATE=value')
  mkdirSync(join(sourceRoot, 'private')); writeFileSync(join(sourceRoot, 'private', 'hidden.txt'), 'private file')
  const audit: ActionLogEntry[] = []
  const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 10_000_000, retentionDays: 30 })
  let clock = Date.now()
  let policy = 'initial'
  let denyWrites = false
  const disabledTools = new Set<string>()
  const processes: ReturnType<typeof fakePty>[] = []
  const spawned: PtySpawnRequest[] = []
  const options = {
    sourceRoot, directory: join(state, 'workbenches'), workspaceId: 'development', maxBytes: 1_000_000, protectedRoots: [state], hasRipgrep: false,
    actions: { async record(entry: ActionLogEntry) { audit.push(entry) }, async recoverInterrupted() { return 0 }, read() { return audit }, page() { return { entries: audit, nextCursor: null } } },
    history, now: () => clock,
    authorizePath: (path: string, operation: 'read' | 'write') => !path.startsWith('private') && !(operation === 'write' && denyWrites),
    policyHash: () => policy,
    authorizeTool: (tool: string) => !disabledTools.has(tool),
    async prepareTerminal(input: { root: string; cwd: string; cols: number; rows: number }) {
      return { command: 'fixture-shell', args: [], cwd: input.cwd, cols: input.cols, rows: input.rows, environment: {} }
    },
    async spawnPty(input: PtySpawnRequest) { const process = fakePty(); processes.push(process); spawned.push(input); return process.process },
  }
  let manager: WorkbenchManager = createWorkbenchManager(options)
  cleanups.push(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
  const grant = { id: randomUUID(), token: 'workbench-fixture-token-with-enough-bytes', projectId: 'project-a', chatId: 'chat-a', allowShell: true }
  await manager.provision(grant)
  const copyRoot = join(options.directory, grant.id, 'workspace')
  const read = () => manager.invoke(grant.id, { actorId: 'alice', tool: 'fs_read', args: { path: 'note.txt' } })
  async function edit(content: string) {
    await manager.invoke(grant.id, { actorId: 'alice', tool: 'fs_write', args: { path: 'note.txt', content, expectedHash: workbenchHash(readFileSync(join(copyRoot, 'note.txt'))) } })
  }
  return { root, sourceRoot, state, copyRoot, grant, audit, history, processes, spawned, options, read, edit, disabledTools,
    get manager() { return manager },
    denyWrites() { denyWrites = true }, changePolicy() { policy = 'changed' }, advance(ms: number) { clock += ms },
    async restart() { await manager.close(); manager = createWorkbenchManager(options) },
  }
}

describe('staged workbench files and publication', () => {
  it('persists only a token hash, binds the grant to one chat, and makes setup retries idempotent', async () => {
    const f = await fixture()
    expect(await f.manager.provision(f.grant)).toMatchObject({ id: f.grant.id, chatId: 'chat-a' })
    expect(await f.manager.authenticate(f.grant.id, 'Bearer ' + f.grant.token)).toBe(true)
    expect(await f.manager.authenticate(f.grant.id, 'Bearer agent-token')).toBe(false)
    expect(readFileSync(join(f.options.directory, f.grant.id, 'state.json'), 'utf8')).not.toContain(f.grant.token)
    await expect(f.manager.provision({ ...f.grant, token: 'different-workbench-fixture-secret-token' })).rejects.toThrow('conflicts')
    await expect(f.manager.provision({ ...f.grant, id: randomUUID() })).rejects.toThrow('unresolved')
  })

  it('shares staged edits with terminals and publishes only an explicitly reviewed checkpoint', async () => {
    const f = await fixture()
    await f.edit('staged')
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('original')
    const { terminal } = await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    expect(f.spawned[0]!.cwd).toBe(f.copyRoot)
    expect(readFileSync(join(f.copyRoot, 'note.txt'), 'utf8')).toBe('staged')
    await expect(f.manager.review(f.grant.id, 'alice')).rejects.toThrow('Stop all terminals')
    await f.manager.stopTerminal(f.grant.id, terminal.id, 'alice')
    const { review } = await f.manager.review(f.grant.id, 'alice')
    expect(review.changes).toMatchObject([{ path: 'note.txt', before: 'original', after: 'staged' }])
    const applied = await f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })
    expect(applied.workbench.status).toBe('applied')
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('staged')
    expect(await f.manager.hasActiveWork()).toBe(false)
    await f.history.restore(applied.checkpoint!.id)
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('original')
  })

  it('refuses source conflicts and keeps staged edits available', async () => {
    const f = await fixture()
    await f.edit('staged')
    const { review } = await f.manager.review(f.grant.id, 'alice')
    writeFileSync(join(f.sourceRoot, 'note.txt'), 'external')
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })).rejects.toThrow('Workspace changed')
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('external')
    expect(readFileSync(join(f.copyRoot, 'note.txt'), 'utf8')).toBe('staged')
    expect(await f.history.list()).toHaveLength(0)
  })

  it('invalidates a review when the staged file changes through editor or another writer', async () => {
    const f = await fixture()
    await f.edit('first')
    const first = await f.manager.review(f.grant.id, 'alice')
    await f.edit('second')
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: first.review.id })).rejects.toThrow('stale')
    const second = await f.manager.review(f.grant.id, 'alice')
    writeFileSync(join(f.copyRoot, 'note.txt'), 'third')
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: second.review.id })).rejects.toThrow('changed after review')
  })

  it('excludes credentials, denied directories and outside links from staging and rejects direct access', async () => {
    const f = await fixture()
    expect(existsSync(join(f.copyRoot, '.env'))).toBe(false)
    expect(existsSync(join(f.copyRoot, 'private'))).toBe(false)
    for (const path of ['.env', 'private/hidden.txt']) await expect(f.manager.invoke(f.grant.id, { actorId: 'alice', tool: 'fs_read', args: { path } })).rejects.toThrow('permission')
    symlinkSync(f.sourceRoot, join(f.copyRoot, 'escape'))
    await expect(f.manager.invoke(f.grant.id, { actorId: 'alice', tool: 'fs_read', args: { path: 'escape/note.txt' } })).rejects.toThrow(/outside|Symbolic/)
    await expect(f.manager.review(f.grant.id, 'alice')).rejects.toThrow('symbolic link')
  })

  it('rechecks permissions at Apply rather than trusting the earlier review', async () => {
    const f = await fixture()
    await f.edit('staged')
    const { review } = await f.manager.review(f.grant.id, 'alice')
    f.denyWrites()
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })).rejects.toThrow('current workspace permissions')
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('original')
  })

  it('records uncertain publication and refuses automatic retry or discard', async () => {
    const f = await fixture()
    await f.edit('staged')
    const { review } = await f.manager.review(f.grant.id, 'alice')
    const promote = f.history.promote
    f.history.promote = async (_details, _expected, _target, _content, checkpoint) => { checkpoint?.(); throw new Error('fixture interruption') }
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })).rejects.toThrow('fixture interruption')
    expect((await f.manager.get(f.grant.id)).status).toBe('apply_uncertain')
    await expect(f.manager.discard(f.grant.id, 'alice')).rejects.toThrow('uncertain')
    f.history.promote = promote
  })


  it('reconciles uncertain publication only when canonical files exactly match a known endpoint', async () => {
    const f = await fixture()
    await f.edit('staged')
    const { review } = await f.manager.review(f.grant.id, 'alice')
    const promote = f.history.promote
    f.history.promote = async (_details, _expected, _target, _content, checkpoint) => { checkpoint?.(); throw new Error('fixture interruption') }
    await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })).rejects.toThrow('fixture interruption')
    writeFileSync(join(f.sourceRoot, 'note.txt'), 'third-party')
    await expect(f.manager.recover(f.grant.id)).rejects.toThrow('partial or conflicts')
    writeFileSync(join(f.sourceRoot, 'note.txt'), 'original')
    expect((await f.manager.recover(f.grant.id)).workbench.status).toBe('open')
    f.history.promote = promote
    const next = await f.manager.review(f.grant.id, 'alice')
    await f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: next.review.id })
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('staged')
    expect(existsSync(join(f.options.directory, f.grant.id, 'objects'))).toBe(false)
  })

  it('searches staged text without following symbolic links or requiring ripgrep', async () => {
    const f = await fixture()
    await f.edit('match literal .* here')
    symlinkSync(join(f.sourceRoot, '.env'), join(f.copyRoot, 'linked.txt'))
    const response = await f.manager.invoke(f.grant.id, { actorId: 'alice', tool: 'fs_search_content', args: { path: '.', pattern: '.*' } })
    expect(response.result).toMatchObject({ literal: true, matches: [{ path: 'note.txt', line: 1, text: 'match literal .* here' }] })
    await expect(f.manager.invoke(f.grant.id, { actorId: 'alice', tool: 'fs_read', args: { path: 'linked.txt' } })).rejects.toThrow()
  })

  it('discards staged files without touching canonical files and permits a fresh workbench', async () => {
    const f = await fixture()
    await f.edit('staged')
    await f.manager.discard(f.grant.id, 'alice')
    expect(existsSync(f.copyRoot)).toBe(false)
    expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('original')
    expect(await f.manager.hasActiveWork()).toBe(false)
    await expect(f.manager.provision({ ...f.grant, id: randomUUID() })).resolves.toMatchObject({ status: 'open' })
  })
})

describe('terminal control and recovery', () => {
  it('requires explicit shell authority and refuses new terminals after a policy change', async () => {
    const f = await fixture()
    f.changePolicy()
    await expect(f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })).rejects.toThrow('policy changed')
    await f.manager.discard(f.grant.id, 'alice')
    const grant = { ...f.grant, id: randomUUID(), allowShell: false }
    await f.manager.provision(grant)
    await expect(f.manager.startTerminal(grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })).rejects.toThrow('no interactive shell authority')
  })

  it('allows only the current controller and refuses stale generations after explicit handoff', async () => {
    const f = await fixture()
    const { terminal } = await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    const request = { actorId: 'alice', generation: terminal.generation, sequence: 1, data: 'echo fixture\r' }
    await f.manager.terminalInput(f.grant.id, terminal.id, request)
    await f.manager.terminalInput(f.grant.id, terminal.id, request)
    expect(f.processes[0]!.input).toEqual(['echo fixture\r'])
    await expect(f.manager.controlTerminal(f.grant.id, terminal.id, { actorId: 'bob', action: 'acquire' })).rejects.toThrow('another user')
    const handoff = await f.manager.controlTerminal(f.grant.id, terminal.id, { actorId: 'alice', action: 'handoff', generation: terminal.generation, nextActorId: 'bob' })
    await expect(f.manager.terminalInput(f.grant.id, terminal.id, { ...request, sequence: 2 })).rejects.toThrow('another user')
    await f.manager.terminalInput(f.grant.id, terminal.id, { actorId: 'bob', generation: handoff.terminal.generation, sequence: 1, data: 'pwd\r' })
    expect(f.processes[0]!.input).toEqual(['echo fixture\r', 'pwd\r'])
    const released = await f.manager.controlTerminal(f.grant.id, terminal.id, { actorId: 'bob', generation: handoff.terminal.generation, action: 'release' })
    expect(released.terminal).toMatchObject({ controllerId: null, lastControllerId: 'bob' })
    await f.restart()
    expect((await f.manager.get(f.grant.id)).terminals[0]?.lastControllerId).toBe('bob')
    expect(JSON.stringify(f.audit)).not.toContain('echo fixture')
  })

  it('expires input control without destroying a running terminal', async () => {
    const f = await fixture()
    const { terminal } = await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    f.advance(61_000)
    await expect(f.manager.terminalInput(f.grant.id, terminal.id, { actorId: 'alice', generation: terminal.generation, sequence: 1, data: 'pwd\r' })).rejects.toThrow('expired')
    const { terminal: acquired } = await f.manager.controlTerminal(f.grant.id, terminal.id, { actorId: 'bob', action: 'acquire' })
    expect(acquired.status).toBe('running')
    expect(acquired.controllerId).toBe('bob')
  })

  it('bounds replay output and supports ordered reconnect cursors', async () => {
    const f = await fixture()
    const { terminal } = await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    f.processes[0]!.output('x'.repeat(2_000_000))
    const first = await f.manager.terminalEvents(f.grant.id, terminal.id, 0)
    expect(first.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThan(270_000)
    const next = await f.manager.terminalEvents(f.grant.id, terminal.id, first.nextSequence)
    expect(next.events[0]!.sequence).toBe(first.nextSequence + 1)
    await f.manager.stopTerminal(f.grant.id, terminal.id, 'alice')
    await f.restart()
    expect((await f.manager.terminalEvents(f.grant.id, terminal.id, 0)).events.length).toBeGreaterThan(0)
  })

  it('recovers interrupted process metadata while retaining the working copy', async () => {
    const f = await fixture()
    await f.edit('retained')
    const { terminal } = await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    await f.manager.close()
    const file = join(f.options.directory, f.grant.id, 'state.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.terminals[0].status = 'running'
    stored.terminals[0].controllerId = 'alice'
    writeFileSync(file, JSON.stringify(stored))
    await f.restart()
    expect((await f.manager.get(f.grant.id)).terminals[0]).toMatchObject({ id: terminal.id, status: 'interrupted', controllerId: null })
    expect(readFileSync(join(f.copyRoot, 'note.txt'), 'utf8')).toBe('retained')
  })

  it('refuses a second process from owning the same working copies concurrently', async () => {
    const f = await fixture()
    const other = createWorkbenchManager(f.options)
    await expect(other.get(f.grant.id)).rejects.toThrow('another Buckle process')
    await other.close()
  })

  it('stops running terminals when workspace policy is replaced', async () => {
    const f = await fixture()
    await f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    f.changePolicy()
    await f.manager.policyChanged()
    expect(await f.manager.get(f.grant.id)).toMatchObject({ status: 'interrupted', terminals: [{ status: 'exited', controllerId: null }] })
  })
})

 it('enforces tool policy for staged reads, terminal startup and reviewed publication', async () => {
  const f = await fixture()
  await f.edit('staged')
  const { review } = await f.manager.review(f.grant.id, 'alice')
  f.disabledTools.add('fs_write')
  await expect(f.manager.apply(f.grant.id, { actorId: 'alice', reviewId: review.id })).rejects.toThrow('Tool disabled')
  expect(readFileSync(join(f.sourceRoot, 'note.txt'), 'utf8')).toBe('original')
  f.disabledTools.add('fs_read')
  await expect(f.read()).rejects.toThrow('Tool disabled')
  await expect(f.manager.review(f.grant.id, 'alice')).rejects.toThrow('Tool disabled')
  f.disabledTools.add('shell_exec')
  await expect(f.manager.startTerminal(f.grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })).rejects.toThrow('Tool disabled')
  expect(f.spawned).toHaveLength(0)
  expect(f.audit.filter(event => event.outcome === 'error').length).toBe(4)
})
