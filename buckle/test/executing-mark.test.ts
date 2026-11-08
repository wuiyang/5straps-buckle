import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvokeResponse } from '@5straps/protocol'
import type { ToolContext } from '../common/domain/tool.js'
import { logger } from '../common/runtime/log.js'
import { ACTIVE_WORK_FRESH_MS, ACTIVE_WORK_REFRESH_MS, activeElsewhere, activeWorkDirectory, createExecutingMark, executingInstances } from '../common/services/workspaces/active-work.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The executing mark (approval follow-ups, F5x): a lease each runtime holds on disk only while a tool runs, so the idle
// check of another process can tell a long tool from a workspace nobody uses. A call waiting for a person holds none.

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-executing-'))
  roots.push(root)
  return root
}

function marks(): string {
  const directory = join(temporary(), 'marks')
  mkdirSync(directory, { mode: 0o700 })
  return directory
}

const executingFiles = (directory: string) => existsSync(directory) ? readdirSync(directory).filter(name => name.startsWith('executing-')) : []

describe('the executing mark', () => {
  it('is written under its instance as a run begins, refreshed while any run holds it, and removed as the last run ends', () => {
    vi.useFakeTimers()
    const directory = marks()
    const mark = createExecutingMark({ directory, workspaceId: 'w', instance: 'first' })
    const one = mark.begin()
    const two = mark.begin()
    expect(executingFiles(directory)).toEqual(['executing-first'])

    vi.advanceTimersByTime(ACTIVE_WORK_FRESH_MS * 3)
    expect(executingInstances({ directory, now: Date.now() })).toEqual(['first'])
    one.end()
    one.end()
    expect(executingInstances({ directory, now: Date.now() })).toEqual(['first'])
    two.end()
    expect(executingFiles(directory)).toEqual([])
    expect(executingInstances({ directory, now: Date.now() })).toEqual([])
  })

  it('is not held while a run waits for a person, unless another run of the instance holds it', async () => {
    const directory = marks()
    const mark = createExecutingMark({ directory, workspaceId: 'w', instance: 'script' })
    const script = mark.begin()
    let answered!: () => void
    const waiting = script.paused(() => new Promise<string>((resolve) => { answered = () => resolve('answer') }))
    expect(executingInstances({ directory })).toEqual([])

    const nested = mark.begin()
    expect(executingInstances({ directory })).toEqual(['script'])
    nested.end()
    expect(executingInstances({ directory })).toEqual([])

    answered()
    expect(await waiting).toBe('answer')
    expect(executingInstances({ directory })).toEqual(['script'])
    script.end()
    expect(executingInstances({ directory })).toEqual([])
  })

  it('ends a run that waits without holding the mark again once the wait ends', async () => {
    const directory = marks()
    const script = createExecutingMark({ directory, workspaceId: 'w', instance: 'cut' }).begin()
    let answered!: () => void
    const waiting = script.paused(() => new Promise<void>((resolve) => { answered = resolve }))
    script.end()
    answered()
    await waiting
    expect(executingFiles(directory)).toEqual([])
  })

  it('never refreshes a mark a dead process left, though a new process under its pid runs a tool, and removes it once stale', () => {
    vi.useFakeTimers()
    const directory = marks()
    const left = join(directory, 'executing-dead')
    writeFileSync(left, '')
    const died = new Date(Date.now() - 1_000)
    utimesSync(left, died, died)

    const run = createExecutingMark({ directory, workspaceId: 'w', instance: 'reborn' }).begin()
    expect(executingInstances({ directory, now: Date.now() }).sort()).toEqual(['dead', 'reborn'])
    vi.advanceTimersByTime(ACTIVE_WORK_FRESH_MS)
    expect(executingInstances({ directory, now: Date.now() })).toEqual(['reborn'])
    expect(executingFiles(directory)).toEqual(['executing-reborn'])
    run.end()
  })

  it('recreates its mark at the next refresh where a reader removed it while the process stalled', () => {
    vi.useFakeTimers()
    const directory = marks()
    const run = createExecutingMark({ directory, workspaceId: 'w', instance: 'slow' }).begin()
    rmSync(join(directory, 'executing-slow'))
    vi.advanceTimersByTime(ACTIVE_WORK_REFRESH_MS)
    expect(executingInstances({ directory, now: Date.now() })).toEqual(['slow'])
    run.end()
  })

  it('warns, and never throws, where its mark cannot be written or removed, so a tool runs and answers all the same', () => {
    const blocked = join(temporary(), 'blocked')
    writeFileSync(blocked, '')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const run = createExecutingMark({ directory: blocked, workspaceId: 'w', instance: 'nowhere' }).begin()
    run.end()
    expect(warned).toHaveBeenCalledWith('Could not mark that a tool runs in this workspace; another process may take it as idle meanwhile', expect.objectContaining({ workspaceId: 'w' }))
    warned.mockRestore()
  })

  it('writes its mark at a later refresh where the first write failed, for as long as the run lasts', () => {
    vi.useFakeTimers()
    const directory = join(temporary(), 'late')
    writeFileSync(directory, '')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const run = createExecutingMark({ directory, workspaceId: 'w', instance: 'late' }).begin()
    expect(warned).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(ACTIVE_WORK_REFRESH_MS * 3)
    expect(warned).toHaveBeenCalledTimes(2)

    rmSync(directory)
    mkdirSync(directory, { mode: 0o700 })
    vi.advanceTimersByTime(ACTIVE_WORK_REFRESH_MS)
    expect(executingInstances({ directory, now: Date.now() })).toEqual(['late'])
    run.end()
    expect(executingFiles(directory)).toEqual([])
    warned.mockRestore()
  })

  it('stops holding the workspace within 10 s of its process being killed while a run holds it', async () => {
    const directory = marks()
    const killedAt = await killedWhileRunning(directory, 'killed')
    expect(executingFiles(directory)).toEqual(['executing-killed'])
    expect(statSync(join(directory, 'executing-killed')).mtimeMs).toBeLessThanOrEqual(killedAt)

    expect(executingInstances({ directory, now: killedAt + ACTIVE_WORK_FRESH_MS })).toEqual([])
    expect(executingFiles(directory)).toEqual([])
  }, 30_000)

  it('reads a workspace whose marks folder is not made yet as running no tool', () => {
    expect(executingInstances({ directory: join(temporary(), 'none') })).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('throws where the marks cannot be read, so the idle check can tell activity is unknown', () => {
    const directory = marks()
    writeFileSync(join(directory, 'executing-other'), '')
    chmodSync(directory, 0o000)
    try { expect(() => executingInstances({ directory })).toThrow() } finally { chmodSync(directory, 0o700) }
  })

  it('is kept apart from the mark disable and remove read, which counts waits as well', () => {
    const directory = marks()
    writeFileSync(join(directory, 'executing-elsewhere'), '')
    expect(activeElsewhere({ directory })).toBe(false)
    writeFileSync(join(directory, String(process.pid + 1)), '')
    expect(activeElsewhere({ directory })).toBe(true)
  })
})

describe('a workspace runtime', () => {
  it('marks the workspace executing while a tool runs, and not while a call waits for an answer', async () => {
    const { runtime, directory } = await workspace()
    let release!: () => void
    slowRead(runtime, 'notes.md', new Promise<void>((resolve) => { release = resolve }))
    const reading = read(runtime)
    await vi.waitFor(() => expect(executingInstances({ directory })).toHaveLength(1))
    release()
    expect(await reading).toMatchObject({ outcome: 'ok' })
    expect(executingFiles(directory)).toEqual([])

    const writing = write(runtime, { mode: 'finite', ms: 10_000 })
    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1))
    expect(existsSync(join(directory, String(process.pid)))).toBe(true)
    expect(executingInstances({ directory })).toEqual([])
    await answer(runtime, runtime.approvalService.waiting()[0]!.request.token)
    expect(await writing).toMatchObject({ outcome: 'ok' })
    expect(executingFiles(directory)).toEqual([])
    await runtime.history.close()
  }, 30_000)

  it('holds the mark until the checkpoint after the tool is taken, not only while the tool runs', async () => {
    const { runtime, directory } = await workspace()
    const run = runtime.history.run.bind(runtime.history)
    const afterTool: string[][] = []
    vi.spyOn(runtime.history, 'run').mockImplementation((details, execute, signal) => run(details, async () => {
      const output = await execute()
      afterTool.push(executingInstances({ directory }))
      return output
    }, signal))
    const writing = write(runtime, { mode: 'finite', ms: 10_000 })
    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1))
    await answer(runtime, runtime.approvalService.waiting()[0]!.request.token)

    expect(await writing).toMatchObject({ outcome: 'ok' })
    expect(afterTool).toEqual([[expect.any(String)]])
    expect(executingFiles(directory)).toEqual([])
    await runtime.history.close()
  }, 30_000)

  it('drops the mark as the tool ends, though the log service drops the result entry', async () => {
    const { runtime, directory } = await workspace()
    let release!: () => void
    slowRead(runtime, 'notes.md', new Promise<void>((resolve) => { release = resolve }))
    const append = vi.spyOn(runtime.actions, 'append').mockImplementation(() => {})
    const reading = read(runtime)
    await vi.waitFor(() => expect(executingInstances({ directory })).toHaveLength(1))
    release()

    expect(await reading).toMatchObject({ outcome: 'ok' })
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ event: 'result', tool: 'fs_read' }))
    expect(executingFiles(directory)).toEqual([])
    const entries = (await auditEntries(runtime.actions, 50)).filter(entry => entry.tool === 'fs_read')
    expect(entries.map(entry => entry.event)).toEqual(['attempt'])
    await runtime.history.close()
  }, 30_000)

  it('holds the mark while a script\'s calls run, and none while a call of the script waits for an answer', async () => {
    const { runtime, directory } = await workspace()
    let release!: () => void
    slowRead(runtime, 'notes.md', new Promise<void>((resolve) => { release = resolve }))
    const script = 'const read = await tools.fs_read({ path: "notes.md" }); await tools.fs_write({ path: "one/out.md", content: read.content }); return 1'
    const running = runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'finite', ms: 10_000 }, request: { requestId: 'script-1', tool: 'code_run', args: { script, timeoutMs: 20_000 }, approvalTokens: [] } })
    await vi.waitFor(() => expect(executingInstances({ directory })).toHaveLength(1), { timeout: 10_000 })
    release()

    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1), { timeout: 10_000 })
    expect(executingInstances({ directory })).toEqual([])
    await answer(runtime, runtime.approvalService.waiting()[0]!.request.token)
    expect(await running).toMatchObject({ outcome: 'ok', output: { ok: true, value: 1 } })
    expect(executingFiles(directory)).toEqual([])
    await runtime.history.close()
  }, 30_000)
})

async function workspace(): Promise<{ runtime: CoreRuntime; directory: string }> {
  const root = temporary()
  const folder = join(root, 'workspace')
  mkdirSync(join(folder, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(folder, 'notes.md'), 'hello')
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: folder, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  return { runtime, directory: activeWorkDirectory(join(root, 'state'), runtime.workspaceId) }
}

let sequence = 0
function read(runtime: CoreRuntime): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', request: { requestId: `read-${++sequence}`, tool: 'fs_read', args: { path: 'notes.md' }, approvalTokens: [] } })
}

function write(runtime: CoreRuntime, approvalWait: { mode: 'finite'; ms: number }): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', approvalWait, request: { requestId: `write-${++sequence}`, tool: 'fs_write', args: { path: 'one/new.md', content: 'x' }, approvalTokens: [] } })
}

async function answer(runtime: CoreRuntime, token: string): Promise<void> {
  expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
}

/** fs_read held on one path until `wait` settles, as a long tool runs. */
function slowRead(runtime: CoreRuntime, slowPath: string, wait: Promise<void>): void {
  const fsRead = runtime.registry().get('fs_read')
  const prepare = fsRead.prepare.bind(fsRead)
  vi.spyOn(fsRead, 'prepare').mockImplementation((args) => {
    const prepared = prepare(args)
    return { ...prepared, execute: async (context: ToolContext) => {
      if (args.path === slowPath) await wait
      return await prepared.execute(context)
    } }
  })
}

/** A second process that begins a run under `instance` and is killed while it holds the mark; resolves with when. */
async function killedWhileRunning(directory: string, instance: string): Promise<number> {
  const script = join(dirname(directory), `executing-child-${process.pid}.mts`)
  writeFileSync(script, `
    import { createExecutingMark } from ${JSON.stringify(new URL('../common/services/workspaces/active-work.ts', import.meta.url).href)};
    const [directory, instance] = process.argv.slice(2);
    createExecutingMark({ directory, workspaceId: 'w', instance }).begin();
    setInterval(() => {}, 60_000);
    process.stdout.write('running\\n');
  `)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, directory, instance], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('running\n')) resolve() })
    child.once('exit', code => reject(new Error(`the second process exited with ${code} before its run began`)))
  })
  // Long enough for at least one refresh, so the mark that stops being refreshed is a live one's.
  await new Promise(resolve => setTimeout(resolve, ACTIVE_WORK_REFRESH_MS + 500))
  child.kill('SIGKILL')
  await exited
  return Date.now()
}
