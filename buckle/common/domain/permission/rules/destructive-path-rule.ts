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
 * `delete-tree:<folder>`: that folder removed with everything in it.
 */
export const DELETE_PREFIX = 'delete:'
export const DELETE_TREE_PREFIX = 'delete-tree:'
const FLOOR_PREFIXES = [DELETE_PREFIX, DELETE_TREE_PREFIX] as const

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
 * the shell side, and no stage of the decision AI ever answers it, as it rates commands alone. A person may grant it
 * once, for the session, or always, as any write ask; strict mode offers once alone. A move's source that moves a file
 * and replaces nothing (`floor: false`) is judged by the write scope as a write to its folder instead.
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
  if (effect.kind !== 'delete_path' || !effect.floor) return null
  if (effect.tree) return { subject: `${DELETE_TREE_PREFIX}${effect.path}`, reason: `Deleting the folder ${paths.toVirtual(effect.path)} and everything in it (${treeWords(effect.tree)}) always asks a person, whatever the folder's write grant says` }
  return { subject: `${DELETE_PREFIX}${effect.directory}`, reason: `Deleting ${paths.toVirtual(effect.path)} always asks a person, whatever the folder's write grant says` }
}
