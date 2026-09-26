import { setTimeout as delay } from 'node:timers/promises'
import { RuntimeError, RuntimeErrorCode } from '../errors.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import { isSqliteBusy } from './busy.js'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, rawConnection, type SqliteDatabase } from './database.js'

// Same defaults as Buckle's history execution lock (harness-rpc journal.ts).
export const DEFAULT_LOCK_DEADLINE_MS = 300_000
export const DEFAULT_LOCK_POLL_MS = 25

export type LockWait = 'none' | { deadlineMs: number; pollMs?: number }

export interface FileLockOptions {
  path: string
  wait: LockWait
  signal?: AbortSignal
}

export interface FileLock {
  readonly path: string
  readonly held: boolean
  release(): Promise<void>
}

// One independently owned DB0 connection per acquisition; the SQLite RESERVED lock is the file lock.
// The OS drops it when the process dies, so a killed holder never leaves a stale lock.
export async function acquireFileLock(options: FileLockOptions): Promise<FileLock> {
  const db = await openDatabase({ path: options.path, pragmas: { busy_timeout: 0 } })
  const connection = await rawConnection(db)
  try {
    await beginWithinDeadline(connection, options)
  } catch (error) {
    await db.dispose()
    throw error
  }
  return heldLock({ db, connection, path: options.path })
}

export async function withFileLock<T>(options: FileLockOptions, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

// Held for the owner's lifetime and released in its `locks` close stage.
export async function acquireOwnershipLock(options: { path: string; owner: RuntimeOwner }): Promise<FileLock> {
  const lock = await acquireFileLock({ path: options.path, wait: 'none' })
  options.owner.onClose('locks', `ownership lock ${options.path}`, () => lock.release())
  return lock
}

async function beginWithinDeadline(connection: DatabaseSync, options: FileLockOptions): Promise<void> {
  const deadline = options.wait === 'none' ? 0 : Date.now() + options.wait.deadlineMs
  const pollMs = options.wait === 'none' ? 0 : options.wait.pollMs ?? DEFAULT_LOCK_POLL_MS
  while (true) {
    try {
      connection.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      if (Date.now() >= deadline) throw new RuntimeError(RuntimeErrorCode.lockBusy, `Lock ${options.path} is held by another owner`, { cause: error })
    }
    await delay(pollMs, undefined, options.signal ? { signal: options.signal } : undefined)
  }
}

function heldLock({ db, connection, path }: { db: SqliteDatabase; connection: DatabaseSync; path: string }): FileLock {
  let releasing: Promise<void> | undefined
  return {
    path,
    get held() { return releasing === undefined },
    release() {
      releasing ??= (async () => {
        try { connection.exec('COMMIT') } finally { await db.dispose() }
      })()
      return releasing
    },
  }
}
