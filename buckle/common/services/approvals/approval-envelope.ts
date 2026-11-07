import { approvalDecisionPath, createMemoryNonceStore, EnvelopeError, looksSealed, open, type ApprovalKey, type EnvelopeRefusal, type NonceStore } from '@5straps/protocol/envelope'
import type { NonceClaims } from '../../types/ports/nonce-claims.js'

/** Why a decision body was refused: an envelope that failed, or a plain body once a key is paired. */
export type DecisionRefusal = EnvelopeRefusal | 'plain_refused'

export type OpenedDecision = { ok: true; body: unknown } | { ok: false; reason: DecisionRefusal }

/**
 * `RINGS-D20`: a decision from Rings arrives sealed once this node holds the key minted at
 * pairing, and plain before then. A node with a key refuses a plain body; a node without one
 * cannot open an envelope and says so, which is the cue to pair again.
 */
export function openApprovalDecision(input: { key: ApprovalKey | undefined; body: unknown; workspaceId: string; seen: NonceStore; now?: number }): OpenedDecision {
  const sealed = looksSealed(input.body)
  if (!input.key) return sealed ? { ok: false, reason: 'unknown_key' } : { ok: true, body: input.body }
  if (!sealed) return { ok: false, reason: 'plain_refused' }
  try {
    return { ok: true, body: open(input.key, input.body, { method: 'POST', path: approvalDecisionPath(input.workspaceId), now: input.now ?? Date.now(), seen: input.seen }) }
  } catch (error) {
    if (error instanceof EnvelopeError) return { ok: false, reason: error.reason }
    throw error
  }
}

/** Without a paired key nothing is opened, so nothing needs to outlive the process. */
export function createMemoryNonceClaims(): NonceClaims {
  const seen = createMemoryNonceStore()
  return { withClaims: async use => use(seen) }
}
