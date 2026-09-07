import type { GrantScope } from '@5straps/protocol'
import { outsideMountReason, type PathView } from '../../path-view.js'
import { isInside, isInsideAny } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

export interface WriteScopeOptions {
  /** The roots the agent may name. Scratch directories among them are writable without asking. */
  paths: PathView
  /** Strict mode refuses to persist write grants, so every directory asks every session. */
  strict: boolean
}

export function createWriteScopeRule({ paths, strict }: WriteScopeOptions): PermissionRule {
  const offeredScopes: GrantScope[] = strict ? ['once'] : ['once', 'session', 'always']
  const reachable = [paths.root, ...paths.scratchRoots]

  return {
    id: 'write_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'write_path') return null
      if (isInsideAny(paths.scratchRoots, effect.path)) return { kind: 'allow' }
      // A mount is the boundary, so a write beyond it is refused rather than offered for approval.
      if (paths.mount && !isInsideAny(reachable, effect.path)) {
        return deny('write_scope', effect.path, outsideMountReason({ named: null, displayRoots: paths.displayRoots }))
      }

      const granted = grants.subjectsFor('write_scope').find(root => isInside(root, effect.path))
      if (granted) return allowedVia('write_scope', granted)
      const free = paths.scratchRoots.length > 0 ? `. Writable without asking: ${paths.scratchRoots.join(', ')}` : ''
      return ask('write_scope', effect.directory, `Writing to ${paths.toVirtual(effect.directory)} is not yet approved${free}`, offeredScopes)
    },
  }
}
