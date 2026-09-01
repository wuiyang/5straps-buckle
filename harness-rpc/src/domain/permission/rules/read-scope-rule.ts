import { isInsideAny } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { ask } from '../decision.js'

/** Reads are free inside the workspace; anything else asks and, once approved, joins the sandbox. */
export function createReadScopeRule(workspaceRoots: string[]): PermissionRule {
  return {
    id: 'read_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path') return null
      const allowed = [...workspaceRoots, ...grants.subjectsFor('read_scope')]
      if (isInsideAny(allowed, effect.path)) return { kind: 'allow' }
      return ask('read_scope', effect.directory, `${effect.path} is outside the sandbox`)
    },
  }
}
