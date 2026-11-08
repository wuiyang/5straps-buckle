import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createLogQueue } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditUnavailableError, createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { StateBusyError } from '../common/adapters/json-file-store.js'
import { createAuditHealth } from '../common/services/audit/audit-health.js'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { closeFaultyWriters, faultyWriter, type FaultyWriter } from './support/writer-faults.js'

afterEach(async () => {
  await closeFaultyWriters()
})

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-one-writer-')), 'actions.jsonl')
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return { event: 'result', at: '2026-11-08T00:00:00.000Z', requestId: 'r1', sessionId: 's1', tool: 'fs_read', outcome: 'ok', durationMs: 1, effects: [], args: {}, ...overrides }
}

/** An entry as the log service queues it: with the id it keeps across every attempt at writing it. */
function queued(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return entry({ entryId: randomUUID(), ...overrides })
}

function attempt(auditId: string): ActionLogEntry {
  return queued({ requestId: auditId, auditId, event: 'attempt', outcome: 'started' })
}

/** The file's whole lines, parsed; a torn line is left out. */
function written(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
}

function pendingIds(path: string): string[] {
  return Object.keys((JSON.parse(readFileSync(`${path}.pending.json`, 'utf8')) as { pending: object }).pending).sort()
}

describe('one writer per action log file', () => {
  it('answers busy, writes nothing, and leaves the log healthy while another process holds the file\'s lock', async () => {
    const path = logPath()
    const holder = await holdLockInProcess(`${path}.lock.sqlite`)
    try {
      const health = createAuditHealth()
      const log = createFileActionLog(path, { health, lockDeadlineMs: 100 })
      await expect(log.record(attempt('busy'))).rejects.toBeInstanceOf(StateBusyError)
      expect(health.available).toBe(true)
      expect(existsSync(path) ? readFileSync(path, 'utf8') : '').toBe('')
    } finally {
      await killHolder(holder)
    }
  })

  it('keeps a line whole that another writer\'s torn write would have run into', async () => {
    const path = logPath()
    const first = faultyWriter()
    const second = faultyWriter()
    // Both workers started, so the second reaches its write at once unless the lock holds it.
    await Promise.all([first, second].map(started => createFileActionLog(logPath(), { writer: started.writer }).record(entry())))
    first.holdWrites()
    const begun = first.writes()
    const whole = createFileActionLog(path, { writer: first.writer }).record(entry({ requestId: 'whole' }))
    await vi.waitFor(() => expect(first.writes()).toBe(begun + 1))
    second.shortAtWrite(1)
    const torn = createFileActionLog(path, { writer: second.writer }).record(entry({ requestId: 'torn' })).then(() => null, (failure: unknown) => failure)
    await delay(150)
    first.releaseWrites()

    await whole
    expect(await torn).toBeInstanceOf(AuditUnavailableError)
    await createFileActionLog(path).record(entry({ requestId: 'after' }))
    expect(createFileActionLog(path).read(10).map(item => item.requestId)).toEqual(['whole', 'after'])
  })

  it('writes whole lines when two processes write required attempts and queued batches at once', async () => {
    const path = logPath()
    const module = new URL('../common/adapters/action-log/file-action-log.ts', import.meta.url).href
    const script = (name: string) => [
      `import { randomUUID } from 'node:crypto'`,
      `import { createFileActionLog } from ${JSON.stringify(module)}`,
      `const log = createFileActionLog(${JSON.stringify(path)})`,
      `const base = ${JSON.stringify(entry())}`,
      `const writes = []`,
      `for (let i = 0; i < 8; i += 1) {`,
      `  writes.push(log.record({ ...base, auditId: '${name}-a' + i, requestId: '${name}-a' + i, event: 'attempt', outcome: 'started' }))`,
      `  writes.push(log.recordMany([0, 1, 2].map(k => ({ ...base, entryId: randomUUID(), requestId: '${name}-b' + i + '-' + k }))))`,
      `}`,
      `await Promise.all(writes)`,
    ].join('\n')
    const run = (name: string) => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script(name)], { timeout: 60_000 })
    await Promise.all([run('one'), run('two')])

    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter(Boolean)
    // A torn line, or two run together, would not parse.
    const requestIds = lines.map(line => (JSON.parse(line) as ActionLogEntry).requestId)
    const expected = ['one', 'two'].flatMap(name => Array.from({ length: 8 }, (_, i) => [`${name}-a${i}`, ...[0, 1, 2].map(k => `${name}-b${i}-${k}`)]).flat())
    expect(requestIds.sort()).toEqual(expected.sort())
    expect(pendingIds(path)).toHaveLength(16)
  }, 90_000)

  it('ends a line a dead writer tore, keeps it, and skips it', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ requestId: 'r1' }))
    const half = '{"requestId":"r2","tru'
    writeFileSync(path, `${readFileSync(path, 'utf8')}${half}`)
    await log.record(entry({ requestId: 'r3' }))

    expect(readFileSync(path, 'utf8')).toContain(`\n${half}\n`)
    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r3'])
  })

  it('gives every line its own entryId, a recovered interrupted result included', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ requestId: 'plain' }))
    await log.record(entry({ requestId: 'gone', auditId: 'gone', event: 'attempt', outcome: 'started' }))
    const pendingPath = `${path}.pending.json`
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as { pending: Record<string, object> }
    for (const record of Object.values(pending.pending)) Object.assign(record, { processId: 2_000_000_000, processInstanceId: 'terminated-fixture-process' })
    writeFileSync(pendingPath, JSON.stringify(pending))
    expect(await log.recoverInterrupted()).toBe(1)

    const ids = written(path).map(line => line.entryId)
    expect(ids).toHaveLength(3)
    for (const id of ids) expect(id).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(3)
  })
})

describe('a write tried again', () => {
  const faults: Array<[string, (writer: FaultyWriter) => void]> = [
    ['the sync after the append fails', writer => writer.failAtSync(1)],
    ['the worker ends at the sync after the append', writer => writer.endAtSync(1)],
    ['the directory\'s sync, after the file\'s, fails', writer => writer.failAtSync(2)],
  ]

  it.each(faults)('leaves out what the failed attempt wrote when %s, and tracks its attempts', async (_, strike) => {
    // Windows syncs no directory, so its second sync is another batch's.
    if (process.platform === 'win32') return
    const path = logPath()
    const writer = faultyWriter()
    const log = createFileActionLog(path, { writer: writer.writer })
    const batch = [attempt('a1'), queued({ requestId: 'r2' })]
    strike(writer)
    await expect(log.recordMany(batch)).rejects.toBeInstanceOf(AuditUnavailableError)

    await log.recordMany(batch)
    expect(written(path).map(line => line.requestId)).toEqual(['a1', 'r2'])
    expect(pendingIds(path)).toEqual(['a1'])
  })

  it('leaves out what was written when the pending store\'s update failed, and its result still closes the attempt', async () => {
    const path = logPath()
    const log = createFileActionLog(path, { lockDeadlineMs: 100 })
    const batch = [attempt('a1'), queued({ requestId: 'r2' })]
    const holder = await holdLockInProcess(`${path}.pending.json.lock.sqlite`)
    try {
      await expect(log.recordMany(batch)).rejects.toBeInstanceOf(StateBusyError)
    } finally {
      await killHolder(holder)
    }

    await log.recordMany(batch)
    expect(written(path).map(line => line.requestId)).toEqual(['a1', 'r2'])
    expect(pendingIds(path)).toEqual(['a1'])
    await log.record(queued({ requestId: 'a1', auditId: 'a1', event: 'result', outcome: 'ok' }))
    expect(pendingIds(path)).toEqual([])
  })

  it('writes again only the entries a torn write left unfinished, and keeps the torn piece', async () => {
    const path = logPath()
    const writer = faultyWriter()
    const log = createFileActionLog(path, { writer: writer.writer })
    // The cut falls halfway through the bytes, so inside the long second line.
    const batch = [queued({ requestId: 'short' }), queued({ requestId: 'long', detail: 'x'.repeat(2_000) })]
    writer.shortAtWrite(1)
    await expect(log.recordMany(batch)).rejects.toBeInstanceOf(AuditUnavailableError)

    await log.recordMany(batch)
    expect(written(path).map(line => line.requestId)).toEqual(['short', 'long'])
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('reads back from each file\'s own failed attempt when one batch failed on two files', async () => {
    // Windows syncs no directory, so its second sync is another batch's.
    if (process.platform === 'win32') return
    const writer = faultyWriter()
    const files = [logPath(), logPath()].map(path => ({ path, log: createFileActionLog(path, { writer: writer.writer }) }))
    const batch = [queued({ requestId: 'r1' }), queued({ requestId: 'r2' })]
    for (const file of files) {
      writer.failAtSync(1)
      await expect(file.log.recordMany(batch)).rejects.toBeInstanceOf(AuditUnavailableError)
    }

    for (const file of files) await file.log.recordMany(batch)
    for (const file of files) expect(written(file.path).map(line => line.requestId)).toEqual(['r1', 'r2'])
  })

  it('takes the retry of the log queue, as the log service will, without writing an entry twice', async () => {
    const path = logPath()
    const writer = faultyWriter()
    const log = createFileActionLog(path, { writer: writer.writer })
    const queue = createLogQueue<ActionLogEntry>({ destination: path, write: batch => log.recordMany(batch), retryDelaysMs: [10, 10, 10] })
    writer.failAtSync(1)
    queue.push(queued({ requestId: 'r1' }))
    queue.push(queued({ requestId: 'r2' }))
    await queue.flush()

    expect(written(path).map(line => line.requestId)).toEqual(['r1', 'r2'])
    expect(queue.stats()).toMatchObject({ written: 2, dropped: 0, failures: 1 })
  })
})
