import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, type Database } from 'db0'
import nodeSqliteConnector from 'db0/connectors/node-sqlite'

// Any DB0 database on the node-sqlite connector: one from openDatabase or Nitro's useDatabase().
export type SqliteDatabase = Database
export type PragmaValue = string | number | boolean

export interface OpenDatabaseOptions {
  path: string
  pragmas?: Readonly<Record<string, PragmaValue>>
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const DEFAULT_PRAGMAS = Object.freeze({ busy_timeout: DEFAULT_BUSY_TIMEOUT_MS, foreign_keys: true })
const PRAGMA_NAME = /^[a-z_]+$/
const PRAGMA_WORD = /^[A-Za-z_]+$/

// DB0 node-sqlite with an explicit absolute path: no `.data/` fallback, directory 0700, file 0600.
export async function openDatabase(options: OpenDatabaseOptions): Promise<SqliteDatabase> {
  const path = requireExplicitPath(options.path)
  prepareDatabaseFile(path)
  const db = createDatabase(nodeSqliteConnector({ path }))
  try {
    applyPragmas(await rawConnection(db), { ...DEFAULT_PRAGMAS, ...options.pragmas })
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

function prepareDatabaseFile(path: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  closeSync(openSync(path, 'a', 0o600))
  chmodSync(path, 0o600)
}

function applyPragmas(connection: DatabaseSync, pragmas: Readonly<Record<string, PragmaValue>>): void {
  for (const [name, value] of Object.entries(pragmas)) {
    if (!PRAGMA_NAME.test(name)) throw new TypeError(`Invalid pragma name ${name}`)
    connection.exec(`PRAGMA ${name}=${formatPragmaValue(name, value)}`)
  }
}

function formatPragmaValue(name: string, value: PragmaValue): string {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF'
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value === 'string' && PRAGMA_WORD.test(value)) return value
  throw new TypeError(`Invalid value for pragma ${name}`)
}
