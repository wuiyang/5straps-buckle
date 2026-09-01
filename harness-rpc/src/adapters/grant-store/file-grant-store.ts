import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GrantRecordSchema, type GrantRecord, type PermissionRuleId } from '@5straps/protocol'
import type { GrantStore } from '../../ports/grant-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({ version: z.literal(1), grants: z.array(GrantRecordSchema) })

/**
 * Grants live in one JSON file per machine, keyed by workspace. 'once' grants are never
 * written; they exist only for the invocation that created them.
 */
export function createFileGrantStore(input: { filePath: string; workspace: string }): GrantStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, grants: [] } })
  let grants = store.read().grants

  const persist = (): void => store.write({ version: 1, grants: grants.filter(isPersistable) })

  return {
    activeSubjects({ sessionId, rule }) {
      const now = Date.now()
      return grants
        .filter(grant => grant.workspace === input.workspace && grant.rule === rule)
        .filter(grant => grant.sessionId === null || grant.sessionId === sessionId)
        .filter(grant => !grant.expiresAt || Date.parse(grant.expiresAt) > now)
        .map(grant => grant.subject)
    },

    grant({ sessionId, rule, subject, scope }) {
      const record: GrantRecord = {
        id: randomUUID(),
        workspace: input.workspace,
        rule,
        subject,
        scope,
        sessionId: scope === 'always' ? null : sessionId,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      }
      grants = [...grants.filter(existing => !isSameSubject(existing, record)), record]
      if (isPersistable(record)) persist()
      return record
    },

    list: () => grants.filter(grant => grant.workspace === input.workspace),

    revoke(id) {
      const next = grants.filter(grant => grant.id !== id)
      if (next.length === grants.length) return false
      grants = next
      persist()
      return true
    },

    endSession(sessionId) {
      grants = grants.filter(grant => grant.sessionId !== sessionId)
      persist()
    },
  }
}

/** 'once' grants live in the approvals file and are consumed by a single retry. */
function isPersistable(grant: GrantRecord): boolean {
  return grant.scope === 'always' || grant.scope === 'session'
}

function isSameSubject(left: GrantRecord, right: GrantRecord): boolean {
  return left.workspace === right.workspace && left.rule === right.rule && left.subject === right.subject
}


export function createGrantLookup(store: GrantStore, sessionId: string): { subjectsFor(rule: PermissionRuleId): string[] } {
  return { subjectsFor: rule => store.activeSubjects({ sessionId, rule }) }
}
