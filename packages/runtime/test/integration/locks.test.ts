import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createCliConsumerSlot, createCliRequester, createRuntimeOwner, isRuntimeError, RuntimeErrorCode } from '../../src/index.js'
import { acquireFileLock, acquireOwnershipLock, DEFAULT_LOCK_DEADLINE_MS, DEFAULT_LOCK_POLL_MS, openDatabase, rawConnection, withFileLock } from '../../src/sqlite/index.js'
import { startWorker } from './support/workers.js'

function lockPath(name = 'execution.lock.sqlite'): string {
  return join(mkdtempSync(join(tmpdir(), 'lock-')), 'locks', name)
}

async function expectLockBusy(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(isRuntimeError(error, RuntimeErrorCode.lockBusy), `expected LockBusyError, got ${String(error)}`).toBe(true)
}

describe('cross-process SQLite coordination', () => {
  it('F33 allocates 1000 unique sequence numbers from 4 processes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seq-')), 'sequence.sqlite')
    const db = await openDatabase({ path, pragmas: { journal_mode: 'WAL' } })
    await db.exec('CREATE TABLE sequence (value INTEGER NOT NULL UNIQUE, worker TEXT NOT NULL)')
    const workers = Array.from({ length: 4 }, (_, index) => startWorker(['sequence', path, '250', `w${index}`]))
    await Promise.all(workers.map(worker => worker.exited))
    const { rows } = await db.sql`SELECT COUNT(*) AS total, COUNT(DISTINCT value) AS distinct_values, MIN(value) AS low, MAX(value) AS high, COUNT(DISTINCT worker) AS writers FROM sequence`
    expect(rows?.[0]).toEqual({ total: 1000, distinct_values: 1000, low: 1, high: 1000, writers: 4 })
    await db.dispose()
  }, 60_000)

  // Bounds are loose on purpose (review L14): release:check load and ARM64 CI stretch wall time, not behaviour.
  it('F34 fails a try-lock held by another process with LockBusyError without waiting', async () => {
    const path = lockPath()
    const holder = startWorker(['hold-lock', path, '5000'])
    await holder.next(message => message.locked === true)
    const started = performance.now()
    await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
    // No polling: far below the 300 s default deadline and any poll interval (under 50 ms on a quiet machine).
    expect(performance.now() - started).toBeLessThan(1_000)
    holder.child.kill('SIGKILL')
    await holder.exited
  }, 20_000)

  it('F35 waits for a deadline lock, and gives up at the deadline, with journal.ts parity defaults', async () => {
    expect([DEFAULT_LOCK_DEADLINE_MS, DEFAULT_LOCK_POLL_MS]).toEqual([300_000, 25])
    const path = lockPath()
    // sqlite-fixes-11: the holder releases when told to, not on a timer, so load cannot reorder the steps.
    const holder = startWorker(['hold-lock', path, 'stdin'])
    await holder.next(message => message.locked === true)
    await expectLockBusy(acquireFileLock({ path, wait: { deadlineMs: 50 } }))
    const waiting = acquireFileLock({ path, wait: { deadlineMs: 5_000, pollMs: DEFAULT_LOCK_POLL_MS } })
    holder.child.stdin!.end('release\n')
    const lock = await waiting
    expect(lock.held).toBe(true)
    await lock.release()
    await holder.exited
  }, 20_000)

  it('F36 holds a lock across awaits and releases it when the operation throws', async () => {
    const path = lockPath()
    const failure = await withFileLock({ path, wait: 'none' }, async () => {
      await delay(20)
      await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
      throw new Error('operation failed')
    }).catch((error: unknown) => error)
    expect(failure).toEqual(new Error('operation failed'))
    const again = await acquireFileLock({ path, wait: 'none' })
    await again.release()
    await again.release()
    expect(again.held).toBe(false)
  })

  it('F37 releases the lock within 1 s when the holder is killed with SIGKILL', async () => {
    const path = lockPath()
    const holder = startWorker(['hold-lock', path, '60000'])
    await holder.next(message => message.locked === true)
    await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
    holder.child.kill('SIGKILL')
    await holder.exited
    // Timed from the holder's exit, not from kill(): the OS frees the lock with the process.
    const exitedAt = performance.now()
    const lock = await acquireFileLock({ path, wait: { deadlineMs: 5_000 } })
    expect(performance.now() - exitedAt).toBeLessThan(1_000)
    await lock.release()
  }, 20_000)

  it('takes a lock in a folder that exists with existingDirectory, and fails with ENOENT where the folder is gone without making it', async () => {
    const path = lockPath()
    const folder = dirname(path)
    await expect(acquireFileLock({ path, wait: 'none', existingDirectory: true })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(folder)).toBe(false)
    mkdirSync(folder)
    await withFileLock({ path, wait: 'none', existingDirectory: true }, async () => undefined)
    rmSync(folder, { recursive: true })
    await expect(withFileLock({ path, wait: 'none', existingDirectory: true }, async () => undefined)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(folder)).toBe(false)
  })

  it('F38 gives every acquisition its own connection, so locks on different paths are independent', async () => {
    const first = lockPath('a.lock.sqlite')
    const second = lockPath('b.lock.sqlite')
    const a = await acquireFileLock({ path: first, wait: 'none' })
    const b = await acquireFileLock({ path: second, wait: 'none' })
    await expectLockBusy(acquireFileLock({ path: first, wait: 'none' }))
    await a.release()
    await expectLockBusy(acquireFileLock({ path: second, wait: 'none' }))
    const reacquired = await acquireFileLock({ path: first, wait: 'none' })
    await Promise.all([b.release(), reacquired.release()])
  })

  it('holds an ownership lock for the runtime lifetime and releases it in the locks close stage', async () => {
    const path = lockPath('workbench.owner.sqlite')
    const owner = createRuntimeOwner({ services: [] })
    await owner.start(async (runtime) => { await acquireOwnershipLock({ path, owner: runtime }) })
    await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
    await owner.close()
    const next = await acquireFileLock({ path, wait: 'none' })
    await next.release()
  })
})

async function childSeesBusy(path: string): Promise<boolean> {
  const probe = startWorker(['try-lock', path])
  const message = await probe.next(item => 'busy' in item)
  await probe.exited
  return message.busy === true
}

describe('releasing a lock another connection is reading (Buckle B9)', () => {
  it('releases a first-use lock file while another connection holds a shared lock, instead of failing with SQLITE_BUSY', async () => {
    const path = lockPath('fresh.lock.sqlite')
    const lock = await acquireFileLock({ path, wait: 'none' })
    // A contender polling BEGIN IMMEDIATE holds SHARED between its attempts; a reader stands in for it here.
    const reader = new DatabaseSync(path, { timeout: 0 })
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sqlite_master').get()
    try {
      await lock.release()
      expect(lock.held).toBe(false)
    } finally {
      reader.exec('COMMIT')
      reader.close()
    }
    const again = await acquireFileLock({ path, wait: 'none' })
    await again.release()
  })
})

describe('same-process opens keep SQLite locks (review H1, L5 to L7)', () => {
  it('H1 a second acquire in the holder process leaves the OS lock in place and release() still works', async () => {
    const path = lockPath()
    const lock = await acquireFileLock({ path, wait: 'none' })
    await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
    expect(await childSeesBusy(path)).toBe(true)
    await lock.release()
    expect(lock.held).toBe(false)
    expect(await childSeesBusy(path)).toBe(false)
  }, 20_000)

  it('H1 a second openDatabase of a database with an open write transaction keeps the writer lock', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'writer-')), 'main.sqlite')
    const writer = await openDatabase({ path, pragmas: { journal_mode: 'DELETE' } })
    await writer.exec('CREATE TABLE t (id INTEGER)')
    const connection = await rawConnection(writer)
    connection.exec('BEGIN IMMEDIATE')
    const second = await openDatabase({ path, pragmas: { journal_mode: 'DELETE', busy_timeout: 0 } })
    expect(await childSeesBusy(path)).toBe(true)
    connection.exec('COMMIT')
    await Promise.all([writer.dispose(), second.dispose()])
  }, 20_000)

  it('L5 releases the lock when the owner refuses the close step', async () => {
    const path = lockPath('owner.sqlite')
    const owner = createRuntimeOwner({ services: [] })
    await owner.start(() => {})
    await owner.close()
    const refused = await acquireOwnershipLock({ path, owner }).catch((error: unknown) => error)
    expect(isRuntimeError(refused, RuntimeErrorCode.disposedRuntime)).toBe(true)
    const next = await acquireFileLock({ path, wait: 'none' })
    await next.release()
  })

  it('L6 checks the signal before the first attempt and fails a cancelled wait with a typed error', async () => {
    const path = lockPath()
    const early = await acquireFileLock({ path, wait: { deadlineMs: 1_000 }, signal: AbortSignal.abort('stop') }).catch((error: unknown) => error)
    expect(isRuntimeError(early, RuntimeErrorCode.lockAborted)).toBe(true)
    const holder = await acquireFileLock({ path, wait: 'none' })
    const controller = new AbortController()
    const waiting = acquireFileLock({ path, wait: { deadlineMs: 5_000 }, signal: controller.signal }).catch((error: unknown) => error)
    await delay(30)
    controller.abort('caller left')
    expect(isRuntimeError(await waiting, RuntimeErrorCode.lockAborted)).toBe(true)
    await holder.release()
  })

  it('L7 refuses a human wait while a file lock is held', async () => {
    const slot = createCliConsumerSlot()
    slot.attach({ prompt: async () => ({ status: 'answered', answer: { choice: 'yes' } }) })
    const { requestCli } = createCliRequester({ slot })
    const refused = await withFileLock({ path: lockPath(), wait: 'none' }, () => requestCli({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'x' }, wait: { mode: 'indefinite' } })).catch((error: unknown) => error)
    expect(isRuntimeError(refused, RuntimeErrorCode.waitInsideTransaction)).toBe(true)
  })
})
