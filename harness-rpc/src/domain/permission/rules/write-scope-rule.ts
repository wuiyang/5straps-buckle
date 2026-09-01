import { isInsideAny } from '../../paths.js'
import type { GrantScope } from '@5straps/protocol'
import type { PermissionRule } from '../decision.js'
import { ask } from '../decision.js'

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
      const allowed = [...scratchRoots, ...grants.subjectsFor('write_scope')]
      if (isInsideAny(allowed, effect.path)) return { kind: 'allow' }
      return ask('write_scope', effect.directory, `Writing to ${effect.directory} is not yet approved`, offeredScopes)
    },
  }
}
