import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { redactCredentials } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, ApprovalNoticeSchema, ApprovalDecisionSchema, ApprovalRequestSchema, GrantSubjectSchema, JsonValueSchema, type ApprovalDecision, type ApprovalNotice, type ApprovalRequest, type GrantSubject, type JsonValue, type PermissionRuleId } from '@5straps/protocol'
import { alreadyReported, createJsonFileStore, fileVersion, StateFileError } from '../../adapters/json-file-store.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import { FLOOR_WARNING } from '../../domain/approval-instruction.js'
import { guardDecision, screenDecision, type ApprovalAuthority, type DecisionClaim, type LedgerView } from '../../domain/approval/decision-guard.js'
import { logger, withoutCause } from '../../runtime/log.js'
import { isPlainName } from '../../domain/paths.js'

export const APPROVAL_OUTBOX_COUNT_MAX = 4096
export const APPROVAL_OUTBOX_BYTES_MAX = 4 * 1024 * 1024
export const APPROVAL_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * How long an ask stays answerable past the hold of the call that made it, and how long one nobody holds any more lasts:
 * the join window, the replay window's ten minutes (invocation/executions.ts).
 */
export const PENDING_TTL_MS = 10 * 60_000
/** How long after a failed background prune an ordinary call tries it again. */
const PRUNE_RETRY_MS = 5_000
/**
 * Asks one session may keep waiting at once. An agent calling in a loop with the hint `none` would
 * otherwise grow the queue, and every update rewrites approvals.json whole (review L9).
 */
export const MAX_PENDING_PER_SESSION = 50
/** Asks the whole workspace may keep waiting at once, so fresh session ids cannot evade the per-session cap (review L2 of B13-B14). */
export const MAX_PENDING_PER_WORKSPACE = 500
/**
 * The most one ask may hold, its request and its whole call as shown (owner decision D17): a call over it is
 * refused before anything is asked, never shown in part. The node's request budget (BUCKLE_MAX_REQUEST_BYTES,
 * 1 MiB unless the owner raises it) keeps every call sent over HTTP well inside it.
 */
export const MAX_ASK_BYTES = 16 * 1_024 * 1_024
/**
 * What every waiting ask of one session may hold together, so one session never holds the budgets of the
 * others (review M5): one ask of the largest size fits. A group's whole call counts once. A session is its id
 * under the actor that opened it (review L5 of the slice 5 re-review).
 */
export const MAX_PENDING_BYTES_PER_SESSION = 16 * 1_024 * 1_024
/** What the waiting asks of one actor (the identity its transport authenticated) may hold, whatever sessions it opens. */
export const MAX_PENDING_BYTES_PER_ACTOR = 32 * 1_024 * 1_024
/** What every waiting ask of the workspace may hold together, so a listing, which carries each group's call once, stays bounded. */
export const MAX_PENDING_BYTES = 64 * 1_024 * 1_024
/** Where each request group's whole call is kept, beside approvals.json. */
const CALLS_DIRECTORY = 'approval-calls'
const CALL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
// requestId and actor let a re-sent call join the ask it already made (ruling 5 of 2026-09-28); an
// answered entry keeps them, so a call re-sent after part of its asks were answered still joins.
const joinKey = { requestId: z.string().optional(), actor: z.string().optional() }
// fingerprint: the tool and its whole arguments that asked, hashed (requestFingerprint); a re-send joins
// only with the same one, and a once decided on its ask is spent only by it, whichever route decided it
// (review H3 of B23-B25; review item 1 of the proof-of-possession fixes).
const fingerprint = { fingerprint: z.string().optional() }
// call: the whole call as the node's signed challenge shows it (owner decisions D9 and D17): its redacted
// arguments, the directory they resolve against, what it does in the node's words and the effects the rules
// judged. `complete` marks a call recorded whole; an ask recorded before this build (with `truncated`, and
// perhaps cut arguments) has none, so it is denied or joined by a re-send that records the whole call.
// judge: what the decision AI's stages said of the call's command asks (D91), shown beside the action and never part of its digest.
const levelSchema = z.enum(['safe', 'warning', 'danger'])
const quickNoteSchema = z.union([
  z.object({ level: levelSchema, confidence: z.number().min(0).max(1), model: z.string(), latencyMs: z.number().nonnegative() }).strict(),
  z.object({ unavailable: z.string() }).strict(),
])
// warning: a floor ask's one constant line, which no stage passes (addendum 3 R2); only that constant is kept.
const warning = { warning: z.literal(FLOOR_WARNING).optional() }
const judgeNoteSchema = z.union([
  z.object({ subject: z.string(), level: levelSchema, confidence: z.number().min(0).max(1), model: z.string(), reasoning: z.string(), latencyMs: z.number().nonnegative().optional(), quick: quickNoteSchema.optional(), ...warning }).strict(),
  z.object({ subject: z.string(), unavailable: z.string(), quick: quickNoteSchema.optional(), ...warning }).strict(),
  z.object({ subject: z.string(), onRequest: z.literal(true), ...warning }).strict(),
  z.object({ subject: z.string(), quick: quickNoteSchema, ...warning }).strict(),
])
const callSchema = z.object({
  arguments: JsonValueSchema, cwd: z.string(), description: z.string().nullable().default(null),
  effects: z.array(z.string()).optional(), complete: z.literal(true).optional(), truncated: z.boolean().optional(),
  judge: z.array(judgeNoteSchema).optional(),
})
// decidedBy: key:<fingerprint> when a person's enrolled key signed the decision (review H4 of B23-B25).
const decidedBy = { decidedBy: z.string().optional() }
// lapsesAt: when an ask nobody holds lapses before its stated expiry, ten minutes after the last hold on it ended, and
// again from a re-send that joins it (the MCP asks brief, item 5). An ask at wait 0 states no deadline, which its signed
// challenge carries, so the lapse is kept beside the request rather than in it; none while a caller holds it until
// answered. abandonedAt: when the caller that held it left before its hold ended; the oldest abandoned asks make room
// under the caps, so a session's or the workspace's cap is never reached through them alone.
const lapse = { lapsesAt: z.iso.datetime().optional(), abandonedAt: z.iso.datetime().optional() }
// callFile: the file beside approvals.json that holds the whole call of the ask's request group, once for every
// ask the call made, so the file every update rewrites holds requests alone (review M5). `bytes` counts against
// the budgets once per group; `complete` repeats the call's own mark. An ask recorded before this build keeps its
// call inline, in `call`.
const callFileSchema = z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), bytes: z.number().int().nonnegative(), complete: z.literal(true).optional() })
// floor and destructive: the marks the rule that asked set (AskMarks); an ask recorded before they were kept reads as both.
const marks = { floor: z.boolean().default(true), destructive: z.boolean().default(true) }
const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string(), workspace: z.string(), ...marks, ...joinKey, ...fingerprint, notify: z.literal(true).optional(), call: callSchema.optional(), callFile: callFileSchema.optional(), ...lapse })
// code: the code a once the decision AI's thorough stage gave on request binds to (fix brief 9, B31).
const onceSchema = z.object({
  workspace: z.string(), token: z.string(), subject: GrantSubjectSchema,
  sessionId: z.string(), tool: z.string(), expiresAt: z.string(), requestId: z.string().optional(), ...fingerprint, ...decidedBy,
  code: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), allowed: z.boolean() }).optional(),
})
const resolvedSchema = z.object({
  workspace: z.string(), decision: ApprovalDecisionSchema, widenedTo: z.string().optional(), expiresAt: z.string(),
  request: ApprovalRequestSchema.optional(), sessionId: z.string().optional(), ...joinKey, ...fingerprint, ...decidedBy,
})
const deliverySchema = z.object({ id: z.string().uuid(), workspace: z.string(), notice: ApprovalNoticeSchema, expiresAt: z.iso.datetime() })
export type ApprovalDelivery = Omit<z.infer<typeof deliverySchema>, 'workspace'>

const fileSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  once: z.array(onceSchema),
  resolved: z.array(resolvedSchema),
  outbox: z.array(deliverySchema).default([]),
})
type State = z.infer<typeof fileSchema>
type OnceEntry = z.infer<typeof onceSchema>
type PendingEntry = State['pending'][number]
/**
 * An ask waiting in the queue, with the whole call it came from, read from its file. `callRef` names the file,
 * which every ask of one request group shares, so a listing carries the group's call once and each ask names it
 * (review M1 of the slice 5 re-review); an ask recorded before this build keeps its call inline and has none.
 */
export type PendingAsk = Omit<PendingEntry, 'workspace' | 'callFile'> & { callRef?: string }

// Refused before anything is written; the invoker records the refusal in the call's audit entries. A session is
// its id under the actor that opened it: HTTP callers choose the id, and stdio hosts share `mcp`, so one caller's
// asks never fill another's session (review L5 of the slice 5 re-review).
function assertRoomFor(input: { state: State; workspace: string; sessionId: string; actor: string | undefined; asked: number }): void {
  const waiting = input.state.pending.filter(entry => entry.workspace === input.workspace)
  const session = waiting.filter(entry => entry.sessionId === input.sessionId && entry.actor === input.actor).length
  if (session + input.asked > MAX_PENDING_PER_SESSION) {
    logger.warn('Approval refused: the session has too many asks waiting', { waiting: session, asked: input.asked, limit: MAX_PENDING_PER_SESSION })
    throw new ApprovalLimitError(`This session already has ${session} approvals waiting; ask again once some are answered or withdrawn (limit ${MAX_PENDING_PER_SESSION})`, 'session')
  }
  if (waiting.length + input.asked > MAX_PENDING_PER_WORKSPACE) {
    logger.warn('Approval refused: the workspace has too many asks waiting', { waiting: waiting.length, asked: input.asked, limit: MAX_PENDING_PER_WORKSPACE })
    throw new ApprovalLimitError(`This workspace already has ${waiting.length} approvals waiting; ask again once some are answered or withdrawn (limit ${MAX_PENDING_PER_WORKSPACE})`, 'workspace')
  }
}

/** What each waiting ask holds against the budgets: its record in approvals.json, and its group's call file once. */
function footprints(pending: readonly PendingEntry[]): Array<{ bytes: number; sessionId: string; actor: string | undefined }> {
  const counted = new Set<string>()
  return pending.map((entry) => {
    const file = entry.callFile && !counted.has(entry.callFile.id) ? entry.callFile.bytes : 0
    if (entry.callFile) counted.add(entry.callFile.id)
    return { bytes: Buffer.byteLength(JSON.stringify(entry)) + file, sessionId: entry.sessionId, actor: entry.actor }
  })
}

/**
 * One request group against the budgets (review M5). Each ask records its request and the group's whole call,
 * which must fit what a person is shown whole: one too large is refused for good. Every waiting ask of the
 * session, of the actor and of the workspace together must fit theirs, the group's call counted once: a full
 * budget refuses until asks are answered, withdrawn or expire.
 */
function assertBytesFor(input: { waiting: readonly PendingEntry[]; group: readonly PendingEntry[]; callBytes: number }): void {
  const sizes = input.group.map(entry => Buffer.byteLength(JSON.stringify(entry)))
  const largest = Math.max(0, ...sizes) + input.callBytes
  if (largest > MAX_ASK_BYTES) {
    logger.warn('Approval refused: the call is larger than an approval shows whole', { bytes: largest, limit: MAX_ASK_BYTES })
    throw new ActionTooLargeError(`This call needs approval, and one of its asks records ${largest} bytes (its request and the whole call as an approval shows it), over the ${MAX_ASK_BYTES} bytes a person is shown whole; nothing was asked or run. Send a smaller call: split a batch, or write a long script to a file first`)
  }
  const asked = sizes.reduce((sum, size) => sum + size, 0) + input.callBytes
  const [first] = input.group
  if (!first) return
  const held = footprints(input.waiting)
  const sum = (keep: (item: (typeof held)[number]) => boolean) => held.filter(keep).reduce((total, item) => total + item.bytes, 0)
  const budgets = [
    { held: sum(item => item.sessionId === first.sessionId && item.actor === first.actor), limit: MAX_PENDING_BYTES_PER_SESSION, whose: 'This session\'s approvals waiting', per: 'per session', room: 'session' as const },
    { held: sum(item => item.actor === first.actor), limit: MAX_PENDING_BYTES_PER_ACTOR, whose: 'The approvals waiting from this caller', per: 'per caller', room: 'actor' as const },
    { held: sum(() => true), limit: MAX_PENDING_BYTES, whose: 'The approvals waiting in this workspace', per: 'per workspace', room: 'workspace' as const },
  ]
  for (const budget of budgets) {
    if (budget.held + asked <= budget.limit) continue
    logger.warn('Approval refused: the approvals waiting hold too much', { waiting: budget.held, asked, limit: budget.limit, per: budget.per })
    throw new ApprovalLimitError(`${budget.whose} already hold ${budget.held} bytes and this call's asks would add ${asked}; ask again once some are answered or withdrawn (limit ${budget.limit} bytes ${budget.per})`, budget.room)
  }
}

/**
 * The whole calls of waiting asks, one 0600 file per request group in a 0700 directory beside approvals.json,
 * written before the index names it and removed once no waiting ask names it (review M5).
 */
interface CallFiles {
  write(id: string, text: string): void
  /** The group's whole call, or why its file could not be read; logs nothing, so a pass says it once (callsRead). */
  read(id: string): { call: AskedCall } | { failure: string }
  /** The file's size in bytes, or undefined when it is missing: one stat, no read. */
  size(id: string): number | undefined
  remove(ids: Iterable<string>): void
  /** Removes every call file no waiting ask names; run under the queue's lock. */
  prune(named: ReadonlySet<string>): void
  /** Whether any call file, or a temporary one, is left that no waiting ask names. */
  unnamed(named: ReadonlySet<string>): boolean
}

function createCallFiles(directory: string): CallFiles {
  const pathOf = (id: string) => join(directory, `${id}.json`)
  return {
    write(id, text) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `${id}.${randomUUID()}.tmp`)
      try {
        const descriptor = openSync(temporary, 'wx', 0o600)
        try {
          writeFileSync(descriptor, text)
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        renameSync(temporary, pathOf(id))
      } finally {
        rmSync(temporary, { force: true })
      }
    },
    read(id) {
      try {
        return { call: callSchema.parse(JSON.parse(readFileSync(pathOf(id), 'utf8'))) }
      } catch (error) {
        // Shown as recorded before this build: denied or re-sent, never approved from a part.
        return { failure: error instanceof Error ? error.name : 'Unknown error' }
      }
    },
    size: id => statSync(pathOf(id), { throwIfNoEntry: false })?.size,
    remove(ids) {
      for (const id of ids) rmSync(pathOf(id), { force: true })
    },
    prune(named) {
      for (const name of leftOver(named)) rmSync(join(directory, name), { force: true })
    },
    unnamed: named => leftOver(named).length > 0,
  }

  function leftOver(named: ReadonlySet<string>): string[] {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    return names.filter((name) => {
      if (!isPlainName(name)) return false
      const id = CALL_FILE.exec(name)?.[1]
      return (id !== undefined && !named.has(id)) || name.endsWith('.tmp')
    })
  }
}

/** The call files the waiting asks name, of every workspace the file holds. */
function namedCalls(state: State): Set<string> {
  return new Set(state.pending.flatMap(entry => entry.callFile ? [entry.callFile.id] : []))
}

/** A call re-sent under the same requestId asked for something else: HTTP 409. */
export class ApprovalConflictError extends Error {}

/**
 * A call re-sent under the requestId of an ask still waiting (or denied) carries other arguments: it is
 * another call, refused as REQUEST_ID_REUSED (HTTP 409), and never joins the ask a person sees (review H3 of B23-B25).
 */
export class RequestIdReusedError extends Error {}

/** The session or the workspace already has its cap of asks waiting: retryable once some are answered or expire. */
export class ApprovalLimitError extends Error {
  /** Whose cap refused: the abandoned asks there are the ones withdrawn to make room (the MCP asks brief, item 5). */
  constructor(message: string, readonly room: LimitRoom = 'workspace') { super(message) }
}

/** The asks one cap counts: the session's (its id under its actor), the actor's, or the whole workspace's. */
type LimitRoom = 'session' | 'actor' | 'workspace'

/** One ask would hold more than MAX_ASK_BYTES: refused whole before anything is asked, never shown in part (owner decision D17). */
export class ActionTooLargeError extends Error {
  readonly code = 'ACTION_TOO_LARGE'
}

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
  /** The whole call as a challenge shows it: its redacted arguments, their directory, the node's description and the judged effects. */
  call?: AskedCall
  /**
   * How long the asking caller is held, in ms; null holds it until answered. An ask that states no deadline lapses this
   * long and ten minutes more from now, and a re-send that joins restarts that clock (the MCP asks brief, item 5); one held
   * until answered lapses only once its hold ends (holdEnded). Absent, from a face that does not send a call again
   * (ApprovalRequestInput.resends): no lapse, as before the brief.
   */
  holdMs?: number | null
}

/** A call as its challenge shows it (owner decision D9). */
export type AskedCall = z.infer<typeof callSchema>

/** A recorded call as a relay or listing is handed it: the whole call when it was kept whole, else nothing (owner decision D17). */
export function shownCall(call: AskedCall | undefined): { arguments: JsonValue; cwd: string; description: string | null; effects: string[] } | undefined {
  return call?.complete ? { arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] } : undefined
}

export interface ResolveOptions {
  /** `buckle approve --host`: a host pattern recorded in place of the host that asked (DecisionClaim.widenTo). */
  widenTo?: string
  /**
   * Checked against the ask under the queue's lock: a decision a person's key signed names `digest`, which must be one of
   * the ask's own challenges, as `shown` gives them. Such a proven `once` is then spent only by a call with the ask's fingerprint.
   */
  challenge?: { digest: string; shown: (ask: PendingAsk) => string[] }
  /** Who decided, recorded with the decision and its grant: key:<fingerprint> for a person's key. */
  decidedBy?: string
  /** Authenticated device proof deadline; the body never supplies it. */
  consumeNotAfter?: number
  /** The code an approved `once` binds to: the decision AI's thorough stage approved it on request (fix brief 9, B31). */
  code?: CodeBinding
}

/**
 * On a widened grant, the pattern recorded and the host it was asked for, for the audit entry.
 * `repeated` marks an answer identical to the one already recorded, which changes nothing. `asked`
 * is the rule and subject the decision answered, for the decision's audit entry (review item 6).
 * `granted`: the ask's wider subject, where the decision granted it in place of the ask's own (the delete policy brief).
 */
export type Resolution = { ok: true; widened?: { pattern: string; askedBy: string }; repeated?: true; asked?: { rule: PermissionRuleId; subject: string }; granted?: string } | { ok: false; reason: string }

/**
 * A joined call gets the requests still waiting and the tokens of its asks already answered, so its
 * check after the wait counts a `once` given before it joined.
 */
export interface AskResult {
  requests: ApprovalRequest[]
  joined: boolean
  answered: string[]
  /** The abandoned asks withdrawn to make room for this one under a cap (the MCP asks brief, item 5). */
  evicted?: string[]
  /** When the earliest of the group's asks lapses, in ms, where one now does: a sweep then reports it. */
  lapsesAt?: number
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
    /** The call's fingerprint: a `once` is spent only by the call it was asked for. */
    fingerprint?: string
    check: (subjects: GrantSubject[]) => PermissionOutcome
    admit?: () => boolean
    /** Told, when the call clears, who decided each `once` it spent (key:<fingerprint>), for its audit entry. */
    spent?: (decidedBy: string[]) => void
    /**
     * Whether the code a `once` binds to (ResolveOptions.code) is still the code the call would run; a `once` it does not
     * hold for is left unspent, as is every bound one where none is given (fix brief 9, B31).
     */
    holds?: (subject: GrantSubject, code: CodeBinding) => boolean
  }): Promise<PermissionOutcome>
  wasDenied(tokens: string[]): boolean
  /** Withdraws the asks still waiting among `tokens`, returning those it withdrew. */
  cancel(tokens: string[]): Promise<string[]>
  /**
   * The last hold on these asks ended with them unanswered (the MCP asks brief, item 5). `abandoned`: its caller left
   * before the hold ended, so each stays answerable for ten minutes at most and is marked abandoned; otherwise an ask that
   * states no deadline and was held until answered lapses ten minutes from now. Returns the earliest lapse it set, in ms.
   */
  holdEnded(input: { tokens: string[]; abandoned: boolean }): Promise<number | undefined>
  /**
   * Withdraws one call: the group of the ask a token names (its requestId, session and actor), waiting
   * or answered, or the asks under a hashed requestId, session and actor. Its asks still waiting are
   * withdrawn, and its answered `once` approvals no call spent yet are dropped (review L1 of B23-B25).
   * A requestId form without an actor that matches more than one actor's call is refused (review item 16).
   */
  cancelGroup(selector: GroupSelector): Promise<GroupWithdrawal>
  /** Drops the asks that expired unanswered, telling `onExpired` about them. Every update does this too. */
  sweep(): Promise<void>
  /**
   * Sweeps when an ask expired unanswered or a call file no waiting ask names is left over, as a process that
   * stopped leaves them, and does nothing otherwise; read without the lock (review L1 of the slice 5 re-review).
   */
  sweepIfDue(): Promise<void>
  pendingDeliveries(): ApprovalDelivery[]
  acknowledgeDeliveries(ids: string[]): Promise<void>
  enqueueSkippedNotices(notices: ApprovalNotice[]): Promise<void>
  pending(): ApprovalRequest[]
  /** The asks still waiting, each with the call it came from: each group's call file read once and shared by its asks. */
  waiting(): PendingAsk[]
  /** One waiting ask with its call, reading that ask's call file alone; undefined when the token is not waiting. */
  waitingAsk(token: string): PendingAsk | undefined
  /** One session's `once` approvals not yet spent, each still bound to the tool it was asked for. */
  unspent(sessionId: string): Array<{ subject: GrantSubject; tool: string }>
}

/** One call to withdraw, with its requestId hashed as the registry keeps it. */
export type GroupSelector = { token: string } | { requestId: string; sessionId: string; actor?: string }

/** A requestId withdraw without an actor matched calls of more than one actor: HTTP 409, nothing withdrawn. */
export class AmbiguousWithdrawError extends Error {
  readonly code = 'WITHDRAW_AMBIGUOUS'
  readonly status = 409
}

/** What withdrawing one call did: the asks it withdrew, and the answered `once` approvals it dropped. */
export interface GroupWithdrawal {
  withdrawn: string[]
  dropped: string[]
}

export interface ApprovalRegistryOptions {
  lockDeadlineMs?: number
  durableNotices?: boolean
  onNoticeQueued?: () => void
  /** Told of this workspace's asks that expired unanswered, by whichever update drops them first. */
  onExpired?: (requests: ApprovalRequest[]) => void
}

export function createApprovalRegistry(grants: GrantStore, filePath: string, workspace = filePath, waitMs: number | null = 0, options: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const store = createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1, pending: [], once: [], resolved: [], outbox: [] }, lockDeadlineMs: options.lockDeadlineMs })
  const durableNotices = options.durableNotices === true
  const calls = createCallFiles(join(dirname(filePath), CALLS_DIRECTORY))
  // When the earliest waiting ask this process last saw expires: an ordinary call past it prunes, so an expired
  // ask's entry, its call file and its expiry notice never wait for the next approval event (review L1 of the
  // slice 5 re-review). Unknown until the queue is first read.
  let nextExpiry = Number.NEGATIVE_INFINITY
  let queueVersion: string | undefined
  let pruning: Promise<void> | undefined
  // The index version an ordinary call last found unreadable: it is not read again, nor its failure logged again,
  // until the file changes (review L3 of the continuation review). Any read that succeeds on any path clears it, as
  // the store clears its own report, so a repair seen only by an ask, a decision or the sender still lets the next
  // outage log once (slice 7f review R7F-QV-1).
  let unreadableVersion: string | undefined
  /** Whether an ask's end is told to the webhook: asked with the flag, or waiting in this durable registry's workspace. */
  const notifies = (entry: PendingEntry): boolean => entry.notify === true || (durableNotices && entry.workspace === workspace)

  /** Reads the queue without the lock, and notes when its earliest waiting ask expires. */
  function read(): State {
    // Capture before reading: a concurrent atomic rename is noticed on the next check.
    const version = currentQueueVersion()
    const state = store.read()
    // The read succeeded, so a version marked unreadable is readable again: forget the mark, whichever path read it.
    unreadableVersion = undefined
    queueVersion = version
    nextExpiry = earliestExpiry(state)
    return state
  }

  /**
   * Every change starts by dropping what expired; this workspace's unanswered asks among them are reported once
   * written, and the call files no waiting ask names any longer are removed once the index no longer names them.
   */
  async function update<R>(change: (state: State) => R | Promise<R>): Promise<R> {
    let expired: ApprovalRequest[] = []
    let released: string[] = []
    let queued = false
    // Set once the store has read the index whole, before the change runs, so a change that throws still counts it.
    let readable = false
    const result = await store.update(async (state) => {
      readable = true
      const before = namedCalls(state)
      const outboxBefore = new Set(state.outbox.map(entry => entry.id))
      const expiredEntries = prune(state)
      expired = expiredEntries.filter(entry => entry.workspace === workspace).map(entry => entry.request)
      // An expiry never refuses (review M2 of the continuation review): every update prunes first, so a throw here
      // would fail every later update, acknowledgement included.
      for (const entry of expiredEntries) {
        if (notifies(entry)) enqueueOutcome(state, entry.workspace, { token: entry.request.token, event: 'expired', at: new Date().toISOString() })
      }
      const value = await change(state)
      const after = namedCalls(state)
      released = [...before].filter(id => !after.has(id))
      const added = state.outbox.filter(entry => !outboxBefore.has(entry.id))
      queued = added.some(entry => entry.workspace === workspace)
      // Said once per update, not once per end it kept: one sweep may expire hundreds of unreserved asks.
      if (added.length > 0 && pastDeliveryLimits(state.outbox)) logger.warn('Approval outcome delivery is past its limits; the asks\' ends were kept anyway, and new asks wait until the receiver drains it', { entries: state.outbox.length, added: added.length, events: [...new Set(added.map(entry => entry.notice.event))] })
      nextExpiry = earliestExpiry(state)
      return value
    }).finally(() => {
      // The update read the index whole, so a version marked unreadable is readable again: forget it once the lock is
      // released, even when the change then threw, as the store forgot its own report (slice 7g review R7G-RG-1).
      if (readable) unreadableVersion = undefined
    })
    queueVersion = undefined
    calls.remove(released)
    if (expired.length > 0) options.onExpired?.(expired)
    // Only an update that queued a notice wakes the sender, which otherwise keeps its own retry delay (review L6 of the
    // continuation review): a decision, a cancel or an expiry here, not every write of the index.
    if (durableNotices && queued) options.onNoticeQueued?.()
    return result
  }

  /**
   * Ordinary calls stat the small index and read it only after an atomic replacement, so another process's
   * asks get an expiry too. No call body is read. Due cleanup finishes before the allowed call returns.
   */
  function pruneWhenDue(): Promise<void> | undefined {
    if (pruning) return pruning
    const version = currentQueueVersion()
    // An index found unreadable is read again once the file changes or the retry delay passes, since a repair in
    // place (a mode put back) keeps its version (slice 7 review R7-RR-2). While one is marked unreadable, any other
    // version is read at once, even the one last read whole, which a repair gives back: that read clears this mark and
    // the store's, so a second outage logs again (slice 7e review R7E-QV-1).
    const unreadable = version === unreadableVersion
    if (unreadable && Date.now() < nextExpiry) return undefined
    if ((unreadableVersion !== undefined || version !== queueVersion) && !readForPrune(version)) return undefined
    if (Date.now() < nextExpiry) return undefined
    nextExpiry = Number.POSITIVE_INFINITY
    pruning = update(() => undefined).catch((error: unknown) => {
      nextExpiry = Date.now() + PRUNE_RETRY_MS
      // A damaged index the store already reported is retried quietly, not warned about every PRUNE_RETRY_MS (slice 7c
      // review R7C-TL-3).
      if (!alreadyReported(error)) logger.warn('Could not drop the approvals that expired', { error: withoutCause(error) })
    }).finally(() => { pruning = undefined })
    return pruning
  }

  /**
   * Reads the index for pruneWhenDue. A damaged one fails the calls that need the queue, never an ordinary call the
   * rules settled (review L3 of the continuation review): it is logged once for each version of the file, with the
   * error's name and own message and never its cause, which quotes the file (slice 7 review R7-RR-3). The store logs
   * its own line once for each version, so the timed retry of a version already found unreadable adds none (slice 7b
   * review RRL-2, slice 7c review R7C-TL-3).
   */
  function readForPrune(version: string): boolean {
    try {
      // A successful read clears unreadableVersion itself, so this path need not clear it again.
      read()
      return true
    } catch (error) {
      if (!(error instanceof StateFileError)) throw error
      if (version !== unreadableVersion) logger.warn('The approvals index is unreadable; ordinary calls go on, while asks and decisions wait for its repair', { error: withoutCause(error) })
      unreadableVersion = version
      nextExpiry = Date.now() + PRUNE_RETRY_MS
      return false
    }
  }

  /**
   * The index's version as the store names it: an index that cannot be stat'ed gives `unknown:<code>`, never a raw
   * throw, so the store's failure is reported once per version and the sender retries quietly (slice 7d review
   * R7D-GR-1).
   */
  function currentQueueVersion(): string {
    return fileVersion(filePath)
  }

  /** A waiting ask with its whole call: read from the group's file, or inline for an ask recorded before this build. */
  function withCall(entry: PendingEntry): PendingAsk {
    return callsRead(callOf => withCallFrom(entry, callOf))
  }

  /**
   * One pass over call files: each file read and parsed once, and one warning for all those missing or unreadable,
   * never one per waiting ask (slice 7 review, notes: a 50-ask group warned 50 times per re-send).
   */
  function callsRead<R>(pass: (callOf: (id: string) => AskedCall | undefined) => R): R {
    const results = new Map<string, { call: AskedCall } | { failure: string }>()
    const value = pass((id) => {
      if (!results.has(id)) results.set(id, calls.read(id))
      const result = results.get(id)!
      return 'call' in result ? result.call : undefined
    })
    const failures = [...results.values()].flatMap(result => 'failure' in result ? [result.failure] : [])
    if (failures.length > 0) logger.warn('Waiting asks\' call files are missing or unreadable; their asks show as recorded before this build until the call is re-sent', { files: failures.length, errors: [...new Set(failures)] })
    return value
  }

  /**
   * Whether a waiting ask's call file still holds the whole call, for one pass: the index says the call was whole when
   * written, and the file is there at the size written (review L4 of the continuation review: a deleted or cut file
   * is partial). One stat per file and no parse, so a re-send of a large group stays cheap under the lock (slice 7
   * review R7-RR-1); a file damaged at its own size is found when a decision reads it, and approves nothing (D17).
   */
  function keptWhole(): (entry: PendingEntry) => boolean {
    const sizes = new Map<string, number | undefined>()
    return (entry) => {
      if (!entry.callFile) return entry.call?.complete === true
      const { id, bytes, complete } = entry.callFile
      if (!sizes.has(id)) sizes.set(id, calls.size(id))
      return complete === true && sizes.get(id) === bytes
    }
  }

  /**
   * Records one group's whole call in a file of its own, once the group fits the budgets, and names it from each
   * ask. `replacing`: the waiting asks the group stands in for (a re-send recording a call kept in part), not counted.
   */
  function recordCall(input: { state: State; group: PendingEntry[]; call: AskedCall; replacing?: readonly PendingEntry[] }): PendingEntry[] {
    const text = JSON.stringify(input.call)
    const callFile = { id: randomUUID(), bytes: Buffer.byteLength(text), ...(input.call.complete ? { complete: true as const } : {}) }
    const named = input.group.map(entry => ({ ...entry, callFile }))
    const replaced = new Set(input.replacing ?? [])
    assertBytesFor({ waiting: input.state.pending.filter(entry => entry.workspace === workspace && !replaced.has(entry)), group: named, callBytes: callFile.bytes })
    calls.write(callFile.id, text)
    return named
  }

  const registry: ApprovalRegistry = {
    async ask({ tool, sessionId, asks, requestId, actor, fingerprint: callFingerprint, call, waitMs: lifetime = waitMs, holdMs }) {
      const evicted: PendingEntry[] = []
      const result = await update((state): AskResult => {
        const now = Date.now()
        const joined = requestId === undefined ? null : joinWaiting({ state, workspace, key: { requestId, sessionId, actor }, call: { tool, asks, fingerprint: callFingerprint, ...(call === undefined ? {} : { recorded: call }) }, record: recordCall, shownWhole: keptWhole(), renew: entry => renewed(entry, holdMs, now) })
        if (joined) return { ...joined, ...lapseOfGroup(joined.requests, state) }
        // The group's expiry: ten minutes past the hold the node gives, or none at wait 0, where it lapses instead (item 5).
        const expiresAt = lifetime === null ? APPROVAL_NO_DEADLINE : new Date(now + PENDING_TTL_MS + lifetime).toISOString()
        const lapsesAt = lifetime === null ? lapseAfter(holdMs, now) : undefined
        const admit = (): AskResult => {
          assertRoomFor({ state, workspace, sessionId, actor, asked: asks.length })
          // Every field a person or a relay reads is redacted (owner decision D17), a reason as the free text it is
          // (owner ruling B); a subject is already what its rule asks under, which holds no credential the display redacts.
          // Keep the label in the signed reason so strict older challenges need no new field.
          const requests = asks.map(item => ({ token: randomUUID(), rule: item.rule, subject: item.subject, reason: redactCredentials(item.severity === undefined ? item.reason : `[${item.severity}] ${item.reason}`, 'text'), ...(item.severity === undefined ? {} : { severity: item.severity }), tool, offeredScopes: item.offeredScopes, expiresAt, ...(item.widerSubject === undefined ? {} : { widerSubject: item.widerSubject }) }))
          const entries: PendingEntry[] = requests.map((request, index) => ({ request, sessionId, workspace, floor: asks[index]!.floor, destructive: asks[index]!.destructive, ...(options.durableNotices ? { notify: true as const } : {}), ...(requestId === undefined ? {} : { requestId }), ...(actor === undefined ? {} : { actor }), ...(callFingerprint === undefined ? {} : { fingerprint: callFingerprint }), ...(lapsesAt === undefined ? {} : { lapsesAt }) }))
          assertDeliveryRoom(state, entries, notifies)
          // The group's whole call is kept once, in its own file, however many asks the call made (review M5).
          if (call === undefined) assertBytesFor({ waiting: state.pending.filter(entry => entry.workspace === workspace), group: entries, callBytes: 0 })
          state.pending.push(...(call === undefined ? entries : recordCall({ state, group: entries, call })))
          return { requests, joined: false, answered: [], ...(lapsesAt === undefined ? {} : { lapsesAt: Date.parse(lapsesAt) }) }
        }
        const admitted = withRoom({ state, workspace, sessionId, actor, admit, evicted })
        for (const entry of evicted) if (notifies(entry)) enqueueOutcome(state, entry.workspace, { token: entry.request.token, event: 'cancelled', at: new Date(now).toISOString() })
        return evicted.length === 0 ? admitted : { ...admitted, evicted: evicted.map(entry => entry.request.token) }
      })
      if (evicted.length > 0) logger.info('Withdrew abandoned approvals to make room for a new ask', { withdrawn: evicted.length })
      return result
    },

    async resolve(decision, authority = 'admin', options = {}) {
      const claim: DecisionClaim = {
        decision, authority, ...(options.widenTo === undefined ? {} : { widenTo: options.widenTo }),
        ...(options.challenge === undefined ? {} : { challenge: options.challenge.digest }), ...(options.consumeNotAfter === undefined ? {} : { consumeNotAfter: options.consumeNotAfter }),
      }
      // Refused before the lock, so these come back even when the approvals file cannot be read.
      const screened = screenDecision(claim)
      if (!screened.ok) {
        if (screened.code === 'assurance_too_low') logger.warn('Persisted approval refused: only the admin credential writes one', { scope: decision.scope })
        return { ok: false, reason: screened.reason }
      }
      // The grant is written while the approvals file is still locked, so no reader sees the decision without it.
      return update(async (state): Promise<Resolution> => {
        const now = Date.now()
        const previous = state.resolved.find(entry => entry.workspace === workspace && entry.decision.token === decision.token)
        const approval = previous === undefined ? state.pending.find(entry => entry.workspace === workspace && entry.request.token === decision.token) : undefined
        const waiting = approval === undefined ? undefined : waitingView(withCall(approval), options.challenge)
        const ledger: LedgerView = { ...(previous === undefined ? {} : { resolved: previous }), ...(waiting === undefined ? {} : { waiting }) }
        const verdict = guardDecision({ claim, ledger, now })
        if (!verdict.ok) return { ok: false, reason: verdict.reason }
        if ('repeated' in verdict) return { ok: true, repeated: true, ...(verdict.asked ? { asked: verdict.asked } : {}) }
        if (approval === undefined) throw new Error('The decision guard applied a decision to an ask the approvals ledger does not hold')
        const { wider, widenedTo } = verdict.apply
        const { rule, subject, tool } = approval.request
        const { requestId, actor } = approval
        const decider = options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }
        const coded = options.code === undefined ? {} : { code: options.code }
        // A once covers the call that asked and no other, whichever route decided it: the terminal,
        // `buckle approve`, MCP elicitation, the admin bearer, a sealed envelope or a person's key
        // (policy.md: "Once binds to the exact invocation"; review item 1 of the proof-of-possession fixes).
        const bound = approval.fingerprint !== undefined ? { fingerprint: approval.fingerprint } : {}
        const expiresAt = new Date(Math.min(now + PENDING_TTL_MS, decision.approved && decision.scope === 'once' ? options.consumeNotAfter ?? Infinity : Infinity)).toISOString()
        state.pending = state.pending.filter(entry => entry.request.token !== decision.token)
        state.resolved.push({
          workspace, decision, ...(widenedTo ? { widenedTo } : {}), expiresAt, request: approval.request, sessionId: approval.sessionId,
          ...(requestId === undefined ? {} : { requestId }), ...(actor === undefined ? {} : { actor }), ...(approval.fingerprint === undefined ? {} : { fingerprint: approval.fingerprint }), ...decider,
        })
        if (approval.notify || durableNotices) enqueueOutcome(state, workspace, {
          token: decision.token, event: decision.approved ? 'answered' : 'denied', at: new Date(now).toISOString(), scope: decision.scope,
          ...(decision.approved && decision.scope === 'once' && options.consumeNotAfter !== undefined ? { consumeNotAfter: new Date(options.consumeNotAfter).toISOString() } : {}),
        })
        if (decision.approved) {
          if (decision.scope === 'once') state.once.push({ workspace, token: decision.token, subject: { rule, subject }, sessionId: approval.sessionId, tool, expiresAt, ...(requestId === undefined ? {} : { requestId }), ...bound, ...decider, ...coded })
          else await grants.grant({ sessionId: approval.sessionId, rule, subject: widenedTo ?? wider ?? subject, scope: decision.scope, ...(widenedTo ? { pattern: true } : {}), ...decider })
          // The subject can carry a command's arguments, so the log names its size only; the action log keeps it.
          logger.info('Approval granted', { rule, scope: decision.scope, tool, subjectLength: subject.length, ...(widenedTo || wider ? { widened: true } : {}) })
        }
        if (!decision.approved && decision.scope !== 'once') await grants.grant({ sessionId: approval.sessionId, rule, subject, scope: decision.scope, denied: true, ...decider })
        const answered = { rule, subject }
        if (wider) return { ok: true, asked: answered, granted: wider }
        return widenedTo ? { ok: true, widened: { pattern: widenedTo, askedBy: subject }, asked: answered } : { ok: true, asked: answered }
      })
    },

    evaluate({ tokens, sessionId, tool, fingerprint: callFingerprint, check, admit, spent, holds }) {
      // An ordinary call carries no token and the rules settle it without a once, so no once could be spent and the
      // queue is not locked (review M5). It reads the small index only after another process replaced it, to learn
      // when the earliest ask expires, and rewrites it only to drop what expired; a damaged index fails neither the
      // call nor the next one (review L3 of the continuation review).
      if (tokens.length === 0) {
        const settled = check([])
        if (settled.kind !== 'ask') {
          if (settled.kind === 'allow') admit?.()
          const prune = pruneWhenDue()
          return prune ? prune.then(() => settled) : Promise.resolve(settled)
        }
      }
      return update(state => {
        // A once names the call it was asked for; any other call, token or not, cannot spend it (review H3 of B23-B25, item 1).
        // A once bound to code holds only while that code is what the call would run (fix brief 9, B31).
        const bound = state.once.filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && entry.tool === tool && Date.parse(entry.expiresAt) > Date.now() && (entry.fingerprint === undefined || entry.fingerprint === callFingerprint) && (entry.code === undefined || (holds?.(entry.subject, entry.code) ?? false)))
        const usable = bound.filter(entry => tokens.includes(entry.token))
        let used = [...usable, ...unclaimedReliedOn({ usable, unclaimed: bound.filter(entry => !tokens.includes(entry.token)), check })]
        // The last check is the one the caller acts on, so it sees only the approvals this call uses.
        let outcome = check(used.map(entry => entry.subject))
        while (outcome.kind === 'allow') {
          const live = used.filter(entry => Date.parse(entry.expiresAt) > Date.now())
          if (live.length === used.length) break
          used = live
          outcome = check(used.map(entry => entry.subject))
        }
        // Keep partial approvals until every gate clears; consume under the same process lock.
        if (outcome.kind === 'allow' && (admit?.() ?? true)) {
          const consumed = new Set(used.map(entry => entry.token))
          state.once = state.once.filter(entry => !consumed.has(entry.token))
          spent?.([...new Set(used.flatMap(entry => entry.decidedBy === undefined ? [] : [entry.decidedBy]))])
        }
        return outcome
      })
    },

    unspent: sessionId => read().once
      .filter(entry => entry.workspace === workspace && entry.sessionId === sessionId && Date.parse(entry.expiresAt) > Date.now())
      .map(entry => ({ subject: entry.subject, tool: entry.tool })),

    wasDenied: tokens => read().resolved.some(entry => entry.workspace === workspace && tokens.includes(entry.decision.token) && !entry.decision.approved),

    cancel(tokens) {
      return update(state => {
        const selected = state.pending.filter(entry => entry.workspace === workspace && tokens.includes(entry.request.token))
        const withdrawn = selected.map(entry => entry.request.token)
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.request.token))
        state.once = state.once.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.token))
        for (const entry of selected) if (entry.notify || durableNotices) enqueueOutcome(state, workspace, { token: entry.request.token, event: 'cancelled', at: new Date().toISOString() })
        return withdrawn
      })
    },

    holdEnded({ tokens, abandoned }) {
      return update((state) => {
        const now = Date.now()
        const lapse = now + PENDING_TTL_MS
        let earliest: number | undefined
        state.pending = state.pending.map((entry) => {
          if (entry.workspace !== workspace || !tokens.includes(entry.request.token)) return entry
          const noDeadline = entry.request.expiresAt === APPROVAL_NO_DEADLINE
          // Held until answered, it starts its ten minutes now; a lapse already set by a finite hold stands.
          if (!abandoned && (!noDeadline || entry.lapsesAt !== undefined)) return entry
          const at = Math.min(lapse, entry.lapsesAt === undefined ? Infinity : Date.parse(entry.lapsesAt))
          earliest = Math.min(earliest ?? Infinity, at)
          return { ...entry, lapsesAt: new Date(at).toISOString(), ...(abandoned ? { abandonedAt: new Date(now).toISOString() } : {}) }
        })
        return earliest
      })
    },

    cancelGroup(selector) {
      return update((state): GroupWithdrawal => {
        const pending = state.pending.filter(entry => entry.workspace === workspace)
        const resolved = state.resolved.filter(entry => entry.workspace === workspace)
        type Member = { token: string; requestId?: string; sessionId?: string; actor?: string }
        const members: Member[] = [
          ...pending.map(entry => ({ token: entry.request.token, requestId: entry.requestId, sessionId: entry.sessionId, actor: entry.actor })),
          ...resolved.map(entry => ({ token: entry.decision.token, requestId: entry.requestId, sessionId: entry.sessionId, actor: entry.actor })),
        ]
        // A token names its group whether its ask still waits or was answered.
        const named = 'token' in selector ? members.find(member => member.token === selector.token) : undefined
        const inGroup = 'token' in selector
          ? (member: Member) => member === named || (named?.requestId !== undefined && member.requestId === named.requestId && member.sessionId === named.sessionId && member.actor === named.actor)
          : (member: Member) => member.requestId === selector.requestId && member.sessionId === selector.sessionId && (selector.actor === undefined || member.actor === selector.actor)
        const matched = members.filter(inGroup)
        // A call is its requestId, session and actor: one actor's cancel never drops another's asks or onces.
        if (new Set(matched.map(member => member.actor)).size > 1) throw new AmbiguousWithdrawError('That requestId and session name calls of more than one actor; send the actor, or a token of the call')
        const group = new Set(matched.map(member => member.token))
        const withdrawn = pending.map(entry => entry.request.token).filter(token => group.has(token))
        const dropped = state.once.filter(entry => entry.workspace === workspace && group.has(entry.token)).map(entry => entry.token)
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !group.has(entry.request.token))
        state.once = state.once.filter(entry => entry.workspace !== workspace || !group.has(entry.token))
        for (const entry of pending.filter(entry => group.has(entry.request.token))) if (entry.notify || durableNotices) enqueueOutcome(state, workspace, { token: entry.request.token, event: 'cancelled', at: new Date().toISOString() })
        return { withdrawn, dropped }
      })
    },

    // Also removes call files no waiting ask names, which a process that stopped between the two writes leaves.
    sweep: () => update(state => calls.prune(namedCalls(state))),

    async sweepIfDue() {
      const state = read()
      if (Date.now() >= nextExpiry || calls.unnamed(namedCalls(state))) await registry.sweep()
    },

    pendingDeliveries: () => read().outbox.filter(entry => entry.workspace === workspace && Date.parse(entry.expiresAt) > Date.now()).map(({ workspace: _workspace, ...entry }) => entry),

    acknowledgeDeliveries(ids) {
      const accepted = new Set(ids)
      return update(state => { state.outbox = state.outbox.filter(entry => entry.workspace !== workspace || !accepted.has(entry.id)) })
    },

    enqueueSkippedNotices(notices) {
      if (!durableNotices || notices.length === 0) return Promise.resolve()
      return update(state => {
        for (const value of notices) {
          const notice = ApprovalNoticeSchema.parse(value)
          if (notice.event !== 'skipped') throw new Error('Only registry transitions enqueue terminal approval outcomes')
          if (!state.pending.some(entry => entry.workspace === workspace && entry.request.token === notice.token)) continue
          enqueueOutcome(state, workspace, notice)
        }
      })
    },

    pending: () => read().pending
      .filter(entry => entry.workspace === workspace && lapseOf(entry) > Date.now())
      .map(entry => entry.request),

    // Each group's call file is read and parsed once, and its asks share the one call (review M1 of the slice 5 re-review).
    waiting() {
      const pending = read().pending.filter(entry => entry.workspace === workspace && lapseOf(entry) > Date.now())
      return callsRead(callOf => pending.map(entry => withCallFrom(entry, callOf)))
    },

    waitingAsk(token) {
      const entry = read().pending.find(candidate => candidate.workspace === workspace && candidate.request.token === token && lapseOf(candidate) > Date.now())
      return entry === undefined ? undefined : withCall(entry)
    },
  }
  return registry
}

/** A queue entry as a waiting ask: its call from the group's file (read by `readCall`), or inline for an ask recorded before this build. */
function withCallFrom({ workspace: _workspace, callFile, call, ...entry }: PendingEntry, readCall: (id: string) => AskedCall | undefined): PendingAsk {
  const whole = callFile ? readCall(callFile.id) : call
  return { ...entry, ...(callFile ? { callRef: callFile.id } : {}), ...(whole === undefined ? {} : { call: whole }) }
}

/** When the earliest ask waiting in the file expires, any workspace's: every update prunes them all. */
function earliestExpiry(state: State): number {
  return Math.min(...state.pending.map(lapseOf), ...state.outbox.map(entry => Date.parse(entry.expiresAt)))
}

/** When a waiting ask leaves the queue: its stated expiry, or its lapse where that comes first (the MCP asks brief, item 5). */
function lapseOf(entry: PendingEntry): number {
  return Math.min(Date.parse(entry.request.expiresAt), entry.lapsesAt === undefined ? Infinity : Date.parse(entry.lapsesAt))
}

/** The lapse of an ask whose caller is held `holdMs`: ten minutes past the hold, or none while held until answered. */
function lapseAfter(holdMs: number | null | undefined, now: number): string | undefined {
  return holdMs === undefined || holdMs === null ? undefined : new Date(now + holdMs + PENDING_TTL_MS).toISOString()
}

/**
 * A waiting ask a re-send joined: no longer abandoned, and its clock restarted from the re-send's hold (the MCP asks brief,
 * item 5). A re-send that gives no hold, from a face that does not send calls again, holds the ask until answered, as a
 * first call does: its lapse goes with the abandoned mark.
 */
function renewed(entry: PendingEntry, holdMs: number | null | undefined, now: number): PendingEntry {
  const { lapsesAt: _lapsesAt, abandonedAt: _abandonedAt, ...rest } = entry
  const lapsesAt = entry.request.expiresAt === APPROVAL_NO_DEADLINE ? lapseAfter(holdMs, now) : undefined
  return lapsesAt === undefined ? rest : { ...rest, lapsesAt }
}

/** The earliest lapse among a joined group's waiting asks, for the sweep that reports it. */
function lapseOfGroup(requests: readonly ApprovalRequest[], state: State): { lapsesAt?: number } {
  const tokens = new Set(requests.map(request => request.token))
  const lapses = state.pending.flatMap(entry => tokens.has(entry.request.token) && entry.lapsesAt !== undefined ? [Date.parse(entry.lapsesAt)] : [])
  return lapses.length === 0 ? {} : { lapsesAt: Math.min(...lapses) }
}

/**
 * Admits a new group, and while a cap refuses it withdraws the oldest abandoned ask that cap counts, one at a time, so the
 * cap is never reached through abandoned asks alone (the MCP asks brief, item 5). Each withdrawn ask is told cancelled, as
 * an ask whose caller left is. A cap full of asks someone holds or re-sent still refuses.
 */
function withRoom(input: { state: State; workspace: string; sessionId: string; actor: string | undefined; admit: () => AskResult; evicted: PendingEntry[] }): AskResult {
  for (;;) {
    try {
      return input.admit()
    } catch (error) {
      if (!(error instanceof ApprovalLimitError)) throw error
      const counted = (entry: PendingEntry) => entry.workspace === input.workspace && (error.room === 'workspace' || (entry.actor === input.actor && (error.room === 'actor' || entry.sessionId === input.sessionId)))
      const oldest = input.state.pending
        .filter(entry => entry.abandonedAt !== undefined && counted(entry))
        .sort((a, b) => Date.parse(a.abandonedAt!) - Date.parse(b.abandonedAt!))[0]
      if (!oldest) throw error
      input.state.pending = input.state.pending.filter(entry => entry !== oldest)
      input.evicted.push(oldest)
    }
  }
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
function joinWaiting(input: { state: State; workspace: string; key: JoinKey; call: { tool: string; asks: Ask[]; fingerprint?: string; recorded?: AskedCall }; record: (input: { state: State; group: PendingEntry[]; call: AskedCall; replacing: readonly PendingEntry[] }) => PendingEntry[]; shownWhole: (entry: PendingEntry) => boolean; renew: (entry: PendingEntry) => PendingEntry }): AskResult | null {
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
  // An ask recorded before this build, or whose call file is missing or damaged, names the same call (its fingerprint
  // matched): the re-send records it whole, in a file of its own and within the budgets, so a person's device can
  // decide it (owner decision D17, review M5; review L4 of the continuation review).
  // The fingerprint and the re-sent call's completeness first, so a call file is judged only when it could be repaired.
  const { recorded: whole } = input.call
  const partial = whole?.complete ? pending.filter(entry => entry.fingerprint !== undefined && entry.fingerprint === input.call.fingerprint && !input.shownWhole(entry)) : []
  if (whole?.complete && partial.length > 0) {
    const recorded = input.record({ state: input.state, group: partial.map(({ call: _call, callFile: _callFile, ...entry }) => entry), call: whole, replacing: partial })
    input.state.pending = input.state.pending.map(entry => { const index = partial.indexOf(entry); return index === -1 ? entry : recorded[index]! })
  }
  // The re-send holds the asks now: they are no longer abandoned, and their clock restarts (the MCP asks brief, item 5).
  input.state.pending = input.state.pending.map(entry => inGroup(entry) ? input.renew(entry) : entry)
  return { requests: waiting, joined: true, answered: answered.map(request => request.token) }
}

/** Every waiting ask is asked again with the same tool, rule, subject, scopes and severity. */
function sameGroup(input: { waiting: ApprovalRequest[]; answered: ApprovalRequest[]; call: { tool: string; asks: Ask[] } }): boolean {
  const key = (item: { rule: string; subject: string; offeredScopes: readonly string[]; severity?: ApprovalRequest['severity'] }) => JSON.stringify([item.rule, item.subject, [...item.offeredScopes].sort(), item.severity ?? null])
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

/** A waiting ask as the decision guard reads it: whether its whole call was kept, and the challenges it was shown under. */
function waitingView(asked: PendingAsk, challenge: ResolveOptions['challenge']): NonNullable<LedgerView['waiting']> {
  return { request: asked.request, complete: asked.call?.complete === true, challenges: challenge === undefined ? [] : challenge.shown(asked) }
}

/** Drops everything past its expiry, returning the asks that expired unanswered. */
function prune(state: State): State['pending'] {
  const now = Date.now()
  state.outbox = state.outbox.filter(entry => Date.parse(entry.expiresAt) > now)
  const expired = state.pending.filter(entry => lapseOf(entry) <= now)
  state.pending = state.pending.filter(entry => lapseOf(entry) > now)
  state.once = state.once.filter(entry => Date.parse(entry.expiresAt) > now)
  state.resolved = state.resolved.filter(entry => Date.parse(entry.expiresAt) > now)
  return expired
}

/**
 * Admits an ask only while the outbox has room for every waiting ask's end (and its wait notice) besides what it
 * holds. `notifies` names the asks whose end is queued: those asked with the flag, and in a durable registry every
 * ask of its workspace, so an ask from before the webhook was configured is reserved for too (review M2 of the
 * continuation review).
 */
function assertDeliveryRoom(state: State, additional: readonly PendingEntry[], notifies: (entry: PendingEntry) => boolean): void {
  const pending = [...state.pending, ...additional].filter(notifies)
  const reserved = pending.flatMap(entry => {
    const reservation = {
    id: '00000000-0000-4000-8000-000000000000', workspace: entry.workspace, expiresAt: '9999-12-31T23:59:59.999Z',
    notice: { token: entry.request.token, event: 'cancelled', at: '9999-12-31T23:59:59.999Z', scope: 'session', reason: 'caller_declined_wait', consumeNotAfter: '9999-12-31T23:59:59.999Z' },
    }
    // Reserve the skipped wait notice too, until it already occupies its own slot.
    return state.outbox.some(item => item.workspace === entry.workspace && item.notice.token === entry.request.token) ? [reservation] : [reservation, reservation]
  })
  if (pastDeliveryLimits([...state.outbox, ...reserved])) {
    throw new ApprovalLimitError('Approval outcome delivery is full; restore the webhook receiver before asking for more approvals', 'workspace')
  }
}

function pastDeliveryLimits(entries: readonly unknown[]): boolean {
  return entries.length > APPROVAL_OUTBOX_COUNT_MAX || Buffer.byteLength(JSON.stringify(entries)) > APPROVAL_OUTBOX_BYTES_MAX
}

/**
 * Queues an ask's end or its wait notice, and never refuses (review M2 of the continuation review): an expiry,
 * a decision, a cancel or an acknowledgement must commit whatever the outbox holds. Admission keeps the outbox
 * within its limits for every reserved ask; an end nothing reserved room for may pass them, which the update logs
 * once, and new asks then wait until the receiver drains it.
 */
function enqueueOutcome(state: State, workspace: string, notice: ApprovalNotice): void {
  const previous = state.outbox.find(entry => entry.workspace === workspace && entry.notice.token === notice.token)
  if (previous && (previous.notice.event !== 'skipped' || notice.event === 'skipped')) return
  state.outbox = state.outbox.filter(entry => entry !== previous)
  state.outbox.push({ id: randomUUID(), workspace, notice, expiresAt: new Date(Date.now() + APPROVAL_OUTBOX_RETENTION_MS).toISOString() })
}

export function subjectsByRule(subjects: GrantSubject[], rule: PermissionRuleId): string[] {
  return subjects.filter(subject => subject.rule === rule).map(subject => subject.subject)
}
