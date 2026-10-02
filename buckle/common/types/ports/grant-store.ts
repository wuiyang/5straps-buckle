import type { GrantRecord, GrantScope, PermissionRuleId } from '@5straps/protocol'

export interface GrantStore {
  /** Exact subjects currently granted for a rule, filtered to this session and to unexpired records. */
  activeSubjects(input: { sessionId: string; rule: PermissionRuleId }): string[]
  /** Host patterns granted with `buckle approve --host`, under the same filters. */
  activePatterns(input: { sessionId: string; rule: PermissionRuleId }): string[]
  grant(input: {
    sessionId: string
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
