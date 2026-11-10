import { createHash } from 'node:crypto'
import type { InvokeRequest } from '@5straps/protocol'
import { canonicalJson } from '@5straps/protocol/signed-request'

/** The duration shared by replay, resumable joins, journals, and approval lapse; each owns its clock. */
export const CALL_REPLAY_WINDOW_MS = 10 * 60_000

export interface CallIdentity {
  sessionId: string
  actor?: string
  requestId: string
}

export function callIdentityKey(input: CallIdentity): string {
  return JSON.stringify([input.sessionId, input.actor ?? null, input.requestId])
}

/**
 * The key a requestId joins and dedupes under: a hash of the whole id, so two ids that share a
 * prefix never meet, and a long id stores as 64 characters (review L2 of B18-B19).
 */
export function requestIdKey(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex')
}

/** The same call's fingerprint whatever order its arguments' keys arrive in. */
export function requestFingerprint(request: Pick<InvokeRequest, 'tool' | 'args'>): string {
  return createHash('sha256').update(canonicalJson([request.tool, request.args])).digest('hex')
}

/**
 * The key a script's calls are named under, `code:<key>:<call number>` (owner decision D82, point 4), and its replay
 * journal is filed under: the session, the actor, and the outer call's tool and what names its script, hashed.
 */
export function nestedCallKey(key: Pick<CallIdentity, 'sessionId' | 'actor'> & { fingerprint: string }): string {
  return createHash('sha256').update(JSON.stringify([key.sessionId, key.actor ?? null, key.fingerprint])).digest('hex')
}
