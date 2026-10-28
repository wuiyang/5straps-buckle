import type { ChangeKind, RestoreTarget } from '../../domain/effect.js'
import { isInside } from '../../domain/paths.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { requireOwnerOnly, setMode } from '../../adapters/file-modes.js'
import { replaceFile } from '../../adapters/replace-file.js'
import { logger } from '../../runtime/log.js'
import type { UntrustedRoots } from '../../domain/executable.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { applySnapshot, assertSnapshotMatches, changedPaths, notRestorablePaths, sameEntry, SnapshotConflictError, type Entry, type Snapshot } from './snapshot.js'
import { HistoryBusyError, OWNER_LOCK_WAIT_MS, withHistoryLock } from './execution-lock.js'
import { createGitStore, DEFAULT_HISTORY_FILE_BYTES, type CapturedState, type TreeCapture } from './git-store.js'
import { readLegacyHistory } from './legacy.js'
import { checkpointSchema, type Checkpoint } from './records.js'
import { captureHashes, HistoryCaptureSafetyError } from './capture-hashes.js'
import { DEFAULT_HISTORY_KEEP_TURNS, DEFAULT_HISTORY_TURN_IDLE_MS, retainedTurns } from './turn-retention.js'
import { openHistoryActivity } from './activity.js'
export { HistoryBusyError } from './execution-lock.js'

export interface HistoryInput { sessionId: string; stageId?: string | undefined; turnStageId?: string | null; tool: string; requestId?: string; parentRequestId?: string; roots: string[]; excluded?: string[] }
export type CheckpointSummary = ReturnType<typeof summary>
export type RestoreBy = Omit<HistoryInput, 'roots' | 'excluded'>
export const RECENT_CHECKPOINTS_MAX = 100
export type RollbackTarget = RestoreTarget
export interface RollbackPlan { checkpoint: string; head: string; undoes: number; changes: Array<{ path: string; kind: ChangeKind }> }

export class RestoreRefusedError extends Error implements ServiceFailure {
  readonly code = 'RESTORE_REFUSED'
  readonly status = 409
  readonly path: string | undefined
  constructor(message: string, options?: ErrorOptions & { path?: string }) { super(message, options); this.path = options?.path }
}
export function withConflictPath(refusal: { message: string }, shown: string | undefined): string { return shown === undefined ? refusal.message : `${refusal.message} (${shown})` }
export class HistoryRecoveryNeededError extends Error implements ServiceFailure {
  readonly code = 'HISTORY_RECOVERY_NEEDED'
  readonly status = 409
  constructor(readonly checkpoint: string) { super(`Checkpoint ${checkpoint} needs owner recovery; run buckle history recover ${checkpoint}`) }
}
export interface ChangeHistoryOptions {
  directory: string; excluded: string[]; maxBytes: number; retentionDays?: number; label?: string; lockDeadlineMs?: number; now?: () => number; platform?: NodeJS.Platform
  untrusted?: () => UntrustedRoots; allowHostGit?: boolean; keepTurns?: number; turnIdleMs?: number; maxFileBytes?: number; onRecoveryNeeded?: (id: string) => Promise<void>
}
const stateSchema = z.object({ version: z.literal(2), checkpoints: z.array(checkpointSchema), lastGcAt: z.number().default(0) })
type State = z.infer<typeof stateSchema>
const GC_INTERVAL_MS = 3_600_000

export async function openChangeHistory(input: ChangeHistoryOptions) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 }); setMode(input.directory, 0o700); requireOwnerOnly(input.directory, 'directory')
  const file = join(input.directory, 'checkpoints.json')
  const now = input.now ?? Date.now
  const settings = { keepTurns: input.keepTurns ?? DEFAULT_HISTORY_KEEP_TURNS, turnIdleMs: input.turnIdleMs ?? DEFAULT_HISTORY_TURN_IDLE_MS, maxFileBytes: input.maxFileBytes ?? DEFAULT_HISTORY_FILE_BYTES, allowHostGit: input.allowHostGit !== false }
  const store = createGitStore({ directory: input.directory, excluded: input.excluded, maxFileBytes: () => settings.maxFileBytes, allowed: () => settings.allowHostGit, ...(input.untrusted ? { untrusted: input.untrusted } : {}), ...(input.platform ? { platform: input.platform } : {}) })
  let closed = false
  let gc: Promise<void> | undefined
  let gcTimer: ReturnType<typeof setTimeout> | undefined
  const offered = new Set<string>()
  const activity = openHistoryActivity(input.directory)
  let reconcile = true

  function read(): State {
    if (closed) throw new Error('History is closed')
    if (!existsSync(file)) return { version: 2, checkpoints: [], lastGcAt: 0 }
    return stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }
  function records(): Checkpoint[] {
    const current = read().checkpoints
    const ids = new Set(current.map(record => record.id))
    return [...readLegacyHistory(input.directory).filter(record => !ids.has(record.id)), ...current]
  }
  async function save(state: State): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); await replaceFile(temporary, file) }
    finally { rmSync(temporary, { force: true }) }
  }
  async function saveRecord(record: Checkpoint): Promise<void> {
    const state = read()
    const saved = record.status === 'pending' ? { ...record, before: {}, after: undefined } : record
    const index = state.checkpoints.findIndex(item => item.id === record.id)
    if (index === -1) state.checkpoints.push(saved)
    else state.checkpoints[index] = saved
    await save(state)
  }
  function locked<T>(operation: () => Promise<T>, options: { owner?: boolean; force?: boolean; signal?: AbortSignal; immediate?: boolean } = {}): Promise<T> {
    if (closed) return Promise.reject(new Error('History is closed'))
    const deadlineMs = options.immediate ? 0 : options.owner ? Math.min(input.lockDeadlineMs ?? OWNER_LOCK_WAIT_MS, OWNER_LOCK_WAIT_MS) : input.lockDeadlineMs ?? 300_000
    return withHistoryLock({ directory: input.directory, label: input.label ?? 'workspace mutation', deadlineMs, ...(options.signal ? { signal: options.signal } : {}), ...(options.force ? { force: true } : {}) }, operation)
  }
  function offer(error: unknown): void {
    if (!(error instanceof HistoryRecoveryNeededError) || offered.has(error.checkpoint) || !input.onRecoveryNeeded) return
    offered.add(error.checkpoint)
    void input.onRecoveryNeeded(error.checkpoint).catch(() => logger.warn('Inline history recovery could not finish')).finally(() => offered.delete(error.checkpoint))
  }
  function pending(): void {
    const record = records().find(record => record.status === 'pending')
    if (record) { const error = new HistoryRecoveryNeededError(record.id); logger.warn(error.message, { code: error.code }); throw error }
  }
  function observeCall(sessionId: string, stageId?: string): string {
    const existing = records()
    const latest = existing.findLast(record => record.sessionId === sessionId)
    const known = activity.activeTurn(sessionId, stageId) ?? (stageId === undefined ? undefined : existing.find(record => record.sessionId === sessionId && record.turnStageId === stageId)?.turnId)
    const fallback = latest?.turnId ? { at: Date.parse(latest.createdAt), turn: latest.turnId, stage: latest.turnStageId ?? null } : undefined
    return activity.observe({ session: sessionId, at: now(), ...(stageId === undefined ? {} : { stage: stageId }), idleMs: settings.turnIdleMs, ...(known ? { knownTurn: known } : {}), ...(fallback ? { fallback } : {}) })
  }
  function startCall(sessionId: string, stageId?: string): string {
    const turn = observeCall(sessionId, stageId)
    activity.start(sessionId, stageId, turn)
    return turn
  }
  function completeCall(sessionId: string, turn: string): void { activity.complete(sessionId, turn, now()) }
  function finishCall(sessionId: string, stageId: string | undefined, turn: string): void { activity.finish(sessionId, stageId, turn, now()) }
  function latestTrees(): TreeCapture[] { return records().findLast(record => record.afterTrees?.length)?.afterTrees ?? [] }
  async function begin(details: HistoryInput, restore?: { restores: string; undoes?: number }): Promise<Checkpoint> {
    pending()
    const stage = details.turnStageId === undefined ? details.stageId : details.turnStageId ?? undefined
    const turnId = activity.activeTurn(details.sessionId, stage) ?? observeCall(details.sessionId, stage)
    const id = `change-${randomUUID()}`
    let captured: CapturedState
    let baselineAvailable = true
    try { captured = await store.capture({ roots: details.roots, excluded: details.excluded, id, phase: 'before', parents: latestTrees() }) }
    catch (error) { if (error instanceof HistoryCaptureSafetyError) throw error; baselineAvailable = false; captured = { snapshot: {}, trees: [], restorable: false, reason: 'History could not capture the before state; this write continues without restorable content or a complete changed-path list' }; logger.warn(`Checkpoint ${id}: ${captured.reason}`) }
    const record: Checkpoint = { ...details, id, stageId: details.stageId ?? turnId, turnId, turnStageId: stage ?? null, requestId: details.requestId?.slice(0, 200), createdAt: new Date(now()).toISOString(), status: 'pending', baselineAvailable, before: captured.snapshot, beforeTrees: captured.trees, restorable: captured.restorable, ...(captured.reason ? { reason: captured.reason } : {}), ...restore }
    await saveRecord(record)
    return record
  }
  async function finish(record: Checkpoint): Promise<void> {
    try {
      const captured = await store.capture({ roots: record.roots, excluded: record.excluded, id: record.id, phase: 'after', parents: record.beforeTrees })
      record.after = captured.snapshot
      if (!record.baselineAvailable) record.before = captured.snapshot
      record.afterTrees = captured.trees
      record.restorable = record.restorable !== false && captured.restorable
      record.changed = record.baselineAvailable && captured.restorable ? await store.changed(record.beforeTrees ?? [], record.afterTrees) : changedPaths(record.before, record.after)
      record.status = 'complete'
      compact(record)
      await saveRecord(record)
      await pruneRetained(record)
    } catch {
      record.status = 'interrupted'; record.restorable = false
      record.reason = 'History capture did not finish; this checkpoint is not restorable. Later writes can continue'
      compact(record)
      await saveRecord(record)
      logger.warn(`Checkpoint ${record.id}: ${record.reason}`)
    }
  }
  async function pruneRetained(current?: Checkpoint): Promise<void> {
    const state = read()
    const keep = retainedTurns({ records: state.checkpoints, keep: settings.keepTurns })
    const dropped = state.checkpoints.filter(record => record.status !== 'pending' && !keep.has(record.turnId ?? record.id))
    state.checkpoints = state.checkpoints.filter(record => !dropped.includes(record))
    if (store.available && store.bytes() > input.maxBytes && current) {
      const turns = [...new Set(state.checkpoints.map(record => record.turnId ?? record.id))]
      for (const turn of turns) {
        if (turn === current.turnId) continue
        const reachable = await store.reachableBytes(state.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]))
        if (reachable <= input.maxBytes) break
        const remove = state.checkpoints.filter(record => record.turnId === turn && record.status !== 'pending')
        dropped.push(...remove); state.checkpoints = state.checkpoints.filter(record => !remove.includes(record))
      }
    }
    if (store.available) {
      for (const record of dropped) await store.removeRefs(record.id, [...record.beforeTrees ?? [], ...record.afterTrees ?? []])
      const removed = reconcile ? await store.reconcile(state.checkpoints) : false
      if (dropped.length || removed) await store.reparent(state.checkpoints)
      reconcile = false
    } else reconcile = true
    if (store.available && store.bytes() > input.maxBytes) await store.pruneLoose()
    if (store.bytes() > input.maxBytes && current) {
      const retained = state.checkpoints.find(record => record.id === current.id)
      if (retained) {
        retained.restorable = false; current.restorable = false
        retained.reason = current.reason = 'History reached its rolling size cap; this checkpoint records changes without restorable content'
        if (store.available) await store.removeRefs(current.id, [...current.beforeTrees ?? [], ...current.afterTrees ?? []])
        retained.beforeTrees = []; retained.afterTrees = []; current.beforeTrees = []; current.afterTrees = []
        if (store.available) await store.pruneLoose()
        logger.warn(`Checkpoint ${current.id}: ${current.reason}`)
      }
    }
    await save(state)
    scheduleCollection()
  }
  function scheduleCollection(): void {
    if (!store.available || gc || gcTimer || now() - read().lastGcAt < GC_INTERVAL_MS) return
    gcTimer = setTimeout(() => {
      gcTimer = undefined
      if (closed) return
      gc = locked(async () => {
        const state = read()
        if (now() - state.lastGcAt < GC_INTERVAL_MS) return
        const trees = state.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []])
        await store.collect(trees)
        state.lastGcAt = now(); await save(state)
      }, { immediate: true }).catch(error => { if (!(error instanceof HistoryBusyError)) logger.warn('History garbage collection did not finish') }).finally(() => { gc = undefined })
    }, 0)
    gcTimer.unref()
  }
  function since(target: RollbackTarget): Checkpoint[] {
    const recent = records().toReversed().slice(0, 'turns' in target ? undefined : RECENT_CHECKPOINTS_MAX)
    if (recent[0]?.status === 'pending') throw new HistoryRecoveryNeededError(recent[0].id)
    if ('turns' in target) {
      if (!Number.isSafeInteger(target.turns) || target.turns < 1 || target.turns > RECENT_CHECKPOINTS_MAX) throw new RestoreRefusedError('turns counts user turns back from the current state, 1 to 100')
      const turns = [...new Set(recent.map(record => record.turnId ?? record.id))]
      if (turns.length < target.turns) throw new RestoreRefusedError(`The change history holds fewer than ${target.turns} turns`)
      const chosen = turns[target.turns - 1]
      const index = recent.findLastIndex(record => (record.turnId ?? record.id) === chosen)
      return recent.slice(0, index + 1).reverse()
    }
    if ('steps' in target) {
      if (!Number.isSafeInteger(target.steps) || target.steps < 1 || target.steps > RECENT_CHECKPOINTS_MAX) throw new RestoreRefusedError(`steps counts checkpoints back from the current state, 1 to ${RECENT_CHECKPOINTS_MAX}`)
      if (recent.length < target.steps) throw new RestoreRefusedError(`The change history holds ${recent.length} ${recent.length === 1 ? 'checkpoint' : 'checkpoints'}, fewer than the ${target.steps} steps named`)
      return recent.slice(0, target.steps).reverse()
    }
    const index = recent.findIndex(record => record.id === target.id)
    if (index === -1) throw new RestoreRefusedError(`No checkpoint ${target.id} is among the newest ${RECENT_CHECKPOINTS_MAX}; history_list names them`)
    return recent.slice(0, index + 1).reverse()
  }
  async function restoreRecord(record: Checkpoint, by?: RestoreBy, undoes?: number) {
    if (!record.after) throw new RestoreRefusedError('Completed checkpoint not found')
    if (!store.available) throw new RestoreRefusedError('Content restoration requires permitted trusted host git')
    if (record.restorable === false) throw new RestoreRefusedError(record.reason ?? 'Content restoration requires permitted trusted host git')
    const paths = changedPaths(record.before, record.after)
    assertExcludedUntouched(paths, [...input.excluded, ...record.excluded ?? []])
    const restore = await begin({ ...(by ?? { sessionId: record.sessionId, stageId: record.stageId, tool: 'owner_restore' }), roots: record.roots, excluded: record.excluded }, { restores: record.id, undoes })
    let applying = false
    try {
      assertSnapshotMatches({ current: restore.before, expected: record.after, target: record.before, paths, operation: 'Restore' })
      const content = await store.restoreContent({ trees: record.beforeTrees ?? [], target: record.before, paths })
      applying = true
      applySnapshot({ target: record.before, current: restore.before, paths, roots: record.roots, content: hash => { const value = content.get(hash); if (!value) throw new Error('History content is missing'); return value } })
    } catch (error) {
      if (applying) {
        await finish(restore); restore.status = 'interrupted'; restore.reason = 'Restore stopped after some paths may have changed; history_list shows this interrupted checkpoint'; await saveRecord(restore)
        logger.warn(`Checkpoint ${restore.id}: ${restore.reason}`)
        throw new RestoreRefusedError(restore.reason, { cause: error })
      }
      const state = read(); state.checkpoints = state.checkpoints.filter(item => item.id !== restore.id); await save(state)
      await store.removeRefs(restore.id, restore.beforeTrees ?? [])
      if (error instanceof SnapshotConflictError) throw new RestoreRefusedError(error.message, { cause: error, ...(error.path === undefined ? {} : { path: error.path }) })
      throw error
    }
    await finish(restore)
    return { ...summary(restore), notRestorable: notRestorablePaths(record.before, record.after) }
  }
  async function hydrate(record: Checkpoint): Promise<Checkpoint> {
    if (!record.beforeTrees?.length) return record
    record.before = Object.assign({}, ...await Promise.all(record.beforeTrees.map(store.loadTree)))
    return record
  }
  return {
    list: async () => records().map(summary),
    observeCall,
    startCall,
    completeCall,
    finishCall,
    notice: (sessionId: string, requestId: string) => { const found = records().findLast(record => record.sessionId === sessionId && (record.requestId === requestId || record.parentRequestId === requestId)); return found ? summary(found) : null },
    recent: async (count: number) => {
      const found = records().toReversed().slice(0, Math.min(count, RECENT_CHECKPOINTS_MAX) + 1)
      const shown = found.slice(0, count)
      return { checkpoints: shown.map((record, index) => ({ ...summary(record), current: index === 0 && record.status !== 'pending' })), more: found.length > shown.length }
    },
    async plan(target: RollbackTarget): Promise<RollbackPlan> {
      try { return await locked(async () => { const selected = since(target); const unavailable = selected.find(record => record.restorable === false); if (unavailable) throw new RestoreRefusedError(unavailable.reason ?? 'Content restoration requires permitted trusted host git'); return planOf(selected) }, { immediate: true }) }
      catch (error) { if (error instanceof HistoryBusyError) throw new RestoreRefusedError('Another call is changing the files now; try again once it finishes'); offer(error); throw error }
    },
    async rollback(input: { target: RollbackTarget; by: RestoreBy; onLocked?: () => void; check?: (plan: RollbackPlan) => void; signal?: AbortSignal }) {
      return locked(async () => {
        input.onLocked?.()
        const selected = since(input.target); const chain = chained(selected); const plan = planOf(selected, chain)
        input.check?.(plan)
        const first = selected[0]!
        return restoreRecord({ ...first, id: plan.checkpoint, roots: [...new Set(selected.flatMap(record => record.roots))], excluded: [...new Set(selected.flatMap(record => record.excluded ?? []))], ...chain, beforeTrees: selected.flatMap(record => record.beforeTrees ?? []), restorable: selected.every(record => record.restorable !== false) }, input.by, plan.undoes)
      }, { owner: true, ...(input.signal ? { signal: input.signal } : {}) })
    },
    async run<T>(details: HistoryInput, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      try { return await locked(async () => { const record = await begin(details); try { return await execute() } finally { await finish(record); completeCall(record.sessionId, record.turnId!) } }, signal ? { signal } : {}) }
      catch (error) { offer(error); throw error }
    },
    exclusive<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> { return locked(execute, signal ? { signal } : {}) },
    async promote(details: HistoryInput, expected: Snapshot, target: Snapshot, content: (hash: string) => Buffer, onCheckpoint?: () => void) {
      return locked(async () => {
        const paths = changedPaths(expected, target)
        if (!paths.length) return null
        assertExcludedUntouched(paths, details.excluded)
        const current = await captureHashes({ roots: details.roots, excluded: [...input.excluded, ...details.excluded ?? [], input.directory], maxFileBytes: settings.maxFileBytes, hashFiles: true, platform: input.platform ?? process.platform })
        assertSnapshotMatches({ current, expected, target, paths, operation: 'Promotion' })
        const record = await begin(details)
        try { onCheckpoint?.(); applySnapshot({ target, current, paths, content, roots: details.roots }) }
        finally { await finish(record); completeCall(record.sessionId, record.turnId!) }
        return summary(record)
      })
    },
    async recover(id: string, options: { force?: boolean } = {}) {
      return locked(async () => {
        const found = records().find(record => record.id === id)
        if (!found || found.status !== 'pending') throw new Error('Pending checkpoint not found')
        const record = await hydrate(found)
        if (record.legacy) { record.status = 'interrupted'; record.reason = 'Legacy interrupted checkpoint acknowledged; new writes use the git history'; await saveRecord(record) }
        else { await finish(record); record.status = 'interrupted'; await saveRecord(record) }
        return summary(record)
      }, { owner: true, ...options })
    },
    async restore(id: string, options: { force?: boolean } = {}) {
      return locked(async () => { const record = records().find(record => record.id === id); if (!record) throw new Error('Checkpoint not found'); return restoreRecord(record) }, { owner: true, ...options })
    },
    async restoreStage(stageId: string, sessionId: string, options: { force?: boolean } = {}) {
      return locked(async () => {
        const selected = records().filter(record => record.stageId === stageId && record.sessionId === sessionId && !record.restores)
        if (!selected.length || selected.some(record => !record.after)) throw new Error('Completed stage not found')
        let chain
        try { chain = chained(selected) }
        catch (error) { if (error instanceof RestoreRefusedError) throw new RestoreRefusedError('Restore conflict: changes from another stage are interleaved'); throw error }
        return restoreRecord({ ...selected[0]!, id: `stage:${stageId}`, roots: [...new Set(selected.flatMap(record => record.roots))], ...chain, beforeTrees: selected.flatMap(record => record.beforeTrees ?? []) })
      }, { owner: true, ...options })
    },
    prune: (options: { force?: boolean; legacy?: boolean } = {}) => locked(async () => {
      if (options.legacy) { for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(join(input.directory, `history.sqlite${suffix}`), { force: true }); const state = read(); state.checkpoints = state.checkpoints.filter(record => !record.legacy); await save(state) }
      await pruneRetained(); return { ok: true }
    }, { owner: true, ...options }),
    configure(next: Partial<typeof settings>): void { Object.assign(settings, next) },
    capability: () => ({ engine: store.available ? 'git' as const : 'hashes' as const, restorable: store.available, maxFileBytes: settings.maxFileBytes, keepTurns: settings.keepTurns, turnIdleMs: settings.turnIdleMs }),
    async close(): Promise<void> { if (closed) return; if (gcTimer) clearTimeout(gcTimer); await gc; activity.close(); closed = true },
  }
}
export type ChangeHistory = Awaited<ReturnType<typeof openChangeHistory>>

function summary(record: Checkpoint) {
  return { id: record.id, sessionId: record.sessionId, stageId: record.stageId, turnId: record.turnId ?? record.stageId, tool: record.tool, requestId: record.requestId, createdAt: record.createdAt, status: record.status, reason: record.reason, restores: record.restores, undoes: record.undoes, restorable: record.restorable !== false, legacy: record.legacy, paths: record.after ? changedPaths(record.before, record.after) : [], changed: record.changed ?? [], changes: record.after ? changesOf(record.before, record.after) : [], notRestorable: record.after ? notRestorablePaths(record.before, record.after) : [] }
}
function compact(record: Checkpoint): void {
  if (!record.after) { record.before = {}; return }
  const paths = [...changedPaths(record.before, record.after), ...notRestorablePaths(record.before, record.after)]
  const selected = new Set(paths)
  for (const path of paths) for (const root of record.roots) if (isInside(root, path)) { let at = path; while (at !== root && at.includes('/')) { at = at.slice(0, at.lastIndexOf('/')) || '/'; selected.add(at); if (at === '/') break } }
  record.before = Object.fromEntries(Object.entries(record.before).filter(([path]) => selected.has(path)))
  record.after = Object.fromEntries(Object.entries(record.after).filter(([path]) => selected.has(path)))
}
function changesOf(before: Snapshot, after: Snapshot): Array<{ path: string; kind: ChangeKind }> { return changedPaths(before, after).map(path => ({ path, kind: !before[path] ? 'created' : !after[path] ? 'deleted' : 'modified' })) }
function assertExcludedUntouched(paths: string[], excluded: string[] = []): void { if (paths.some(path => excluded.some(hidden => isInside(path, hidden) || isInside(hidden, path)))) throw new Error('Changes overlap a protected file or its parent directory') }
function planOf(selected: Checkpoint[], chain = chained(selected)): RollbackPlan { return { checkpoint: selected[0]!.id, head: selected.at(-1)!.id, undoes: selected.length, changes: changesOf(chain.before, chain.after) } }
function chained(selected: Checkpoint[]): { before: Snapshot; after: Snapshot } {
  const base: Snapshot = {}; for (const record of selected) Object.assign(base, record.before, record.after)
  const first = new Map<string, Entry | undefined>(); const last = new Map<string, Entry | undefined>()
  for (const record of selected) {
    if (!record.after) throw new RestoreRefusedError('A checkpoint among those it undoes never completed, so nothing is restored')
    const restorablePaths = changedPaths(record.before, record.after)
    for (const path of [...restorablePaths, ...notRestorablePaths(record.before, record.after)]) {
      if (restorablePaths.includes(path) && last.has(path) && !sameEntry(last.get(path), record.before[path])) throw new RestoreRefusedError('Restore conflict: a file changed outside Buckle between two of the checkpoints this restore undoes', { path })
      if (!first.has(path)) first.set(path, record.before[path]); last.set(path, record.after[path])
    }
  }
  const before: Snapshot = { ...base }; const after: Snapshot = { ...base }
  for (const [path, entry] of first) { if (entry) before[path] = entry; else delete before[path] }
  for (const [path, entry] of last) { if (entry) after[path] = entry; else delete after[path] }
  return { before, after }
}
