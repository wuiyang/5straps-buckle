import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApprovalDecisionSchema, ApprovalRequestSchema, GrantSubjectSchema, type ApprovalDecision, type ApprovalRequest, type GrantSubject, type PermissionRuleId } from '@5straps/protocol'
import { createJsonFileStore } from '../adapters/json-file-store.js'
import type { PermissionDecision } from '../domain/permission/decision.js'
import type { PermissionOutcome } from '../domain/permission/engine.js'
import type { ApprovalAuthority } from '../ports/approval-channel.js'
import type { GrantStore } from '../ports/grant-store.js'
import { logger } from '../logger.js'

const PENDING_TTL_MS = 10 * 60_000

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string(), workspace: z.string().optional() })
const onceSchema = z.object({
  workspace: z.string().optional(), token: z.string(), subject: GrantSubjectSchema,
  sessionId: z.string().optional(), tool: z.string().optional(), expiresAt: z.string().optional(),
})
const fileSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  once: z.array(onceSchema),
  resolved: z.array(z.object({ workspace: z.string().optional(), decision: ApprovalDecisionSchema, expiresAt: z.string() })).default([]),
})
type State = z.infer<typeof fileSchema>

export interface ApprovalRegistry {
  issue(input: { tool: string; sessionId: string; asks: Ask[] }): ApprovalRequest[]
  /**
   * `BUCKLE-D14`: a decision that outlives the call is written under the admin credential
   * alone. An `agent` authority may answer `once`, which expires with the call it unblocks.
   * The default names the owner, because every caller but the agent-facing MCP face reaches
   * this from the owner's own process or from behind the admin credential.
   */
  resolve(decision: ApprovalDecision, authority?: ApprovalAuthority): { ok: true } | { ok: false; reason: string }
  evaluate(input: {
    tokens: string[]; sessionId: string; tool: string
    check: (subjects: GrantSubject[]) => PermissionOutcome
  }): PermissionOutcome
  pending(): ApprovalRequest[]
}

export function createApprovalRegistry(grants: GrantStore, filePath: string, workspace = filePath): ApprovalRegistry {
  const store = createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1, pending: [], once: [], resolved: [] } })

  return {
    issue({ tool, sessionId, asks }) {
      return store.update(state => {
        prune(state)
        const requests = asks.map(item => ({
          token: randomUUID(), rule: item.rule, subject: item.subject, reason: item.reason,
          tool, offeredScopes: item.offeredScopes, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
        }))
        state.pending.push(...requests.map(request => ({ request, sessionId, workspace })))
        return requests
      })
    },

    resolve(decision, authority = 'admin') {
      if (decision.approved && decision.scope !== 'once' && authority !== 'admin') {
        logger.warn('Persisted approval refused: only the admin credential writes one', { scope: decision.scope })
        return { ok: false, reason: 'Only the admin credential writes an approval that outlives the call' }
      }
      return store.update(state => {
        prune(state)
        const previous = state.resolved.find(entry => entry.workspace === workspace && entry.decision.token === decision.token)
        if (previous) {
          return previous.decision.approved === decision.approved && previous.decision.scope === decision.scope
            ? { ok: true as const }
            : { ok: false as const, reason: 'Approval already has a different decision' }
        }
        const approval = state.pending.find(entry => entry.workspace === workspace && entry.request.token === decision.token)
        if (!approval) return { ok: false as const, reason: 'Approval token is unknown or expired' }
        if (decision.approved && !approval.request.offeredScopes.includes(decision.scope)) {
          return { ok: false as const, reason: `Scope ${decision.scope} is not offered for this approval` }
        }
        if (decision.approved) {
          const { rule, subject, tool, expiresAt } = approval.request
          if (decision.scope === 'once') state.once.push({ workspace, token: decision.token, subject: { rule, subject }, sessionId: approval.sessionId, tool, expiresAt })
          else grants.grant({ sessionId: approval.sessionId, rule, subject, scope: decision.scope })
          logger.info('Approval granted', { rule, subject, scope: decision.scope, tool })
        }
        state.pending = state.pending.filter(entry => entry.request.token !== decision.token)
        state.resolved.push({ workspace, decision, expiresAt: approval.request.expiresAt })
        return { ok: true as const }
      })
    },

    evaluate({ tokens, sessionId, tool, check }) {
      return store.update(state => {
        prune(state)
        const usable = state.once.filter(entry => entry.workspace === workspace && tokens.includes(entry.token) && entry.sessionId === sessionId && entry.tool === tool)
        const outcome = check(usable.map(entry => entry.subject))
        // Keep partial approvals until every gate clears; consume under the same process lock.
        if (outcome.kind === 'allow') {
          const used = new Set(usable.map(entry => entry.token))
          state.once = state.once.filter(entry => !used.has(entry.token))
        }
        return outcome
      })
    },

    pending: () => store.read().pending.filter(entry => entry.workspace === workspace && Date.parse(entry.request.expiresAt) > Date.now()).map(entry => entry.request),
  }
}

function prune(state: State): void {
  const now = Date.now()
  state.pending = state.pending.filter(entry => Date.parse(entry.request.expiresAt) > now)
  // Legacy once records had no session/expiry binding; require a fresh owner decision.
  state.once = state.once.filter(entry => entry.sessionId && entry.tool && entry.expiresAt && Date.parse(entry.expiresAt) > now)
  state.resolved = state.resolved.filter(entry => Date.parse(entry.expiresAt) > now)
}

export function subjectsByRule(subjects: GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
