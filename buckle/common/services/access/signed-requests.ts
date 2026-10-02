import { checkSignedRequest, nonceClaim, withinWindow, type SignedRequestPurpose, type SignedRequestVerdict } from '@5straps/protocol/signed-request'
import type { NonceClaims } from '../../adapters/approval/file-nonce-store.js'
import type { ClientKeys } from '../../types/ports/client-keys.js'
import { requestIdKey } from '../invocation/executions.js'

export interface SignedRequestInput {
  /** Opaque transport request identity; proof metadata remains private to this node verifier. */
  requestIdentity?: object
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
  approvalProofDeadline(request: object): number | undefined
}

/**
 * One verifier per node (owner ruling H4 of 2026-09-28): the enrolled keys and their scopes, this
 * node's serverId and signing key fingerprint (owner decision D11), and the seen-nonce store the
 * sealed approvals use. Everything but the nonce is checked outside that store's lock; only a
 * request that passed takes it, to claim its nonce (review L10 of B23-B25), so a flood of malformed
 * or forged headers never rewrites the store or queues a genuine request behind it. A nonce is kept
 * under the requestId hash (executions.ts), so what is stored is bounded whatever a caller sends.
 * The claim judges the window again with its own clock: a claim that waited past it would prune the
 * nonce a replay needs to find, so it is refused as expired (review item 3 of the proof-of-possession fixes).
 */
export function createRequestVerifier(input: { keys: ClientKeys; nonces: NonceClaims; serverId: string; nodeKeyId: string; now?: () => number }): RequestVerifier {
  const now = input.now ?? Date.now
  const approvalProofDeadlines = new WeakMap<object, number>()
  return {
    approvalProofDeadline: request => approvalProofDeadlines.get(request),
    async verify(request) {
      if (request.requestIdentity) approvalProofDeadlines.delete(request.requestIdentity)
      const checked = checkSignedRequest({
        authorization: request.authorization,
        expected: { purpose: request.purpose, node: input.serverId, nodeKey: input.nodeKeyId, workspace: request.workspaceId, method: request.method, path: request.path },
        body: request.body,
        now: now(),
        publicKeyFor: payload => input.keys.publicKeyFor(payload.keyId, { purpose: request.purpose, workspace: request.workspaceId, registry: request.registry }),
      })
      if (!checked.ok) return checked
      const { keyId, nonce, keepUntil } = nonceClaim(checked.payload)
      // The clock is read again under the lock, so both the window and what is pruned are judged at the claim.
      const claimed = await input.nonces.withClaims((seen) => {
        const at = now()
        if (!withinWindow(checked.payload, at)) return 'expired'
        return seen.claim({ keyId, nonce: requestIdKey(nonce), ts: keepUntil, now: at }) ? 'claimed' : 'replayed'
      })
      if (claimed !== 'claimed') return { ok: false, reason: claimed, claimedKeyId: keyId }
      if (request.requestIdentity && request.purpose === 'buckle-approval') approvalProofDeadlines.set(request.requestIdentity, checked.payload.expiresAt)
      return checked
    },
  }
}
