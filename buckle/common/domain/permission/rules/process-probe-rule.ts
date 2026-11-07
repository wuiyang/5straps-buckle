import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, PLAIN_MARKS } from '../decision.js'

const SUBJECT = 'process_list'

/** Enumerating other processes leaks command lines, so it is gated even though it only reads. */
export function createProcessProbeRule(): PermissionRule {
  return {
    id: 'process_probe',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'process_probe') return null
      if (grants.subjectsFor('process_probe').includes(SUBJECT)) return allowedVia('process_probe', SUBJECT)
      return ask({ rule: 'process_probe', subject: SUBJECT, reason: 'Listing running processes exposes other users command lines', marks: PLAIN_MARKS, offeredScopes: ['once', 'session'] })
    },
  }
}
