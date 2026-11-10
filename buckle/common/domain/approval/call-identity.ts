import { createHash } from 'node:crypto'
import { callIdentityKey, type CallIdentity } from '../call-identity.js'

/**
 * The name a call's hold gives its asks in the executing mark, which every process reads: the join key, hashed, so the
 * mark names the asks a re-send would join and holds no requestId.
 */
export function heldAskName(input: CallIdentity): string {
  return createHash('sha256').update(callIdentityKey(input)).digest('base64url')
}
