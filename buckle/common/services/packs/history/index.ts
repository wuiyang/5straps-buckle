import { z } from 'zod'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { RestoreTarget } from '../../../domain/effect.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, LockWaitError, ToolExecutionError, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import { RECENT_CHECKPOINTS_MAX, RestoreRefusedError, withConflictPath, type ChangeHistory, type CheckpointSummary } from '../../history/journal.js'
import { loadPackSkill } from '../pack-skill.js'

const PACK_ID = 'history'
/** How many checkpoints history_list answers where `last` names none. */
const DEFAULT_LISTED = 10
/** How many changed paths one checkpoint lists before the rest are counted (`unlisted`). */
const LISTED_CHANGES = 100
/** Why a restore planned under the execution lock is not run: another call changed the history after it was judged. */
const HISTORY_MOVED = 'The change history moved since this restore was judged, so it would undo other checkpoints than the person approved; nothing was restored. List the history again and ask again'

const listInput = z.object({ last: z.number().int().min(1).max(RECENT_CHECKPOINTS_MAX).default(DEFAULT_LISTED) }).strict()

const restoreInput = z.object({
  id: z.string().min(1).max(200).optional(),
  steps: z.number().int().min(1).max(RECENT_CHECKPOINTS_MAX).optional(),
  turns: z.number().int().min(1).max(RECENT_CHECKPOINTS_MAX).optional(),
}).strict().refine(input => [input.id, input.steps, input.turns].filter(value => value !== undefined).length === 1, { message: 'Name exactly one of id, steps, or turns back from the current state' })

export interface HistoryPackOptions {
  paths: PathView
  /** The workspace's change history; null withholds the pack. */
  history: ChangeHistory | null
  /** Why the pack is withheld though the history is kept; null offers it. */
  unavailableReason?: string | null
}

/**
 * The workspace's change history as the agent sees it (slice D, rollback): history_list, a read, and history_restore,
 * which restores the workspace to before a checkpoint and asks a person every time (destructive-path-rule.ts). Paths are
 * shown as the agent names them, and a path the read rules keep from it is counted, not shown.
 */
export function createHistoryPack(options: HistoryPackOptions): Pack {
  const { history, paths } = options
  const required = (): ChangeHistory => {
    if (!history) throw new ToolExecutionError('This workspace keeps no change history here', { code: 'HISTORY_UNAVAILABLE' })
    return history
  }

  const tools = [
    defineTool(PACK_ID, {
      name: 'history_list',
      description: 'The newest checkpoints of the change history, newest first: each one\'s id, time, the call that made it, and the files it changed, the current one marked.',
      risk: 'read',
      tags: ['history'],
      input: listInput,
      effects: () => [{ kind: 'read_path', path: '.' }],
      run: async (input, context): Promise<JsonValue> => {
        const recent = await required().recent(input.last)
        const checkpoints: JsonObject[] = []
        for (const checkpoint of recent.checkpoints) checkpoints.push(await shownCheckpoint(checkpoint, { paths, context }))
        const turns = [...new Set(recent.checkpoints.map(checkpoint => checkpoint.turnId))].map(id => ({ id, checkpoints: recent.checkpoints.filter(checkpoint => checkpoint.turnId === id).map(checkpoint => checkpoint.id) }))
        return { checkpoints, more: recent.more, turns }
      },
    }),
    defineTool(PACK_ID, {
      name: 'history_restore',
      description: 'Restore files by checkpoint id, checkpoint steps, or user turns back: the selected checkpoint and every later one are undone. A person approves each restore.',
      risk: 'write',
      tags: ['history', 'filesystem'],
      input: restoreInput,
      // It takes the workspace's execution lock itself, through the history's restore path, and checkpoints its own change.
      managesHistory: true,
      effects: input => [{ kind: 'restore_checkpoint', target: targetOf(input) }],
      run: (input, context) => restore({ history: required(), target: targetOf(input), paths, context }),
    }),
  ]

  return {
    id: PACK_ID,
    version: '1.0.0',
    tools,
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: history ? options.unavailableReason ?? null : 'This node keeps no change history for the workspace here',
  }
}

function targetOf(input: z.infer<typeof restoreInput>): RestoreTarget {
  return input.id !== undefined ? { id: input.id } : input.turns !== undefined ? { turns: input.turns } : { steps: input.steps! }
}

/**
 * One restore, under the execution lock: planned again there and run only where the plan is the one the call's permission
 * check judged, then answered with what it changed. The wait for the lock is untimed, as the invoker's own is, and a wait
 * that ended ran nothing (LockWaitError).
 */
async function restore(input: { history: ChangeHistory; target: RestoreTarget; paths: PathView; context: ToolContext }): Promise<JsonValue> {
  const { context } = input
  const by = { sessionId: context.sessionId, stageId: context.historyStage ?? context.stageId ?? context.requestId, turnStageId: context.historyTurnStage === undefined ? context.stageId ?? null : context.historyTurnStage, tool: 'history_restore', requestId: context.requestId }
  const untimed = context.untimed ?? (<T>(wait: (signal: AbortSignal | undefined) => Promise<T>) => wait(context.signal))
  let waiting = true
  try {
    const restored = await untimed(signal => input.history.rollback({
      target: input.target,
      by,
      ...(signal ? { signal } : {}),
      onLocked: () => { waiting = false },
      check: (plan) => {
        if (context.authorizeRestore && !context.authorizeRestore(plan)) throw new ToolInputError(HISTORY_MOVED, { code: 'RESTORE_REFUSED' })
        context.beginRun?.()
      },
    }))
    const shown = await shownChanges(restored.changes, input)
    const notRestorable = await shownPaths(restored.notRestorable, input)
    return { checkpoint: restored.id, restores: restored.restores ?? null, undoes: restored.undoes ?? 1, changes: shown.changes, ...(shown.unlisted > 0 ? { unlisted: shown.unlisted } : {}), ...(notRestorable.paths.length > 0 ? { notRestorable: notRestorable.paths } : {}), ...(notRestorable.unlisted > 0 ? { notRestorableUnlisted: notRestorable.unlisted } : {}) }
  } catch (error) {
    if (waiting) throw new LockWaitError(error)
    if (error instanceof RestoreRefusedError) throw new ToolExecutionError(await refusalText(error, input), { code: error.code })
    throw error
  }
}

/** A refusal's message, with the path in conflict as the agent names it, unless the read rules keep the path from it. */
async function refusalText(refusal: RestoreRefusedError, input: { paths: PathView; context: ToolContext }): Promise<string> {
  const shown = refusal.path !== undefined && await readable(refusal.path, input.context) ? input.paths.display(refusal.path) : undefined
  return withConflictPath(refusal, shown)
}

/** A checkpoint as history_list answers it: no snapshot, its paths as the agent names them. */
async function shownCheckpoint(checkpoint: CheckpointSummary & { current: boolean }, input: { paths: PathView; context: ToolContext }): Promise<JsonObject> {
  const shown = await shownChanges(checkpoint.changes, input)
  const changed = await shownPaths(checkpoint.changed, input)
  const notRestorable = await shownPaths(checkpoint.notRestorable, input)
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    tool: checkpoint.tool,
    sessionId: checkpoint.sessionId,
    ...(checkpoint.requestId === undefined ? {} : { requestId: checkpoint.requestId }),
    stageId: checkpoint.stageId,
    turnId: checkpoint.turnId,
    restorable: checkpoint.restorable,
    ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
    changed: changed.paths,
    ...(changed.unlisted > 0 ? { changedUnlisted: changed.unlisted } : {}),
    notRestorable: notRestorable.paths,
    ...(notRestorable.unlisted > 0 ? { notRestorableUnlisted: notRestorable.unlisted } : {}),
    status: checkpoint.status,
    current: checkpoint.current,
    ...(checkpoint.restores === undefined ? {} : { restores: checkpoint.restores }),
    ...(checkpoint.undoes === undefined ? {} : { undoes: checkpoint.undoes }),
    changes: shown.changes,
    ...(shown.unlisted > 0 ? { unlisted: shown.unlisted } : {}),
  }
}

/**
 * The first LISTED_CHANGES changed paths the read rules let the agent see, as it names them; `unlisted` counts the rest,
 * past that number or kept from it.
 */
async function shownChanges(changes: ReadonlyArray<{ path: string; kind: string }>, input: { paths: PathView; context: ToolContext }): Promise<{ changes: JsonObject[]; unlisted: number }> {
  const shown: JsonObject[] = []
  for (const change of changes) {
    if (shown.length === LISTED_CHANGES) break
    if (await readable(change.path, input.context)) shown.push({ path: input.paths.display(change.path), kind: change.kind })
  }
  return { changes: shown, unlisted: changes.length - shown.length }
}

async function shownPaths(paths: readonly string[], input: { paths: PathView; context: ToolContext }): Promise<{ paths: string[]; unlisted: number }> {
  const shown: string[] = []
  for (const path of paths) {
    if (shown.length === LISTED_CHANGES) break
    if (await readable(path, input.context)) shown.push(input.paths.display(path))
  }
  return { paths: shown, unlisted: paths.length - shown.length }
}

/** Whether the read rules let the agent see a path's name; run outside the invoker, every path is. */
function readable(path: string, context: ToolContext): Promise<boolean> {
  return context.authorizeRead ? context.authorizeRead(path) : Promise.resolve(true)
}
