import type { GrantRecord, GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { GrantHolder } from '../../domain/permission/grant-holder.js'

/** Which sessions end: one session id, whichever actor asked in it, or every session of the workspace. */
export type SessionEnding = { sessionId: string } | { allSessions: true }

/**
 * `sessionsFrom`: where set, a session approval made before it clears nothing, as while the workspace's activity cannot be
 * read; an always grant and every denial still stand.
 */
interface StandingFilter { sessionsFrom?: number }

export interface GrantStore {
  /** The workspace whose grants it holds, by id; the approval ledger is keyed by the same id. */
  readonly workspace: string
  /** Exact subjects currently granted for a rule, filtered to this holder, to unexpired records, and to `scopes` where named. */
  activeSubjects(input: GrantHolder & StandingFilter & { rule: PermissionRuleId; scopes?: readonly GrantScope[] }): string[]
  /** Host patterns granted with `buckle approve --host`, under the same filters. */
  activePatterns(input: GrantHolder & StandingFilter & { rule: PermissionRuleId }): string[]
  grant(input: {
    /** The id an owed decision named for it, so writing it again keeps the record a revoke names; a fresh one otherwise. */
    id?: string
    sessionId: string
    /** The actor a session grant serves; an always grant serves every actor. */
    actor?: string
    rule: PermissionRuleId
    subject: string
    scope: GrantScope
    denied?: boolean
    pattern?: boolean
    /** key:<fingerprint> when a person's enrolled key signed the decision that made it. */
    decidedBy?: string
  }): Promise<GrantRecord>
  list(): GrantRecord[]
  revoke(id: string): Promise<boolean>
  /** Removes the session grants, approvals and denials alike, of the sessions that end, returning what it removed. */
  endSessions(ending: SessionEnding): Promise<GrantRecord[]>
}

/** The grants as every caller holds them: a session ends through the approval service alone, which ends its asks with it. */
export type LedgerGrants = Omit<GrantStore, 'endSessions'>
