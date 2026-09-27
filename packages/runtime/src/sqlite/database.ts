import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, type Database } from 'db0'
import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { RuntimeError } from '../errors.js'
import type { Logger } from '../logger/types.js'
import { SqliteErrorCode } from './codes.js'

// Any DB0 database on the node-sqlite connector: one from openDatabase or Nitro's useDatabase().
export type SqliteDatabase = Database
export type PragmaValue = string | number | boolean

export interface OpenDatabaseOptions {
  path: string
  pragmas?: Readonly<Record<string, PragmaValue>>
  // Receives a warning when the parent directory is accessible to other users or a mode cannot be set (EPERM).
  logger?: Logger
  // Refuse instead of warn when the parent directory is accessible to other users (it holds credentials).
  requireOwnerOnlyDirectory?: boolean
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const DEFAULT_PRAGMAS = Object.freeze({ busy_timeout: DEFAULT_BUSY_TIMEOUT_MS, foreign_keys: true })
// Only a new database is switched to WAL; an existing file keeps its journal mode unless the caller sets one.
const NEW_DATABASE_PRAGMAS = Object.freeze({ journal_mode: 'WAL' })
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal']
const PRAGMA_NAME = /^[a-z_]+$/
const PRAGMA_WORD = /^[A-Za-z_]+$/

interface SqlitePragmaDefaults {
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
  const isNew = prepareDatabaseFile({ path, logger: options.logger, requireOwnerOnlyDirectory: options.requireOwnerOnlyDirectory === true })
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

// Normalised, so '..' can never point the created-directory walk at an existing parent.
function requireExplicitPath(path: string): string {
  if (!path || !isAbsolute(path)) throw new TypeError(`SQLite path must be absolute; got ${JSON.stringify(path)}`)
  return resolve(path)
}

interface PrepareFileInput {
  path: string
  logger: Logger | undefined
  requireOwnerOnlyDirectory: boolean
}

// Returns whether the database is new: this call created the file, or it is still empty.
function prepareDatabaseFile(input: PrepareFileInput): boolean {
  const { path, logger } = input
  prepareDirectory({ ...input, directory: dirname(path) })
  const isNew = createFileIfAbsent(path)
  restrictMode({ path, mode: 0o600, logger })
  restrictSidecars(path, logger)
  return isNew
}

// SQLite gives a new -wal or -shm file the database's mode, but files made under an older, looser mode keep it.
function restrictSidecars(path: string, logger: Logger | undefined): void {
  for (const sidecar of SIDECAR_SUFFIXES.map(suffix => `${path}${suffix}`)) {
    if (lstatSync(sidecar, { throwIfNoEntry: false })?.isFile()) restrictMode({ path: sidecar, mode: 0o600, logger })
  }
}

// Only directories this call created get 0700; an existing (possibly shared or mounted) one is left alone.
function prepareDirectory(input: Omit<PrepareFileInput, 'path'> & { directory: string }): void {
  const firstCreated = mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  if (firstCreated !== undefined) restrictCreatedDirectories({ ...input, firstCreated })
  checkDirectoryAccess(input)
}

function restrictCreatedDirectories({ directory, firstCreated, logger }: { directory: string; firstCreated: string; logger: Logger | undefined }): void {
  for (let current = directory; ; current = dirname(current)) {
    restrictMode({ path: current, mode: 0o700, logger })
    if (current === firstCreated) return
  }
}

// Warns by default; a directory that holds credentials must be owner-only, so the caller can ask for a refusal.
function checkDirectoryAccess({ directory, logger, requireOwnerOnlyDirectory }: Omit<PrepareFileInput, 'path'> & { directory: string }): void {
  const mode = statSync(directory).mode & 0o777
  if ((mode & 0o077) === 0) return
  if (requireOwnerOnlyDirectory) throw new RuntimeError(SqliteErrorCode.directoryNotOwnerOnly, `SQLite directory ${directory} is accessible to other users (mode ${mode.toString(8)}); it holds credentials and must be 0700`)
  logger?.warn('SQLite directory is accessible to other users; its mode was left unchanged', { directory, mode: mode.toString(8) })
}

// A file another user owns, or a filesystem without modes, refuses chmod with EPERM: warn and keep going.
function restrictMode({ path, mode, logger }: { path: string; mode: number; logger: Logger | undefined }): void {
  try {
    chmodSync(path, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    logger?.warn('SQLite file mode could not be restricted', { path, mode: mode.toString(8), code: 'EPERM' })
  }
}

// Never open an existing database through fs: POSIX close() drops every fcntl lock this process
// holds on the inode, including SQLite's, so a second open would free another connection's lock.
function createFileIfAbsent(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing) {
    // lstat: a symlink is refused rather than followed to a file this process did not choose.
    if (!existing.isFile()) throw new RuntimeError(SqliteErrorCode.notRegularFile, `SQLite path must be a regular file, not a symlink or directory; got ${JSON.stringify(path)}`)
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
