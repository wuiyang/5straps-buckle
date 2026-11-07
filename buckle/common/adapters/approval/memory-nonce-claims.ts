import { createMemoryNonceStore } from '@5straps/protocol/envelope'
import type { NonceClaims } from '../../types/ports/nonce-claims.js'

/** Without a paired key nothing is opened, so nothing needs to outlive the process. */
export function createMemoryNonceClaims(): NonceClaims {
  const seen = createMemoryNonceStore()
  return { withClaims: async use => use(seen) }
}
