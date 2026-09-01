import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ApprovalRequestSchema,
  GrantSubjectSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type GrantSubject,
  type PermissionRuleId,
} from '@5straps/protocol'
import { createJsonFileStore } from '../adapters/json-file-store.js'
import type { PermissionDecision } from '../domain/permission/decision.js'
import type { GrantStore } from '../ports/grant-store.js'
import { logger } from '../logger.js'

const PENDING_TTL_MS = 10 * 60_000

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string() })
const fileSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  once: z.array(z.object({ token: z.string(), subject: GrantSubjectSchema })),
})

type PendingApproval = z.infer<typeof pendingSchema>

export interface ApprovalRegistry {
  issue(input: { tool: string; sessionId: string; asks: Ask[] }): ApprovalRequest[]
  resolve(decision: ApprovalDecision): { ok: true } | { ok: false; reason: string }
  /** Subjects unlocked by 'once' approvals whose token the caller replayed. Consumed on read. */
  consume(tokens: string[]): GrantSubject[]
  pending(): ApprovalRequest[]
}

/**
 * Approvals always end as grants. A 'once' approval is held until the retry that replays its
 * token; 'session' and 'always' go straight to the grant store.
 *
 * State is persisted because each CLI invocation is its own process: the call that reports
 * `approval_required` has already exited by the time `buckle approve` runs.
 */
export function createApprovalRegistry(grants: GrantStore, filePath: string): ApprovalRegistry {
  const store = createJsonFileStore({
    filePath,
    schema: fileSchema,
    fallback: { version: 1 as const, pending: [], once: [] },
  })

  const load = (): { pending: Map<string, PendingApproval>; once: Map<string, GrantSubject> } => {
    const state = store.read()
    return {
      pending: new Map(state.pending.map(entry => [entry.request.token, entry])),
      once: new Map(state.once.map(entry => [entry.token, entry.subject])),
    }
  }

  const save = (state: { pending: Map<string, PendingApproval>; once: Map<string, GrantSubject> }): void => {
    const now = Date.now()
    store.write({
      version: 1,
      pending: [...state.pending.values()].filter(entry => Date.parse(entry.request.expiresAt) > now),
      once: [...state.once].map(([token, subject]) => ({ token, subject })),
    })
  }

  return {
    issue({ tool, sessionId, asks }) {
      const state = load()
      const issued = asks.map(item => {
        const request: ApprovalRequest = {
          token: randomUUID(),
          rule: item.rule,
          subject: item.subject,
          reason: item.reason,
          tool,
          offeredScopes: item.offeredScopes,
          expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
        }
        state.pending.set(request.token, { request, sessionId })
        return request
      })
      save(state)
      return issued
    },

    resolve(decision) {
      const state = load()
      const approval = state.pending.get(decision.token)
      if (!approval) return { ok: false, reason: 'Approval token is unknown or expired' }
      if (!approval.request.offeredScopes.includes(decision.scope)) {
        return { ok: false, reason: `Scope ${decision.scope} is not offered for this approval` }
      }

      state.pending.delete(decision.token)
      if (!decision.approved) {
        save(state)
        return { ok: true }
      }

      const { rule, subject } = approval.request
      if (decision.scope === 'once') state.once.set(decision.token, { rule, subject })
      else grants.grant({ sessionId: approval.sessionId, rule, subject, scope: decision.scope })
      save(state)

      logger.info('Approval granted', { rule, subject, scope: decision.scope, tool: approval.request.tool })
      return { ok: true }
    },

    consume(tokens) {
      if (tokens.length === 0) return []
      const state = load()
      const subjects: GrantSubject[] = []
      for (const token of tokens) {
        const subject = state.once.get(token)
        if (!subject) continue
        state.once.delete(token)
        subjects.push(subject)
      }
      if (subjects.length > 0) save(state)
      return subjects
    },

    pending: () => [...load().pending.values()].map(approval => approval.request),
  }
}

export function subjectsByRule(subjects: GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
