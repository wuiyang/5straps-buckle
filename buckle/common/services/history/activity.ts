import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'pathe'
import { logger } from '../../runtime/log.js'

interface Activity { at: number; turn: string; stage: string | null }

export function openHistoryActivity(directory: string) {
  const memory = new Map<string, Activity>()
  const active = new Map<string, Map<string | null, { turn: string; count: number }>>()
  let db: DatabaseSync | undefined
  try {
    const file = join(directory, 'activity.sqlite')
    db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    db.exec('PRAGMA busy_timeout = 1000; CREATE TABLE IF NOT EXISTS activity (session TEXT PRIMARY KEY, at INTEGER NOT NULL, turn TEXT NOT NULL, stage TEXT)')
  } catch {
    db?.close(); db = undefined
    logger.warn('History activity could not be persisted; turn grouping may reset after restart')
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
    } catch {
      next = choose(memory.get(input.session) ?? input.fallback)
      logger.warn('History activity could not be persisted; turn grouping may reset after restart')
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
    try { db?.prepare('UPDATE activity SET at = max(at, ?) WHERE session = ? AND turn = ?').run(at, session, turn) }
    catch { logger.warn('History activity could not be persisted; turn grouping may reset after restart') }
  }

  return { observe, activeTurn, start, finish, complete, close: () => db?.close() }
}
