import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GrantRecordSchema, type GrantRecord, type PermissionRuleId } from '@5straps/protocol'
import type { GrantLookup } from '../../domain/permission/decision.js'
import type { GrantStore } from '../../ports/grant-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({ version: z.literal(1), grants: z.array(GrantRecordSchema) })

/**
 * Grants live in one JSON file per machine, keyed by workspace. 'once' grants are never written
 * here; the approval registry holds them and consumes them on a single retry.
 *
 * Every operation reads the file rather than caching it. `buckle approve` runs as its own
 * process, so a server that cached grants at startup would never see an approval a person just
 * granted in a terminal, and would ask again forever. The file is small and the read is cheap
 * next to the work a tool call does.
 */
export function createFileGrantStore(input: { filePath: string; workspace: string }): GrantStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, grants: [] } })

  const load = (): GrantRecord[] => store.read().grants

  const active = (sessionId: string, rule: PermissionRuleId): GrantRecord[] => {
    const now = Date.now()
    return load()
      .filter(grant => grant.workspace === input.workspace && grant.rule === rule)
      .filter(grant => grant.sessionId === null || grant.sessionId === sessionId)
      .filter(grant => !grant.expiresAt || Date.parse(grant.expiresAt) > now)
  }

  return {
    activeSubjects: ({ sessionId, rule }) => active(sessionId, rule).filter(grant => !grant.pattern && !grant.denied && rule !== 'sensitive_path').map(grant => grant.subject),

    activePatterns: ({ sessionId, rule }) => active(sessionId, rule).filter(grant => grant.pattern && !grant.denied).map(grant => grant.subject),

    grant({ sessionId, rule, subject, scope, pattern, denied }) {
      const record: GrantRecord = {
        id: randomUUID(),
        workspace: input.workspace,
        rule,
        subject,
        scope,
        ...(denied ? { denied: true } : {}),
        ...(pattern ? { pattern: true as const } : {}),
        sessionId: scope === 'always' ? null : sessionId,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      }
      if (scope === 'once') throw new Error('Once grants belong to the approval registry')
      store.update(state => { state.grants = [...state.grants.filter(existing => !isSameSubject(existing, record)), record] })
      return record
    },

    list: () => load().filter(grant => grant.workspace === input.workspace),

    revoke(id) {
      return store.update(state => {
        const next = state.grants.filter(grant => grant.id !== id || grant.workspace !== input.workspace)
        const changed = next.length !== state.grants.length
        state.grants = next
        return changed
      })
    },

    endSession(sessionId) {
      store.update(state => { state.grants = state.grants.filter(grant => grant.workspace !== input.workspace || grant.sessionId !== sessionId) })
    },
  }
}

function isSameSubject(left: GrantRecord, right: GrantRecord): boolean {
  return left.workspace === right.workspace && left.rule === right.rule && left.subject === right.subject && left.scope === right.scope
    && left.sessionId === right.sessionId && Boolean(left.pattern) === Boolean(right.pattern)
}

export function createGrantLookup(store: GrantStore, sessionId: string): GrantLookup {
  return {
    deniedSubjectsFor: rule => deniedSubjects(store, sessionId, rule),
    subjectsFor: rule => store.activeSubjects({ sessionId, rule }),
    patternsFor: rule => store.activePatterns({ sessionId, rule }),
  }
}

export function deniedSubjects(store: GrantStore, sessionId: string, rule: PermissionRuleId): string[] {
  return store.list().filter(record => record.denied && record.rule === rule && (record.sessionId === null || record.sessionId === sessionId) && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())).map(record => record.subject)
}
