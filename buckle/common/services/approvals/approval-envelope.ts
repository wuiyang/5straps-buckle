import { approvalDecisionPath, EnvelopeError, looksSealed, open, type ApprovalKey, type EnvelopeRefusal, type NonceStore } from '@5straps/protocol/envelope'

/** Why a decision body was refused: an envelope that failed, or a plain body once a key is paired. */
export type DecisionRefusal = EnvelopeRefusal | 'plain_refused'

/** `sealed`: the body came in an envelope, whose nonce opening it claimed. */
export type OpenedDecision = { ok: true; body: unknown; sealed: boolean } | { ok: false; reason: DecisionRefusal }

/**
 * `RINGS-D20`: a decision from Rings arrives sealed once this node holds the key minted at
 * pairing, and plain before then. A node with a key refuses a plain body; a node without one
 * cannot open an envelope and says so, which is the cue to pair again.
 */
export function openApprovalDecision(input: { key: ApprovalKey | undefined; body: unknown; workspaceId: string; seen: NonceStore; now?: number }): OpenedDecision {
  const sealed = looksSealed(input.body)
  if (!input.key) return sealed ? { ok: false, reason: 'unknown_key' } : { ok: true, body: input.body, sealed: false }
  if (!sealed) return { ok: false, reason: 'plain_refused' }
  try {
    return { ok: true, body: open(input.key, input.body, { method: 'POST', path: approvalDecisionPath(input.workspaceId), now: input.now ?? Date.now(), seen: input.seen }), sealed: true }
  } catch (error) {
    if (error instanceof EnvelopeError) return { ok: false, reason: error.reason }
    throw error
  }
}
