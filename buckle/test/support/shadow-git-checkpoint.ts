import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { createGitStore } from '../../common/services/history/git-store.js'
import type { Checkpoint } from '../../common/services/history/records.js'
import { changedPaths, notRestorablePaths } from '../../common/services/history/snapshot.js'

/**
 * Writes one checkpoint as the shadow-git engine of 670f1dc2 did: the whole of `roots` captured in shadow git before and
 * after `execute`, the trees in `beforeTrees` and `afterTrees`. Since Slice F2 no call makes one, but stores written
 * before it hold them, and history still lists, keeps, migrates, and restores them (item 7).
 */
export async function shadowGitCheckpoint<T>(input: { directory: string; roots: string[]; sessionId: string; stageId: string; tool?: string; turnId?: string; maxFileBytes?: number; execute: () => T | Promise<T> }): Promise<Checkpoint> {
  const store = createGitStore({ directory: input.directory, excluded: [], maxFileBytes: () => input.maxFileBytes ?? 32 * 1_048_576, allowed: () => true })
  const id = `change-${randomUUID()}`
  const before = await store.capture({ roots: input.roots, id, phase: 'before' })
  await input.execute()
  {
    const after = await store.capture({ roots: input.roots, id, phase: 'after', parents: before.trees })
    const record: Checkpoint = {
      id, sessionId: input.sessionId, stageId: input.stageId, tool: input.tool ?? 'test', turnId: input.turnId ?? `turn-${input.stageId}`, turnStageId: input.stageId,
      createdAt: new Date().toISOString(), status: 'complete', baselineAvailable: true, roots: input.roots, before: before.snapshot, beforeTrees: before.trees,
      after: after.snapshot, afterTrees: after.trees, restorable: before.restorable && after.restorable, changed: await store.changed(before.trees, after.trees),
    }
    const kept = new Set([...changedPaths(record.before, record.after!), ...notRestorablePaths(record.before, record.after!)])
    record.before = Object.fromEntries(Object.entries(record.before).filter(([path]) => kept.has(path)))
    record.after = Object.fromEntries(Object.entries(record.after!).filter(([path]) => kept.has(path)))
    const file = join(input.directory, 'checkpoints.json')
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 2, checkpoints: [], lastGcAt: 0 }
    state.checkpoints.push(record)
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
    return record
  }
}
