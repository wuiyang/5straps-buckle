import { MAX_COUNTED_ENTRIES } from './effect.js'

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

/** Buckle's own, where neither the workspace nor the node names a value. */
export const BUILT_IN_DELETE_POLICY = Object.freeze({ inWorkspace: 'allow' as DeleteInWorkspace, massLimit: DEFAULT_MASS_DELETE_LIMIT })

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
