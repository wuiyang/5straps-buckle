import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APPROVAL_NO_DEADLINE, ApprovalDecisionSchema, ApprovalRequestSchema, GrantSubjectSchema, type ApprovalDecision, type ApprovalRequest, type GrantSubject, type PermissionRuleId } from '@5straps/protocol'
import { createJsonFileStore } from '../adapters/json-file-store.js'
import type { PermissionDecision } from '../domain/permission/decision.js'
import type { PermissionOutcome } from '../domain/permission/engine.js'
import type { ApprovalAuthority } from '../ports/approval-channel.js'
import type { GrantStore } from '../ports/grant-store.js'
import { compileHostPattern, UrlPatternError } from '../domain/url-pattern.js'
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
  resolved: z.array(z.object({ workspace: z.string().optional(), decision: ApprovalDecisionSchema, widenedTo: z.string().optional(), expiresAt: z.string() })).default([]),
})
type State = z.infer<typeof fileSchema>
type OnceEntry = z.infer<typeof onceSchema>

/**
 * `widenTo` records a network approval for a host pattern instead of the host that asked, per
 * `BUCKLE-D18: A host wildcard covers the apex and every subdomain, in lists and grants alike`.
 * It is a separate argument rather than a field of the decision, so no decision an agent or a
 * relay sends can carry one: `buckle approve --host` is the only caller that passes it.
 */
export interface ResolveOptions {
  widenTo?: string
}

/** On a widened grant, the pattern recorded and the host it was asked for, for the audit entry. */
export type Resolution = { ok: true; widened?: { pattern: string; askedBy: string } } | { ok: false; reason: string }

export interface ApprovalRegistry {
  issue(input: { tool: string; sessionId: string; asks: Ask[] }): ApprovalRequest[]
  /**
   * `BUCKLE-D14`: a decision that outlives the call is written under the admin credential
   * alone. An `agent` authority may answer `once`, which expires with the call it unblocks.
   * The default names the owner, because every caller but the agent-facing MCP face reaches
   * this from the owner's own process or from behind the admin credential.
   */
  resolve(decision: ApprovalDecision, authority?: ApprovalAuthority, options?: ResolveOptions): Resolution
  evaluate(input: {
    tokens: string[]; sessionId: string; tool: string
    check: (subjects: GrantSubject[]) => PermissionOutcome
  }): PermissionOutcome
  wasDenied(tokens: string[]): boolean
  cancel(tokens: string[]): void
  pending(): ApprovalRequest[]
  /** One session's `once` approvals not yet spent, each still bound to the tool it was asked for. */
  unspent(sessionId: string): Array<{ subject: GrantSubject; tool: string }>
}

export function createApprovalRegistry(grants: GrantStore, filePath: string, workspace = filePath, waitMs: number | null = 0): ApprovalRegistry {
  const store = createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1, pending: [], once: [], resolved: [] } })

  return {
    issue({ tool, sessionId, asks }) {
      return store.update(state => {
        prune(state)
        const requests = asks.map(item => ({
          token: randomUUID(), rule: item.rule, subject: item.subject, reason: item.reason,
          tool, offeredScopes: item.offeredScopes, expiresAt: waitMs === null ? APPROVAL_NO_DEADLINE : new Date(Date.now() + PENDING_TTL_MS + waitMs).toISOString(),
        }))
        state.pending.push(...requests.map(request => ({ request, sessionId, workspace })))
        return requests
      })
    },

    resolve(decision, authority = 'admin', options = {}) {
      if (decision.scope !== 'once' && authority !== 'admin') {
        logger.warn('Persisted approval refused: only the admin credential writes one', { scope: decision.scope })
        return { ok: false, reason: 'Only the admin credential writes an approval that outlives the call' }
      }
      const widening = options.widenTo === undefined ? null : checkWidening({ pattern: options.widenTo, decision, authority })
      if (widening && !widening.ok) return widening
      return store.update((state): Resolution => {
        prune(state)
        const widenedTo = widening?.pattern
        const previous = state.resolved.find(entry => entry.workspace === workspace && entry.decision.token === decision.token)
        if (previous) {
          return previous.decision.approved === decision.approved && previous.decision.scope === decision.scope && previous.widenedTo === widenedTo
            ? { ok: true }
            : { ok: false, reason: 'Approval already has a different decision' }
        }
        const approval = state.pending.find(entry => entry.workspace === workspace && entry.request.token === decision.token)
        if (!approval) return { ok: false, reason: 'Approval token is unknown or expired' }
        if (decision.approved && !approval.request.offeredScopes.includes(decision.scope)) {
          return { ok: false, reason: `Scope ${decision.scope} is not offered for this approval` }
        }
        const { rule, subject, tool } = approval.request
        if (rule === 'sensitive_path' && decision.approved && decision.scope !== 'once') return { ok: false, reason: 'Sensitive files can only be allowed once' }
        if (!decision.approved && decision.scope !== 'once' && rule !== 'sensitive_path') return { ok: false, reason: 'Persistent denials are supported only for sensitive files' }
        const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString()
        if (widenedTo) {
          const refusal = patternRefusal({ rule, subject, pattern: widenedTo })
          if (refusal) return { ok: false, reason: refusal }
        }
        if (decision.approved) {
          if (decision.scope === 'once') state.once.push({ workspace, token: decision.token, subject: { rule, subject }, sessionId: approval.sessionId, tool, expiresAt })
          else grants.grant({ sessionId: approval.sessionId, rule, subject: widenedTo ?? subject, scope: decision.scope, ...(widenedTo ? { pattern: true } : {}) })
          logger.info('Approval granted', { rule, subject: widenedTo ?? subject, ...(widenedTo ? { askedBy: subject } : {}), scope: decision.scope, tool })
        }
        if (!decision.approved && decision.scope !== 'once') grants.grant({ sessionId: approval.sessionId, rule, subject, scope: decision.scope, denied: true })
        state.pending = state.pending.filter(entry => entry.request.token !== decision.token)
        state.resolved.push({ workspace, decision, ...(widenedTo ? { widenedTo } : {}), expiresAt })
        return widenedTo ? { ok: true, widened: { pattern: widenedTo, askedBy: subject } } : { ok: true }
      })
    },

    evaluate({ tokens, sessionId, tool, check }) {
      return store.update(state => {
        prune(state)
        const bound = state.once.filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && entry.tool === tool)
        const usable = bound.filter(entry => tokens.includes(entry.token))
        const used = [...usable, ...unclaimedReliedOn({ usable, unclaimed: bound.filter(entry => !tokens.includes(entry.token)), check })]
        // The last check is the one the caller acts on, so it sees only the approvals this call uses.
        const outcome = check(used.map(entry => entry.subject))
        // Keep partial approvals until every gate clears; consume under the same process lock.
        if (outcome.kind === 'allow') {
          const consumed = new Set(used.map(entry => entry.token))
          state.once = state.once.filter(entry => !consumed.has(entry.token))
        }
        return outcome
      })
    },

    unspent: sessionId => store.read().once
      .filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && entry.tool && entry.expiresAt && Date.parse(entry.expiresAt) > Date.now())
      .map(entry => ({ subject: entry.subject, tool: entry.tool! })),

    wasDenied: tokens => store.read().resolved.some(entry => entry.workspace === workspace && tokens.includes(entry.decision.token) && !entry.decision.approved),

    cancel(tokens) {
      store.update(state => {
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.request.token))
        state.once = state.once.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.token))
      })
    },

    pending: () => store.read().pending.filter(entry => entry.workspace === workspace && Date.parse(entry.request.expiresAt) > Date.now()).map(entry => entry.request),
  }
}

/**
 * A `once` answered after the grace period has no call left to carry its token: over MCP the
 * retry arrives without one. When the call would otherwise ask, an unconsumed `once` for this
 * session and tool counts, but only the ones a rule actually relied on for this call's effects,
 * so a `once` still covers one call with that subject and nothing wider.
 *
 * Only the smallest set the call needs is spent: one `once` per subject, the one expiring first,
 * and none whose subject is already covered without it, by a session grant for instance. The
 * others stay for the next call rather than wasting an owner's answer.
 */
function unclaimedReliedOn(input: {
  usable: OnceEntry[]
  unclaimed: OnceEntry[]
  check: (subjects: GrantSubject[]) => PermissionOutcome
}): OnceEntry[] {
  if (input.unclaimed.length === 0) return []
  if (input.check(input.usable.map(entry => entry.subject)).kind !== 'ask') return []
  const wider = input.check([...input.usable, ...input.unclaimed].map(entry => entry.subject))
  if (wider.kind !== 'allow') return []
  const relied = new Set(wider.allowedBy)
  const firstPerSubject = new Map<string, OnceEntry>()
  for (const entry of [...input.unclaimed].sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!))) {
    const key = `${entry.subject.rule}:${entry.subject.subject}`
    if (relied.has(key) && !firstPerSubject.has(key)) firstPerSubject.set(key, entry)
  }
  let needed = [...firstPerSubject.values()]
  for (const entry of [...needed]) {
    const without = needed.filter(other => other !== entry)
    if (input.check([...input.usable, ...without].map(other => other.subject)).kind === 'allow') needed = without
  }
  return needed
}

/**
 * What a widening needs before the request is looked at: the owner's authority, an approval that
 * outlives the call (`once` stays exact, since it covers one call), and a well-formed wildcard.
 */
function checkWidening(input: { pattern: string; decision: ApprovalDecision; authority: ApprovalAuthority }): { ok: true; pattern: string } | { ok: false; reason: string } {
  if (input.authority !== 'admin') return { ok: false, reason: 'Only the admin credential widens an approval to a host pattern' }
  if (!input.decision.approved) return { ok: false, reason: 'A denial names no host pattern; deny without --host' }
  if (input.decision.scope === 'once') return { ok: false, reason: 'A once approval covers one call to the host that asked; widen a session or always approval instead' }
  const pattern = input.pattern.trim()
  let wildcard: boolean
  try {
    wildcard = compileHostPattern(pattern).wildcard
  } catch (error) {
    if (error instanceof UrlPatternError) return { ok: false, reason: error.message }
    throw error
  }
  if (!wildcard) return { ok: false, reason: `--host takes a wildcard pattern such as *.example.com, got ${pattern}; without --host the approval is for the host that asked` }
  return { ok: true, pattern }
}

/**
 * A pattern widens only a network approval, and only one it covers. The subject carries no scheme,
 * so it is tried as http and as https: a pattern naming port 443 covers `api.example.com` asked
 * over https.
 */
function patternRefusal(input: { rule: PermissionRuleId; subject: string; pattern: string }): string | null {
  if (input.rule !== 'network_egress') return `--host widens a network approval only; this one is ${input.rule} for ${input.subject}`
  const matcher = compileHostPattern(input.pattern)
  const covers = ['http', 'https'].some(scheme => {
    try {
      return matcher.matches(new URL(`${scheme}://${input.subject}/`))
    } catch {
      return false
    }
  })
  return covers ? null : `The pattern ${input.pattern} does not cover ${input.subject}, the host that asked`
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
