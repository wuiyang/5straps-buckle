import { checkSignedRequest, nonceClaim, type SignedRequestPurpose, type SignedRequestVerdict } from '@5straps/protocol/signed-request'
import type { NonceClaims } from '../../adapters/approval/file-nonce-store.js'
import type { ClientKeys } from '../../types/ports/client-keys.js'
import { requestIdKey } from '../invocation/executions.js'

export interface SignedRequestInput {
  authorization: string | undefined
  purpose: SignedRequestPurpose
  workspaceId: string
  /** A change to the node's workspace registry, which only a node-scoped key signs (owner decision D10). */
  registry: boolean
  method: string
  /** The path and query as requested. */
  path: string
  /** The body exactly as it arrived. */
  body: Uint8Array
}

/** Verifies the requests a person's client signed, for the setup and approval guards. */
export interface RequestVerifier {
  verify(input: SignedRequestInput): Promise<SignedRequestVerdict>
}

/**
 * One verifier per node (owner ruling H4 of 2026-09-28): the enrolled keys and their scopes, this
 * node's serverId and signing key fingerprint (owner decision D11), and the seen-nonce store the
 * sealed approvals use. Everything but the nonce is checked outside that store's lock; only a
 * request that passed takes it, to claim its nonce (review L10 of B23-B25), so a flood of malformed
 * or forged headers never rewrites the store or queues a genuine request behind it. A nonce is kept
 * under the requestId hash (executions.ts), so what is stored is bounded whatever a caller sends.
 */
export function createRequestVerifier(input: { keys: ClientKeys; nonces: NonceClaims; serverId: string; nodeKeyId: string; now?: () => number }): RequestVerifier {
  const now = input.now ?? Date.now
  return {
    async verify(request) {
      const checked = checkSignedRequest({
        authorization: request.authorization,
        expected: { purpose: request.purpose, node: input.serverId, nodeKey: input.nodeKeyId, workspace: request.workspaceId, method: request.method, path: request.path },
        body: request.body,
        now: now(),
        publicKeyFor: payload => input.keys.publicKeyFor(payload.keyId, { purpose: request.purpose, workspace: request.workspaceId, registry: request.registry }),
      })
      if (!checked.ok) return checked
      const { keyId, nonce, keepUntil } = nonceClaim(checked.payload)
      // The clock is read again under the lock, so what is pruned is judged at the claim.
      const claimed = await input.nonces.withClaims(seen => seen.claim({ keyId, nonce: requestIdKey(nonce), ts: keepUntil, now: now() }))
      return claimed ? checked : { ok: false, reason: 'replayed', claimedKeyId: keyId }
    },
  }
}
