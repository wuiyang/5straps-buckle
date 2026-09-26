import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createCliConsumerSlot, createCliRequester, isRuntimeError, RuntimeErrorCode } from '../../src/index.js'
import { createConnectionOwner, openDatabase, rawConnection, readPragma, SqliteErrorCode, type SqliteDatabase } from '../../src/sqlite/index.js'

function databasePath(name = 'app.sqlite'): string {
  return join(mkdtempSync(join(tmpdir(), 'sqlite-')), 'state', name)
}

async function notesDatabase(): Promise<SqliteDatabase> {
  const db = await openDatabase({ path: databasePath() })
  await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)')
  return db
}

async function noteTexts(db: SqliteDatabase): Promise<string[]> {
  const { rows } = await db.sql`SELECT text FROM notes ORDER BY id`
  return (rows ?? []).map(row => String(row.text))
}

describe('DB0 node-sqlite factory', () => {
  it('F27 needs an explicit absolute path and creates a 0700 directory and a 0600 file with no cwd fallback', async () => {
    await expect(openDatabase({ path: 'relative.sqlite' })).rejects.toThrow('SQLite path must be absolute')
    await expect(openDatabase({ path: '' })).rejects.toThrow('SQLite path must be absolute')
    const path = databasePath()
    const db = await openDatabase({ path })
    await db.exec('CREATE TABLE t (id INTEGER)')
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(join(process.cwd(), '.data'))).toBe(false)
    expect(db.connector).toBe('node-sqlite')
    await db.dispose()
  })

  it('F28 applies default and requested pragmas and rejects unsafe pragma input', async () => {
    const db = await openDatabase({ path: databasePath(), pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL', busy_timeout: 1234 } })
    expect(await readPragma(db, 'busy_timeout')).toBe(1234)
    expect(await readPragma(db, 'foreign_keys')).toBe(1)
    expect(await readPragma(db, 'journal_mode')).toBe('wal')
    expect(await readPragma(db, 'synchronous')).toBe(1)
    await db.dispose()
    await expect(openDatabase({ path: databasePath(), pragmas: { 'x; DROP TABLE t': 1 } })).rejects.toThrow('Invalid pragma name')
    await expect(openDatabase({ path: databasePath(), pragmas: { journal_mode: 'WAL; DROP TABLE t' } })).rejects.toThrow('Invalid value for pragma journal_mode')
  })
})

describe('connection owner transactions', () => {
  it('F29 commits on success and rolls back everything on an injected failure', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    await owner.transaction(async (tx) => { await tx.sql`INSERT INTO notes (text) VALUES (${'kept'})` })
    await expect(owner.transaction(async (tx) => {
      await tx.sql`INSERT INTO notes (text) VALUES (${'lost 1'})`
      await tx.sql`INSERT INTO notes (text) VALUES (${'lost 2'})`
      throw new Error('injected failure')
    })).rejects.toThrow('injected failure')
    expect(await owner.run(noteTexts)).toEqual(['kept'])
    await owner.close()
  })

  it('F30 raw DB0 loses an unrelated write to a rollback; the executor preserves it', async () => {
    const raw = await notesDatabase()
    const rawA = (async () => {
      await raw.exec('BEGIN IMMEDIATE')
      await raw.sql`INSERT INTO notes (text) VALUES (${'A'})`
      await delay(10)
      await raw.exec('ROLLBACK')
    })()
    await delay(1)
    await raw.sql`INSERT INTO notes (text) VALUES (${'B'})`
    await rawA
    expect(await noteTexts(raw)).toEqual([])
    await raw.dispose()

    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    const ownedA = owner.transaction(async (tx) => {
      await tx.sql`INSERT INTO notes (text) VALUES (${'A'})`
      await delay(10)
      throw new Error('A rolls back')
    })
    await delay(1)
    await owner.run(db => db.sql`INSERT INTO notes (text) VALUES (${'B'})`)
    await expect(ownedA).rejects.toThrow('A rolls back')
    expect(await owner.run(noteTexts)).toEqual(['B'])
    await owner.close()
  })

  it('F31 runs a synchronous native transaction and rejects an async body', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    const count = await owner.nativeTransaction((connection) => {
      connection.prepare('INSERT INTO notes (text) VALUES (?)').run('sync 1')
      connection.prepare('INSERT INTO notes (text) VALUES (?)').run('sync 2')
      return Number(connection.prepare('SELECT COUNT(*) AS n FROM notes').get()!.n)
    })
    expect(count).toBe(2)
    const asyncBody = await owner.nativeTransaction(async () => 1).catch((error: unknown) => error)
    expect(isRuntimeError(asyncBody, RuntimeErrorCode.asyncTransactionBody)).toBe(true)
    const promiseBody = await owner.nativeTransaction((connection) => {
      connection.prepare('INSERT INTO notes (text) VALUES (?)').run('rolled back')
      return Promise.resolve(1)
    }).catch((error: unknown) => error)
    expect(isRuntimeError(promiseBody, RuntimeErrorCode.asyncTransactionBody)).toBe(true)
    expect(await owner.run(noteTexts)).toEqual(['sync 1', 'sync 2'])
    await owner.close()
  })

  it('F32 refuses to wait for a human inside a transaction', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    const { requestCli } = createCliRequester({ slot: createCliConsumerSlot() })
    const error = await owner.transaction(async () => requestCli({ id: 'r1', kind: 'approval', correlationId: 'c1', action: { summary: 'write' }, wait: { mode: 'indefinite' } })).catch((failure: unknown) => failure)
    expect(isRuntimeError(error, RuntimeErrorCode.waitInsideTransaction)).toBe(true)
    await owner.close()
  })

  it('lets the transaction body use owner.run and refuses nested transactions', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    const nested = await owner.transaction(async () => {
      await owner.run(db => db.sql`INSERT INTO notes (text) VALUES (${'inside'})`)
      return owner.transaction(async () => undefined).catch((error: unknown) => error)
    })
    expect(isRuntimeError(nested, SqliteErrorCode.nestedTransaction)).toBe(true)
    expect(await owner.run(noteTexts)).toEqual(['inside'])
    await owner.close()
  })

  it('F40 disposes an owned database on close and leaves an injected one open', async () => {
    const owned = await notesDatabase()
    const ownedOwner = createConnectionOwner(owned, { owned: true })
    const pending = ownedOwner.transaction(async (tx) => { await delay(5); await tx.sql`INSERT INTO notes (text) VALUES (${'drained'})` })
    await Promise.all([ownedOwner.close(), ownedOwner.close()])
    await pending
    expect(owned.disposed).toBe(true)
    await expect(ownedOwner.run(noteTexts)).rejects.toThrow('is closed')

    const injected = await notesDatabase()
    const injectedOwner = createConnectionOwner(injected, { owned: false })
    await injectedOwner.close()
    expect(injected.disposed).toBe(false)
    expect((await rawConnection(injected)).isOpen).toBe(true)
    await injected.dispose()
  })
})
