import type { GrantRecord } from '@5straps/protocol'

/** Whose standing grants a lookup reads: an always grant serves every actor, a session grant the actor that asked in it. */
export interface GrantHolder {
  sessionId: string
  /** The identity the call's transport authenticated; absent for the node's own process. */
  actor?: string
}

export function servesHolder(grant: Pick<GrantRecord, 'sessionId' | 'actor'>, holder: GrantHolder): boolean {
  return grant.sessionId === null || (grant.sessionId === holder.sessionId && grant.actor === (holder.actor ?? null))
}
