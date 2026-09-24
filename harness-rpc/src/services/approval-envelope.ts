import { approvalDecisionPath, EnvelopeError, looksSealed, open, seal, type ApprovalKey, type EnvelopeRefusal, type NonceStore } from '@5straps/protocol/envelope'

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

/** What a report to Rings carries: sealed for its route once the node holds a key, plain before. */
export function sealForRings(key: ApprovalKey | undefined, path: string, body: unknown): unknown {
  return key ? seal(key, { method: 'POST', path, body }) : body
}
