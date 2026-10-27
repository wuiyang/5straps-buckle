import type { GrantScope } from '@5straps/protocol'
import { treeWords, type ResolvedEffect } from '../../effect.js'
import type { PathView } from '../../path-view.js'
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
/** `overwrite:<file>`: a write that empties or halves that file, which the session never read (the destructive-write check). */
export const OVERWRITE_PREFIX = 'overwrite:'
/** `rewrite-batch:<workspace folder>`: one call that rewrites more existing files than the check lets through. */
export const REWRITE_BATCH_PREFIX = 'rewrite-batch:'
const FLOOR_PREFIXES = [DELETE_PREFIX, DELETE_TREE_PREFIX, OVERWRITE_PREFIX, REWRITE_BATCH_PREFIX] as const

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
 * The destructive floor for files: every delete asks a person, whatever the folder's write grant says, as `rm -r` does on
 * the shell side, and so does each write the destructive-write check marked (DestructiveWriteEffect). No stage of the
 * decision AI ever answers it, as it rates commands alone. A person may grant it once, for the session, or always, as
 * any write ask; strict mode offers once alone. A move's source that moves a file and replaces nothing (`floor: false`)
 * is judged by the write scope as a write to its folder instead.
 */
export function createDestructivePathRule(input: { paths: PathView; strict: boolean }): PermissionRule {
  const offeredScopes: GrantScope[] = input.strict ? ['once'] : ['once', 'session', 'always']
  return {
    id: 'write_scope',
    evaluate({ effect, grants }) {
      const floor = floorAsk(effect, input.paths)
      if (floor === null) return null
      if (grants.subjectsFor('write_scope').includes(floor.subject)) return allowedVia('write_scope', floor.subject)
      return ask('write_scope', floor.subject, floor.reason, offeredScopes)
    },
  }
}

function floorAsk(effect: ResolvedEffect, paths: PathView): { subject: string; reason: string } | null {
  if (effect.kind === 'unread_shrink') return { subject: `${OVERWRITE_PREFIX}${effect.path}`, reason: `Writing ${paths.toVirtual(effect.path)} ${effect.empties ? 'empties a file this session never read' : 'shrinks a file this session never read to under half its size'}, so a person decides, whatever the folder's write grant says` }
  if (effect.kind === 'many_rewrites') return { subject: `${REWRITE_BATCH_PREFIX}${paths.root}`, reason: `This call rewrites ${effect.files} existing files at once, so a person decides, whatever the folder's write grant says` }
  if (effect.kind !== 'delete_path' || !effect.floor) return null
  if (effect.tree) return { subject: `${DELETE_TREE_PREFIX}${effect.path}`, reason: `Deleting the folder ${paths.toVirtual(effect.path)} and everything in it (${treeWords(effect.tree)}) asks a person, whatever the folder's write grant says` }
  return { subject: `${DELETE_PREFIX}${effect.directory}`, reason: `Deleting ${paths.toVirtual(effect.path)} asks a person, whatever the folder's write grant says` }
}
