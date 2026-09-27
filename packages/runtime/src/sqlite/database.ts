import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, type Database } from 'db0'
import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import type { Logger } from '../logger/types.js'

// Any DB0 database on the node-sqlite connector: one from openDatabase or Nitro's useDatabase().
export type SqliteDatabase = Database
export type PragmaValue = string | number | boolean

export interface OpenDatabaseOptions {
  path: string
  pragmas?: Readonly<Record<string, PragmaValue>>
  // Receives a warning when an existing parent directory is readable by other users.
  logger?: Logger
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const DEFAULT_PRAGMAS = Object.freeze({ busy_timeout: DEFAULT_BUSY_TIMEOUT_MS, foreign_keys: true })
// Only a new database is switched to WAL; an existing file keeps its journal mode unless the caller sets one.
const NEW_DATABASE_PRAGMAS = Object.freeze({ journal_mode: 'WAL' })
const PRAGMA_NAME = /^[a-z_]+$/
const PRAGMA_WORD = /^[A-Za-z_]+$/

export interface SqlitePragmaDefaults {
  defaults: Readonly<Record<string, PragmaValue>>
  newDatabase?: Readonly<Record<string, PragmaValue>>
}

// DB0 node-sqlite with an explicit absolute path: no `.data/` fallback, directory 0700, file 0600.
export function openDatabase(options: OpenDatabaseOptions): Promise<SqliteDatabase> {
  return openSqlite(options, { defaults: DEFAULT_PRAGMAS, newDatabase: NEW_DATABASE_PRAGMAS })
}

// Shared by openDatabase and the lock connections, which keep the file's own journal mode.
export async function openSqlite(options: OpenDatabaseOptions, pragmas: SqlitePragmaDefaults): Promise<SqliteDatabase> {
  const path = requireExplicitPath(options.path)
  const isNew = prepareDatabaseFile(path, options.logger)
  const db = createDatabase(nodeSqliteConnector({ path }))
  try {
    applyPragmas({ connection: await rawConnection(db), pragmas: { ...pragmas.defaults, ...(isNew ? pragmas.newDatabase : {}), ...options.pragmas }, logger: options.logger })
  } catch (error) {
    await db.dispose()
    throw error
  }
  return db
}

// The synchronous node:sqlite handle behind a DB0 database, for native transactions and lock polling.
export async function rawConnection(db: SqliteDatabase): Promise<DatabaseSync> {
  const instance: unknown = await db.getInstance()
  if (!(instance instanceof DatabaseSync)) throw new TypeError(`Expected a node-sqlite DB0 connector, got ${db.connector}`)
  return instance
}

export async function readPragma(db: SqliteDatabase, name: string): Promise<unknown> {
  if (!PRAGMA_NAME.test(name)) throw new TypeError(`Invalid pragma name ${name}`)
  const row = (await rawConnection(db)).prepare(`PRAGMA ${name}`).get()
  return row ? Object.values(row)[0] : undefined
}

function requireExplicitPath(path: string): string {
  if (!path || !isAbsolute(path)) throw new TypeError(`SQLite path must be absolute; got ${JSON.stringify(path)}`)
  return path
}

// Returns whether the database is new: this call created the file, or it is still empty.
function prepareDatabaseFile(path: string, logger: Logger | undefined): boolean {
  prepareDirectory(dirname(path), logger)
  const isNew = createFileIfAbsent(path)
  chmodSync(path, 0o600)
  return isNew
}

// Only directories this call created get 0700; an existing (possibly shared or mounted) one is left alone.
function prepareDirectory(directory: string, logger: Logger | undefined): void {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (firstCreated === undefined) return warnIfShared(directory, logger)
  for (let current = directory; ; current = dirname(current)) {
    chmodSync(current, 0o700)
    if (current === firstCreated) return
  }
}

function warnIfShared(directory: string, logger: Logger | undefined): void {
  const mode = statSync(directory).mode & 0o777
  if ((mode & 0o077) !== 0) logger?.warn('SQLite directory is accessible to other users; its mode was left unchanged', { directory, mode: mode.toString(8) })
}

// Never open an existing database through fs: POSIX close() drops every fcntl lock this process
// holds on the inode, including SQLite's, so a second open would free another connection's lock.
function createFileIfAbsent(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isFile()) throw new TypeError(`SQLite path must be a regular file; got ${JSON.stringify(path)}`)
    return existing.size === 0
  }
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return true
}

// journal_mode answers with the mode it ended up in; WAL needs shared memory, so a filesystem may refuse it.
function applyPragmas(input: { connection: DatabaseSync; pragmas: Readonly<Record<string, PragmaValue>>; logger: Logger | undefined }): void {
  for (const [name, value] of Object.entries(input.pragmas)) {
    if (!PRAGMA_NAME.test(name)) throw new TypeError(`Invalid pragma name ${name}`)
    const row = input.connection.prepare(`PRAGMA ${name}=${formatPragmaValue(name, value)}`).get()
    const applied = row ? Object.values(row)[0] : undefined
    if (name === 'journal_mode' && String(applied).toLowerCase() !== String(value).toLowerCase()) {
      input.logger?.warn('SQLite journal mode was not applied', { requested: String(value), applied: String(applied) })
    }
  }
}

function formatPragmaValue(name: string, value: PragmaValue): string {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF'
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value === 'string' && PRAGMA_WORD.test(value)) return value
  throw new TypeError(`Invalid value for pragma ${name}`)
}
