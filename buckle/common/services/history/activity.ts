import { randomUUID } from 'node:crypto'
import { isSqliteBusy, openDatabase, rawConnection, type SqliteDatabase } from '@5straps/runtime/sqlite'
import { join } from 'pathe'
import { SESSION_IDLE_BOUNDS } from '../../domain/approval/session-idle.js'
import type { GrantHolder } from '../../domain/permission/grant-holder.js'
import { logger } from '../../runtime/log.js'

interface Activity { at: number; turn: string; stage: string | null }

/** The store's file, which the idle check names where it cannot read it. */
export const ACTIVITY_STORE = 'activity.sqlite'

/** Another process held the store busy past its wait: activity is not unknown, only unread this time. */
export class ActivityBusyError extends Error {
  constructor() { super(`${ACTIVITY_STORE} was busy`) }
}

const UNPERSISTED = 'History activity could not be persisted; turn grouping may reset after restart'
const UNTOUCHED = 'Session activity could not be recorded; the session may end at idle sooner than its window'
// A session is its id under its actor; one no actor asked in is kept under ''.
const TOUCH_SESSION = 'INSERT INTO sessions (session, actor, at) VALUES (?, ?, ?) ON CONFLICT(session, actor) DO UPDATE SET at = max(at, excluded.at)'
/** The session ids whose turns the store keeps, newest first. */
const TURNS_KEPT = 4096
/**
 * The sessions each actor keeps activity for, newest first, so no caller's new session ids push out another's; an older
 * one reads as idle, as one never seen does.
 */
const SESSIONS_KEPT_PER_ACTOR = 4096

/**
 * Each session id's newest call start or end, for turn grouping, and each session's own row, its id under its actor, which
 * its calls' starts and ends, its asks, and its decisions touch: the session's last activity, which the idle check reads.
 */
export async function openHistoryActivity(directory: string, options: { sessionsKept?: number } = {}) {
  const sessionsKept = options.sessionsKept ?? SESSIONS_KEPT_PER_ACTOR
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
    db.exec('CREATE TABLE IF NOT EXISTS sessions (session TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, actor))')
  } catch {
    await database?.dispose(); database = undefined; db = undefined
    failed(UNPERSISTED)
  }

  function touchSession(connection: NonNullable<typeof db>, holder: GrantHolder, at: number): void {
    connection.prepare(TOUCH_SESSION).run(holder.sessionId, holder.actor ?? '', at)
  }

  /** Drops every row older than the longest idle window, idle under any, and the holder's actor's own past its newest kept. */
  function pruneSessions(connection: NonNullable<typeof db>, holder: GrantHolder, at: number): void {
    connection.prepare('DELETE FROM sessions WHERE at < ?').run(at - SESSION_IDLE_BOUNDS.max)
    connection.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE actor = ? ORDER BY at DESC LIMIT -1 OFFSET ?)').run(holder.actor ?? '', sessionsKept)
  }

  /** A call's turn; `holder`, the session a call starts in, which counts as its activity, where a call starts. */
  function observe(input: { session: string; holder?: GrantHolder; at: number; stage?: string; idleMs: number; knownTurn?: string; fallback?: Activity }): string {
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
        if (input.holder) touchSession(db, input.holder, input.at)
        db.exec(`DELETE FROM activity WHERE session IN (SELECT session FROM activity ORDER BY at DESC LIMIT -1 OFFSET ${TURNS_KEPT})`)
        if (input.holder) pruneSessions(db, input.holder, input.at)
        db.exec('COMMIT')
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
  function finish(session: string, stage: string | undefined, turn: string, at: number, holder: GrantHolder): void {
    complete(session, turn, at, holder)
    const stages = active.get(session)
    const entry = stages?.get(stage ?? null)
    if (entry?.turn === turn && --entry.count === 0) stages!.delete(stage ?? null)
    if (stages?.size === 0) active.delete(session)
  }

  /** The turn's time moves to `at`; `holder`, the session whose call ended, which counts as its activity, where a call ended. */
  function complete(session: string, turn: string, at: number, holder?: GrantHolder): void {
    const previous = memory.get(session)
    if (previous?.turn === turn) previous.at = Math.max(previous.at, at)
    if (!db) return
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE activity SET at = max(at, ?) WHERE session = ? AND turn = ?').run(at, session, turn)
        // A call's end is its session's activity whatever turn the session moved on to meanwhile.
        if (holder) touchSession(db, holder, at)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      warned.clear()
    } catch { failed('History activity could not be persisted; turn grouping may reset after restart, and the session may end at idle sooner than its window') }
  }

  /** An ask or a decision of the session, at `at`. */
  function touch(holder: GrantHolder, at: number): void {
    try {
      if (!db) throw new Error('Activity store unavailable')
      touchSession(db, holder, at)
      warned.clear()
    } catch { failed(UNTOUCHED) }
  }

  /**
   * The session's newest activity; undefined where none was recorded. Throws where the store cannot be read, its in-memory
   * fallback included, which knows this process's activity alone, and ActivityBusyError where another process held it
   * busy past the wait.
   */
  function latest(holder: GrantHolder): number | undefined {
    if (!db) throw new Error('Activity store unavailable')
    try {
      const row = db.prepare('SELECT at FROM sessions WHERE session = ? AND actor = ?').get(holder.sessionId, holder.actor ?? '') as { at: number } | undefined
      return row?.at
    } catch (error) {
      if (isSqliteBusy(error)) throw new ActivityBusyError()
      throw error
    }
  }

  return { observe, activeTurn, start, finish, complete, touch, latest, close: () => database?.dispose() ?? Promise.resolve() }
}
