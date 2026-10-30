import type { ResolvedEffect } from './effect.js'
import { MAX_COUNTED_ENTRIES } from './effect.js'
import type { PathView } from './path-view.js'
import { relative } from 'pathe'
import { isInside } from './paths.js'

/**
 * What a delete inside the workspace's own folder meets (the owner's ruling of 2026-10-28, the delete policy brief):
 * `allow`, Buckle's default, runs it under the ordinary write gate, as removing old code is part of a coding task;
 * `ask` keeps it at the destructive floor, as every delete was before. The workspace setting files.deleteInWorkspace,
 * else the node's BUCKLE_DELETE_IN_WORKSPACE.
 */
export const DELETE_IN_WORKSPACE_MODES = ['allow', 'ask'] as const
export type DeleteInWorkspace = typeof DELETE_IN_WORKSPACE_MODES[number]

/**
 * The entries one call may remove inside the workspace's folder under `allow` before it asks at the floor anyway (a
 * coordinator default the owner can reverse): files and folders, a folder removed whole counted with all it holds.
 * A folder at the top of the workspace's folder removed whole asks too. 0 turns the guard off.
 */
export const DEFAULT_MASS_DELETE_LIMIT = 100
/** The largest limit: past the entries a folder is counted to before an ask, a count says only "more than". */
export const MAX_MASS_DELETE_LIMIT = MAX_COUNTED_ENTRIES

/** A workspace's delete settings in force, as the destructive floor and the write gate read them. */
export interface DeletePolicy {
  inWorkspace: DeleteInWorkspace
  massLimit: number
}

/** Buckle's own, where neither the workspace nor the node names a value. */
export const BUILT_IN_DELETE_POLICY: Readonly<DeletePolicy> = Object.freeze({ inWorkspace: 'allow', massLimit: DEFAULT_MASS_DELETE_LIMIT })

/** A delete mode as typed (a setting's value), or null where it is neither word. */
export function parseDeleteInWorkspace(raw: string): DeleteInWorkspace | null {
  const word = raw.trim().toLowerCase()
  return DELETE_IN_WORKSPACE_MODES.find(mode => mode === word) ?? null
}

/** A mass-delete limit as typed: whole entries, 0 to MAX_MASS_DELETE_LIMIT, or null for anything else. */
export function parseMassDeleteLimit(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,6}$/.test(text)) return null
  const value = Number(text)
  return value <= MAX_MASS_DELETE_LIMIT ? value : null
}

type DeleteEffect = Extract<ResolvedEffect, { kind: 'delete_path' }>

/**
 * Whether a real path lies in the workspace's own folder and in none of its mounts: a writable mount, a scratch root, or
 * a path a read or write approval reached is outside it, whatever folder holds it.
 */
export function inWorkspaceFolder(path: string, paths: PathView): boolean {
  return isInside(paths.root, path) && paths.mountOf(path) === null
}

/**
 * A delete at the destructive floor the workspace hands to the ordinary write gate: inside its own folder, where its
 * setting allows deletes. A whole-folder move always stays at the floor. Both rules read this one answer.
 */
export function relievedDelete(effect: ResolvedEffect, paths: PathView, policy: DeletePolicy): boolean {
  return effect.kind === 'delete_path' && effect.floor && !effect.moved && policy.inWorkspace === 'allow' && inWorkspaceFolder(effect.path, paths)
}

/**
 * What a relieved delete removes, for the mass-delete guard: one entry, or a folder whole with the folder itself and
 * all it held when counted, past the count's bound more than any limit. A folder moved whole removes nothing: all of it
 * stands at the landing afterwards.
 */
export function removedEntries(effect: DeleteEffect): number {
  if (effect.moved) return 0
  if (!effect.tree) return 1
  if (!effect.tree.counted || effect.tree.more) return Number.POSITIVE_INFINITY
  return 1 + effect.tree.files + effect.tree.folders
}

/**
 * What the calls of one script have removed so far inside the workspace's folder, which the guard adds to the call it
 * judges (the delete policy review, R1): `removed`, the entries those calls removed that the guard let through, and
 * `tops`, the folders at the top of the workspace's folder they took an entry out of. A call alone sees none of it, so
 * a loop of single deletes, or a folder emptied by one call and removed by the next, met no check.
 */
export interface DeleteRun { removed: number; tops: string[] }
export type DeleteRunView = Readonly<{ removed: number; tops: readonly string[] }>

/** A script that has removed nothing yet. */
export function newDeleteRun(): DeleteRun {
  return { removed: 0, tops: [] }
}

/**
 * Why the guard asks about one folder removed whole, or null: it holds more entries than the limit (`large`), it stands
 * at the top of the workspace's folder and holds anything (`top`), or it stands there and the script that removes it
 * took entries out of it already, so it holds nothing now but did (`emptied`, whether or not the call counted it).
 * A folder moved is no removal, and an empty folder the script never touched holds nothing to lose.
 */
export function guardedTree(effect: DeleteEffect, paths: PathView, policy: DeletePolicy, run?: DeleteRunView): 'large' | 'top' | 'emptied' | null {
  if (policy.massLimit === 0 || effect.moved) return null
  const emptied = run?.tops.some(top => samePath(top, effect.path)) === true
  if (!effect.tree) return emptied ? 'emptied' : null
  const removed = removedEntries(effect)
  if (removed > policy.massLimit) return 'large'
  if (removed > 1 && samePath(effect.directory, paths.root)) return 'top'
  return emptied ? 'emptied' : null
}

/**
 * The entries one call removes inside the workspace's folder beside the folders the guard asks about one by one, added
 * to what the script it belongs to removed before (`run`), or null where they stay within the limit: the batch the guard
 * asks about as a whole.
 */
export function guardedBatch(effects: readonly ResolvedEffect[], paths: PathView, policy: DeletePolicy, run?: DeleteRunView): number | null {
  if (policy.massLimit === 0) return null
  const counted = effects.filter((effect): effect is DeleteEffect => effect.kind === 'delete_path' && relievedDelete(effect, paths, policy) && guardedTree(effect, paths, policy, run) === null)
  const total = (run?.removed ?? 0) + counted.reduce((sum, effect) => sum + removedEntries(effect), 0)
  return total > policy.massLimit ? total : null
}

/**
 * Adds what a call that was cleared to run removes to its script's run: the entries the guard let through, and the
 * top-level folder each removal came out of. A folder the guard asked about is a person's decision, so it is not
 * counted; a folder moved removes nothing. Judged against the run as it stood before the call, so the call's own
 * removals never count toward each other twice.
 */
export function recordRemovals(run: DeleteRun, effects: readonly ResolvedEffect[], paths: PathView, policy: DeletePolicy): void {
  if (policy.massLimit === 0) return
  const before: DeleteRunView = { removed: run.removed, tops: [...run.tops] }
  for (const effect of effects) {
    if (effect.kind !== 'delete_path' || effect.moved || !relievedDelete(effect, paths, policy)) continue
    const top = topFolderOf(effect.path, paths.root)
    if (top !== null && !run.tops.some(item => samePath(item, top))) run.tops.push(top)
    if (guardedTree(effect, paths, policy, before) === null) run.removed += removedEntries(effect)
  }
}

/** The folder directly in the workspace's folder that holds the path, or null for an entry directly in it. */
function topFolderOf(path: string, root: string): string | null {
  const below = relative(root, path)
  const first = below.split('/')[0]
  return first !== undefined && first !== '' && first !== '..' && below.includes('/') ? `${root}/${first}` : null
}

function samePath(left: string, right: string): boolean {
  return isInside(left, right) && isInside(right, left)
}
