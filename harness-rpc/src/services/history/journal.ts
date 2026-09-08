import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { applySnapshot, changedPaths, sameEntry, snapshot, snapshotSchema, type Snapshot } from './snapshot.js'

const checkpointSchema = z.object({ id: z.string(), sessionId: z.string(), stageId: z.string(), tool: z.string(), createdAt: z.string(), status: z.enum(['pending', 'complete', 'interrupted']), roots: z.array(z.string()), before: snapshotSchema, after: snapshotSchema.optional(), restores: z.string().optional() })
type Checkpoint = z.infer<typeof checkpointSchema>
export interface HistoryInput { sessionId: string; stageId: string; tool: string; roots: string[] }

export function createChangeHistory(input: { directory: string; excluded: string[]; maxBytes: number; retentionDays: number }) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  chmodSync(input.directory, 0o700)
  const db = new DatabaseSync(join(input.directory, 'history.sqlite'))
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, content BLOB NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  chmodSync(join(input.directory, 'history.sqlite'), 0o600)
  const excluded = [...input.excluded, input.directory]

  function records(): Checkpoint[] { return db.prepare('SELECT data FROM checkpoints ORDER BY rowid').all().map(row => checkpointSchema.parse(JSON.parse(String(row.data)))) }
  function checkBudget(): void {
    const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count)
    const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size)
    if (pages * pageSize > input.maxBytes) throw new Error('History disk budget reached; increase the limit or prune expired history before more changes')
  }
  function save(record: Checkpoint): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT OR REPLACE INTO checkpoints(id,data) VALUES(?,?)').run(record.id, JSON.stringify(record))
      checkBudget()
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function capture(roots: string[]): Snapshot {
    return snapshot({ roots, excluded, maxBytes: input.maxBytes, save(hash, content) {
      db.prepare('INSERT OR IGNORE INTO objects(hash,content) VALUES(?,?)').run(hash, content)
      checkBudget()
    } })
  }
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = new DatabaseSync(join(input.directory, 'execution.lock.sqlite'), { timeout: 0 })
    const deadline = Date.now() + 300_000
    try {
      while (true) {
        try { lock.exec('BEGIN IMMEDIATE'); break } catch (error) {
          if (!(error instanceof Error) || !/locked|busy/i.test(error.message) || Date.now() >= deadline) throw error
          await delay(25)
        }
      }
      return await operation()
    } finally { lock.close() }
  }
  function prune(): void {
    const cutoff = Date.now() - input.retentionDays * 86_400_000
    for (const record of records()) if (record.status !== 'pending' && Date.parse(record.createdAt) < cutoff) db.prepare('DELETE FROM checkpoints WHERE id=?').run(record.id)
    const referenced = new Set(records().flatMap(record => [...Object.values(record.before), ...Object.values(record.after ?? {})].flatMap(entry => entry.hash ? [entry.hash] : [])))
    for (const row of db.prepare('SELECT hash FROM objects').all()) if (!referenced.has(String(row.hash))) db.prepare('DELETE FROM objects WHERE hash=?').run(String(row.hash))
  }
  function begin(details: HistoryInput, restores?: string): Checkpoint {
    if (records().some(record => record.status === 'pending')) throw new Error('An interrupted checkpoint needs owner recovery before further mutations')
    prune()
    const record: Checkpoint = { ...details, id: `change-${randomUUID()}`, createdAt: new Date().toISOString(), status: 'pending', before: capture(details.roots), restores }
    save(record)
    return record
  }
  function finish(record: Checkpoint, status: 'complete' | 'interrupted' = 'complete'): void {
    record.after = capture(record.roots)
    record.status = status
    save(record)
  }
  function summary(record: Checkpoint) {
    return { id: record.id, sessionId: record.sessionId, stageId: record.stageId, tool: record.tool, createdAt: record.createdAt, status: record.status, restores: record.restores, paths: record.after ? changedPaths(record.before, record.after) : [], changes: record.after ? changedPaths(record.before, record.after).map(path => ({ path, kind: !record.before[path] ? 'created' : !record.after![path] ? 'deleted' : 'modified' })) : [] }
  }
  function restoreRecord(record: Checkpoint) {
    if (!record.after) throw new Error('Completed checkpoint not found')
    const current = capture(record.roots)
    const paths = changedPaths(record.before, record.after)
    if (paths.some(path => !sameEntry(current[path], record.after![path]))) throw new Error('Restore conflict: a changed path no longer matches the checkpoint')
    // New descendants also conflict when a restore removes or replaces their parent.
    for (const path of paths) if (record.after[path]?.kind === 'directory' && record.before[path]?.kind !== 'directory') {
      if (Object.keys(current).some(child => child.startsWith(`${path}/`) && !Object.hasOwn(record.after!, child))) throw new Error('Restore conflict: a directory contains newer files')
    }
    const restore = begin({ sessionId: record.sessionId, stageId: record.stageId, tool: 'owner_restore', roots: record.roots }, record.id)
    try {
      applySnapshot({ target: record.before, current, paths, content(hash) {
        const row = db.prepare('SELECT content FROM objects WHERE hash=?').get(hash)
        if (!row || !(row.content instanceof Uint8Array)) throw new Error('History content is missing')
        return Buffer.from(row.content)
      } })
    } finally { finish(restore) }
    return summary(restore)
  }
  return {
    list: () => records().map(summary),
    async run<T>(details: HistoryInput, execute: () => Promise<T>): Promise<T> {
      return locked(async () => {
        const record = begin(details)
        try { return await execute() } finally { finish(record) }
      })
    },
    async recover(id: string) {
      return locked(async () => {
        const record = records().find(record => record.id === id)
        if (!record || record.status !== 'pending') throw new Error('Pending checkpoint not found')
        finish(record, 'interrupted')
        return summary(record)
      })
    },
    async restore(id: string) {
      return locked(async () => {
        const record = records().find(record => record.id === id)
        if (!record) throw new Error('Checkpoint not found')
        return restoreRecord(record)
      })
    },
    async restoreStage(stageId: string, sessionId: string) {
      return locked(async () => {
        const selected = records().filter(record => record.stageId === stageId && record.sessionId === sessionId && !record.restores)
        if (!selected.length || selected.some(record => !record.after)) throw new Error('Completed stage not found')
        const before: Snapshot = {}; const after: Snapshot = {}; const seen = new Set<string>()
        for (const record of selected) for (const path of changedPaths(record.before, record.after!)) {
          if (seen.has(path) && !sameEntry(after[path], record.before[path])) throw new Error('Restore conflict: changes from another stage are interleaved')
          if (!seen.has(path) && record.before[path]) before[path] = record.before[path]!
          if (record.after![path]) after[path] = record.after![path]!
          else delete after[path]
          seen.add(path)
        }
        return restoreRecord({ ...selected[0]!, id: `stage:${stageId}`, roots: [...new Set(selected.flatMap(record => record.roots))], before, after })
      })
    },
    prune: () => locked(async () => { prune(); db.exec('VACUUM'); return { ok: true } }),
  }
}
export type ChangeHistory = ReturnType<typeof createChangeHistory>
