import type { ResolvedEffect } from './effect.js'
import { MAX_COUNTED_ENTRIES } from './effect.js'
import type { PathView } from './path-view.js'
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
 * setting allows deletes. Both rules read this one answer, so a delete is never judged by neither of them.
 */
export function relievedDelete(effect: ResolvedEffect, paths: PathView, policy: DeletePolicy): boolean {
  return effect.kind === 'delete_path' && effect.floor && policy.inWorkspace === 'allow' && inWorkspaceFolder(effect.path, paths)
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
 * Why the guard asks about one folder removed whole, or null: it holds more entries than the limit, or it stands at the
 * top of the workspace's folder and holds anything. A folder moved is no removal, and an empty folder holds nothing to
 * lose.
 */
export function guardedTree(effect: DeleteEffect, paths: PathView, policy: DeletePolicy): 'large' | 'top' | null {
  if (policy.massLimit === 0 || effect.moved || !effect.tree) return null
  const removed = removedEntries(effect)
  if (removed > policy.massLimit) return 'large'
  return removed > 1 && samePath(effect.directory, paths.root) ? 'top' : null
}

/**
 * The entries one call removes inside the workspace's folder beside the folders the guard asks about one by one, or
 * null where they stay within the limit: the batch the guard asks about as a whole.
 */
export function guardedBatch(effects: readonly ResolvedEffect[], paths: PathView, policy: DeletePolicy): number | null {
  if (policy.massLimit === 0) return null
  const counted = effects.filter((effect): effect is DeleteEffect => effect.kind === 'delete_path' && relievedDelete(effect, paths, policy) && guardedTree(effect, paths, policy) === null)
  const total = counted.reduce((sum, effect) => sum + removedEntries(effect), 0)
  return total > policy.massLimit ? total : null
}

function samePath(left: string, right: string): boolean {
  return isInside(left, right) && isInside(right, left)
}
