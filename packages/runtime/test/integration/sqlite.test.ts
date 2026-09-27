import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { startWorker } from './support/workers.js'
import { createCliConsumerSlot, createCliRequester, createLogger, createServiceRegistry, defineSingleton, isRuntimeError, RuntimeErrorCode, type LogEvent } from '../../src/index.js'
import { createConnectionOwner, DEFAULT_BUSY_TIMEOUT_MS, DEFAULT_SECTION_WAIT_TIMEOUT_MS, isSqliteBusy, openDatabase, rawConnection, readPragma, SqliteErrorCode, type SqliteDatabase } from '../../src/sqlite/index.js'

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

  it('exposes only queued or guarded access to the connection (ruling 2)', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    expect(Object.keys(owner).sort()).toEqual(['close', 'guardedDb', 'nativeTransaction', 'run', 'transaction'])
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

describe('review fixes: directories, journal mode, guarded view, non-blocking begin', () => {
  it('M7 sets 0700 only on directories it created and warns about an existing shared one without changing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirs-'))
    const created = await openDatabase({ path: join(root, 'a', 'b', 'app.sqlite') })
    expect(statSync(join(root, 'a')).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'a', 'b')).mode & 0o777).toBe(0o700)
    await created.dispose()

    const shared = join(root, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o755)
    const events: LogEvent[] = []
    const logs = createLogger({ component: 'sqlite', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
    const db = await openDatabase({ path: join(shared, 'app.sqlite'), logger: logs.logger })
    expect(statSync(shared).mode & 0o777).toBe(0o755)
    await logs.flush()
    expect(events).toEqual([expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ mode: '755' }) })])
    await db.dispose()
  })

  it('L12 defaults journal_mode to WAL and lets the caller choose another', async () => {
    const wal = await openDatabase({ path: databasePath() })
    expect(await readPragma(wal, 'journal_mode')).toBe('wal')
    await wal.dispose()
    const plain = await openDatabase({ path: databasePath(), pragmas: { journal_mode: 'DELETE' } })
    expect(await readPragma(plain, 'journal_mode')).toBe('delete')
    await plain.dispose()
  })

  it('M10 the raw handle loses a write to a foreign rollback; the guarded view waits for it and keeps its write (ruling 6)', async () => {
    const injected = await notesDatabase()
    const owner = createConnectionOwner(injected, { owned: true })
    const aborted = (label: string) => owner.transaction(async (tx) => {
      await tx.sql`INSERT INTO notes (text) VALUES (${label})`
      await delay(10)
      throw new Error(`${label} rolls back`)
    })
    const rawA = aborted('A1')
    await delay(1)
    await injected.sql`INSERT INTO notes (text) VALUES (${'raw B'})`
    await expect(rawA).rejects.toThrow('A1 rolls back')
    expect(await owner.run(noteTexts)).toEqual([])

    // Both calls arrive after A's BEGIN succeeded; they queue behind A and survive its rollback.
    const guardedA = aborted('A2')
    await delay(1)
    const guarded = owner.guardedDb.sql`INSERT INTO notes (text) VALUES (${'guarded B'})`
    const prepared = owner.guardedDb.prepare('INSERT INTO notes (text) VALUES (?)').run('prepared B')
    await expect(guardedA).rejects.toThrow('A2 rolls back')
    await Promise.all([guarded, prepared])

    await owner.transaction(async () => { await owner.guardedDb.sql`INSERT INTO notes (text) VALUES (${'inside own'})` })
    await owner.guardedDb.sql`INSERT INTO notes (text) VALUES (${'after'})`
    expect(await noteTexts(owner.guardedDb)).toEqual(['guarded B', 'prepared B', 'inside own', 'after'])
    await owner.close()
  })

  it('M11 waits for another writer without blocking the event loop', async () => {
    const path = databasePath()
    const owner = createConnectionOwner(await openDatabase({ path, pragmas: { busy_timeout: 2_000 } }), { owned: true })
    await owner.run(db => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)'))
    const other = await openDatabase({ path })
    const otherConnection = await rawConnection(other)
    otherConnection.exec('BEGIN IMMEDIATE')
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 5)
    setTimeout(() => otherConnection.exec('COMMIT'), 150)
    await owner.transaction(async (tx) => { await tx.sql`INSERT INTO notes (text) VALUES (${'after wait'})` })
    clearInterval(ticker)
    // A blocking BEGIN would allow no tick at all; any tick proves the loop kept running.
    expect(ticks).toBeGreaterThan(0)
    expect(await owner.run(db => readPragma(db, 'busy_timeout'))).toBe(2_000)
    expect(await owner.run(noteTexts)).toEqual(['after wait'])
    await Promise.all([owner.close(), other.dispose()])
  })

  it('M11 still gives up with a busy error once the busy timeout passes', async () => {
    const path = databasePath()
    const owner = createConnectionOwner(await openDatabase({ path, pragmas: { busy_timeout: 100 } }), { owned: true })
    const other = await openDatabase({ path })
    const otherConnection = await rawConnection(other)
    otherConnection.exec('BEGIN IMMEDIATE')
    const failure = await owner.transaction(async () => undefined).catch((error: unknown) => error)
    expect(isSqliteBusy(failure)).toBe(true)
    otherConnection.exec('COMMIT')
    await Promise.all([owner.close(), other.dispose()])
  })

  it('sqlite-fixes-1 rolls back and rejects a native transaction whose COMMIT fails', async () => {
    const path = databasePath()
    const db = await openDatabase({ path })
    await db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
    const owner = createConnectionOwner(db, { owned: true })
    // The deferred foreign key is checked at COMMIT, which fails and leaves SQLite's transaction open.
    const failure = await owner.nativeTransaction((connection) => { connection.prepare('INSERT INTO child (parent_id) VALUES (?)').run(99) }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ message: expect.stringContaining('FOREIGN KEY constraint failed') })
    expect((await rawConnection(db)).isTransaction).toBe(false)
    await owner.transaction(async (tx) => { await tx.sql`INSERT INTO parent (id) VALUES (${1})` })
    await owner.close()
    const reopened = await openDatabase({ path })
    expect((await reopened.sql`SELECT id FROM parent`).rows).toEqual([{ id: 1 }])
    expect((await reopened.sql`SELECT id FROM child`).rows).toEqual([])
    await reopened.dispose()
  })

  it('L1 keeps the body error when SQLite already rolled back', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    const failure = owner.nativeTransaction((connection) => {
      connection.exec('ROLLBACK')
      throw new Error('original failure')
    })
    await expect(failure).rejects.toThrow('original failure')
    await owner.close()
  })
})

describe('connection ownership across owners and processes (sqlite-fixes-2, -3, -4)', () => {
  const HUNG = 'hung'
  const settleWithin = <T>(work: Promise<T>) => Promise.race([work, delay(2_000).then(() => HUNG)])

  it('sqlite-fixes-2 lets a flow call back into its own owner from inside another owner section', async () => {
    const a = createConnectionOwner(await notesDatabase(), { owned: true, label: 'a' })
    const b = createConnectionOwner(await notesDatabase(), { owned: true, label: 'b' })
    const insert = (owner: typeof a, text: string) => owner.run(db => db.sql`INSERT INTO notes (text) VALUES (${text})`)
    expect(await settleWithin(a.transaction(async () => b.run(async () => { await insert(a, 'tx > run > run'); return 'done' })))).toBe('done')
    expect(await settleWithin(a.run(async () => b.transaction(async () => { await insert(a, 'run > tx > run'); return 'done' })))).toBe('done')
    expect(await settleWithin(a.transaction(async () => b.run(async () => { await a.guardedDb.sql`INSERT INTO notes (text) VALUES (${'guarded inside own tx'})`; return 'done' })))).toBe('done')
    expect(await a.run(noteTexts)).toEqual(['tx > run > run', 'run > tx > run', 'guarded inside own tx'])
    await Promise.all([a.close(), b.close()])
  })

  it('sqlite-fixes-3 keeps one owner per connection and never hands out the raw handle through the guarded view', async () => {
    const db = await notesDatabase()
    const owner = createConnectionOwner(db, { owned: false })
    expect(() => createConnectionOwner(db, { owned: false })).toThrow(expect.objectContaining({ code: SqliteErrorCode.connectionOwned }))
    expect(() => createConnectionOwner(owner.guardedDb, { owned: false })).toThrow(expect.objectContaining({ code: SqliteErrorCode.connectionOwned }))
    const refused = await rawConnection(owner.guardedDb).catch((error: unknown) => error)
    expect(isRuntimeError(refused, SqliteErrorCode.rawHandleRefused)).toBe(true)
    await owner.close()
    const next = createConnectionOwner(db, { owned: true })
    expect(await next.run(noteTexts)).toEqual([])
    await next.close()
  })

  it('sqlite-fixes-4 keeps an existing database journal mode and opens it while another process holds a write lock', async () => {
    const path = databasePath()
    const legacy = await openDatabase({ path, pragmas: { journal_mode: 'DELETE' } })
    await legacy.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)')
    await legacy.dispose()
    const holder = startWorker(['hold-lock', path, '1500'])
    await holder.next(message => message.locked === true)
    const reopened = await openDatabase({ path })
    expect(await readPragma(reopened, 'journal_mode')).toBe('delete')
    await reopened.dispose()
    await holder.exited
    const fresh = await openDatabase({ path: databasePath() })
    expect(await readPragma(fresh, 'journal_mode')).toBe('wal')
    await fresh.dispose()
  })
})

describe('file and handle hygiene (sqlite-fixes-6, -7, -9, -12)', () => {
  it('sqlite-fixes-6 restricts existing WAL and shared-memory files as well as the database', async () => {
    const path = databasePath()
    mkdirSync(join(path, '..'), { recursive: true })
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1)')
    for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o644)
    const db = await openDatabase({ path })
    expect([path, `${path}-wal`, `${path}-shm`].map(file => statSync(file).mode & 0o777)).toEqual([0o600, 0o600, 0o600])
    await db.dispose()
    legacy.close()
  })

  it('sqlite-fixes-7 never changes the mode of an existing parent reached through ..', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirs-'))
    chmodSync(root, 0o755)
    // A raw string: path.join would normalise the '..' away.
    const db = await openDatabase({ path: `${root}/absent/../db/app.sqlite` })
    expect(statSync(root).mode & 0o777).toBe(0o755)
    expect(statSync(join(root, 'db')).mode & 0o777).toBe(0o700)
    await db.dispose()
  })

  it('sqlite-fixes-9 disposing the guarded view leaves the owner open', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true })
    await owner.guardedDb.dispose()
    await owner.run(db => db.sql`INSERT INTO notes (text) VALUES (${'still open'})`)
    expect(await owner.run(noteTexts)).toEqual(['still open'])
    await owner.close()
  })

  it('sqlite-fixes-12 refuses a path that is not a regular file with a typed error', async () => {
    const target = databasePath()
    const created = await openDatabase({ path: target })
    await created.dispose()
    const link = join(target, '..', 'link.sqlite')
    symlinkSync(target, link)
    const refused = await openDatabase({ path: link }).catch((error: unknown) => error)
    expect(isRuntimeError(refused, SqliteErrorCode.notRegularFile)).toBe(true)
  })
})

describe('bounded owner waits (rulings 1 and 6)', () => {
  const HUNG = 'hung'
  const settleWithin = <T>(work: Promise<T>) => Promise.race([work, delay(3_000).then(() => HUNG)])
  // A literal, so the check cannot pass vacuously while the code is missing.
  const isWaitTimeout = (error: unknown) => isRuntimeError(error, 'SectionWaitTimeoutError')
  const outcome = (work: Promise<unknown>) => work.then(value => ({ value }), (error: unknown) => ({ error }))

  it('defaults the section wait to the busy deadline and refuses an invalid bound', async () => {
    expect(DEFAULT_SECTION_WAIT_TIMEOUT_MS).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    expect(SqliteErrorCode).toMatchObject({ sectionWaitTimeout: 'SectionWaitTimeoutError' })
    const db = await notesDatabase()
    for (const sectionWaitTimeoutMs of [0, -1, 1.5, Number.NaN]) expect(() => createConnectionOwner(db, { owned: false, sectionWaitTimeoutMs })).toThrow(TypeError)
    await db.dispose()
  })

  it('fails one of two flows taking two owners in opposite order with a typed timeout instead of hanging', async () => {
    const a = createConnectionOwner(await notesDatabase(), { owned: true, label: 'a', sectionWaitTimeoutMs: 200 })
    const b = createConnectionOwner(await notesDatabase(), { owned: true, label: 'b', sectionWaitTimeoutMs: 200 })
    const f1 = outcome(a.run(async () => { await delay(20); return b.run(async () => 'f1') }))
    const f2 = outcome(b.run(async () => { await delay(20); return a.run(async () => 'f2') }))
    const settled = await settleWithin(Promise.all([f1, f2]))
    expect(settled).not.toBe(HUNG)
    const results = settled as { value?: unknown; error?: unknown }[]
    expect(results.filter(result => 'error' in result).every(result => isWaitTimeout(result.error))).toBe(true)
    expect(results.some(result => 'error' in result)).toBe(true)
    expect(await settleWithin(Promise.all([a.run(async () => 'a serves'), b.run(async () => 'b serves')]))).toEqual(['a serves', 'b serves'])
    await Promise.all([a.close(), b.close()])
  })

  it('fails a flow that awaits, inside the owner section, a singleton whose factory needs that owner', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true, label: 'a', sectionWaitTimeoutMs: 200 })
    const slow = defineSingleton({ name: 'Slow', create: async () => {
      await delay(50)
      await owner.run(db => db.sql`INSERT INTO notes (text) VALUES (${'factory'})`)
      return 'slow ready'
    } })
    const registry = createServiceRegistry({ services: [slow] })
    const started = outcome(registry.useSingleton(slow))
    const inside = outcome(owner.transaction(async (tx) => {
      await tx.sql`INSERT INTO notes (text) VALUES (${'inside'})`
      return registry.useSingleton(slow)
    }))
    const settled = await settleWithin(Promise.all([started, inside]))
    expect(settled).not.toBe(HUNG)
    const [first, second] = settled as { error?: unknown }[]
    expect(isWaitTimeout(first!.error)).toBe(true)
    expect(isWaitTimeout(second!.error)).toBe(true)
    // The failed factory is not cached: built outside the section it succeeds, and the rolled-back row is gone.
    expect(await settleWithin(registry.useSingleton(slow))).toBe('slow ready')
    expect(await owner.run(noteTexts)).toEqual(['factory'])
    await registry.dispose()
    await owner.close()
  })

  it('makes guardedDb wait with the same bound during another flow transaction, then fail typed', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true, label: 'a', sectionWaitTimeoutMs: 100 })
    const release = Promise.withResolvers<void>()
    const long = owner.transaction(async (tx) => {
      await tx.sql`INSERT INTO notes (text) VALUES (${'A'})`
      await release.promise
    })
    await delay(5)
    const late = await settleWithin(owner.guardedDb.sql`INSERT INTO notes (text) VALUES (${'late'})`.catch((error: unknown) => error))
    expect(isWaitTimeout(late)).toBe(true)
    const latePrepared = await settleWithin(owner.guardedDb.prepare('SELECT text FROM notes').all().catch((error: unknown) => error))
    expect(isWaitTimeout(latePrepared)).toBe(true)
    release.resolve()
    await long
    expect(await owner.run(noteTexts)).toEqual(['A'])
    await owner.close()
  })

  it('never lets the waiters behind a timed-out one into the section while the holder still runs', async () => {
    const owner = createConnectionOwner(await notesDatabase(), { owned: true, label: 'a', sectionWaitTimeoutMs: 200 })
    const order: string[] = []
    const holder = owner.run(async () => { order.push('holder start'); await delay(400); order.push('holder end') })
    const timedOut = outcome(owner.run(async () => { order.push('timed-out waiter') }))
    // The first waiter gives up at 200 ms; these two arrive at 300 ms and fit their own bound.
    await delay(300)
    const queued = [owner.run(async () => { order.push('next') }), owner.run(async () => { order.push('last') })]
    await Promise.all([holder, ...queued])
    expect(isWaitTimeout((await timedOut as { error?: unknown }).error)).toBe(true)
    expect(order).toEqual(['holder start', 'holder end', 'next', 'last'])
    await owner.close()
  })
})
