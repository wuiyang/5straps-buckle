import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Primitive, Statement } from 'db0'
import { RuntimeError, RuntimeErrorCode } from '../errors.js'
import { globalSlot } from '../internal/async-slots.js'
import { assertTimerMs } from '../internal/timeouts.js'
import { runInTransactionMarker } from '../transaction/guard.js'
import { beginImmediateWithinDeadline, readBusyTimeout } from './begin.js'
import { SqliteErrorCode } from './codes.js'
import { DEFAULT_BUSY_TIMEOUT_MS, rawConnection, type SqliteDatabase } from './database.js'

export interface ConnectionOwner {
  // Same connection; each statement queues like run(), behind any other flow's section.
  readonly guardedDb: SqliteDatabase
  run<T>(operation: (db: SqliteDatabase) => Promise<T>): Promise<T>
  transaction<T>(body: (tx: SqliteDatabase) => Promise<T>): Promise<T>
  nativeTransaction<T>(body: (connection: DatabaseSync) => T): Promise<T>
  close(): Promise<void>
}

export interface ConnectionOwnerOptions {
  owned: boolean
  label?: string
  // Bound on waiting for another flow's section (DEFAULT_SECTION_WAIT_TIMEOUT_MS when omitted).
  sectionWaitTimeoutMs?: number
}

// In line with the connection's default busy deadline for BEGIN.
export const DEFAULT_SECTION_WAIT_TIMEOUT_MS = DEFAULT_BUSY_TIMEOUT_MS
const TRANSACTION_BEGIN_POLL_MS = 10

// Guard state belongs to the connection: one owner per DB0 object (Nitro's useDatabase() returns a cached one),
// shared across loaded copies of this package.
const ownedConnections = globalSlot('sqlite-connection-owners', () => new WeakSet<SqliteDatabase>())

// SQLite transactions belong to the connection, not to an async flow: every access queues behind an open transaction.
export function createConnectionOwner(db: SqliteDatabase, options: ConnectionOwnerOptions): ConnectionOwner {
  const label = options.label ?? 'sqlite'
  const sectionWaitTimeoutMs = options.sectionWaitTimeoutMs ?? DEFAULT_SECTION_WAIT_TIMEOUT_MS
  assertTimerMs('sectionWaitTimeoutMs', sectionWaitTimeoutMs)
  if (ownedConnections.has(db)) throw new RuntimeError(SqliteErrorCode.connectionOwned, `Connection ${label} already has a connection owner; share that owner instead of creating another`)
  // Per owner, so entering another owner's section never hides this one's (a.transaction > b.run > a.run).
  const currentSection = new AsyncLocalStorage<string>()
  let tail: Promise<unknown> = Promise.resolve()
  let activeSection: string | undefined
  let transactionOpen = false
  let closing: Promise<void> | undefined

  // A bounded wait turns a cycle (two owners taken in opposite order, a singleton whose factory needs a
  // section its awaiter holds) into a typed failure instead of a hang.
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new RuntimeError(SqliteErrorCode.ownerClosed, `Connection ${label} is closed`))
    const id = randomUUID()
    const previous = tail
    const result = waitForTurn(previous).then(() => {
      activeSection = id
      return currentSection.run(id, operation)
    }).finally(() => { if (activeSection === id) activeSection = undefined })
    // A waiter that timed out never held the section, so the next one still waits for the previous holder.
    tail = previous.then(() => result).catch(() => undefined)
    return result
  }

  function waitForTurn(previous: Promise<unknown>): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(sectionWaitTimeoutError(label, sectionWaitTimeoutMs)), sectionWaitTimeoutMs)
    })
    return Promise.race([previous, timedOut]).finally(() => clearTimeout(timer))
  }

  function enter<T>(operation: () => Promise<T>): Promise<T> {
    return insideOwnSection() ? operation() : exclusive(operation)
  }

  function insideOwnSection(): boolean {
    return activeSection !== undefined && currentSection.getStore() === activeSection
  }

  function run<T>(operation: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    return enter(() => operation(db))
  }

  function transaction<T>(body: (tx: SqliteDatabase) => Promise<T>): Promise<T> {
    if (insideOwnSection()) return transactionOpen ? Promise.reject(nestedTransactionError(label)) : runTransaction(body)
    return exclusive(() => runTransaction(body))
  }

  async function runTransaction<T>(body: (tx: SqliteDatabase) => Promise<T>): Promise<T> {
    const connection = await rawConnection(db)
    await beginWithinBusyTimeout(connection, () => { transactionOpen = true })
    try {
      const result = await runInTransactionMarker(`${label}:${currentSection.getStore()}`, () => body(db))
      connection.exec('COMMIT')
      return result
    } catch (error) {
      rollbackKeepingError(connection)
      throw error
    } finally {
      transactionOpen = false
    }
  }

  function nativeTransaction<T>(body: (connection: DatabaseSync) => T): Promise<T> {
    if (body.constructor.name === 'AsyncFunction') return Promise.reject(asyncBodyError(label))
    if (insideOwnSection() && transactionOpen) return Promise.reject(nestedTransactionError(label))
    const operation = async () => {
      const connection = await rawConnection(db)
      return beginWithinBusyTimeout(connection, () => finishNativeTransaction(connection, body, label))
    }
    return enter(operation)
  }

  function close(): Promise<void> {
    closing ??= tail.then(() => (options.owned ? db.dispose() : undefined)).finally(() => {
      ownedConnections.delete(db)
      ownedConnections.delete(guardedDb)
    })
    return closing
  }

  const guardedDb = createGuardedView({ db, guard: enter, label })
  ownedConnections.add(db)
  ownedConnections.add(guardedDb)
  return { guardedDb, run, transaction, nativeTransaction, close }
}

// Waits for other writers asynchronously, up to the connection's busy_timeout.
function beginWithinBusyTimeout<T>(connection: DatabaseSync, onBegin: () => T): Promise<T> {
  return beginImmediateWithinDeadline(connection, { deadlineMs: readBusyTimeout(connection), pollMs: TRANSACTION_BEGIN_POLL_MS, onBegin })
}

// Runs synchronously right after BEGIN: nothing else on this event loop can run before COMMIT.
function finishNativeTransaction<T>(connection: DatabaseSync, body: (connection: DatabaseSync) => T, label: string): T {
  let result: T
  try {
    result = body(connection)
    if (result instanceof Promise) {
      result.catch(() => undefined)
      throw asyncBodyError(label)
    }
    // A failed COMMIT (deferred foreign key, SQLITE_BUSY, SQLITE_FULL) leaves the transaction open.
    connection.exec('COMMIT')
  } catch (error) {
    rollbackKeepingError(connection)
    throw error
  }
  return result
}

// SQLite may already have rolled back (constraint or I/O error, or the body did it); the body's error stays primary.
function rollbackKeepingError(connection: DatabaseSync): void {
  if (!connection.isTransaction) return
  try { connection.exec('ROLLBACK') } catch {}
}

type Guard = <T>(operation: () => Promise<T>) => Promise<T>

// A shared handle: disposing it is a no-op (only the owner's close, in the databases stage, closes the
// connection), and getInstance is refused because the raw node:sqlite handle would bypass the guard.
function createGuardedView({ db, guard, label }: { db: SqliteDatabase; guard: Guard; label: string }): SqliteDatabase {
  return {
    get connector() { return db.connector },
    get dialect() { return db.dialect },
    get capabilities() { return db.capabilities },
    get disposed() { return db.disposed },
    getInstance: () => Promise.reject(new RuntimeError(SqliteErrorCode.rawHandleRefused, `The guarded view of ${label} does not expose its raw connection; use the connection owner's run() or transaction()`)),
    exec: sql => guard(() => db.exec(sql)),
    prepare: sql => guardStatement(db.prepare(sql), guard),
    sql: <T>(strings: TemplateStringsArray, ...values: Primitive[]) => guard(() => db.sql<T>(strings, ...values)),
    dispose: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
}

// A bound PreparedStatement is a Statement whose methods ignore extra parameters.
function guardStatement(statement: Statement, guard: Guard): Statement {
  return {
    bind: (...params) => guardStatement(statement.bind(...params), guard),
    all: (...params) => guard(() => statement.all(...params)),
    run: (...params) => guard(() => statement.run(...params)),
    get: (...params) => guard(() => statement.get(...params)),
  }
}

function sectionWaitTimeoutError(label: string, timeoutMs: number): RuntimeError {
  return new RuntimeError(SqliteErrorCode.sectionWaitTimeout, `Waited ${timeoutMs} ms for connection ${label} while another flow held it; take owners in one fixed order and resolve singletons at startup`)
}

function nestedTransactionError(label: string): RuntimeError {
  return new RuntimeError(SqliteErrorCode.nestedTransaction, `Transaction already open on ${label}; nested transactions are not supported`)
}

function asyncBodyError(label: string): RuntimeError {
  return new RuntimeError(RuntimeErrorCode.asyncTransactionBody, `Native transaction on ${label} needs a synchronous body; use transaction() for awaited work`)
}
