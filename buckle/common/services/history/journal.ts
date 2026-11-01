import { RuntimeError } from '@5straps/runtime'
import { SqliteErrorCode } from '@5straps/runtime/sqlite'
import type { ChangeKind, RestoreTarget } from '../../domain/effect.js'
import { isInside, parentDirectory } from '../../domain/paths.js'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { requireOwnerOnly, setMode } from '../../adapters/file-modes.js'
import { replaceFile } from '../../adapters/replace-file.js'
import { logger } from '../../runtime/log.js'
import type { UntrustedRoots } from '../../domain/executable.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { applySnapshot, assertSnapshotMatches, changedPaths, notRestorablePaths, sameEntry, SnapshotConflictError, type Entry, type Snapshot } from './snapshot.js'
import { HistoryBusyError, OWNER_LOCK_WAIT_MS, withHistoryLock } from './execution-lock.js'
import { createGitStore, DEFAULT_HISTORY_FILE_BYTES, HistoryGitError } from './git-store.js'
import { readLegacyHistory } from './legacy.js'
import { checkpointSchema, type Checkpoint } from './records.js'
import { HistoryCaptureSafetyError } from './capture-hashes.js'
import { createCommandCapture, FolderReplacedError, HostGitNeededError, type CommandBaseline } from './command-capture.js'
import { DEFAULT_HISTORY_KEEP_TURNS, DEFAULT_HISTORY_TURN_IDLE_MS, retainedTurns } from './turn-retention.js'
import { openHistoryActivity } from './activity.js'
import { blobId, HistoryContentError, openObjectStore } from './object-store.js'
import { captureScope, missingParents, unknownChildren, type ScopePath } from './scoped-capture.js'
export { HistoryBusyError } from './execution-lock.js'

/**
 * `scope`: the paths the call changes, where its tool names every one (a file tool, Slice F2 item 1). The checkpoint then
 * records those paths alone, content in the object store, with no walk of `roots` and no git. Absent, the call is a
 * command (item 3): each folder among `roots` is captured through git's own index and the workspace's ignore rules, and
 * any other root as a scoped path.
 */
export interface HistoryInput { sessionId: string; stageId?: string | undefined; turnStageId?: string | null; tool: string; requestId?: string; parentRequestId?: string; roots: string[]; excluded?: string[]; scope?: ScopePath[] }
export type CheckpointSummary = ReturnType<typeof summary>
export type RestoreBy = Omit<HistoryInput, 'roots' | 'excluded' | 'scope'>
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
export interface ChangeHistoryOptions {
  directory: string; excluded: string[]; maxBytes: number; retentionDays?: number; label?: string; lockDeadlineMs?: number; now?: () => number; platform?: NodeJS.Platform
  untrusted?: () => UntrustedRoots; allowHostGit?: boolean; keepTurns?: number; turnIdleMs?: number; maxFileBytes?: number
}
/** The reason a checkpoint a stopped call left pending is given once the next call takes the lock (Slice F2, item 6). */
export const STOPPED_REASON = 'Buckle stopped before this call finished, so history could not record what it changed; this checkpoint is not restorable'
/** A command's checkpoint where host git is not permitted: the command runs, and nothing it changes is listed (item 3). */
export const HOST_GIT_REASON = 'Not restorable: host git needed. History reads what a command changes through permitted trusted host git, so this call ran without a checkpoint of its changes'
const PARTIAL_REASON = 'Git could not read some files this command may have changed; history does not list their changes'
const CAP_REASON = 'History reached its rolling size cap; this checkpoint records changes without restorable content'
/** A checkpoint the shadow-git engine of 670f1dc2 wrote keeps its content in that store, which only git reads (Slice F2, item 7). */
export const OLD_ENGINE_REASON = 'This checkpoint is from the earlier shadow-git history, whose content only permitted trusted host git can read; this node has none, so it cannot be restored'
/** How many turns of new checkpoints the stores written before the object store outlive (item 7). */
export const OLD_STORE_TURNS = 10
/** Those stores, in a workspace's history folder: shadow git (670f1dc2) and the SQLite history before it. */
const OLD_STORES = ['git', 'roots', 'git-private', ...['', '-wal', '-shm', '-journal'].map(suffix => `history.sqlite${suffix}`)]
/** `oldStoreTurns`: the turns of new checkpoints recorded while an old store is left, up to OLD_STORE_TURNS. */
const stateSchema = z.object({ version: z.literal(2), checkpoints: z.array(checkpointSchema), lastGcAt: z.number().default(0), oldStoreTurns: z.array(z.string()).optional() })
type State = z.infer<typeof stateSchema>
const GC_INTERVAL_MS = 3_600_000

export async function openChangeHistory(input: ChangeHistoryOptions) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 }); setMode(input.directory, 0o700); requireOwnerOnly(input.directory, 'directory')
  const file = join(input.directory, 'checkpoints.json')
  const now = input.now ?? Date.now
  const settings = { keepTurns: input.keepTurns ?? DEFAULT_HISTORY_KEEP_TURNS, turnIdleMs: input.turnIdleMs ?? DEFAULT_HISTORY_TURN_IDLE_MS, maxFileBytes: input.maxFileBytes ?? DEFAULT_HISTORY_FILE_BYTES, allowHostGit: input.allowHostGit !== false }
  const objects = openObjectStore(input.directory)
  const scopeLimits = () => ({ maxFileBytes: settings.maxFileBytes, maxTreeBytes: input.maxBytes, excluded: [...input.excluded, input.directory], ...(input.platform ? { platform: input.platform } : {}) })
  const store = createGitStore({ directory: input.directory, excluded: input.excluded, maxFileBytes: () => settings.maxFileBytes, allowed: () => settings.allowHostGit, ...(input.untrusted ? { untrusted: input.untrusted } : {}), ...(input.platform ? { platform: input.platform } : {}) })
  const commands = createCommandCapture({ directory: input.directory, objects, excluded: () => [...input.excluded, input.directory], allowed: () => settings.allowHostGit, maxFileBytes: () => settings.maxFileBytes, ...(input.untrusted ? { untrusted: input.untrusted } : {}) })
  /** Each running command's state before it ran, by checkpoint, until its finish reads what changed. */
  const baselines = new Map<string, CommandBaseline[]>()
  /** Each stored object's bytes on disk, as its id names one content for good: read once, then kept. */
  const sizes = new Map<string, number>()
  /** The newest checkpoints the journal could not take, for their calls' notices. */
  const unsaved = new Map<string, Checkpoint>()
  let closed = false
  let gc: Promise<void> | undefined
  let gcTimer: ReturnType<typeof setTimeout> | undefined
  const activity = await openHistoryActivity(input.directory)
  let reconcile = true
  /** Set once no old store is left on disk: nothing writes one any more, so none comes back (item 7). */
  let oldStoresGone = false

  // The journal as last validated, keyed by its file's identity on disk: a call reads it several times, and another
  // process replaces it by rename, which changes the key (B12). Each read still hands out its own copy.
  let journal: { key: string; text: string } | undefined
  let legacy: { key: string; records: Checkpoint[] } | undefined
  function read(): State {
    if (closed) throw new RuntimeError(SqliteErrorCode.ownerClosed, 'History is closed')
    const key = identity(file)
    if (key === undefined) return { version: 2, checkpoints: [], lastGcAt: 0 }
    if (journal?.key === key) return JSON.parse(journal.text) as State
    const state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (identity(file) === key) journal = { key, text: JSON.stringify(state) }
    return state
  }
  function legacyRecords(): Checkpoint[] {
    const key = ['', '-wal'].map(suffix => identity(join(input.directory, `history.sqlite${suffix}`)) ?? '-').join('|')
    if (legacy?.key !== key) legacy = { key, records: key === '-|-' ? [] : readLegacyHistory(input.directory) }
    return legacy.records.map(record => structuredClone(record))
  }
  function records(): Checkpoint[] {
    const current = read().checkpoints
    const ids = new Set(current.map(record => record.id))
    return [...legacyRecords().filter(record => !ids.has(record.id)), ...current]
  }
  async function save(state: State): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    const text = JSON.stringify(state)
    try { writeFileSync(temporary, text, { mode: 0o600 }); await replaceFile(temporary, file) }
    finally { rmSync(temporary, { force: true }) }
    const key = identity(file)
    journal = key === undefined ? undefined : { key, text }
  }
  async function saveRecord(record: Checkpoint): Promise<void> {
    const state = read()
    // A shadow-git checkpoint's before state is in its trees; a scoped one's is the record itself, which recovery reads.
    const saved = record.status === 'pending' && record.content !== 'blobs' ? { ...record, before: {}, after: undefined } : record
    const index = state.checkpoints.findIndex(item => item.id === record.id)
    if (index === -1) state.checkpoints.push(saved)
    else state.checkpoints[index] = saved
    await save(state)
  }
  async function repairRefs(state: State): Promise<void> {
    reconcile = true
    await store.reconcile(state.checkpoints)
    reconcile = false
  }
  function locked<T>(operation: () => Promise<T>, options: { owner?: boolean; force?: boolean; signal?: AbortSignal; immediate?: boolean } = {}): Promise<T> {
    if (closed) return Promise.reject(new RuntimeError(SqliteErrorCode.ownerClosed, 'History is closed'))
    const deadlineMs = options.immediate ? 0 : options.owner ? Math.min(input.lockDeadlineMs ?? OWNER_LOCK_WAIT_MS, OWNER_LOCK_WAIT_MS) : input.lockDeadlineMs ?? 300_000
    return withHistoryLock({ directory: input.directory, label: input.label ?? 'workspace mutation', deadlineMs, ...(options.signal ? { signal: options.signal } : {}), ...(options.force ? { force: true } : {}) }, async () => {
      try { await settleStopped() } catch (error) { logger.warn('History could not mark the checkpoints a stopped call left; the call runs', { cause: causeOf(error) }) }
      return operation()
    })
  }
  /**
   * Marks each checkpoint left pending interrupted, with its reason (Slice F2, item 6): one seen while this process holds
   * the execution lock belongs to a call that stopped, as no live call can hold it, so nothing waits on the owner and no
   * call is ever refused for it (A3).
   */
  async function settleStopped(): Promise<void> {
    const stopped = records().filter(record => record.status === 'pending')
    if (!stopped.length) return
    const state = read()
    for (const record of stopped) {
      const settled = { ...record, status: 'interrupted' as const, restorable: false, reason: STOPPED_REASON }
      const index = state.checkpoints.findIndex(item => item.id === record.id)
      if (index === -1) state.checkpoints.push(settled)
      else state.checkpoints[index] = settled
      logger.warn(`Checkpoint ${record.id}: ${STOPPED_REASON}`)
    }
    await save(state)
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
  async function begin(details: HistoryInput, restore?: { restores: string; undoes?: number }): Promise<Checkpoint> {
    if (details.scope) return beginScoped({ ...details, scope: details.scope }, restore)
    const stage = details.turnStageId === undefined ? details.stageId : details.turnStageId ?? undefined
    const turnId = activity.activeTurn(details.sessionId, stage) ?? observeCall(details.sessionId, stage)
    const id = `change-${randomUUID()}`
    const { folders, others } = commandRoots(details.roots)
    let before: Snapshot = {}
    let reason: string | undefined
    try { before = await captureScope({ scope: others, store: objects, ...scopeLimits() }) }
    catch (error) { reason = `History could not record the files before this command (${causeText(error)}); it ran without restorable content`; logger.warn(`Checkpoint ${id}: ${reason}`, { phase: 'before', cause: causeOf(error) }) }
    if (reason === undefined && folders.length) {
      try { baselines.set(id, await commands.baseline(folders)) }
      catch (error) {
        if (error instanceof HostGitNeededError) reason = HOST_GIT_REASON
        else { reason = `History could not record the files before this command (${causeText(error)}); it ran without restorable content`; logger.warn(`Checkpoint ${id}: ${reason}`, { phase: 'before', cause: causeOf(error) }) }
      }
    }
    const record: Checkpoint = { ...details, id, stageId: details.stageId ?? turnId, turnId, turnStageId: stage ?? null, requestId: details.requestId?.slice(0, 200), createdAt: new Date(now()).toISOString(), status: 'pending', baselineAvailable: reason === undefined, before, restorable: reason === undefined, ...(reason ? { reason } : {}), content: 'blobs', scope: others, ...restore }
    await savePending(record)
    return record
  }
  async function beginScoped(details: HistoryInput & { scope: ScopePath[] }, restore?: { restores: string; undoes?: number }): Promise<Checkpoint> {
    const stage = details.turnStageId === undefined ? details.stageId : details.turnStageId ?? undefined
    const turnId = activity.activeTurn(details.sessionId, stage) ?? observeCall(details.sessionId, stage)
    const id = `change-${randomUUID()}`
    let before: Snapshot = {}
    let reason: string | undefined
    try { before = await captureScope({ scope: details.scope, store: objects, ...scopeLimits() }) }
    catch (error) { reason = `History could not record the files before this call (${causeText(error)}); it ran without restorable content`; logger.warn(`Checkpoint ${id}: ${reason}`, { phase: 'before', cause: causeOf(error) }) }
    const record: Checkpoint = { ...details, id, stageId: details.stageId ?? turnId, turnId, turnStageId: stage ?? null, requestId: details.requestId?.slice(0, 200), createdAt: new Date(now()).toISOString(), status: 'pending', baselineAvailable: reason === undefined, before, restorable: reason === undefined, ...(reason ? { reason } : {}), content: 'blobs', ...restore }
    await savePending(record)
    return record
  }
  async function finishScoped(record: Checkpoint): Promise<void> {
    const baseline = baselines.get(record.id)
    baselines.delete(record.id)
    try {
      const after = await captureScope({ scope: record.scope ?? [], store: objects, ...scopeLimits() })
      if (!record.baselineAvailable) record.before = after
      record.after = after
      if (baseline) {
        const found = await commands.changes(baseline, priorEntry(record.id))
        Object.assign(record.before, found.before); Object.assign(after, found.after)
        if (found.ignored) record.ignored = found.ignored
        if (found.partial) { record.reason ??= PARTIAL_REASON; logger.warn(`Checkpoint ${record.id}: ${PARTIAL_REASON}`, { phase: 'after' }) }
      }
      record.changed = changedPaths(record.before, after)
      record.status = 'complete'
    } catch (error) {
      record.after ??= record.before
      record.status = 'interrupted'; record.restorable = false
      record.reason = `History could not record the files after this call (${causeText(error)}); this checkpoint is not restorable. Later writes can continue`
      logger.warn(`Checkpoint ${record.id}: ${record.reason}`, { phase: 'after', cause: causeOf(error) })
    }
    compact(record)
    // One journal write: the finished checkpoint, with the turns retention drops beside it (item 5).
    try { await pruneRetained(record) }
    catch (error) {
      logger.warn('History could not drop its oldest turns; it tries again after the next write', { cause: causeOf(error) })
      try { if (read().checkpoints.find(saved => saved.id === record.id)?.status !== record.status) await saveRecord(record) }
      catch (failure) { unsavedRecord(record, failure) }
    }
  }
  /** A checkpoint saved as its call begins; where the journal cannot take it, the call runs all the same (item 6). */
  async function savePending(record: Checkpoint): Promise<void> {
    try { await saveRecord(record) }
    catch (error) { logger.warn(`Checkpoint ${record.id}: history could not save it as the call began; the call runs`, { cause: causeOf(error) }) }
  }
  /** A finished checkpoint the journal could not take: the call's notice names why, and the owner's log the cause (D2). */
  function unsavedRecord(record: Checkpoint, error: unknown): void {
    record.restorable = false
    record.reason = `History could not save this call's checkpoint (${causeText(error)}); the call ran without one`
    unsaved.set(record.id, record)
    while (unsaved.size > RECENT_CHECKPOINTS_MAX) unsaved.delete(unsaved.keys().next().value!)
    logger.warn(`Checkpoint ${record.id}: history could not save it; the call ran without one`, { cause: causeOf(error) })
  }
  /** Every checkpoint this journal begins records content in the object store (Slice F2, items 1 and 3). */
  function finish(record: Checkpoint): Promise<void> { return finishScoped(record) }
  /**
   * The entry the newest earlier checkpoint left at a path: a command's before side takes its mode from there, as git
   * keeps only 644 and 755, so a checkpoint chain reads one state the same from both sides.
   */
  function priorEntry(current: string): (path: string) => Entry | undefined {
    const earlier = read().checkpoints.filter(record => record.id !== current && record.status === 'complete').reverse()
    return path => earlier.find(record => record.after?.[path] !== undefined)?.after?.[path]
  }
  /**
   * Retention (Slice F2, item 5), with `current` the checkpoint a call just finished, saved here in the same write. Keeps
   * the newest turns; over the rolling cap, which counts the content retained checkpoints name and never the copy git
   * keeps for the next command, it drops whole oldest turns, never the current one. A current checkpoint that does not
   * fit is saved with its paths and no content. Then it deletes the objects nothing names. A retained checkpoint is
   * never rewritten, and the workspace is never read (B2, A9).
   */
  async function pruneRetained(current?: Checkpoint): Promise<void> {
    const state = read()
    if (current) {
      const index = state.checkpoints.findIndex(record => record.id === current.id)
      if (index === -1) state.checkpoints.push(current)
      else state.checkpoints[index] = current
    }
    const keep = retainedTurns({ records: state.checkpoints, keep: settings.keepTurns })
    const dropped = state.checkpoints.filter(record => record.status !== 'pending' && record !== current && !keep.has(turnOf(record)))
    state.checkpoints = state.checkpoints.filter(record => !dropped.includes(record))
    const expired = current !== undefined && expireOldStores(state, current)
    let capped = false
    if (current && current.restorable !== false && heldBytes([current]) > input.maxBytes) capped = true
    else for (const turn of [...new Set(state.checkpoints.map(turnOf))]) {
      if (heldBytes(state.checkpoints) <= input.maxBytes) break
      if (turn === (current && turnOf(current))) continue
      const remove = state.checkpoints.filter(record => turnOf(record) === turn && record.status !== 'pending')
      dropped.push(...remove); state.checkpoints = state.checkpoints.filter(record => !remove.includes(record))
    }
    if (current && current.restorable !== false && (capped || heldBytes(state.checkpoints) > input.maxBytes)) {
      current.restorable = false; current.reason = CAP_REASON; capped = true
      logger.warn(`Checkpoint ${current.id}: ${CAP_REASON}`)
    }
    // A checkpoint the shadow-git engine wrote keeps its content there, pinned by its refs, until its turn drops (item 7):
    // its commits are moved to the graph that engine settled on, published, and only then are refs changed.
    const shadow = !expired && store.available && (state.checkpoints.some(hasTrees) || dropped.some(hasTrees))
    if (shadow && await store.isolate(state.checkpoints)) reconcile = true
    if (dropped.some(hasTrees)) reconcile = true
    if (current || dropped.length || shadow && reconcile) await save(state)
    if (shadow && reconcile) await repairRefs(state)
    if (dropped.length || capped) sweepBlobs(state)
    scheduleCollection(state)
  }
  /** Whether a store written before the object store is left: a checkpoint of one in the journal, or its files (item 7). */
  function oldStoresLeft(state: State): boolean {
    if (state.checkpoints.some(isOldRecord)) return true
    if (!oldStoresGone) oldStoresGone = !OLD_STORES.some(name => lstatSync(join(input.directory, name), { throwIfNoEntry: false }))
    return !oldStoresGone
  }
  /**
   * The old stores outlive OLD_STORE_TURNS turns of new checkpoints (item 7), counted in `state` as `current` finishes,
   * whatever retention keeps. Then their checkpoints leave the journal and their folders are deleted, with no git. A
   * deletion that fails keeps the count, so the next write tries again. Answers whether the old checkpoints left.
   */
  function expireOldStores(state: State, current: Checkpoint): boolean {
    if (!oldStoresLeft(state)) { delete state.oldStoreTurns; return false }
    const turns = [...new Set([...state.oldStoreTurns ?? [], turnOf(current)])]
    state.oldStoreTurns = turns
    if (turns.length < OLD_STORE_TURNS) return false
    state.checkpoints = state.checkpoints.filter(record => !isOldRecord(record))
    try {
      for (const name of OLD_STORES) rmSync(join(input.directory, name), { recursive: true, force: true })
      delete state.oldStoreTurns; oldStoresGone = true
      logger.info(`History deleted the stores of its earlier engines after ${OLD_STORE_TURNS} turns of new checkpoints`)
    } catch (error) { logger.warn('History could not delete the stores of its earlier engines; it tries again after the next write', { cause: causeOf(error) }) }
    return true
  }
  /** The bytes on disk of the content the restorable checkpoints among `records` name, each object once. */
  function heldBytes(records: Checkpoint[]): number {
    let bytes = 0
    for (const id of namedObjects(records)) {
      let size = sizes.get(id)
      if (size === undefined) { size = objects.stored(id) ?? 0; sizes.set(id, size) }
      bytes += size
    }
    return bytes
  }
  /** The objects a restore of a retained checkpoint reads: each file's content where its checkpoint is restorable. */
  function namedObjects(records: Checkpoint[]): Set<string> {
    const named = new Set<string>()
    for (const record of records) {
      if (record.content !== 'blobs' || record.status !== 'pending' && record.restorable === false) continue
      for (const entry of [...Object.values(record.before), ...Object.values(record.after ?? {})]) if (entry.kind === 'file' && entry.hash) named.add(entry.hash)
    }
    return named
  }
  /**
   * Removes each object no restorable checkpoint names and no shadow index reuses for the next command's before state:
   * a dropped turn's content, an over-cap file's, and the trees git wrote. An index history cannot read removes nothing.
   */
  function sweepBlobs(state: State): void {
    const indexed = commands.indexed()
    if (indexed === undefined) { logger.warn('History keeps every stored object: a command index is in a form it cannot read'); return }
    const named = namedObjects(state.checkpoints)
    for (const id of objects.list()) if (!named.has(id) && !indexed.has(id)) { objects.remove(id); sizes.delete(id) }
  }
  /** The shadow-git store's hourly collection, while one is left: the object store needs none (item 7). */
  function scheduleCollection(state: State): void {
    if (gc || gcTimer || now() - state.lastGcAt < GC_INTERVAL_MS || !oldStoresLeft(state) || !store.available) return
    gcTimer = setTimeout(() => {
      gcTimer = undefined
      if (closed) return
      gc = locked(async () => {
        const state = read()
        if (now() - state.lastGcAt < GC_INTERVAL_MS) return
        const trees = state.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []])
        // An attempt counts whether or not it finishes, so a failing collection waits its interval, not the next write (A9).
        try { await repairRefs(state); await store.collect(trees) }
        finally { const saved = read(); saved.lastGcAt = now(); await save(saved) }
      }, { immediate: true }).catch(error => { if (!(error instanceof HistoryBusyError)) logger.warn('History garbage collection did not finish; it tries again in an hour', { cause: causeOf(error) }) }).finally(() => { gc = undefined })
    }, 0)
    gcTimer.unref()
  }
  function since(target: RollbackTarget): Checkpoint[] {
    const recent = records().toReversed().slice(0, 'turns' in target ? undefined : RECENT_CHECKPOINTS_MAX)
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
  /**
   * Puts `record`'s paths back as they were before it (item 2): only the paths it changed, each read from the disk now
   * and required to stand as the newest checkpoint left it, or the restore is refused naming that path. No ignore rule
   * decides what is written or removed. The restore is a scoped checkpoint of its own, so it can be undone.
   */
  async function restoreRecord(record: Checkpoint, by?: RestoreBy, undoes?: number) {
    if (!record.after) throw new RestoreRefusedError('Completed checkpoint not found')
    if (record.restorable === false) throw new RestoreRefusedError(record.reason ?? 'Content restoration requires permitted trusted host git')
    const paths = changedPaths(record.before, record.after)
    assertExcludedUntouched(paths, [...input.excluded, ...record.excluded ?? []])
    assertShadowReachable(record, paths)
    const restore = await beginScoped({ ...(by ?? { sessionId: record.sessionId, stageId: record.stageId, tool: 'owner_restore' }), roots: record.roots, ...(record.excluded ? { excluded: record.excluded } : {}), scope: restoreScope(paths, record) }, { restores: record.id, undoes })
    let applying = false
    try {
      if (!restore.baselineAvailable) throw new RestoreRefusedError('History could not read the files this restore would change, so nothing was restored')
      const current = withRemovedChildren({ current: restore.before, expected: record.after, target: record.before, paths })
      assertSnapshotMatches({ current, expected: record.after, target: record.before, paths, operation: 'Restore' })
      const content = await restoredContent(record, paths)
      applying = true
      applySnapshot({ target: record.before, current, paths, roots: record.roots, content: hash => { const value = content.get(hash); if (!value) throw new Error('History content is missing'); return value } })
    } catch (error) {
      if (applying) {
        await finish(restore); restore.status = 'interrupted'; restore.restorable = false; restore.reason = 'Restore stopped after some paths may have changed; history_list shows this interrupted checkpoint'; await saveRecord(restore)
        logger.warn(`Checkpoint ${restore.id}: ${restore.reason}`)
        throw new RestoreRefusedError(restore.reason, { cause: error })
      }
      const state = read(); state.checkpoints = state.checkpoints.filter(item => item.id !== restore.id); await save(state)
      sweepBlobs(state)
      if (error instanceof SnapshotConflictError) throw new RestoreRefusedError(error.message, { cause: error, ...(error.path === undefined ? {} : { path: error.path }) })
      throw error
    }
    await finish(restore)
    return { ...summary(restore), notRestorable: notRestorablePaths(record.before, record.after) }
  }
  /**
   * A checkpoint made before the object store keeps its content in shadow git (item 7): a restore of one goes through
   * that store, so it needs permitted host git, even where none of its content is put back, and says so before any ask.
   */
  function assertShadowReachable(record: Checkpoint, paths: string[]): void {
    if (record.beforeTrees?.length && !store.available) throw new RestoreRefusedError(OLD_ENGINE_REASON)
    const needed = paths.find(path => { const entry = record.before[path]; return entry?.kind === 'file' && entry.hash !== undefined && !objects.has(entry.hash) })
    if (needed !== undefined && !record.beforeTrees?.length) throw new RestoreRefusedError('History content for a path this restore puts back is missing, so nothing was restored', { path: needed })
  }
  /** A checkpoint as the owner and the agent list it: a shadow-git one reads as not restorable where host git is not permitted now. */
  function listedAs(): (record: Checkpoint) => Checkpoint {
    const available = store.available
    return record => available || !record.beforeTrees?.length || record.restorable === false ? record : { ...record, restorable: false, reason: OLD_ENGINE_REASON }
  }
  /** Each file a restore writes, read back and checked against the id its checkpoint recorded: from the object store, else shadow git. */
  async function restoredContent(record: Checkpoint, paths: string[]): Promise<Map<string, Buffer>> {
    const content = new Map<string, Buffer>()
    const shadow: string[] = []
    for (const path of paths) {
      const hash = record.before[path]?.kind === 'file' ? record.before[path]!.hash : undefined
      if (hash === undefined || content.has(hash)) continue
      if (!objects.has(hash)) { shadow.push(path); continue }
      try { content.set(hash, await objects.read(hash)) }
      catch (error) { if (error instanceof HistoryContentError) throw new RestoreRefusedError('History content for a path this restore puts back is missing or damaged, so nothing was restored', { cause: error, path }); throw error }
    }
    if (shadow.length) for (const [hash, value] of await store.restoreContent({ trees: record.beforeTrees ?? [], target: record.before, paths: shadow })) {
      if (!matchesObject(hash, value)) throw new RestoreRefusedError('History content no longer matches its checkpoint, so nothing was restored')
      content.set(hash, value)
    }
    return content
  }
  /** The current state of each path a restore would change, read from the disk without storing anything: its plan's check. */
  async function assertCurrentMatches(chain: { before: Snapshot; after: Snapshot }): Promise<void> {
    const paths = changedPaths(chain.before, chain.after)
    const read = await captureScope({ scope: restoreScope(paths, chain), ...scopeLimits() })
    try { assertSnapshotMatches({ current: withRemovedChildren({ current: read, expected: chain.after, target: chain.before, paths }), expected: chain.after, target: chain.before, paths, operation: 'Restore' }) }
    catch (error) { if (error instanceof SnapshotConflictError) throw new RestoreRefusedError(error.message, { cause: error, ...(error.path === undefined ? {} : { path: error.path }) }); throw error }
  }
  return {
    list: async () => { const view = listedAs(); return records().map(record => summary(view(record))) },
    observeCall,
    startCall,
    completeCall,
    finishCall,
    notice: (sessionId: string, requestId: string) => {
      const matches = (record: Checkpoint) => record.sessionId === sessionId && (record.requestId === requestId || record.parentRequestId === requestId)
      const found = [...unsaved.values()].findLast(matches) ?? records().findLast(matches)
      return found ? summary(found) : null
    },
    recent: async (count: number) => {
      const found = records().toReversed().slice(0, Math.min(count, RECENT_CHECKPOINTS_MAX) + 1)
      const shown = found.slice(0, count)
      const view = listedAs()
      return { checkpoints: shown.map((record, index) => ({ ...summary(view(record)), current: index === 0 && record.status !== 'pending' })), more: found.length > shown.length }
    },
    async plan(target: RollbackTarget): Promise<RollbackPlan> {
      try {
        return await locked(async () => {
          const selected = since(target)
          const unavailable = selected.find(record => record.restorable === false)
          if (unavailable) throw new RestoreRefusedError(unavailable.reason ?? 'Content restoration requires permitted trusted host git')
          const chain = chained(selected)
          assertShadowReachable({ ...selected[0]!, ...chain, beforeTrees: selected.flatMap(record => record.beforeTrees ?? []) }, changedPaths(chain.before, chain.after))
          await assertCurrentMatches(chain)
          return planOf(selected, chain)
        }, { immediate: true })
      }
      catch (error) { if (error instanceof HistoryBusyError) throw new RestoreRefusedError('Another call is changing the files now; try again once it finishes'); throw error }
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
    run<T>(details: HistoryInput, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return locked(async () => { const record = await begin(details); try { return await execute() } finally { await finish(record); completeCall(record.sessionId, record.turnId!) } }, signal ? { signal } : {})
    },
    exclusive<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> { return locked(execute, signal ? { signal } : {}) },
    /**
     * Puts a copy's changes into the folder (the isolated shell, a workbench): it names every path it changes, so its
     * checkpoint records those alone, as a file tool's does, with no walk and no git (Slice F2, item 3).
     */
    async promote(details: HistoryInput, expected: Snapshot, target: Snapshot, content: (hash: string) => Buffer, onCheckpoint?: () => void) {
      return locked(async () => {
        const paths = changedPaths(expected, target)
        if (!paths.length) return null
        assertExcludedUntouched(paths, details.excluded)
        const scope = promotionScope({ paths, expected, target, roots: details.roots })
        const limits = scopeLimits()
        const current = await captureScope({ scope, digest: sha256, ...limits, excluded: [...limits.excluded, ...details.excluded ?? []] })
        assertSnapshotMatches({ current, expected, target, paths, operation: 'Promotion' })
        const record = await beginScoped({ ...details, scope })
        try { onCheckpoint?.(); applySnapshot({ target, current, paths, content, roots: details.roots }) }
        finally { await finish(record); completeCall(record.sessionId, record.turnId!) }
        return summary(record)
      })
    },
    /** A checkpoint a stopped call left, as the lock settled it (settleStopped): the owner's command names its state. */
    async recover(id: string, options: { force?: boolean } = {}) {
      return locked(async () => {
        const found = records().find(record => record.id === id)
        if (!found || found.status === 'complete') throw new Error('Interrupted checkpoint not found')
        return summary(found)
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
    async close(): Promise<void> { if (closed) return; if (gcTimer) clearTimeout(gcTimer); await gc; await activity.close(); closed = true },
  }
}
export type ChangeHistory = Awaited<ReturnType<typeof openChangeHistory>>

/** A file's identity as the journal's cache keys it: replaced, grown, or touched, it reads as another file. */
function identity(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false, bigint: true })
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined
}
function hasTrees(record: Checkpoint): boolean { return Boolean(record.beforeTrees?.length || record.afterTrees?.length) }
/** A checkpoint an engine before the object store wrote (670f1dc2's shadow git, or SQLite): every new one is `blobs`. */
function isOldRecord(record: Checkpoint): boolean { return record.content !== 'blobs' }
function turnOf(record: Checkpoint): string { return record.turnId ?? record.id }
/**
 * What the owner's log may say of a capture that failed (D2): its kind, its system code, and for a git step which one and
 * how it failed, never its message, which can name the owner's paths.
 */
function causeOf(error: unknown): Record<string, string | number> {
  if (error instanceof HistoryGitError) {
    const { operation, failure, exitCode, errno } = error.details
    return { error: 'HistoryGitError', operation, failure, ...(exitCode === undefined ? {} : { exitCode }), ...(errno ? { code: errno } : {}) }
  }
  const code = systemCode(error)
  return { error: error instanceof Error ? error.constructor.name : 'Unknown', ...(code ? { code } : {}) }
}
/** The same cause in the words a checkpoint's reason gives the agent and the owner (D2): no path and no message. */
function causeText(error: unknown): string {
  if (error instanceof HistoryGitError) {
    const { operation, failure, exitCode } = error.details
    const how = failure === 'exit' ? `exited with ${exitCode ?? 'a signal'}` : failure === 'timeout' ? 'timed out' : failure === 'start' ? 'could not start' : 'wrote more output than history reads'
    return `git ${operation} ${how}`
  }
  const code = systemCode(error)
  if (code) return `the file system answered ${code}`
  if (error instanceof HistoryContentError) return 'its content store is damaged'
  if (error instanceof HistoryCaptureSafetyError) return error.message
  if (error instanceof FolderReplacedError) return 'a folder it records was replaced by a link or another folder'
  return error instanceof Error && error.constructor !== Error ? error.constructor.name : 'an unexpected error'
}
function systemCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? error.code : undefined
}
/** Whether content is the git blob `hash` names, as SHA-1 or SHA-256 git names it by its length. */
function matchesObject(hash: string, content: Buffer): boolean {
  if (hash.length === 40) return blobId(content) === hash
  return createHash('sha256').update(`blob ${content.length}\0`).update(content).digest('hex') === hash
}
/**
 * What a restore reads before it changes `paths`: each path, each folder above one that the checkpoint recorded (its
 * parent check), and each missing folder above a path it puts back, which writing that path makes.
 */
function restoreScope(paths: string[], recorded: { before: Snapshot; after?: Snapshot | undefined }): ScopePath[] {
  const scope = new Map<string, ScopePath>()
  for (const path of paths) {
    scope.set(path, { path })
    for (let parent = parentDirectory(path); parent !== parentDirectory(parent); parent = parentDirectory(parent)) if (recorded.after?.[parent] !== undefined) scope.set(parent, { path: parent })
    if (recorded.before[path] !== undefined) for (const parent of missingParents(path)) scope.set(parent, { path: parent })
  }
  return [...scope.values()]
}
/** The current state with what stands on disk inside each folder a restore removes: an entry no checkpoint names there is a conflict. */
function withRemovedChildren(input: { current: Snapshot; expected: Snapshot; target: Snapshot; paths: string[] }): Snapshot {
  const current = { ...input.current }
  for (const path of input.paths) if (input.current[path]?.kind === 'directory' && input.target[path]?.kind !== 'directory') Object.assign(current, unknownChildren(path, current))
  return current
}
/**
 * A command's roots (item 3): each folder, captured through git, and each other root, a file or a path not made yet,
 * recorded as a scoped path. A root inside a folder among them is that folder's own.
 */
function commandRoots(roots: string[]): { folders: string[]; others: ScopePath[] } {
  const unique = [...new Set(roots)]
  const folders = unique.filter(root => lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
  const outer = folders.filter(root => !folders.some(other => other !== root && isInside(other, root)))
  const others = unique.filter(root => !folders.includes(root) && !outer.some(folder => isInside(folder, root))).map(path => ({ path }))
  return { folders: outer, others }
}
/** What a promotion reads before it changes `paths`: each path, a folder it removes with all it holds, and each folder above one inside its roots. */
function promotionScope(input: { paths: string[]; expected: Snapshot; target: Snapshot; roots: string[] }): ScopePath[] {
  const scope = new Map<string, ScopePath>()
  for (const path of input.paths) {
    const removed = input.expected[path]?.kind === 'directory' && input.target[path]?.kind !== 'directory'
    scope.set(path, { path, ...(removed ? { tree: true } : {}) })
    for (let parent = parentDirectory(path); parent !== parentDirectory(parent); parent = parentDirectory(parent)) {
      if (!input.roots.some(root => isInside(root, parent))) break
      if (!scope.has(parent)) scope.set(parent, { path: parent })
    }
  }
  return [...scope.values()]
}
function sha256(content: Buffer): string { return createHash('sha256').update(content).digest('hex') }
function summary(record: Checkpoint) {
  return { id: record.id, sessionId: record.sessionId, stageId: record.stageId, turnId: record.turnId ?? record.stageId, tool: record.tool, requestId: record.requestId, createdAt: record.createdAt, status: record.status, reason: record.reason, restores: record.restores, undoes: record.undoes, restorable: record.restorable !== false, legacy: record.legacy, ...(record.ignored ? { ignored: { count: record.ignored, reason: 'ignored' as const } } : {}), paths: record.after ? changedPaths(record.before, record.after) : [], changed: record.changed ?? [], changes: record.after ? changesOf(record.before, record.after) : [], notRestorable: record.after ? notRestorablePaths(record.before, record.after) : [] }
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
