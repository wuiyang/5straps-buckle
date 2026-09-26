import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { RuntimeError, RuntimeErrorCode } from '../errors.js'
import { runInTransactionMarker } from '../transaction/guard.js'
import { rawConnection, type SqliteDatabase } from './database.js'

export const SqliteErrorCode = Object.freeze({
  ownerClosed: 'ConnectionOwnerClosedError',
  nestedTransaction: 'NestedTransactionError',
} as const)

export interface ConnectionOwner {
  readonly db: SqliteDatabase
  run<T>(operation: (db: SqliteDatabase) => Promise<T>): Promise<T>
  transaction<T>(body: (tx: SqliteDatabase) => Promise<T>): Promise<T>
  nativeTransaction<T>(body: (connection: DatabaseSync) => T): Promise<T>
  close(): Promise<void>
}

// Which transaction the current async flow is inside, so its own statements skip the queue.
const currentTransaction = new AsyncLocalStorage<string>()

// SQLite transactions belong to the connection, not to an async flow: every access queues behind an open transaction.
export function createConnectionOwner(db: SqliteDatabase, options: { owned: boolean; label?: string }): ConnectionOwner {
  const label = options.label ?? 'sqlite'
  let tail: Promise<unknown> = Promise.resolve()
  let activeTransaction: string | undefined
  let closing: Promise<void> | undefined

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new RuntimeError(SqliteErrorCode.ownerClosed, `Connection ${label} is closed`))
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }

  function insideOwnTransaction(): boolean {
    return activeTransaction !== undefined && currentTransaction.getStore() === activeTransaction
  }

  function run<T>(operation: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    if (insideOwnTransaction()) return operation(db)
    return exclusive(() => operation(db))
  }

  function transaction<T>(body: (tx: SqliteDatabase) => Promise<T>): Promise<T> {
    if (insideOwnTransaction()) return Promise.reject(new RuntimeError(SqliteErrorCode.nestedTransaction, `Transaction already open on ${label}; nested transactions are not supported`))
    return exclusive(async () => {
      const id = randomUUID()
      await db.exec('BEGIN IMMEDIATE')
      activeTransaction = id
      try {
        const result = await currentTransaction.run(id, () => runInTransactionMarker(`${label}:${id}`, () => body(db)))
        await db.exec('COMMIT')
        return result
      } catch (error) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        activeTransaction = undefined
      }
    })
  }

  function nativeTransaction<T>(body: (connection: DatabaseSync) => T): Promise<T> {
    if (body.constructor.name === 'AsyncFunction') return Promise.reject(asyncBodyError(label))
    const operation = async () => runNativeTransaction(await rawConnection(db), body, label)
    if (insideOwnTransaction()) return Promise.reject(new RuntimeError(SqliteErrorCode.nestedTransaction, `Transaction already open on ${label}`))
    return exclusive(operation)
  }

  return {
    db,
    run,
    transaction,
    nativeTransaction,
    close() {
      closing ??= tail.then(() => (options.owned ? db.dispose() : undefined))
      return closing
    },
  }
}

// Wholly synchronous: nothing else on this event loop can run between BEGIN and COMMIT.
function runNativeTransaction<T>(connection: DatabaseSync, body: (connection: DatabaseSync) => T, label: string): T {
  connection.exec('BEGIN IMMEDIATE')
  let result: T
  try {
    result = body(connection)
  } catch (error) {
    connection.exec('ROLLBACK')
    throw error
  }
  if (result instanceof Promise) {
    connection.exec('ROLLBACK')
    result.catch(() => undefined)
    throw asyncBodyError(label)
  }
  connection.exec('COMMIT')
  return result
}

function asyncBodyError(label: string): RuntimeError {
  return new RuntimeError(RuntimeErrorCode.asyncTransactionBody, `Native transaction on ${label} needs a synchronous body; use transaction() for awaited work`)
}
