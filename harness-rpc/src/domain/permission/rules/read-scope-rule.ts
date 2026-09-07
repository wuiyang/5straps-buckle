import { outsideMountReason, type PathView } from '../../path-view.js'
import { isInside, isInsideAny } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

/**
 * Reads are free inside the workspace; anything else asks and, once approved, joins the sandbox.
 * With a mount there is nothing to ask about: a path that resolves outside the roots the view
 * names is refused, which is also what catches a symlink pointing off the workspace.
 */
export function createReadScopeRule({ paths }: { paths: PathView }): PermissionRule {
  const reachable = [paths.root, ...paths.scratchRoots]

  return {
    id: 'read_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path') return null
      if (isInside(paths.root, effect.path)) return { kind: 'allow' }
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
