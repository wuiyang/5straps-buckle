import type { GrantRecord } from '@5straps/protocol'
import type { SessionEnding } from '../../types/ports/grant-store.js'

/** Whose standing grants a lookup reads: an always grant serves every actor, a session grant the actor that asked in it. */
export interface GrantHolder {
  sessionId: string
  /** The identity the call's transport authenticated; absent for the node's own process. */
  actor?: string
}

export function servesHolder(grant: Pick<GrantRecord, 'sessionId' | 'actor'>, holder: GrantHolder): boolean {
  return grant.sessionId === null || (grant.sessionId === holder.sessionId && grant.actor === (holder.actor ?? null))
}

/** One session, as a map keys it: its id under the actor that asked in it. */
export function holderKey(holder: GrantHolder): string {
  return JSON.stringify([holder.sessionId, holder.actor ?? null])
}

/** A session as it is named, its actor left out where none asked, from an entry or a grant that may name one. */
export function sessionOf(entry: { sessionId: string; actor?: string | null | undefined }): GrantHolder {
  return entry.actor === undefined || entry.actor === null ? { sessionId: entry.sessionId } : { sessionId: entry.sessionId, actor: entry.actor }
}

/**
 * Whether a grant is a session approval while session approvals are suspended, so it clears nothing: while a workspace's
 * activity cannot be read, its session may have ended unseen. A denial binds whatever.
 */
export function suspendedSessionApproval(grant: Pick<GrantRecord, 'scope' | 'denied'>, suspended: boolean | undefined): boolean {
  return suspended === true && grant.scope === 'session' && grant.denied !== true
}

/** Whether a grant ends with these sessions: a session grant of one of them, made by `endedAt` where that is named. */
export function endsWithSessions(grant: Pick<GrantRecord, 'scope' | 'sessionId' | 'actor' | 'createdAt'>, ending: SessionEnding, endedAt?: string): boolean {
  if (grant.scope !== 'session' || grant.sessionId === null) return false
  return endsSession(ending, sessionOf({ sessionId: grant.sessionId, actor: grant.actor })) && (endedAt === undefined || Date.parse(grant.createdAt) <= Date.parse(endedAt))
}

/** Whether a session is one of those that end: under the id a face ends, every caller's; else the very session named. */
export function endsSession(ending: SessionEnding, session: GrantHolder): boolean {
  if ('allSessions' in ending) return true
  if ('sessionId' in ending) return ending.sessionId === session.sessionId
  const key = holderKey(session)
  return ending.sessions.some(named => holderKey(named) === key)
}
