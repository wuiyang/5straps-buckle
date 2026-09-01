import type { GrantRecord, GrantScope, PermissionRuleId } from '@5straps/protocol'

export interface GrantStore {
  /** Subjects currently granted for a rule, filtered to this session and to unexpired records. */
  activeSubjects(input: { sessionId: string; rule: PermissionRuleId }): string[]
  grant(input: {
    sessionId: string
    rule: PermissionRuleId
    subject: string
    scope: GrantScope
  }): GrantRecord
  list(): GrantRecord[]
  revoke(id: string): boolean
  /** Drops 'once' grants that were consumed and any session grants for a finished session. */
  endSession(sessionId: string): void
}
