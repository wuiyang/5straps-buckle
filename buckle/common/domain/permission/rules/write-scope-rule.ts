import type { GrantScope } from '@5straps/protocol'
import { outsideMountReason, readOnlyMountReason, type PathView } from '../../path-view.js'
import { isInside, isInsideAny, isInsideComparable } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'
import { isFloorSubject } from './destructive-path-rule.js'

export interface WriteScopeOptions {
  /** The roots the agent may name. Scratch directories among them are writable without asking. */
  paths: PathView
  /** Strict mode refuses to persist write grants, so every directory asks every session. */
  strict: boolean
  pathDecision?: (path: string) => 'inherit' | 'allow' | 'ask' | 'deny'
  /** Whether the volume ignores case, which decides a root by any spelling of it; the platform's default when absent. */
  caseInsensitive?: boolean
}

/**
 * A write inside a scratch root is free; inside a mount the owner shares read-only it is refused, as no approval makes
 * it writable (Q6); beyond a mounted view's roots it is refused; anywhere else, the workspace and a read-write mount
 * among it, the first write to a directory asks, and an approval is remembered as the scope offered allows.
 *
 * A delete is a write: refused where a write is, and where it would remove a root the agent may name or a folder holding
 * one, or a read-only mount's source. One at the destructive floor asks there alone (destructive-path-rule.ts); a move's
 * source that moves a file and replaces nothing asks as a write to its folder does.
 */
export function createWriteScopeRule({ paths, strict, pathDecision, caseInsensitive }: WriteScopeOptions): PermissionRule {
  const offeredScopes: GrantScope[] = strict ? ['once'] : ['once', 'session', 'always']
  const reachable = paths.reachableRoots
  const readOnly = paths.mounts.filter(mount => mount.access === 'ro').map(mount => mount.source)

  return {
    id: 'write_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'write_path' && effect.kind !== 'delete_path') return null
      if (effect.kind === 'delete_path') {
        // Any spelling a volume that ignores case reads as the root is the root: a refusal never answers by case.
        const holder = [...reachable, ...readOnly].find(root => isInsideComparable(effect.path, root, caseInsensitive))
        if (holder !== undefined) return deny('write_scope', effect.path, `${paths.toVirtual(effect.path)} is or holds ${paths.toVirtual(holder)}, a folder the workspace shows or a read-only mount, which no tool removes or moves`)
      }
      // A delete at the floor in a scratch root still asks there (destructive-path-rule.ts): only its refusals are here.
      const floor = effect.kind === 'delete_path' && effect.floor
      if (isInsideAny(paths.scratchRoots, effect.path)) return floor ? null : { kind: 'allow' }
      if (isInsideAny(readOnly, effect.path)) return deny('write_scope', effect.path, readOnlyMountReason(paths.toVirtual(effect.path)))
      // A mount is the boundary, so a write beyond it is refused rather than offered for approval.
      if (paths.mount && !isInsideAny(reachable, effect.path)) {
        return deny('write_scope', effect.path, outsideMountReason({ named: null, displayRoots: paths.displayRoots }))
      }
      if (floor) return null

      if (isInside(paths.root, effect.path) && pathDecision?.(effect.path) === 'allow') return { kind: 'allow' }
      // The floor's own subjects name no folder, so none is ever read as a grant over one.
      const granted = grants.subjectsFor('write_scope').filter(subject => !isFloorSubject(subject)).find(root => isInside(root, effect.path))
      if (granted) return allowedVia('write_scope', granted)
      const free = paths.scratchRoots.length > 0 ? `. Writable without asking: ${paths.scratchRoots.join(', ')}` : ''
      return ask('write_scope', effect.directory, `Writing to ${paths.toVirtual(effect.directory)} is not yet approved${free}`, offeredScopes)
    },
  }
}
