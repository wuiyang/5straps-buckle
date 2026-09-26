import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createRuntimeOwner, isRuntimeError, RuntimeErrorCode } from '../../src/index.js'
import { acquireFileLock, acquireOwnershipLock, DEFAULT_LOCK_DEADLINE_MS, DEFAULT_LOCK_POLL_MS, openDatabase, withFileLock } from '../../src/sqlite/index.js'
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

  it('F34 fails a try-lock held by another process with LockBusyError in under 50 ms', async () => {
    const path = lockPath()
    const holder = startWorker(['hold-lock', path, '5000'])
    await holder.next(message => message.locked === true)
    const started = performance.now()
    await expectLockBusy(acquireFileLock({ path, wait: 'none' }))
    expect(performance.now() - started).toBeLessThan(50)
    holder.child.kill('SIGKILL')
    await holder.exited
  }, 20_000)

  it('F35 waits for a deadline lock, and gives up at the deadline, with journal.ts parity defaults', async () => {
    expect([DEFAULT_LOCK_DEADLINE_MS, DEFAULT_LOCK_POLL_MS]).toEqual([300_000, 25])
    const path = lockPath()
    const holder = startWorker(['hold-lock', path, '300'])
    await holder.next(message => message.locked === true)
    await expectLockBusy(acquireFileLock({ path, wait: { deadlineMs: 50 } }))
    const lock = await acquireFileLock({ path, wait: { deadlineMs: 5_000, pollMs: DEFAULT_LOCK_POLL_MS } })
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
    const killedAt = performance.now()
    await holder.exited
    const lock = await acquireFileLock({ path, wait: { deadlineMs: 1_000 } })
    expect(performance.now() - killedAt).toBeLessThan(1_000)
    await lock.release()
  }, 20_000)

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
