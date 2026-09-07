import { isInside, isInsideAny } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask } from '../decision.js'

/**
 * Reads are free inside the workspace; anything else asks and, once approved, joins the sandbox.
 * `displayRoots` is how the caller names those roots, which differs from the real ones when
 * the workspace is mounted.
 */
export function createReadScopeRule(workspaceRoots: string[], displayRoots: string[] = workspaceRoots): PermissionRule {
  return {
    id: 'read_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path') return null
      if (isInsideAny(workspaceRoots, effect.path)) return { kind: 'allow' }

      const granted = grants.subjectsFor('read_scope').find(root => isInside(root, effect.path))
      if (granted) return allowedVia('read_scope', granted)
      // Naming the roots turns a refusal into directions, for a caller that cannot read the manifest.
      return ask('read_scope', effect.directory, `${effect.path} is outside the sandbox. Readable without asking: ${displayRoots.join(', ')}`)
    },
  }
}
