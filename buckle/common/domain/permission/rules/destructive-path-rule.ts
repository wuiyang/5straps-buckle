import type { GrantScope } from '@5straps/protocol'
import { guardedBatch, guardedTree, inWorkspaceFolder, relievedDelete, type DeletePolicy, type DeleteRunView } from '../../delete-policy.js'
import { treeWords, type ResolvedEffect } from '../../effect.js'
import type { PathView } from '../../path-view.js'
import { homeDirectory, isInside } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask } from '../decision.js'

/**
 * The subjects the file side of the destructive floor asks and grants under (the fs-verbs brief). They ride under the
 * `write_scope` rule with a prefix, as a secret file's use rides under `sensitive_path` (sensitive-path-rule.ts), so no
 * wire schema gains a rule a consumer pinned to an earlier protocol would refuse; no folder grant ever matches one, as
 * none is a path. `delete:<folder>`: an entry removed from that folder, matched exactly, never a folder beneath it.
 * `delete-tree:<folder>`: that folder removed with everything in it. A grant of one covers its subject alone.
 */
export const DELETE_PREFIX = 'delete:'
export const DELETE_TREE_PREFIX = 'delete-tree:'
/**
 * `delete-below:<folder>`: every delete outside the workspace's own folder in that folder and its subfolders, matched as a
 * write grant matches (isInside), which a person may grant for the session or always in place of the subject a delete
 * there asks under (the delete policy brief). Never a delete inside the workspace's folder, which its own setting decides.
 */
export const DELETE_BELOW_PREFIX = 'delete-below:'
/** `delete-batch:<workspace folder>`: one call that deletes more entries in the workspace's folder than its limit lets through. */
export const DELETE_BATCH_PREFIX = 'delete-batch:'
/** `overwrite:<file>`: a write that empties or halves that file, which the session never read (the destructive-write check). */
export const OVERWRITE_PREFIX = 'overwrite:'
/** `rewrite-batch:<workspace folder>`: one call that rewrites more existing files than the check lets through. */
export const REWRITE_BATCH_PREFIX = 'rewrite-batch:'
const FLOOR_PREFIXES = [DELETE_PREFIX, DELETE_TREE_PREFIX, DELETE_BELOW_PREFIX, DELETE_BATCH_PREFIX, OVERWRITE_PREFIX, REWRITE_BATCH_PREFIX] as const

/** Whether a `write_scope` subject is one of the floor's own, which names no folder a write grant covers. */
export function isFloorSubject(subject: string): boolean {
  return FLOOR_PREFIXES.some(prefix => subject.startsWith(prefix))
}

/** The real path a floor subject names, for the dangerously-allow switch's bound to the workspace; null for a folder grant's subject. */
export function floorSubjectPath(subject: string): string | null {
  const prefix = FLOOR_PREFIXES.find(item => subject.startsWith(item))
  return prefix === undefined ? null : subject.slice(prefix.length)
}

/**
 * The destructive floor for files: a delete asks a person, whatever the folder's write grant says, as `rm -r` does on
 * the shell side, and so does each write the destructive-write check marked (DestructiveWriteEffect). No stage of the
 * decision AI ever answers it, as it rates commands alone. A person may grant it once, for the session, or always, as
 * any write ask; strict mode offers once alone. A move's source that moves a file and replaces nothing (`floor: false`)
 * is judged by the write scope as a write to its folder instead, unless the file comes from outside the workspace's
 * folder into it (moveEffects).
 *
 * The workspace's delete policy (the owner's ruling of 2026-10-28): under `allow`, a delete inside its own folder is the
 * write scope's alone, except where one call deletes past the mass-delete limit or a folder at the top of the folder,
 * which still asks here. A delete outside it always asks here, and offers its folder and subfolders (`delete-below`) as a
 * wider grant beside the entry alone, for the session or always; strict mode offers neither. Nor is it offered, or
 * honored, for a folder that is the owner's home folder or holds it, or that holds a root the agent may name (its
 * folder, a mount, a scratch root): the agent chooses the target, and such a grant would cover other projects or the
 * whole disk (the delete policy review, R3). `home`: the owner's home folder, the node's own where absent.
 */
export function createDestructivePathRule(input: { paths: PathView; strict: boolean; deletes: DeletePolicy; home?: string }): PermissionRule {
  const offeredScopes: GrantScope[] = input.strict ? ['once'] : ['once', 'session', 'always']
  const home = input.home ?? homeDirectory()
  const grantable = (folder: string) => !isInside(folder, home) && !input.paths.reachableRoots.some(root => isInside(folder, root) && !isInside(root, folder))
  return {
    id: 'write_scope',
    evaluate({ effect, effects, run, grants }) {
      const floor = floorAsk(effect, effects ?? [effect], run, input)
      if (floor === null) return null
      const held = grants.subjectsFor('write_scope')
      if (held.includes(floor.subject)) return allowedVia('write_scope', floor.subject)
      const { outside } = floor
      if (outside === undefined) return ask('write_scope', floor.subject, floor.reason, offeredScopes)
      const below = held.find(subject => subject.startsWith(DELETE_BELOW_PREFIX) && grantable(subject.slice(DELETE_BELOW_PREFIX.length)) && isInside(subject.slice(DELETE_BELOW_PREFIX.length), outside.path))
      if (below !== undefined) return allowedVia('write_scope', below)
      return { ...ask('write_scope', floor.subject, floor.reason, offeredScopes), ...(input.strict || !grantable(outside.directory) ? {} : { widerSubject: `${DELETE_BELOW_PREFIX}${outside.directory}` }) }
    },
  }
}

/** What the floor asks about one effect, and, for a delete outside the workspace's folder, the entry a wider grant may cover. */
interface FloorAsk { subject: string; reason: string; outside?: { path: string; directory: string } }

function floorAsk(effect: ResolvedEffect, effects: readonly ResolvedEffect[], run: DeleteRunView | undefined, input: { paths: PathView; deletes: DeletePolicy }): FloorAsk | null {
  const { paths } = input
  if (effect.kind === 'unread_shrink') return { subject: `${OVERWRITE_PREFIX}${effect.path}`, reason: `Writing ${paths.toVirtual(effect.path)} ${effect.empties ? 'empties a file this session never read' : 'shrinks a file this session never read to under half its size'}, so a person decides, whatever the folder's write grant says` }
  if (effect.kind === 'many_rewrites') return { subject: `${REWRITE_BATCH_PREFIX}${paths.root}`, reason: `This call rewrites ${effect.files} existing files at once, so a person decides, whatever the folder's write grant says` }
  if (effect.kind !== 'delete_path' || !effect.floor) return null
  if (relievedDelete(effect, paths, input.deletes)) return massDeleteAsk(effect, effects, run, input)
  const outside = inWorkspaceFolder(effect.path, paths) ? {} : { outside: { path: effect.path, directory: effect.directory } }
  if (effect.tree) return { subject: `${DELETE_TREE_PREFIX}${effect.path}`, reason: `Deleting the folder ${paths.toVirtual(effect.path)} and everything in it (${treeWords(effect.tree)}) asks a person, whatever the folder's write grant says`, ...outside }
  return { subject: `${DELETE_PREFIX}${effect.directory}`, reason: `Deleting ${paths.toVirtual(effect.path)} asks a person, whatever the folder's write grant says`, ...outside }
}

/**
 * The mass-delete guard over deletes the workspace allows (the delete policy brief, item 2): a folder removed whole that
 * holds more than the limit, or stands at the top of the workspace's folder, asks under its own `delete-tree` subject;
 * the rest of the call's deletes, past the limit together, ask once under `delete-batch`. Otherwise nothing asks here.
 * Within a script (`run`), what its earlier calls removed counts toward the limit, and a top-level folder they took
 * entries out of asks when it is removed itself, though it holds nothing by then (the delete policy review, R1).
 */
function massDeleteAsk(effect: Extract<ResolvedEffect, { kind: 'delete_path' }>, effects: readonly ResolvedEffect[], run: DeleteRunView | undefined, input: { paths: PathView; deletes: DeletePolicy }): FloorAsk | null {
  const { paths, deletes } = input
  const tree = guardedTree(effect, paths, deletes, run)
  if (tree !== null) {
    const subject = `${DELETE_TREE_PREFIX}${effect.path}`
    const folder = paths.toVirtual(effect.path)
    const held = effect.tree ? ` and everything in it (${treeWords(effect.tree)})` : ''
    const why = tree === 'large' ? ` removes more than ${deletes.massLimit} entries at once, so a person decides` : tree === 'top' ? ', at the top of the workspace, asks a person' : ', at the top of the workspace and emptied by this script, asks a person'
    return { subject, reason: `Deleting the folder ${folder}${held}${why}, though the workspace allows deletes in its folder` }
  }
  const batch = guardedBatch(effects, paths, deletes, run)
  if (batch === null) return null
  const reason = (run?.removed ?? 0) > 0
    ? `This script has deleted ${batch} entries in the workspace so far, more than ${deletes.massLimit}, so a person decides, though the workspace allows deletes in its folder`
    : `This call deletes ${batch} entries in the workspace at once, more than ${deletes.massLimit}, so a person decides, though the workspace allows deletes in its folder`
  return { subject: `${DELETE_BATCH_PREFIX}${paths.root}`, reason }
}
