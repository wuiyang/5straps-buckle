import { randomUUID } from 'node:crypto'
import { isSqliteBusy, openDatabase, rawConnection, type SqliteDatabase } from '@5straps/runtime/sqlite'
import { join } from 'pathe'
import { logger } from '../../runtime/log.js'

interface Activity { at: number; turn: string; stage: string | null }

/** The store's file, which the idle check names where it cannot read it. */
export const ACTIVITY_STORE = 'activity.sqlite'

/** Another process held the store busy past its wait: activity is not unknown, only unread this time. */
export class ActivityBusyError extends Error {
  constructor() { super(`${ACTIVITY_STORE} was busy`) }
}

const UNPERSISTED = 'History activity could not be persisted; turn grouping may reset after restart'
const TOUCH_WORKSPACE = 'INSERT INTO workspace (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = max(at, excluded.at)'

/**
 * Each session's newest call start or end, for turn grouping, and the workspace's own row, which each call end, ask, and
 * decision touches: together the workspace's last activity, which the idle check reads.
 */
export async function openHistoryActivity(directory: string) {
  const memory = new Map<string, Activity>()
  const active = new Map<string, Map<string | null, { turn: string; count: number }>>()
  let database: SqliteDatabase | undefined
  let db: Awaited<ReturnType<typeof rawConnection>> | undefined
  // Each warning is said once until a write succeeds again: a store that stays broken would warn at every call and ask.
  const warned = new Set<string>()
  const failed = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    logger.warn(message)
  }
  try {
    const file = join(directory, ACTIVITY_STORE)
    database = await openDatabase({ path: file, pragmas: { busy_timeout: 1000, journal_mode: 'DELETE' }, requireOwnerOnlyDirectory: true, logger })
    db = await rawConnection(database)
    db.exec('CREATE TABLE IF NOT EXISTS activity (session TEXT PRIMARY KEY, at INTEGER NOT NULL, turn TEXT NOT NULL, stage TEXT)')
    db.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)')
  } catch {
    await database?.dispose(); database = undefined; db = undefined
    failed(UNPERSISTED)
  }

  function observe(input: { session: string; at: number; stage?: string; idleMs: number; knownTurn?: string; fallback?: Activity }): string {
    const choose = (previous: Activity | undefined): Activity => {
      const stage = input.stage ?? null
      const same = previous?.stage === stage && (stage !== null || input.at - previous.at <= input.idleMs)
      return { at: input.at, stage, turn: input.knownTurn ?? (same ? previous!.turn : `turn-${randomUUID()}`) }
    }
    let next: Activity
    try {
      if (!db) throw new Error('Activity store unavailable')
      db.exec('BEGIN IMMEDIATE')
      try {
        const previous = db.prepare('SELECT at, turn, stage FROM activity WHERE session = ?').get(input.session) as Activity | undefined
        next = choose(previous ?? input.fallback)
        db.prepare('INSERT INTO activity (session, at, turn, stage) VALUES (?, ?, ?, ?) ON CONFLICT(session) DO UPDATE SET at = excluded.at, turn = excluded.turn, stage = excluded.stage').run(input.session, next.at, next.turn, next.stage)
        db.exec('DELETE FROM activity WHERE session IN (SELECT session FROM activity ORDER BY at DESC LIMIT -1 OFFSET 4096); COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      warned.clear()
    } catch {
      next = choose(memory.get(input.session) ?? input.fallback)
      failed(UNPERSISTED)
    }
    memory.delete(input.session); memory.set(input.session, next)
    if (memory.size > 4096) memory.delete(memory.keys().next().value!)
    return next.turn
  }

  function activeTurn(session: string, stage?: string): string | undefined { return active.get(session)?.get(stage ?? null)?.turn }
  function start(session: string, stage: string | undefined, turn: string): void {
    const stages = active.get(session) ?? new Map<string | null, { turn: string; count: number }>()
    const key = stage ?? null
    const entry = stages.get(key)
    if (entry && entry.turn === turn) entry.count++
    else stages.set(key, { turn, count: 1 })
    active.set(session, stages)
  }
  function finish(session: string, stage: string | undefined, turn: string, at: number): void {
    complete(session, turn, at)
    const stages = active.get(session)
    const entry = stages?.get(stage ?? null)
    if (entry?.turn === turn && --entry.count === 0) stages!.delete(stage ?? null)
    if (stages?.size === 0) active.delete(session)
  }

  function complete(session: string, turn: string, at: number): void {
    const previous = memory.get(session)
    if (previous?.turn === turn) previous.at = Math.max(previous.at, at)
    if (!db) return
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE activity SET at = max(at, ?) WHERE session = ? AND turn = ?').run(at, session, turn)
        // A call's end is activity whatever turn its session moved on to meanwhile.
        db.prepare(TOUCH_WORKSPACE).run(at)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      warned.clear()
    } catch { failed('History activity could not be persisted; turn grouping may reset after restart, and the workspace\'s sessions may end at idle sooner than its window') }
  }

  /** An ask or a decision in the workspace, at `at`. */
  function touch(at: number): void {
    try {
      if (!db) throw new Error('Activity store unavailable')
      db.prepare(TOUCH_WORKSPACE).run(at)
      warned.clear()
    } catch { failed('Workspace activity could not be recorded; its sessions may end at idle sooner than its window') }
  }

  /**
   * The newest activity the store holds, of any session or the workspace's own row; undefined where none was recorded.
   * Throws where the store cannot be read, its in-memory fallback included, which knows this process's activity alone, and
   * ActivityBusyError where another process held it busy past the wait.
   */
  function latest(): number | undefined {
    if (!db) throw new Error('Activity store unavailable')
    try {
      const row = db.prepare('SELECT max(at) AS at FROM (SELECT at FROM activity UNION ALL SELECT at FROM workspace)').get() as { at: number | null }
      return row.at ?? undefined
    } catch (error) {
      if (isSqliteBusy(error)) throw new ActivityBusyError()
      throw error
    }
  }

  return { observe, activeTurn, start, finish, complete, touch, latest, close: () => database?.dispose() ?? Promise.resolve() }
}
