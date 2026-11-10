import { RuntimeError, RuntimeErrorCode } from '../errors.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import type { Logger } from '../logger/types.js'
import { runInTransactionMarker } from '../transaction/guard.js'
import type { DatabaseSync } from 'node:sqlite'
import { beginImmediateWithinDeadline } from './begin.js'
import { isSqliteBusy } from './busy.js'
import { openSqlite, rawConnection, type SqliteDatabase } from './database.js'

export const DEFAULT_LOCK_DEADLINE_MS = 300_000
export const DEFAULT_LOCK_POLL_MS = 25
// No journal_mode: a lock connection keeps whatever mode the file already has.
const LOCK_PRAGMAS = Object.freeze({ busy_timeout: 0, foreign_keys: true })

export type LockWait = 'none' | { deadlineMs: number; pollMs?: number }

export interface FileLockOptions {
  path: string
  wait: LockWait
  signal?: AbortSignal
  logger?: Logger
  // Fail with ENOENT where the lock's folder is gone instead of making it.
  existingDirectory?: boolean
}

export interface FileLock {
  readonly path: string
  readonly held: boolean
  release(): Promise<void>
}

// One independently owned DB0 connection per acquisition; the SQLite RESERVED lock is the file lock.
// The OS drops it when the process dies, so a killed holder never leaves a stale lock.
// A bare handle sets no transaction marker: never wait for a human while holding it; prefer withFileLock.
export async function acquireFileLock(options: FileLockOptions): Promise<FileLock> {
  if (options.signal?.aborted) throw lockAborted(options.path, options.signal.reason)
  const db = await openSqlite({ path: options.path, logger: options.logger, existingDirectory: options.existingDirectory }, { defaults: LOCK_PRAGMAS })
  const connection = await rawConnection(db)
  try {
    await beginLock(connection, options)
  } catch (error) {
    await db.dispose()
    throw error
  }
  return heldLock({ db, connection, path: options.path })
}

// The operation runs under the transaction marker (a lock is an open BEGIN IMMEDIATE), so requestCli refuses to wait inside it.
export async function withFileLock<T>(options: FileLockOptions, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(options)
  try {
    return await runInTransactionMarker(`lock:${options.path}`, operation)
  } finally {
    await lock.release()
  }
}

// Held for the owner's lifetime and released in its `locks` close stage.
export async function acquireOwnershipLock(options: { path: string; owner: RuntimeOwner; logger?: Logger }): Promise<FileLock> {
  const lock = await acquireFileLock({ path: options.path, wait: 'none', logger: options.logger })
  try {
    options.owner.onClose('locks', `ownership lock ${options.path}`, () => lock.release())
  } catch (error) {
    await lock.release()
    throw error
  }
  return lock
}

async function beginLock(connection: DatabaseSync, options: FileLockOptions): Promise<void> {
  const wait = options.wait === 'none' ? { deadlineMs: 0, pollMs: 0 } : { deadlineMs: options.wait.deadlineMs, pollMs: options.wait.pollMs ?? DEFAULT_LOCK_POLL_MS }
  try {
    await beginImmediateWithinDeadline(connection, { ...wait, signal: options.signal, onAbort: reason => lockAborted(options.path, reason), onBegin: () => undefined })
  } catch (error) {
    if (isSqliteBusy(error)) throw new RuntimeError(RuntimeErrorCode.lockBusy, `Lock ${options.path} is held by another owner`, { cause: error })
    throw error
  }
}

function lockAborted(path: string, reason: unknown): RuntimeError {
  return new RuntimeError(RuntimeErrorCode.lockAborted, `Waiting for lock ${path} was cancelled`, { cause: reason })
}

function heldLock({ db, connection, path }: { db: SqliteDatabase; connection: DatabaseSync; path: string }): FileLock {
  let releasing: Promise<void> | undefined
  return {
    path,
    get held() { return releasing === undefined },
    release() {
      // ROLLBACK, not COMMIT: the lock writes nothing, but the first BEGIN on a new file dirties page 1,
      // and committing that needs an exclusive lock that a contender's momentary shared lock refuses.
      releasing ??= (async () => {
        try { connection.exec('ROLLBACK') } finally { await db.dispose() }
      })()
      return releasing
    },
  }
}
