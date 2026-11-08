import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_WAITING_WRITES, PROBE_DEADLINE_MS } from '../common/adapters/action-log/action-log-writer.js'
import { AuditUnavailableError, createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import type { WriterRequest } from '../common/adapters/action-log/writer-protocol.js'
import { StateBusyError } from '../common/adapters/json-file-store.js'
import { logger } from '../common/runtime/log.js'
import { createAuditHealth } from '../common/services/audit/audit-health.js'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { closeFaultyWriters, faultyWriter } from './support/writer-faults.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeFaultyWriters()
})

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-writer-')), 'actions.jsonl')
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return { event: 'result', at: '2026-11-08T00:00:00.000Z', requestId: 'r1', sessionId: 's1', tool: 'fs_read', outcome: 'ok', durationMs: 1, effects: [], args: {}, ...overrides }
}

function settled(promise: Promise<unknown>, withinMs: number): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([promise.then(() => 'resolved' as const, () => 'rejected' as const), delay(withinMs).then(() => 'pending' as const)])
}

/** A log path under a plain file, so every write and probe of it fails. */
function brokenLogPath(): string {
  const blocker = logPath()
  writeFileSync(blocker, 'not a directory')
  return join(blocker, 'actions.jsonl')
}

function orphan(path: string): void {
  const pendingPath = `${path}.pending.json`
  const value = JSON.parse(readFileSync(pendingPath, 'utf8')) as { pending: Record<string, { processId: number; processInstanceId: string }> }
  for (const record of Object.values(value.pending)) Object.assign(record, { processId: 2_000_000_000, processInstanceId: 'terminated-fixture-process' })
  writeFileSync(pendingPath, JSON.stringify(value))
}

describe('the action log writer worker', () => {
  it('writes a batch with one append and one sync, and tracks the attempts among it', async () => {
    const { writer, syncs } = faultyWriter()
    const path = logPath()
    const log = createFileActionLog(path, { writer })
    await log.recordMany([
      entry({ requestId: 'r1', auditId: 'a1', event: 'attempt', outcome: 'started' }),
      entry({ requestId: 'r2' }),
      entry({ requestId: 'r3', auditId: 'a3', event: 'attempt', outcome: 'started' }),
    ])

    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r2', 'r3'])
    // The file once, and its directory where the platform syncs one.
    expect(syncs()).toBe(process.platform === 'win32' ? 1 : 2)
    expect(Object.keys((JSON.parse(readFileSync(`${path}.pending.json`, 'utf8')) as { pending: object }).pending).sort()).toEqual(['a1', 'a3'])
  })

  it('writes nothing for an empty batch', async () => {
    const path = logPath()
    await createFileActionLog(path).recordMany([])
    expect(existsSync(path)).toBe(false)
  })

  it('holds a required write whose sync never returns, while the node answers reads and readiness meanwhile', async () => {
    const faults = faultyWriter()
    let now = 0
    const health = createAuditHealth({ now: () => now, probeIntervalMs: 1 })
    // A log that failed before the disk stalled: readiness probes it again, on the stalled worker.
    const blocker = logPath()
    writeFileSync(blocker, 'not a directory')
    const broken = join(blocker, 'actions.jsonl')
    await expect(createFileActionLog(broken, { health, writer: faults.writer }).record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)

    faults.stall()
    const path = logPath()
    const log = createFileActionLog(path, { health, writer: faults.writer })
    const attempt = log.record(entry({ auditId: 'held', event: 'attempt', outcome: 'started' }))

    expect(await settled(attempt, 200)).toBe('pending')
    expect(() => log.read(10)).not.toThrow()
    now = 10
    const asked = performance.now()
    await health.recheck()
    expect(performance.now() - asked).toBeLessThan(PROBE_DEADLINE_MS + 1_000)
    expect(health.failing(broken)).toBe(true)
    expect(await settled(attempt, 0)).toBe('pending')

    faults.release()
    await attempt
    expect(log.read(10).map(item => item.auditId)).toEqual(['held'])
  })

  it('probes every failing log at once, and sends a log no second probe while its first is still out', async () => {
    const faults = faultyWriter()
    let now = 0
    const health = createAuditHealth({ now: () => now, probeIntervalMs: 1 })
    const broken = [brokenLogPath(), brokenLogPath(), brokenLogPath()]
    for (const path of broken) await expect(createFileActionLog(path, { health, writer: faults.writer }).record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)
    faults.stall()
    const held = createFileActionLog(logPath(), { writer: faults.writer }).record(entry({ requestId: 'held' }))
    await vi.waitFor(() => expect(faults.syncs()).toBe(1))
    const posted = vi.spyOn(Worker.prototype, 'postMessage')

    for (const round of [1, 2, 3]) {
      now += 10
      const asked = performance.now()
      await health.recheck()
      expect({ round, withinMs: performance.now() - asked < PROBE_DEADLINE_MS + 500 }).toEqual({ round, withinMs: true })
    }
    const probes = posted.mock.calls.flatMap(([message]) => ((message as WriterRequest).op === 'probe' ? [(message as Extract<WriterRequest, { op: 'probe' }>).file.path] : []))
    expect(probes.sort()).toEqual([...broken].sort())
    expect(broken.every(path => health.failing(path))).toBe(true)

    faults.release()
    await held
  })

  it('opens a log with no attempt another process left without starting a worker', async () => {
    const path = logPath()
    const first = faultyWriter()
    await createFileActionLog(path, { writer: first.writer }).record(entry({ auditId: 'mine', event: 'attempt', outcome: 'started' }))
    const second = faultyWriter()

    expect(await createFileActionLog(path, { writer: second.writer }).recoverInterrupted()).toBe(0)
    expect(await createFileActionLog(logPath(), { writer: second.writer }).recoverInterrupted()).toBe(0)
    expect(second.starts()).toBe(0)
  })

  it('refuses a write as busy, before it reaches the worker, while the most writes it keeps wait on a stalled disk', async () => {
    const faults = faultyWriter()
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const log = createFileActionLog(logPath(), { writer: faults.writer })
    faults.stall()
    const waiting = Array.from({ length: MAX_WAITING_WRITES }, (_, index) => log.record(entry({ requestId: `w${index}` })).catch(() => undefined))
    const refused = log.record(entry({ requestId: 'one too many' })).then(() => 'written', (failure: unknown) => failure)

    expect(await Promise.race([refused, delay(500).then(() => 'still waiting')])).toBeInstanceOf(StateBusyError)
    await faults.writer.close({ deadlineMs: 0 })
    await Promise.all(waiting)
  })

  it('stops at its deadline, and counts what it left, while the worker is held in a disk call', async () => {
    // A named pipe stands in for the disk; Windows has none to open this way.
    if (process.platform === 'win32') return
    const fifo = join(mkdtempSync(join(tmpdir(), 'buckle-writer-fifo-')), 'disk')
    execFileSync('mkfifo', [fifo])
    const faults = faultyWriter({ fifo })
    const error = vi.spyOn(logger, 'error')
    const log = createFileActionLog(logPath(), { writer: faults.writer })
    faults.blockAtSync(1)
    const attempt = log.record(entry({ requestId: 'held' })).then(() => null, (failure: unknown) => failure)
    try {
      await vi.waitFor(() => expect(faults.syncs()).toBe(1))
      const closing = faults.writer.close({ deadlineMs: 50 })
      expect(await settled(closing, 1_500)).toBe('resolved')
      expect(await closing).toEqual({ left: 1 })
      expect(error).toHaveBeenCalledWith('Action log writes left unwritten at close', { left: 1 })
      expect(error).toHaveBeenCalledWith(expect.stringContaining('held in a disk call'))
    } finally {
      faults.unblock()
    }
    expect(await attempt).toBeInstanceOf(AuditUnavailableError)
  })

  it('waits at close for the writes in flight, up to its deadline', async () => {
    const faults = faultyWriter()
    const log = createFileActionLog(logPath(), { writer: faults.writer })
    faults.stall()
    const attempt = log.record(entry({ auditId: 'closing', event: 'attempt', outcome: 'started' }))
    const closing = faults.writer.close({ deadlineMs: 10_000 })
    await delay(50)
    faults.release()

    expect(await closing).toEqual({ left: 0 })
    await expect(attempt).resolves.toBeUndefined()
  })

  it('answers a write still held at the close deadline as failed, counts it, and starts a new worker for the next write', async () => {
    const faults = faultyWriter()
    const error = vi.spyOn(logger, 'error')
    const path = logPath()
    const log = createFileActionLog(path, { writer: faults.writer })
    faults.stall()
    const attempt = log.record(entry({ requestId: 'held' })).then(() => null, (failure: unknown) => failure)
    await delay(50)

    expect(await faults.writer.close({ deadlineMs: 50 })).toEqual({ left: 1 })
    expect(await attempt).toBeInstanceOf(AuditUnavailableError)
    expect(error).toHaveBeenCalledWith('Action log writes left unwritten at close', { left: 1 })

    faults.release()
    await log.record(entry({ requestId: 'after' }))
    expect(log.read(10).map(item => item.requestId)).toContain('after')
  })

  it('answers the writes of a worker that stopped as failed, and the next write starts another', async () => {
    const faults = faultyWriter()
    const health = createAuditHealth()
    const path = logPath()
    const log = createFileActionLog(path, { health, writer: faults.writer })
    faults.endAtSync(1)
    await expect(log.record(entry({ requestId: 'lost' }))).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(health.failing(path)).toBe(true)

    await log.record(entry({ requestId: 'again' }))
    expect(health.available).toBe(true)
  })

  it('answers busy, and leaves the log healthy, while another process holds the pending store', async () => {
    const path = logPath()
    const holder = await holdLockInProcess(`${path}.pending.json.lock.sqlite`)
    try {
      const health = createAuditHealth()
      const log = createFileActionLog(path, { health, lockDeadlineMs: 100 })
      await expect(log.record(entry({ auditId: 'busy', event: 'attempt', outcome: 'started' }))).rejects.toBeInstanceOf(StateBusyError)
      expect(health.available).toBe(true)
    } finally {
      await killHolder(holder)
    }
  })

  it('logs the worker\'s own lines through the node\'s logger', async () => {
    const error = vi.spyOn(logger, 'error')
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ auditId: 'a1', event: 'attempt', outcome: 'started' }))
    writeFileSync(`${path}.pending.json`, '{ corrupt')
    await expect(log.record(entry({ auditId: 'a2', event: 'attempt', outcome: 'started' }))).rejects.toBeInstanceOf(AuditUnavailableError)

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('State file cannot be read safely', expect.objectContaining({ reason: 'SyntaxError' })))
  })

  it('names an interrupted result it recovers by the workspace\'s name as it stands then', async () => {
    const path = logPath()
    let name = 'Site one'
    const log = createFileActionLog(path, { workspaceId: 'w1', workspaceName: () => name })
    await log.record(entry({ auditId: 'gone', event: 'attempt', outcome: 'started', workspaceId: 'w1' }))
    orphan(path)
    name = 'Site renamed'

    expect(await log.recoverInterrupted()).toBe(1)
    expect(log.read(1)[0]).toMatchObject({ auditId: 'gone', event: 'result', outcome: 'interrupted', workspaceName: 'Site renamed' })
  })

  it('keeps a one-shot process alive for a write it was handed, and no longer', async () => {
    const path = logPath()
    const module = new URL('../common/adapters/action-log/file-action-log.ts', import.meta.url).href
    const script = `import { createFileActionLog } from ${JSON.stringify(module)}; void createFileActionLog(${JSON.stringify(path)}).record(${JSON.stringify(entry({ requestId: 'unawaited' }))})`
    await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { timeout: 15_000 })
    expect(readFileSync(path, 'utf8')).toContain('unawaited')
  })
})
