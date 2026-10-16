import { outsideMountReason, type PathView } from '../../path-view.js'
import { isInside, isInsideAny } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

/**
 * Reads are free inside the workspace and inside each mount the owner shares into it (Phase 2 item 2); anything else
 * asks and, once approved, joins the sandbox. With a mount there is nothing to ask about: a path that resolves outside
 * the roots the view names is refused, which is also what catches a symlink pointing off the workspace.
 */
export function createReadScopeRule({ paths }: { paths: PathView }): PermissionRule {
  const reachable = paths.reachableRoots
  const shared = paths.mounts.filter(mount => !mount.scratch).map(mount => mount.source)

  return {
    id: 'read_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path') return null
      if (isInside(paths.root, effect.path) || isInsideAny(shared, effect.path)) return { kind: 'allow' }
      if (paths.mount && !isInsideAny(reachable, effect.path)) {
        return deny('read_scope', effect.path, outsideMountReason({ named: null, displayRoots: paths.displayRoots }))
      }

      const granted = grants.subjectsFor('read_scope').find(root => isInside(root, effect.path))
      if (granted) return allowedVia('read_scope', granted)
      // Naming the roots turns a refusal into directions, for a caller that cannot read the manifest.
      return ask('read_scope', effect.directory, `${paths.toVirtual(effect.path)} is outside the sandbox. Readable without asking: ${paths.displayRoot}`)
    },
  }
}
