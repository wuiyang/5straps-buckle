import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GrantRecordSchema, type GrantRecord, type PermissionRuleId } from '@5straps/protocol'
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
  const save = (grants: GrantRecord[]): void => store.write({ version: 1, grants: grants.filter(isPersistable) })

  return {
    activeSubjects({ sessionId, rule }) {
      const now = Date.now()
      return load()
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
      save([...load().filter(existing => !isSameSubject(existing, record)), record])
      return record
    },

    list: () => load().filter(grant => grant.workspace === input.workspace),

    revoke(id) {
      const grants = load()
      const next = grants.filter(grant => grant.id !== id)
      if (next.length === grants.length) return false
      save(next)
      return true
    },

    endSession(sessionId) {
      save(load().filter(grant => grant.sessionId !== sessionId))
    },
  }
}

/** 'once' never reaches this store, but the filter keeps that invariant true if it ever did. */
function isPersistable(grant: GrantRecord): boolean {
  return grant.scope === 'always' || grant.scope === 'session'
}

function isSameSubject(left: GrantRecord, right: GrantRecord): boolean {
  return left.workspace === right.workspace && left.rule === right.rule && left.subject === right.subject
}

export function createGrantLookup(store: GrantStore, sessionId: string): { subjectsFor(rule: PermissionRuleId): string[] } {
  return { subjectsFor: rule => store.activeSubjects({ sessionId, rule }) }
}
