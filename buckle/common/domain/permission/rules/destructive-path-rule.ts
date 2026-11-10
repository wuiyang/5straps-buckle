import type { ApprovalSeverity, GrantScope } from '@5straps/protocol'
import { guardedBatch, guardedTree, inWorkspaceFolder, relievedDelete, type DeletePolicy, type DeleteRunView } from '../../delete-policy.js'
import { treeWords, undoneWords, type ResolvedEffect } from '../../effect.js'
import type { PathView } from '../../path-view.js'
import { homeDirectory, isInside } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, FILE_FLOOR_MARKS } from '../decision.js'
import { FLOOR_POLICY, type FloorPolicy } from '../floor-policy.js'
import { DELETE_PREFIX, DELETE_TREE_PREFIX, MOVE_TREE_PREFIX, DELETE_BELOW_PREFIX, DELETE_BATCH_PREFIX, OVERWRITE_PREFIX, REWRITE_BATCH_PREFIX, restoreSubject } from '../subjects.js'

/**
 * The destructive floor for files: a delete asks a person, whatever the folder's write grant says, as `rm -r` does on
 * the shell side, and so does each write the destructive-write check marked (DestructiveWriteEffect). No stage of the
 * decision AI ever answers it, as it rates commands alone. A person may grant it once, for the session, or always, as
 * any write ask, while the floor policy's `alwaysAtFloor` keeps always (`policy`); strict mode offers once alone. A
 * move's source that moves a file and replaces nothing (`floor: false`) is judged by the write scope as a write to its
 * folder instead, unless the file comes from outside the workspace's folder into it (moveEffects).
 *
 * The workspace's delete policy (the owner's ruling of 2026-10-28): under `allow`, a delete inside its own folder is the
 * write scope's alone, except where one call deletes past the mass-delete limit or a folder at the top of the folder,
 * which still asks here. Whole-folder moves always ask here with warn severity; recursive and bulk destructive asks carry danger.
 * A delete outside it always asks here, and offers its folder and subfolders (`delete-below`) as a
 * wider grant beside the entry alone, for the session or always; strict mode offers neither. Nor is it offered, or
 * honored, for a folder that is the owner's home folder or holds it, or that holds a root the agent may name (its
 * folder, a mount, a scratch root): the agent chooses the target, and such a grant would cover other projects or the
 * whole disk (the delete policy review, R3). `home`: the owner's home folder, the node's own where absent.
 *
 * A restore of the change history (RestoreEffect) asks here every time, under a subject naming what it undoes
 * (restoreSubject), whatever the folders' write grants say. It offers once alone: once it ran, no later restore undoes
 * the same checkpoints from the same newest one, so a grant for the session or always would never be used. The paths
 * it puts back are judged beside it as writes, and the write scope asks nothing of them (write-scope-rule.ts).
 */
export function createDestructivePathRule(input: { paths: PathView; strict: boolean; deletes: DeletePolicy; home?: string; policy?: FloorPolicy }): PermissionRule {
  const { alwaysAtFloor } = input.policy ?? FLOOR_POLICY
  const offeredScopes: GrantScope[] = input.strict ? ['once'] : alwaysAtFloor ? ['once', 'session', 'always'] : ['once', 'session']
  const home = input.home ?? homeDirectory()
  const grantable = (folder: string) => !isInside(folder, home) && !input.paths.reachableRoots.some(root => isInside(folder, root) && !isInside(root, folder))
  return {
    id: 'write_scope',
    evaluate({ effect, effects, run, grants }) {
      const floor = floorAsk(effect, effects ?? [effect], run, input)
      if (floor === null) return null
      // Where the floor offers no always, an always grant made before clears nothing either.
      const held = grants.subjectsFor('write_scope', alwaysAtFloor ? undefined : SHORT_OF_ALWAYS)
      if (held.includes(floor.subject)) return allowedVia('write_scope', floor.subject)
      const { outside } = floor
      if (outside === undefined) return ask({ rule: 'write_scope', subject: floor.subject, reason: floor.reason, marks: FILE_FLOOR_MARKS, offeredScopes: floor.once ? ['once'] : offeredScopes, severity: floor.severity })
      const below = held.find(subject => subject.startsWith(DELETE_BELOW_PREFIX) && grantable(subject.slice(DELETE_BELOW_PREFIX.length)) && isInside(subject.slice(DELETE_BELOW_PREFIX.length), outside.path))
      if (below !== undefined) return allowedVia('write_scope', below)
      return { ...ask({ rule: 'write_scope', subject: floor.subject, reason: floor.reason, marks: FILE_FLOOR_MARKS, offeredScopes, severity: floor.severity }), ...(input.strict || !grantable(outside.directory) ? {} : { widerSubject: `${DELETE_BELOW_PREFIX}${outside.directory}` }) }
    },
  }
}

const SHORT_OF_ALWAYS: readonly GrantScope[] = ['once', 'session']

/** What the floor asks about one effect, and, for a delete outside the workspace's folder, the entry a wider grant may cover. */
interface FloorAsk { subject: string; reason: string; severity: ApprovalSeverity; outside?: { path: string; directory: string }; once?: true }

function floorAsk(effect: ResolvedEffect, effects: readonly ResolvedEffect[], run: DeleteRunView | undefined, input: { paths: PathView; deletes: DeletePolicy }): FloorAsk | null {
  const { paths } = input
  if (effect.kind === 'restore_checkpoint') return { subject: restoreSubject(effect), reason: `Restoring the workspace to before checkpoint ${effect.checkpoint} undoes ${undoneWords(effect.undoes)}${effect.undoes > 1 ? `, the newest ${effect.head}` : ''}, so a person decides, whatever the folders' write grants say`, severity: 'danger', once: true }
  if (effect.kind === 'unread_shrink') return { subject: `${OVERWRITE_PREFIX}${effect.path}`, reason: `Writing ${paths.toVirtual(effect.path)} ${effect.empties ? 'empties a file this session never read' : 'shrinks a file this session never read to under half its size'}, so a person decides, whatever the folder's write grant says`, severity: 'danger' }
  if (effect.kind === 'many_rewrites') return { subject: `${REWRITE_BATCH_PREFIX}${paths.root}`, reason: `This call rewrites ${effect.files} existing files at once, so a person decides, whatever the folder's write grant says`, severity: 'danger' }
  if (effect.kind !== 'delete_path' || !effect.floor) return null
  if (effect.moved) return { subject: `${MOVE_TREE_PREFIX}${effect.path}`, reason: `Moving the folder ${paths.toVirtual(effect.path)}${effect.tree ? ` and everything in it (${treeWords(effect.tree)})` : ''} changes every path beneath it, so a person decides, whatever the folder's write grant says`, severity: 'warn' }
  if (relievedDelete(effect, paths, input.deletes)) return massDeleteAsk(effect, effects, run, input)
  const outside = inWorkspaceFolder(effect.path, paths) ? {} : { outside: { path: effect.path, directory: effect.directory } }
  if (effect.tree) return { subject: `${DELETE_TREE_PREFIX}${effect.path}`, reason: `Deleting the folder ${paths.toVirtual(effect.path)} and everything in it (${treeWords(effect.tree)}) asks a person, whatever the folder's write grant says`, severity: 'danger', ...outside }
  return { subject: `${DELETE_PREFIX}${effect.directory}`, reason: `Deleting ${paths.toVirtual(effect.path)} asks a person, whatever the folder's write grant says`, severity: 'warn', ...outside }
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
    return { subject, reason: `Deleting the folder ${folder}${held}${why}, though the workspace allows deletes in its folder`, severity: 'danger' }
  }
  const batch = guardedBatch(effects, paths, deletes, run)
  if (batch === null) return null
  const reason = (run?.removed ?? 0) > 0
    ? `This script has deleted ${batch} entries in the workspace so far, more than ${deletes.massLimit}, so a person decides, though the workspace allows deletes in its folder`
    : `This call deletes ${batch} entries in the workspace at once, more than ${deletes.massLimit}, so a person decides, though the workspace allows deletes in its folder`
  return { subject: `${DELETE_BATCH_PREFIX}${paths.root}`, reason, severity: 'danger' }
}
