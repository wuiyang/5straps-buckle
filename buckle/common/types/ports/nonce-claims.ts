import type { NonceStore } from '@5straps/protocol/envelope'

/** Opening a sealed decision or a signed request runs inside `withClaims`: the protocol's claim stays synchronous, over locked state. */
export interface NonceClaims {
  withClaims<T>(use: (seen: NonceStore) => T): Promise<T>
}
