import type { GrantRecord, GrantScope, PermissionRuleId } from '@5straps/protocol'
import type { GrantHolder } from '../../domain/permission/grant-holder.js'

export interface GrantStore {
  /** The workspace whose grants it holds, by id; the approval ledger is keyed by the same id. */
  readonly workspace: string
  /** Exact subjects currently granted for a rule, filtered to this holder and to unexpired records. */
  activeSubjects(input: GrantHolder & { rule: PermissionRuleId }): string[]
  /** Host patterns granted with `buckle approve --host`, under the same filters. */
  activePatterns(input: GrantHolder & { rule: PermissionRuleId }): string[]
  grant(input: {
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
  /** Drops 'once' grants that were consumed and any session grants for a finished session. */
  endSession(sessionId: string): Promise<void>
}
