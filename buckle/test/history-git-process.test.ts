import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitStore } from '../common/services/history/git-store.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { logger } from '../common/runtime/log.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const roots: string[] = []
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks()
  vi.mocked(spawn).mockReset().mockImplementation(actualProcess.spawn)
  vi.mocked(writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-process-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  return { root, workspace, directory, store, details: { roots: [workspace], id: 'change-process', phase: 'before' as const } }
}
function childFixture(action: (child: ChildProcess) => void = () => {}) {
  const child = new ChildProcess()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
  let started: () => void = () => {}
  const running = new Promise<void>(resolve => { started = resolve })
  const launch = () => { started(); queueMicrotask(() => action(child)); return child }
  return { child, kill, running, launch }
}

for (const kind of ['exit', 'start', 'output-limit'] as const) it(`reports safe ${kind} failure metadata and a failed capture summary`, async () => {
  const { root, store, details } = fixture()
  const fake = childFixture(child => {
    child.stderr?.emit('data', Buffer.from('private-stderr token=private-token'))
    if (kind === 'start') child.emit('error', Object.assign(new Error('private-start token=private-token'), { code: 'ENOENT', path: root }))
    if (kind === 'output-limit') child.stdout?.emit('data', Buffer.alloc(64 * 1_048_576 + 1))
    child.emit('close', kind === 'exit' ? 42 : null)
  })
  vi.mocked(spawn).mockImplementationOnce(fake.launch)
  const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
  const failure: unknown = await store.capture(details).catch(error => error)
  expect(failure).toMatchObject({ name: 'HistoryGitError', details: { operation: 'init', failure: kind, elapsedMs: expect.any(Number), ...(kind === 'exit' ? { exitCode: 42 } : {}), ...(kind === 'start' ? { errno: 'ENOENT' } : {}) } })
  const summaries = debug.mock.calls.filter(([message]) => message === 'History capture finished')
  expect(summaries).toEqual([['History capture finished', { phase: 'before', outcome: 'error', captureHashesMs: expect.any(Number), resolveMs: expect.any(Number), gitSubprocessMs: expect.any(Number), commandCount: 1, captureMs: expect.any(Number) }]])
  expect(JSON.stringify({ failure, summaries })).not.toMatch(/private-stderr|private-start|private-token/)
  expect(JSON.stringify({ failure, summaries })).not.toContain(root)
})

for (const phase of ['before', 'after'] as const) it(`preserves the ${phase} fallback while logging safe Git diagnostics`, async () => {
  const { root, workspace, directory } = fixture()
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000 })
  const fake = childFixture(child => { child.stderr?.emit('data', Buffer.from('private-stderr')); child.emit('close', 42) })
  let executed = false; let intercepted = false
  vi.mocked(spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
    if (!intercepted && args[1]?.includes('ls-files') && (phase === 'before' ? !executed : executed)) { intercepted = true; return fake.launch() }
    return actualProcess.spawn(...args)
  })
  const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  try {
    await history.run({ sessionId: 's', tool: 'test', roots: [workspace] }, async () => { executed = true; writeFileSync(join(workspace, 'file'), 'private-content') })
    expect(executed).toBe(true)
    expect(warned.mock.calls).toContainEqual([expect.stringContaining(phase === 'before' ? 'before this command (git ls-files exited with 42)' : 'after this call (git ls-files exited with 42)'), { phase, cause: { error: 'HistoryGitError', operation: 'ls-files', failure: 'exit', exitCode: 42 } }])
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ status: phase === 'before' ? 'complete' : 'interrupted', restorable: false })
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/private-stderr|private-content/)
    expect(JSON.stringify(warned.mock.calls)).not.toContain(root)
  } finally { await history.close() }
})

it('escalates a timed-out Git child and keeps the mutation lock until close confirms exit', async () => {
  const { workspace, directory } = fixture()
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000 })
  const fake = childFixture()
  vi.mocked(spawn).mockImplementationOnce(fake.launch)
  const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  let executed = false; let secondEntered = false
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const running = history.run({ sessionId: 's', tool: 'test', roots: [workspace] }, async () => { executed = true })
  await fake.running
  const second = history.exclusive(async () => { secondEntered = true })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
    expect(executed).toBe(false); expect(secondEntered).toBe(false)
  } finally {
    vi.useRealTimers(); fake.child.emit('close', 0, 'SIGTERM')
    await running; await second; await history.close()
  }
  expect(executed).toBe(true); expect(secondEntered).toBe(true)
  expect(warned.mock.calls).toContainEqual([expect.stringContaining('before this command (git init timed out)'), { phase: 'before', cause: { error: 'HistoryGitError', operation: 'init', failure: 'timeout', exitCode: 0 } }])
})


it('retries setup if writing safety attributes fails after git init completes', async () => {
  const { directory, store, details } = fixture()
  let interrupted = false
  vi.mocked(writeFileSync).mockImplementation((...args: Parameters<typeof writeFileSync>) => {
    if (!interrupted && typeof args[0] === 'string' && args[0].endsWith(join('info', 'attributes'))) { interrupted = true; throw Object.assign(new Error('fixture setup interruption'), { code: 'EPERM' }) }
    return actualFs.writeFileSync(...args)
  })
  await expect(store.capture(details)).rejects.toMatchObject({ code: 'EPERM' })
  expect(existsSync(join(directory, 'git', 'HEAD'))).toBe(true)
  expect(existsSync(join(directory, 'git', 'buckle-setup-complete'))).toBe(false)
  const retried = await store.capture({ ...details, id: 'change-retry' })
  expect(retried.restorable).toBe(true)
  expect(existsSync(join(directory, 'git', 'info', 'attributes'))).toBe(true)
  expect(existsSync(join(directory, 'git', 'buckle-setup-complete'))).toBe(true)
})

// Slice F2, item 5 (A9): a collection that fails saves its attempt, so the next write does not start it again at once.
it('waits its interval after a shadow-git collection that fails, never starting it again after the next write', async () => {
  const { workspace, directory } = fixture()
  const file = join(workspace, 'file')
  await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'old') })
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000 })
  let collections = 0
  vi.mocked(spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
    if (!args[1]?.includes('gc')) return actualProcess.spawn(...args)
    collections++
    return childFixture(child => child.emit('close', 1)).launch()
  })
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const write = (content: string) => history.run({ sessionId: 's', stageId: 'new', tool: 'fs_write', roots: [file], scope: [{ path: file }] }, async () => { writeFileSync(file, content) })
  try {
    await write('first')
    await vi.waitFor(() => expect(JSON.parse(actualFs.readFileSync(join(directory, 'checkpoints.json'), 'utf8')).lastGcAt).toBeGreaterThan(0))
    expect(collections).toBe(1)
    await write('second')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(collections).toBe(1)
  } finally { await history.close() }
})
