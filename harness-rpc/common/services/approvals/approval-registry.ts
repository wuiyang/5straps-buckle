import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APPROVAL_NO_DEADLINE, ApprovalDecisionSchema, ApprovalRequestSchema, GrantSubjectSchema, JsonValueSchema, type ApprovalDecision, type ApprovalRequest, type GrantSubject, type JsonValue, type PermissionRuleId } from '@5straps/protocol'
import { createJsonFileStore } from '../../adapters/json-file-store.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import { compileHostPattern, UrlPatternError } from '../../domain/url-pattern.js'
import { logger } from '../../runtime/log.js'

const PENDING_TTL_MS = 10 * 60_000
/**
 * Asks one session may keep waiting at once. An agent calling in a loop with the hint `none` would
 * otherwise grow the queue, and every update rewrites approvals.json whole (review L9).
 */
export const MAX_PENDING_PER_SESSION = 50
/** Asks the whole workspace may keep waiting at once, so fresh session ids cannot evade the per-session cap (review L2 of B13-B14). */
export const MAX_PENDING_PER_WORKSPACE = 500

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
// requestId and actor let a re-sent call join the ask it already made (ruling 5 of 2026-09-28); an
// answered entry keeps them, so a call re-sent after part of its asks were answered still joins.
const joinKey = { requestId: z.string().optional(), actor: z.string().optional() }
// fingerprint: the tool and its whole arguments that asked, hashed (requestFingerprint); a re-send joins
// only with the same one, and a once a person's key proved is spent only by it (review H3 of B23-B25).
const fingerprint = { fingerprint: z.string().optional() }
// call: the arguments as the node's signed challenge shows them, and the directory they resolve against (owner decision D9).
const callSchema = z.object({ arguments: JsonValueSchema, cwd: z.string() })
// decidedBy: key:<fingerprint> when a person's enrolled key signed the decision (review H4 of B23-B25).
const decidedBy = { decidedBy: z.string().optional() }
const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string(), workspace: z.string(), ...joinKey, ...fingerprint, call: callSchema.optional() })
const onceSchema = z.object({
  workspace: z.string(), token: z.string(), subject: GrantSubjectSchema,
  sessionId: z.string(), tool: z.string(), expiresAt: z.string(), requestId: z.string().optional(), ...fingerprint, ...decidedBy,
})
const resolvedSchema = z.object({
  workspace: z.string(), decision: ApprovalDecisionSchema, widenedTo: z.string().optional(), expiresAt: z.string(),
  request: ApprovalRequestSchema.optional(), sessionId: z.string().optional(), ...joinKey, ...fingerprint, ...decidedBy,
})
const fileSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  once: z.array(onceSchema),
  resolved: z.array(resolvedSchema),
})
type State = z.infer<typeof fileSchema>
type OnceEntry = z.infer<typeof onceSchema>
/** An ask waiting in the queue, with the call it came from. */
export type PendingAsk = Omit<z.infer<typeof pendingSchema>, 'workspace'>

/**
 * Whose answer a decision carries. `BUCKLE-D14` keeps a persisted approval on the admin
 * credential alone: a face reachable with an agent's token resolves as `agent`, and the
 * registry then admits `once` and nothing durable.
 */
export type ApprovalAuthority = 'admin' | 'agent'

// Refused before anything is written; the invoker records the refusal in the call's audit entries.
function assertRoomFor(input: { state: State; workspace: string; sessionId: string; asked: number }): void {
  const waiting = input.state.pending.filter(entry => entry.workspace === input.workspace)
  const session = waiting.filter(entry => entry.sessionId === input.sessionId).length
  if (session + input.asked > MAX_PENDING_PER_SESSION) {
    logger.warn('Approval refused: the session has too many asks waiting', { waiting: session, asked: input.asked, limit: MAX_PENDING_PER_SESSION })
    throw new ApprovalLimitError(`This session already has ${session} approvals waiting; ask again once some are answered or withdrawn (limit ${MAX_PENDING_PER_SESSION})`)
  }
  if (waiting.length + input.asked > MAX_PENDING_PER_WORKSPACE) {
    logger.warn('Approval refused: the workspace has too many asks waiting', { waiting: waiting.length, asked: input.asked, limit: MAX_PENDING_PER_WORKSPACE })
    throw new ApprovalLimitError(`This workspace already has ${waiting.length} approvals waiting; ask again once some are answered or withdrawn (limit ${MAX_PENDING_PER_WORKSPACE})`)
  }
}

/** A call re-sent under the same requestId asked for something else: HTTP 409. */
export class ApprovalConflictError extends Error {}

/**
 * A call re-sent under the requestId of an ask still waiting (or denied) carries other arguments: it is
 * another call, refused as REQUEST_ID_REUSED (HTTP 409), and never joins the ask a person sees (review H3 of B23-B25).
 */
export class RequestIdReusedError extends Error {}

/** The session or the workspace already has its cap of asks waiting: retryable once some are answered or expire. */
export class ApprovalLimitError extends Error {}

export interface AskInput {
  tool: string
  sessionId: string
  asks: Ask[]
  /** The caller's requestId and actor: the same pair with the same asks joins the waiting ask. */
  requestId?: string
  actor?: string
  /** How long the call may be held beyond the ten minutes an ask stays answerable (null: no deadline); the registry's own when absent. */
  waitMs?: number | null
  /** The call's tool and whole arguments, hashed (requestFingerprint). */
  fingerprint?: string
  /** The call as a challenge shows it: its redacted arguments and the directory they resolve against. */
  call?: { arguments: JsonValue; cwd: string }
}

/**
 * `widenTo` records a network approval for a host pattern instead of the host that asked, per
 * `BUCKLE-D18: A host wildcard covers the apex and every subdomain, in lists and grants alike`.
 * It is a separate argument rather than a field of the decision, so no decision an agent or a
 * relay sends can carry one: `buckle approve --host` is the only caller that passes it.
 */
export interface ResolveOptions {
  widenTo?: string
  /**
   * Checked against the ask under the queue's lock: a decision a person's key signed must name the
   * ask's own challenge. Such a proven `once` is then spent only by a call with the ask's fingerprint.
   */
  expect?: (ask: PendingAsk) => boolean
  /** Who decided, recorded with the decision and its grant: key:<fingerprint> for a person's key. */
  decidedBy?: string
}

/**
 * On a widened grant, the pattern recorded and the host it was asked for, for the audit entry.
 * `repeated` marks an answer identical to the one already recorded, which changes nothing.
 */
export type Resolution = { ok: true; widened?: { pattern: string; askedBy: string }; repeated?: true } | { ok: false; reason: string }

/**
 * A joined call gets the requests still waiting and the tokens of its asks already answered, so its
 * check after the wait counts a `once` given before it joined.
 */
export interface AskResult {
  requests: ApprovalRequest[]
  joined: boolean
  answered: string[]
}

export interface ApprovalRegistry {
  /** Issues the asks, or joins the ones a call with the same requestId, session and actor is already waiting on. */
  ask(input: AskInput): Promise<AskResult>
  /**
   * `BUCKLE-D14`: a decision that outlives the call is written under the admin credential
   * alone. An `agent` authority may answer `once`, which expires with the call it unblocks.
   * The default names the owner, because every caller but the agent-facing MCP face reaches
   * this from the owner's own process or from behind the admin credential.
   */
  resolve(decision: ApprovalDecision, authority?: ApprovalAuthority, options?: ResolveOptions): Promise<Resolution>
  /**
   * The last check clears the call or not. A cleared call's `once` approvals are spent under the
   * queue's lock, and `admit` runs under it first: false (another run of the call holds it) leaves them
   * unspent.
   */
  evaluate(input: {
    tokens: string[]; sessionId: string; tool: string
    /** The call's fingerprint: a `once` a person's key proved is spent only by the call it was asked for. */
    fingerprint?: string
    check: (subjects: GrantSubject[]) => PermissionOutcome
    admit?: () => boolean
  }): Promise<PermissionOutcome>
  wasDenied(tokens: string[]): boolean
  /** Withdraws the asks still waiting among `tokens`, returning those it withdrew. */
  cancel(tokens: string[]): Promise<string[]>
  /**
   * Withdraws one call's asks still waiting: the group of the ask a token names (its requestId,
   * session and actor), or every ask waiting under a hashed requestId and session. Returns them.
   */
  cancelGroup(selector: { token: string } | { requestId: string; sessionId: string }): Promise<string[]>
  /** Drops the asks that expired unanswered, telling `onExpired` about them. Every update does this too. */
  sweep(): Promise<void>
  pending(): ApprovalRequest[]
  /** The asks still waiting, each with the call it came from. */
  waiting(): PendingAsk[]
  /** One session's `once` approvals not yet spent, each still bound to the tool it was asked for. */
  unspent(sessionId: string): Array<{ subject: GrantSubject; tool: string }>
}

export interface ApprovalRegistryOptions {
  lockDeadlineMs?: number
  /** Told of this workspace's asks that expired unanswered, by whichever update drops them first. */
  onExpired?: (requests: ApprovalRequest[]) => void
}

export function createApprovalRegistry(grants: GrantStore, filePath: string, workspace = filePath, waitMs: number | null = 0, options: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const store = createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1, pending: [], once: [], resolved: [] }, lockDeadlineMs: options.lockDeadlineMs })

  /** Every change starts by dropping what expired; this workspace's unanswered asks among them are reported once written. */
  async function update<R>(change: (state: State) => R | Promise<R>): Promise<R> {
    let expired: ApprovalRequest[] = []
    const result = await store.update(state => {
      expired = prune(state).filter(entry => entry.workspace === workspace).map(entry => entry.request)
      return change(state)
    })
    if (expired.length > 0) options.onExpired?.(expired)
    return result
  }

  const registry: ApprovalRegistry = {
    ask({ tool, sessionId, asks, requestId, actor, fingerprint: callFingerprint, call, waitMs: lifetime = waitMs }) {
      return update(state => {
        const joined = requestId === undefined ? null : joinWaiting({ state, workspace, key: { requestId, sessionId, actor }, call: { tool, asks, fingerprint: callFingerprint } })
        if (joined) return joined
        assertRoomFor({ state, workspace, sessionId, asked: asks.length })
        const requests = asks.map(item => ({
          token: randomUUID(), rule: item.rule, subject: item.subject, reason: item.reason,
          tool, offeredScopes: item.offeredScopes, expiresAt: lifetime === null ? APPROVAL_NO_DEADLINE : new Date(Date.now() + PENDING_TTL_MS + lifetime).toISOString(),
        }))
        state.pending.push(...requests.map(request => ({ request, sessionId, workspace, ...(requestId === undefined ? {} : { requestId }), ...(actor === undefined ? {} : { actor }), ...(callFingerprint === undefined ? {} : { fingerprint: callFingerprint }), ...(call === undefined ? {} : { call }) })))
        return { requests, joined: false, answered: [] }
      })
    },

    async resolve(decision, authority = 'admin', options = {}) {
      if (decision.scope !== 'once' && authority !== 'admin') {
        logger.warn('Persisted approval refused: only the admin credential writes one', { scope: decision.scope })
        return { ok: false, reason: 'Only the admin credential writes an approval that outlives the call' }
      }
      const widening = options.widenTo === undefined ? null : checkWidening({ pattern: options.widenTo, decision, authority })
      if (widening && !widening.ok) return widening
      // The grant is written while the approvals file is still locked, so no reader sees the decision without it.
      return update(async (state): Promise<Resolution> => {
        const widenedTo = widening?.pattern
        const previous = state.resolved.find(entry => entry.workspace === workspace && entry.decision.token === decision.token)
        if (previous) {
          return previous.decision.approved === decision.approved && previous.decision.scope === decision.scope && previous.widenedTo === widenedTo
            ? { ok: true, repeated: true }
            : { ok: false, reason: 'Approval already has a different decision' }
        }
        const approval = state.pending.find(entry => entry.workspace === workspace && entry.request.token === decision.token)
        if (!approval) return { ok: false, reason: 'Approval token is unknown or expired' }
        if (options.expect && !options.expect(approval)) return { ok: false, reason: 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows' }
        if (decision.approved && !approval.request.offeredScopes.includes(decision.scope)) {
          return { ok: false, reason: `Scope ${decision.scope} is not offered for this approval` }
        }
        const { rule, subject, tool } = approval.request
        const { requestId, actor } = approval
        const decider = options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }
        // A decision a person's key proved on the ask's challenge covers that call and no other.
        const bound = options.expect && approval.fingerprint !== undefined ? { fingerprint: approval.fingerprint } : {}
        if (rule === 'sensitive_path' && decision.approved && decision.scope !== 'once') return { ok: false, reason: 'Sensitive files can only be allowed once' }
        if (!decision.approved && decision.scope !== 'once' && rule !== 'sensitive_path') return { ok: false, reason: 'Persistent denials are supported only for sensitive files' }
        const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString()
        if (widenedTo) {
          const refusal = patternRefusal({ rule, subject, pattern: widenedTo })
          if (refusal) return { ok: false, reason: refusal }
        }
        if (decision.approved) {
          if (decision.scope === 'once') state.once.push({ workspace, token: decision.token, subject: { rule, subject }, sessionId: approval.sessionId, tool, expiresAt, ...(requestId === undefined ? {} : { requestId }), ...bound, ...decider })
          else await grants.grant({ sessionId: approval.sessionId, rule, subject: widenedTo ?? subject, scope: decision.scope, ...(widenedTo ? { pattern: true } : {}), ...decider })
          // The subject can carry a command's arguments, so the log names its size only; the action log keeps it.
          logger.info('Approval granted', { rule, scope: decision.scope, tool, subjectLength: subject.length, ...(widenedTo ? { widened: true } : {}) })
        }
        if (!decision.approved && decision.scope !== 'once') await grants.grant({ sessionId: approval.sessionId, rule, subject, scope: decision.scope, denied: true, ...decider })
        state.pending = state.pending.filter(entry => entry.request.token !== decision.token)
        state.resolved.push({
          workspace, decision, ...(widenedTo ? { widenedTo } : {}), expiresAt, request: approval.request, sessionId: approval.sessionId,
          ...(requestId === undefined ? {} : { requestId }), ...(actor === undefined ? {} : { actor }), ...(approval.fingerprint === undefined ? {} : { fingerprint: approval.fingerprint }), ...decider,
        })
        return widenedTo ? { ok: true, widened: { pattern: widenedTo, askedBy: subject } } : { ok: true }
      })
    },

    evaluate({ tokens, sessionId, tool, fingerprint: callFingerprint, check, admit }) {
      return update(state => {
        // A proven once names the call it was asked for; any other call, token or not, cannot spend it (review H3 of B23-B25).
        const bound = state.once.filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && entry.tool === tool && (entry.fingerprint === undefined || entry.fingerprint === callFingerprint))
        const usable = bound.filter(entry => tokens.includes(entry.token))
        const used = [...usable, ...unclaimedReliedOn({ usable, unclaimed: bound.filter(entry => !tokens.includes(entry.token)), check })]
        // The last check is the one the caller acts on, so it sees only the approvals this call uses.
        const outcome = check(used.map(entry => entry.subject))
        // Keep partial approvals until every gate clears; consume under the same process lock.
        if (outcome.kind === 'allow' && (admit?.() ?? true)) {
          const consumed = new Set(used.map(entry => entry.token))
          state.once = state.once.filter(entry => !consumed.has(entry.token))
        }
        return outcome
      })
    },

    unspent: sessionId => store.read().once
      .filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && Date.parse(entry.expiresAt) > Date.now())
      .map(entry => ({ subject: entry.subject, tool: entry.tool })),

    wasDenied: tokens => store.read().resolved.some(entry => entry.workspace === workspace && tokens.includes(entry.decision.token) && !entry.decision.approved),

    cancel(tokens) {
      return update(state => {
        const withdrawn = state.pending.filter(entry => entry.workspace === workspace && tokens.includes(entry.request.token)).map(entry => entry.request.token)
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.request.token))
        state.once = state.once.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.token))
        return withdrawn
      })
    },

    cancelGroup(selector) {
      return update((state) => {
        const mine = state.pending.filter(entry => entry.workspace === workspace)
        const named = 'token' in selector ? mine.find(entry => entry.request.token === selector.token) : undefined
        const inGroup = 'token' in selector
          ? (entry: State['pending'][number]) => entry === named || (named?.requestId !== undefined && entry.requestId === named.requestId && entry.sessionId === named.sessionId && entry.actor === named.actor)
          : (entry: State['pending'][number]) => entry.requestId === selector.requestId && entry.sessionId === selector.sessionId
        const withdrawn = mine.filter(inGroup).map(entry => entry.request.token)
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !withdrawn.includes(entry.request.token))
        state.once = state.once.filter(entry => entry.workspace !== workspace || !withdrawn.includes(entry.token))
        return withdrawn
      })
    },

    sweep: () => update(() => undefined),

    pending: () => registry.waiting().map(entry => entry.request),

    waiting: () => store.read().pending
      .filter(entry => entry.workspace === workspace && Date.parse(entry.request.expiresAt) > Date.now())
      .map(({ workspace: _workspace, ...entry }) => entry),
  }
  return registry
}

interface JoinKey { requestId: string; sessionId: string; actor: string | undefined }

/**
 * The asks a call with this requestId, session and actor is still waiting on, when there are any, or
 * the group's answered asks when none waits but one was denied (review M2 of B20-B22): its re-send is
 * refused, never asked again. Its re-send asks again for everything still waiting, and may ask again
 * for an answered `once` (it is spent only when a whole call clears) but not for an answered session
 * grant; anything else is a different call reusing the id. A group answered with approvals alone is
 * not joined: its call ran (a re-send replays it) or asks afresh.
 */
function joinWaiting(input: { state: State; workspace: string; key: JoinKey; call: { tool: string; asks: Ask[]; fingerprint?: string } }): AskResult | null {
  const { key } = input
  const inGroup = (entry: { workspace: string; sessionId?: string; requestId?: string; actor?: string }) =>
    entry.workspace === input.workspace && entry.requestId === key.requestId && entry.sessionId === key.sessionId && entry.actor === key.actor
  const pending = input.state.pending.filter(inGroup)
  const waiting = pending.map(entry => entry.request)
  const resolved = input.state.resolved.filter(inGroup)
  if (waiting.length === 0 && !resolved.some(entry => !entry.decision.approved)) return null
  // The ask a person sees names the call that made it: other arguments under its requestId are another call.
  const recorded = [...pending, ...resolved].flatMap(entry => entry.fingerprint === undefined ? [] : [entry.fingerprint])
  if (recorded.some(value => value !== input.call.fingerprint)) throw new RequestIdReusedError(`Request ${key.requestId} already names a different call waiting for approval; send a new requestId`)
  const answered = resolved.flatMap(entry => entry.request ? [entry.request] : [])
  if (!sameGroup({ waiting, answered, call: input.call })) throw new ApprovalConflictError(`Request ${key.requestId} is already waiting for approval of different asks`)
  return { requests: waiting, joined: true, answered: answered.map(request => request.token) }
}

/** Every waiting ask is asked again, and every ask the call makes is one of the group's: tool, rule, subject and offered scopes. */
function sameGroup(input: { waiting: ApprovalRequest[]; answered: ApprovalRequest[]; call: { tool: string; asks: Ask[] } }): boolean {
  const key = (item: { rule: string; subject: string; offeredScopes: readonly string[] }) => JSON.stringify([item.rule, item.subject, [...item.offeredScopes].sort()])
  const asked = new Set(input.call.asks.map(key))
  const group = new Set([...input.waiting, ...input.answered].map(key))
  const sameTool = [...input.waiting, ...input.answered].every(request => request.tool === input.call.tool)
  return sameTool && input.waiting.every(request => asked.has(key(request))) && [...asked].every(item => group.has(item))
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
  for (const entry of [...input.unclaimed].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))) {
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

/** Drops everything past its expiry, returning the asks that expired unanswered. */
function prune(state: State): State['pending'] {
  const now = Date.now()
  const expired = state.pending.filter(entry => Date.parse(entry.request.expiresAt) <= now)
  state.pending = state.pending.filter(entry => Date.parse(entry.request.expiresAt) > now)
  state.once = state.once.filter(entry => Date.parse(entry.expiresAt) > now)
  state.resolved = state.resolved.filter(entry => Date.parse(entry.expiresAt) > now)
  return expired
}

export function subjectsByRule(subjects: GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
