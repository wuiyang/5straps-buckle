import { ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createCommandCapture } from '../common/services/history/command-capture.js'
import { RAW_ATTRIBUTES } from '../common/services/history/git-files.js'
import { historyGitProgram, isolatedGit, runProgram } from '../common/services/history/git-process.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { openObjectStore } from '../common/services/history/object-store.js'
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
  return { root, workspace, directory }
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

for (const kind of ['exit', 'start', 'output-limit'] as const) it(`reports safe ${kind} failure metadata from a Git child`, async () => {
  const { root, workspace, directory } = fixture()
  const program = historyGitProgram({ allowed: true, roots: [workspace] })
  if (!program) throw new Error('The Git process fixture requires trusted host git')
  const owned = join(directory, 'process')
  const { environment, safety, empty } = isolatedGit(owned)
  const fake = childFixture(child => {
    child.stderr?.emit('data', Buffer.from('private-stderr token=private-token'))
    if (kind === 'start') child.emit('error', Object.assign(new Error('private-start token=private-token'), { code: 'ENOENT', path: root }))
    if (kind === 'output-limit') child.stdout?.emit('data', Buffer.alloc(64 * 1_048_576 + 1))
    child.emit('close', kind === 'exit' ? 42 : null)
  })
  vi.mocked(spawn).mockImplementationOnce(fake.launch)
  const failure: unknown = await runProgram({ program, operation: 'init', args: [...safety, 'init', '--quiet', `--template=${empty}`, join(directory, 'git')], cwd: owned, environment }).catch(error => error)
  expect(failure).toMatchObject({ name: 'HistoryGitError', details: { operation: 'init', failure: kind, elapsedMs: expect.any(Number), ...(kind === 'exit' ? { exitCode: 42 } : {}), ...(kind === 'start' ? { errno: 'ENOENT' } : {}) } })
  expect(JSON.stringify(failure)).not.toMatch(/private-stderr|private-start|private-token/)
  expect(JSON.stringify(failure)).not.toContain(root)
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


it('retries command setup if writing safety attributes fails after git init completes', async () => {
  const { workspace, directory } = fixture()
  const commands = createCommandCapture({ directory, objects: openObjectStore(directory), excluded: () => [directory], allowed: () => true, maxFileBytes: () => 1_048_576 })
  const privateGit = join(directory, 'commands', createHash('sha256').update(workspace).digest('hex').slice(0, 24))
  const info = join(privateGit, 'info')
  let interruptions = 0
  let temporary: string | undefined
  let partialBytes = 0
  vi.mocked(writeFileSync).mockImplementation((...args: Parameters<typeof writeFileSync>) => {
    if (!interruptions && args[1] === RAW_ATTRIBUTES) {
      const partial = RAW_ATTRIBUTES.slice(0, 12)
      if (typeof args[0] === 'number') {
        const opened = actualFs.fstatSync(args[0], { bigint: true })
        temporary = actualFs.readdirSync(info).map(name => join(info, name)).find(path => {
          const named = actualFs.lstatSync(path, { bigint: true })
          return named.isFile() && named.dev === opened.dev && named.ino === opened.ino
        })
        if (!temporary) throw new Error('Fixture could not locate the safety attributes file')
        partialBytes = actualFs.writeSync(args[0], partial)
      } else if (typeof args[0] === 'string' && dirname(args[0]) === info) {
        temporary = args[0]
        actualFs.writeFileSync(args[0], partial, args[2])
        partialBytes = Buffer.byteLength(partial)
      } else return actualFs.writeFileSync(...args)
      interruptions++
      throw Object.assign(new Error('fixture setup interruption'), { code: 'EPERM' })
    }
    return actualFs.writeFileSync(...args)
  })
  await expect(commands.baseline([workspace], { deadline: Date.now() + 10_000 })).rejects.toMatchObject({ code: 'EPERM' })
  expect(interruptions).toBe(1)
  expect(partialBytes).toBe(12)
  if (!temporary) throw new Error('Safety attributes failure injection did not locate its file')
  expect(existsSync(temporary)).toBe(false)
  expect(existsSync(join(privateGit, 'HEAD'))).toBe(true)
  expect(existsSync(join(info, 'attributes'))).toBe(false)
  expect(existsSync(join(privateGit, 'buckle-setup-complete'))).toBe(false)
  const retried = await commands.baseline([workspace], { deadline: Date.now() + 10_000 })
  expect(retried).toHaveLength(1)
  expect(retried[0]).toMatchObject({ root: workspace, partial: false, tree: expect.stringMatching(/^[a-f0-9]{40}$/) })
  expect(actualFs.readFileSync(join(info, 'attributes'), 'utf8')).toBe(RAW_ATTRIBUTES)
  expect(existsSync(join(privateGit, 'buckle-setup-complete'))).toBe(true)
  expect(interruptions).toBe(1)
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

// X11 of the Codex review of 670f1dc2..01d3b0c9: a file tool's write starts no git child, even while shadow-git checkpoints
// are retained, host git is permitted, and a turn of them drops; their upkeep runs in the background collection only.
it('starts no git child for a file tool write while shadow-git checkpoints are retained', async () => {
  const { workspace, directory } = fixture()
  const file = join(workspace, 'file')
  for (const turn of ['old-1', 'old-2']) await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: turn, execute: () => writeFileSync(file, turn) })
  const journal = join(directory, 'checkpoints.json')
  actualFs.writeFileSync(journal, JSON.stringify({ ...JSON.parse(actualFs.readFileSync(journal, 'utf8')), lastGcAt: Date.now() }))
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000, keepTurns: 3 })
  const started: string[][] = []
  let writing = false
  vi.mocked(spawn).mockImplementation((...args: Parameters<typeof spawn>) => { if (writing) started.push([...args[1] ?? []]); return actualProcess.spawn(...args) })
  try {
    for (const turn of ['new-1', 'new-2']) {
      writing = true
      await history.run({ sessionId: 's', stageId: turn, tool: 'fs_write', roots: [file], scope: [{ path: file }] }, async () => { writeFileSync(file, turn) })
      writing = false
    }
    expect((await history.list()).map(record => record.stageId)).toEqual(['old-2', 'new-1', 'new-2'])
    expect(started).toEqual([])
  } finally { await history.close() }
})
