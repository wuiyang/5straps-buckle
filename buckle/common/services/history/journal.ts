import { isInside } from '../../domain/paths.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'pathe'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { createConnectionOwner, openDatabase, rawConnection, SqliteErrorCode, withFileLock } from '@5straps/runtime/sqlite'
import { z } from 'zod'
import { requireOwnerOnly, setMode } from '../../adapters/file-modes.js'
import { STATE_BUSY } from '../../adapters/json-file-store.js'
import { logger } from '../../runtime/log.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { applySnapshot, assertSnapshotMatches, changedPaths, notRestorablePaths, sameEntry, snapshot, snapshotSchema, type Snapshot } from './snapshot.js'

const checkpointSchema = z.object({ id: z.string(), sessionId: z.string(), stageId: z.string(), tool: z.string(), createdAt: z.string(), status: z.enum(['pending', 'complete', 'interrupted']), roots: z.array(z.string()), excluded: z.array(z.string()).optional(), before: snapshotSchema, after: snapshotSchema.optional(), restores: z.string().optional() })
type Checkpoint = z.infer<typeof checkpointSchema>
export interface HistoryInput { sessionId: string; stageId: string; tool: string; roots: string[]; excluded?: string[] }
export type CheckpointSummary = ReturnType<typeof summary>

// A section that waited past its bound for another flow: busy, and the runtime's message names the
// history directory, so the caller is told the plain reason instead.
async function busyAsHistory<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (isRuntimeError(error, SqliteErrorCode.sectionWaitTimeout)) throw new HistoryBusyError('This workspace\'s history is busy with another operation; retry shortly', { cause: error })
    throw error
  }
}

// The synchronous handle behind the owner's connection; the runtime owns the driver.
type DatabaseSync = Awaited<ReturnType<typeof rawConnection>>

const SCHEMA = 'CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, content BLOB NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL)'
// One execution at a time per workspace, across processes: the wait matches the lock it replaces.
const EXECUTION_LOCK_DEADLINE_MS = 300_000
const EXECUTION_LOCK_POLL_MS = 25

/** Another execution held the workspace's history lock, or another flow its database, past the wait. */
export class HistoryBusyError extends Error implements ServiceFailure {
  readonly code = STATE_BUSY
  readonly status = 503
}

export interface ChangeHistoryOptions {
  directory: string
  excluded: string[]
  maxBytes: number
  retentionDays: number
  label?: string
  lockDeadlineMs?: number
  /** The host's unless a test imitates another: on Windows a file held open without read sharing is recorded as unreadable. */
  platform?: NodeJS.Platform
}

/**
 * The workspace's change history in history.sqlite, owned by one connection owner. Each step's SQL
 * runs synchronously inside one owner section, so no await splits a capture from its save.
 */
export async function openChangeHistory(input: ChangeHistoryOptions) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  setMode(input.directory, 0o700)
  // It holds copies of workspace files, secrets included. Checked here rather than by openDatabase, so the
  // refusal names the flag that lets it through, as the state directory's does.
  requireOwnerOnly(input.directory, 'directory')
  const db = await openDatabase({ path: join(input.directory, 'history.sqlite'), pragmas: { busy_timeout: 5_000 } })
  const owner = createConnectionOwner(db, { owned: true, label: input.label ?? `history:${input.directory}` })
  const excluded = [...input.excluded, input.directory]
  const lockDeadlineMs = input.lockDeadlineMs ?? EXECUTION_LOCK_DEADLINE_MS
  await section(connection => connection.exec(SCHEMA))
  // Each entry left out for its name (isPlainName) is named once, not at every capture.
  const warnedNames = new Set<string>()
  const warnBackslashName = (shown: string, root: string): void => {
    const key = JSON.stringify([root, shown])
    if (warnedNames.has(key)) return
    warnedNames.add(key)
    logger.warn('History leaves out an entry whose name Buckle would read as another path (a backslash, or on Windows a dot or a space that ends it): it is not captured or restored, and a change to it is listed as not restorable', { root, name: shown })
  }

  function section<T>(body: (connection: DatabaseSync) => T): Promise<T> {
    return busyAsHistory(owner.run(async raw => body(await rawConnection(raw))))
  }

  function records(connection: DatabaseSync): Checkpoint[] {
    return connection.prepare('SELECT data FROM checkpoints ORDER BY rowid').all().map(row => checkpointSchema.parse(JSON.parse(String(row.data))))
  }
  function checkBudget(connection: DatabaseSync): void {
    const pages = Number(connection.prepare('PRAGMA page_count').get()!.page_count)
    const pageSize = Number(connection.prepare('PRAGMA page_size').get()!.page_size)
    if (pages * pageSize > input.maxBytes) throw new Error('History disk budget reached; increase the limit or prune expired history before more changes')
  }
  function save(record: Checkpoint): Promise<void> {
    return busyAsHistory(owner.nativeTransaction(connection => {
      connection.prepare('INSERT OR REPLACE INTO checkpoints(id,data) VALUES(?,?)').run(record.id, JSON.stringify(record))
      checkBudget(connection)
    }))
  }
  function capture(connection: DatabaseSync, roots: string[], extraExcluded: string[] = []): Snapshot {
    return snapshot({ roots, excluded: [...excluded, ...extraExcluded], maxBytes: input.maxBytes, excludeLinkedDependencies: true, onBackslashName: warnBackslashName, ...(input.platform ? { platform: input.platform } : {}), save(hash, content) {
      connection.prepare('INSERT OR IGNORE INTO objects(hash,content) VALUES(?,?)').run(hash, content)
      checkBudget(connection)
    } })
  }
  function readObject(connection: DatabaseSync, hash: string): Buffer {
    const row = connection.prepare('SELECT content FROM objects WHERE hash=?').get(hash)
    if (!row || !(row.content instanceof Uint8Array)) throw new Error('History content is missing')
    return Buffer.from(row.content)
  }
  async function locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await withFileLock({ path: join(input.directory, 'execution.lock.sqlite'), wait: { deadlineMs: lockDeadlineMs, pollMs: EXECUTION_LOCK_POLL_MS }, ...(signal ? { signal } : {}) }, operation)
    } catch (error) {
      if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new HistoryBusyError(`Another execution held this workspace's history for ${Math.round(lockDeadlineMs / 1000)} s; retry once it finishes`, { cause: error })
      throw error
    }
  }
  function prune(connection: DatabaseSync): void {
    const cutoff = Date.now() - input.retentionDays * 86_400_000
    for (const record of records(connection)) if (record.status !== 'pending' && Date.parse(record.createdAt) < cutoff) connection.prepare('DELETE FROM checkpoints WHERE id=?').run(record.id)
    const referenced = new Set(records(connection).flatMap(record => [...Object.values(record.before), ...Object.values(record.after ?? {})].flatMap(entry => entry.hash ? [entry.hash] : [])))
    for (const row of connection.prepare('SELECT hash FROM objects').all()) if (!referenced.has(String(row.hash))) connection.prepare('DELETE FROM objects WHERE hash=?').run(String(row.hash))
  }
  async function begin(details: HistoryInput, restores?: string): Promise<Checkpoint> {
    const record = await section((connection): Checkpoint => {
      if (records(connection).some(item => item.status === 'pending')) throw new Error('An interrupted checkpoint needs owner recovery before further mutations')
      prune(connection)
      return { ...details, id: `change-${randomUUID()}`, createdAt: new Date().toISOString(), status: 'pending', before: capture(connection, details.roots, details.excluded), restores }
    })
    await save(record)
    return record
  }
  async function finish(record: Checkpoint, status: 'complete' | 'interrupted' = 'complete'): Promise<void> {
    record.after = await section(connection => capture(connection, record.roots, record.excluded))
    record.status = status
    await save(record)
  }
  async function findRecord(predicate: (record: Checkpoint) => boolean): Promise<Checkpoint | undefined> {
    return section(connection => records(connection).find(predicate))
  }
  async function restoreRecord(record: Checkpoint) {
    if (!record.after) throw new Error('Completed checkpoint not found')
    const after = record.after
    const paths = changedPaths(record.before, after)
    assertExcludedUntouched(paths, record.excluded)
    const current = await section(connection => capture(connection, record.roots, record.excluded))
    assertSnapshotMatches({ current, expected: after, target: record.before, paths, operation: 'Restore' })
    const restore = await begin({ sessionId: record.sessionId, stageId: record.stageId, tool: 'owner_restore', roots: record.roots, excluded: record.excluded }, record.id)
    try {
      await section(connection => applySnapshot({ target: record.before, current, paths, content: hash => readObject(connection, hash), roots: record.roots }))
    } finally { await finish(restore) }
    // What the restored checkpoint changed in hard-linked dependencies stays as it is, and the result says so (review L1).
    return { ...summary(restore), notRestorable: notRestorablePaths(record.before, after) }
  }
  return {
    list: () => section(connection => records(connection).map(summary)),
    async run<T>(details: HistoryInput, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return locked(async () => {
        const record = await begin(details)
        try { return await execute() } finally { await finish(record) }
      }, signal)
    },
    /** Runs `execute` under the workspace's execution lock with no checkpoint: it writes nothing history restores, and nothing else writes while it runs. */
    exclusive<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return locked(execute, signal)
    },
    async promote(details: HistoryInput, expected: Snapshot, target: Snapshot, content: (hash: string) => Buffer, onCheckpoint?: () => void) {
      return locked(async () => {
        const paths = changedPaths(expected, target)
        if (!paths.length) return null
        assertExcludedUntouched(paths, details.excluded)
        const current = await section(connection => capture(connection, details.roots, details.excluded))
        assertSnapshotMatches({ current, expected, target, paths, operation: 'Promotion' })
        const record = await begin(details)
        try { onCheckpoint?.(); applySnapshot({ target, current, paths, content, roots: details.roots }) }
        finally { await finish(record) }
        return summary(record)
      })
    },
    async recover(id: string) {
      return locked(async () => {
        const record = await findRecord(item => item.id === id)
        if (!record || record.status !== 'pending') throw new Error('Pending checkpoint not found')
        await finish(record, 'interrupted')
        return summary(record)
      })
    },
    async restore(id: string) {
      return locked(async () => {
        const record = await findRecord(item => item.id === id)
        if (!record) throw new Error('Checkpoint not found')
        return restoreRecord(record)
      })
    },
    async restoreStage(stageId: string, sessionId: string) {
      return locked(async () => {
        const selected = await section(connection => records(connection).filter(record => record.stageId === stageId && record.sessionId === sessionId && !record.restores))
        if (!selected.length || selected.some(record => !record.after)) throw new Error('Completed stage not found')
        const before: Snapshot = { ...selected[0]!.before }; const after: Snapshot = { ...selected[0]!.before }; const seen = new Set<string>()
        for (const record of selected) for (const path of changedPaths(record.before, record.after!)) {
          if (seen.has(path) && !sameEntry(after[path], record.before[path])) throw new Error('Restore conflict: changes from another stage are interleaved')
          if (!seen.has(path) && record.before[path]) before[path] = record.before[path]!
          if (record.after![path]) after[path] = record.after![path]!
          else delete after[path]
          seen.add(path)
        }
        return restoreRecord({ ...selected[0]!, id: `stage:${stageId}`, roots: [...new Set(selected.flatMap(record => record.roots))], excluded: [...new Set(selected.flatMap(record => record.excluded ?? []))], before, after })
      })
    },
    prune: () => locked(async () => { await section(connection => { prune(connection); connection.exec('VACUUM') }); return { ok: true } }),
    /** Closes the database once queued sections finish; later calls are refused. */
    close: () => owner.close(),
  }
}
export type ChangeHistory = Awaited<ReturnType<typeof openChangeHistory>>

/**
 * A checkpoint as the owner reads it. `notRestorable`: the paths it changed among entries history records without
 * content (hard-linked dependency files, names holding a backslash, files another program held open), which no
 * restore puts back.
 */
function summary(record: Checkpoint) {
  return { id: record.id, sessionId: record.sessionId, stageId: record.stageId, tool: record.tool, createdAt: record.createdAt, status: record.status, restores: record.restores, paths: record.after ? changedPaths(record.before, record.after) : [], changes: record.after ? changedPaths(record.before, record.after).map(path => ({ path, kind: !record.before[path] ? 'created' : !record.after![path] ? 'deleted' : 'modified' })) : [], notRestorable: record.after ? notRestorablePaths(record.before, record.after) : [] }
}

function assertExcludedUntouched(paths: string[], excluded: string[] = []): void {
  if (paths.some(path => excluded.some(hidden => isInside(path, hidden) || isInside(hidden, path)))) throw new Error('Changes overlap a protected file or its parent directory')
}
