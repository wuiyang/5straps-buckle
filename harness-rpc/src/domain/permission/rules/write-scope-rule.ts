import { isInside, isInsideAny } from '../../paths.js'
import type { GrantScope } from '@5straps/protocol'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask } from '../decision.js'

export interface WriteScopeOptions {
  /** Directories writable without asking. Empty by default, so the first write anywhere asks. */
  scratchRoots: string[]
  /** Strict mode refuses to persist write grants, so every directory asks every session. */
  strict: boolean
}

export function createWriteScopeRule({ scratchRoots, strict }: WriteScopeOptions): PermissionRule {
  const offeredScopes: GrantScope[] = strict ? ['once'] : ['once', 'session', 'always']

  return {
    id: 'write_scope',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'write_path') return null
      if (isInsideAny(scratchRoots, effect.path)) return { kind: 'allow' }

      const granted = grants.subjectsFor('write_scope').find(root => isInside(root, effect.path))
      if (granted) return allowedVia('write_scope', granted)
      return ask('write_scope', effect.directory, `Writing to ${effect.directory} is not yet approved`, offeredScopes)
    },
  }
}
