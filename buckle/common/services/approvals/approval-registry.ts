import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { redactCredentials } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, ApprovalNoticeSchema, ApprovalDecisionSchema, ApprovalRequestSchema, GrantRecordSchema, PermissionRuleIdSchema, type ApprovalDecision, type ApprovalNotice, type ApprovalRequest, type GrantRecord, type GrantSubject, type PermissionRuleId } from '@5straps/protocol'
import { alreadyReported, createJsonFileStore, fileVersion, StateFileError } from '../../adapters/json-file-store.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import type { PermissionOutcome } from '../../domain/permission/engine.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import { servesHolder, type GrantHolder } from '../../domain/permission/grant-holder.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import { askedCallSchema, type AskedCall } from '../../domain/approval/asked-call.js'
import { guardDecision, guardSkip, screenDecision, type DecisionClaim, type LedgerView } from '../../domain/approval/decision-guard.js'
import { TODAYS_ROUTES } from '../../domain/approval/routes.js'
import { GRANT_SAVES, type ApprovalErrorCode, type EventReason, type GrantSave } from '../../types/ports/approval-backend.js'
import { BUILT_IN_SOURCES, type ApprovalSource } from '../../types/ports/approval-source.js'
import { logger, withoutCause } from '../../runtime/log.js'
import { isPlainName } from '../../domain/paths.js'
import { dropOnces, liveOnces, onceSchema, spendOnces, unspentOnces, type OnceEntry, type OnceSpend, type UnspentOnce } from './once-store.js'
import { ActionTooLargeError, ApprovalConflictError, ApprovalLimitError, RequestIdReusedError } from './approval-errors.js'
import { saveFailure } from './grant-save.js'

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
/** The revokes and session ends made while approvals.json could not be read, beside it. */
const REVOCATIONS_FILE = 'approval-revocations.json'
/** The saves a settling pass still has work for: a grant to write, or a skipped grant to confirm removed. */
const UNSETTLED_SAVES: ReadonlySet<GrantSave> = new Set(['owed', 'skipping'])
const CALL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
// requestId and actor let a re-sent call join the ask it already made (ruling 5 of 2026-09-28); an
// answered entry keeps them, so a call re-sent after part of its asks were answered still joins.
const joinKey = { requestId: z.string().optional(), actor: z.string().optional() }
// fingerprint: the tool and its whole arguments that asked, hashed (requestFingerprint); a re-send joins
// only with the same one, and a once decided on its ask is spent only by it, whichever route decided it
// (review H3 of B23-B25; review item 1 of the proof-of-possession fixes).
const fingerprint = { fingerprint: z.string().optional() }
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
const pendingSchema = z.object({ request: ApprovalRequestSchema, sessionId: z.string(), workspace: z.string(), ...marks, ...joinKey, ...fingerprint, notify: z.literal(true).optional(), call: askedCallSchema.optional(), callFile: callFileSchema.optional(), ...lapse })
// grant: the session or always grant an approval makes, kept with its resolved entry under the id it is written with.
// `save` is `owed` until the grant store holds it, then `saved`; a skip turns it `skipping` until a grant that may have
// saved is confirmed gone, then `skipped`, which nothing writes again. The entry commits first, so a grant never stands
// without its decision; one left owed is written, and one left skipping removed, when the workspace opens again
// (recover) or by the next decision recorded or sent again, and a revoke or a session end that undoes an owed one drops
// it. `source`: the route that recorded the decision, which alone may skip it. A lasting denial is never owed: it is
// written before its decision commits.
const sourceSchema = z.object({ id: z.string(), kind: z.enum([...BUILT_IN_SOURCES, 'backend']) })
const lastingGrantSchema = z.object({
  id: z.string().uuid(), sessionId: z.string(), actor: z.string().optional(), rule: PermissionRuleIdSchema, subject: z.string(), scope: z.enum(['session', 'always']),
  pattern: z.literal(true).optional(), ...decidedBy, source: sourceSchema, save: z.enum(GRANT_SAVES),
})
type LastingGrant = z.infer<typeof lastingGrantSchema>
const resolvedSchema = z.object({
  workspace: z.string(), decision: ApprovalDecisionSchema, widenedTo: z.string().optional(), expiresAt: z.string(),
  request: ApprovalRequestSchema.optional(), sessionId: z.string().optional(), ...joinKey, ...fingerprint, ...decidedBy,
  grant: lastingGrantSchema.optional(),
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
type ResolvedEntry = State['resolved'][number]

// Each drops the owed grants that would write again what it removed: a revoked grant, or a session's grants. It is applied
// before the next decision, so it reaches only grants decided before it.
const revocationSchema = z.union([z.object({ grant: GrantRecordSchema }), z.object({ sessionId: z.string() })])
type Revocation = z.infer<typeof revocationSchema>
const revocationsSchema = z.object({ version: z.literal(1), revoked: z.array(revocationSchema) })
type PendingEntry = State['pending'][number]
/** A decision, with the answer it gives and its resolved entry, whose lasting grant reads `owed` while it is unwritten. */
interface AppliedDecision { resolution: Extract<Resolution, { ok: true }>; entry: ResolvedEntry }
/**
 * How far a decision got: made under the lock (`decided`), or refused there (`refused`), then on disk (`recorded`), with a
 * lasting denial written to the grant store before either (`denial`), and why the last settling pass left a grant owed
 * (`saveError`).
 */
interface DecisionProgress { decided?: AppliedDecision; refused?: Extract<Resolution, { ok: false }>; recorded?: true; denial?: GrantRecord; saveError?: string }
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
    return { bytes: recordBytes(entry) + file, sessionId: entry.sessionId, actor: entry.actor }
  })
}

// The marks are the ledger's own and are never shown, so they count against no budget.
function recordBytes(entry: PendingEntry): number {
  const { floor: _floor, destructive: _destructive, ...counted } = entry
  return Buffer.byteLength(JSON.stringify(counted))
}

/**
 * One request group against the budgets (review M5). Each ask records its request and the group's whole call,
 * which must fit what a person is shown whole: one too large is refused for good. Every waiting ask of the
 * session, of the actor and of the workspace together must fit theirs, the group's call counted once: a full
 * budget refuses until asks are answered, withdrawn or expire.
 */
function assertBytesFor(input: { waiting: readonly PendingEntry[]; group: readonly PendingEntry[]; callBytes: number }): void {
  const sizes = input.group.map(recordBytes)
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
        return { call: askedCallSchema.parse(JSON.parse(readFileSync(pathOf(id), 'utf8'))) }
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
  /** Grant the ask's wider subject, read under the lock from the ask, waiting or resolved, so a repeat names the same one. */
  widen?: 'below'
}

/**
 * On a widened grant, the pattern recorded and the host it was asked for, for the audit entry.
 * `repeated` marks an answer identical to the one already recorded, which changes nothing. `asked`
 * is the rule and subject the decision answered, for the decision's audit entry (review item 6).
 * `granted`: the ask's wider subject, where the decision granted it in place of the ask's own (the delete policy brief).
 * `save`: where the session or always grant an approval made stands; while it is `owed`, `saveError` says why, naming no
 * path. A refusal is `retryable` where the same decision sent again may apply; a `grant_unsaved` one says why in `saveError`.
 */
export type Resolution =
  | { ok: true; widened?: { pattern: string; askedBy: string }; repeated?: true; asked?: { rule: PermissionRuleId; subject: string }; granted?: string; save?: GrantSave; saveError?: string }
  | { ok: false; code: ApprovalErrorCode; reason: string; retryable?: true; saveError?: string }

/** Why a grant given up is not confirmed gone: it `stands`, since it could not be removed, or the grants could not be read. */
export interface UnfinishedRemoval { stands: boolean; saveError: string }

/**
 * What a skip came to: `repeated` where the save was skipped already, `removed` where its grant had saved and is gone,
 * `unfinished` where a grant that may have saved is not confirmed gone, which the next settling pass removes.
 */
export type SkipResolution =
  | { ok: true; repeated?: true; removed?: true; unfinished?: UnfinishedRemoval }
  | { ok: false; code: ApprovalErrorCode; reason: string }

/**
 * How an ask left the queue: its recorded decision, else what this process saw. A lapse moves an ask's expiry, so it
 * reads as expired.
 */
export type Departure = { type: 'answered' | 'denied' } | { type: 'expired' } | { type: 'cancelled'; reason: EventReason }

/** How many departures this process remembers, oldest dropped first: a poll reads each within a second. */
const DEPARTURES_KEPT = 1_024
const EXPIRED: Departure = { type: 'expired' }

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
  /** The workspace's grants as every caller uses them: a revoke or a session end also drops the owed grants that would write them again. */
  grants: GrantStore
  /** Issues the asks, or joins the ones a call with the same requestId, session and actor is already waiting on. */
  ask(input: AskInput): Promise<AskResult>
  /**
   * `BUCKLE-D14`: a decision that outlives the call needs a source whose kind the guard rates `local` or above; a relayed
   * one decides `once`, which expires with the call it unblocks, and a backend's only denies.
   */
  resolve(decision: ApprovalDecision, source: ApprovalSource, options?: ResolveOptions): Promise<Resolution>
  /**
   * Gives up the grant of a session or always approval `source` recorded, under the approvals lock the settling pass takes,
   * so one of them goes first. One whose grant may have saved and is not confirmed removed answers `unfinished`.
   */
  skipSave(input: { token: string; source: ApprovalSource }): Promise<SkipResolution>
  /**
   * The last check clears the call or not. A cleared call's `once` approvals are spent under the
   * queue's lock, and `admit` runs under it first: false (another run of the call holds it) leaves them
   * unspent.
   */
  evaluate(input: OnceSpend): Promise<PermissionOutcome>
  wasDenied(tokens: string[]): boolean
  /** How each of these tokens left the queue, for those with a recorded decision or that this process saw go. */
  departures(tokens: string[]): Map<string, Departure>
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
  unspent(sessionId: string): UnspentOnce[]
  /**
   * Run as the workspace opens: applies the revokes recorded while approvals.json could not be read, then writes the grants
   * decisions left owed and removes those skips left unconfirmed, when a process stopped between the writes.
   */
  recover(): Promise<void>
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

/** The ledger is keyed by the grant store's workspace, so its asks and their grants never part. */
export function createApprovalRegistry(grantStore: GrantStore, filePath: string, waitMs: number | null = 0, options: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const { workspace } = grantStore
  const store = createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1, pending: [], once: [], resolved: [], outbox: [] }, lockDeadlineMs: options.lockDeadlineMs })
  const durableNotices = options.durableNotices === true
  const calls = createCallFiles(join(dirname(filePath), CALLS_DIRECTORY))
  const revocationsPath = join(dirname(filePath), REVOCATIONS_FILE)
  const revocations = createJsonFileStore({ filePath: revocationsPath, schema: revocationsSchema, fallback: { version: 1, revoked: [] }, lockDeadlineMs: options.lockDeadlineMs })
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
  // How the asks this process dropped or withdrew left the queue, oldest first.
  const departedHere = new Map<string, Departure>()
  function departed(tokens: readonly string[], departure: Departure): void {
    for (const token of tokens) {
      departedHere.delete(token)
      departedHere.set(token, departure)
      const [oldest] = departedHere.keys()
      if (departedHere.size > DEPARTURES_KEPT && oldest !== undefined) departedHere.delete(oldest)
    }
  }
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
   * `committed` runs once the change is on disk, before the lock is released.
   */
  async function update<R>(change: (state: State, commit: () => Promise<void>) => R | Promise<R>, committed?: () => void): Promise<R> {
    let expired: ApprovalRequest[] = []
    let released: string[] = []
    let queued = false
    // Set once the store has read the index whole, before the change runs, so a change that throws still counts it.
    let readable = false
    const result = await store.update(async (state, commit) => {
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
      const value = await change(state, commit)
      const after = namedCalls(state)
      released = [...before].filter(id => !after.has(id))
      const added = state.outbox.filter(entry => !outboxBefore.has(entry.id))
      queued = added.some(entry => entry.workspace === workspace)
      // Said once per update, not once per end it kept: one sweep may expire hundreds of unreserved asks.
      if (added.length > 0 && pastDeliveryLimits(state.outbox)) logger.warn('Approval outcome delivery is past its limits; the asks\' ends were kept anyway, and new asks wait until the receiver drains it', { entries: state.outbox.length, added: added.length, events: [...new Set(added.map(entry => entry.notice.event))] })
      nextExpiry = earliestExpiry(state)
      return value
    }, committed).finally(() => {
      // The update read the index whole, so a version marked unreadable is readable again: forget it once the lock is
      // released, even when the change then threw, as the store forgot its own report (slice 7g review R7G-RG-1).
      if (readable) unreadableVersion = undefined
    })
    // The change is on disk, so a step below that fails undoes none of it.
    queueVersion = undefined
    calls.remove(released)
    departed(expired.map(request => request.token), EXPIRED)
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

  /**
   * Under the approvals lock (approvals, then grants): writes this workspace's owed grants and removes the grants of skips
   * not confirmed, each committed as it settles, and returns why the first that failed did not. A failure is logged, never
   * thrown, so the change that settles still finishes; the rest wait for the next pass.
   */
  async function settleGrants(state: State, commit: () => Promise<void>): Promise<string | undefined> {
    const unwritten = await writeOwed(state, commit)
    const unremoved = await finishSkips(state, commit)
    return unwritten ?? unremoved
  }

  /** Each owed grant committed as saved once written, so a grant reads owed on disk past its write only where that commit fails. */
  async function writeOwed(state: State, commit: () => Promise<void>): Promise<string | undefined> {
    try {
      for (const entry of state.resolved) {
        const owed = savedAt(entry, 'owed')
        if (owed === undefined) continue
        const { save: _save, source: _source, ...grant } = owed
        await grants.grant(grant)
        entry.grant = { ...owed, save: 'saved' }
        await commit()
      }
      return undefined
    } catch (error) {
      logger.warn('A grant a recorded decision owes was not written; it is written when the workspace opens again or the same decision is sent again', { error: withoutCause(error) })
      return saveFailure(error)
    }
  }

  /** Each skip whose grant is not confirmed gone, committed as skipped once its grant is removed by the id it kept. */
  async function finishSkips(state: State, commit: () => Promise<void>): Promise<string | undefined> {
    for (const entry of state.resolved) {
      const skipping = savedAt(entry, 'skipping')
      if (skipping === undefined) continue
      const removal = await removeGrant(skipping.id)
      if ('saveError' in removal) return removal.saveError
      entry.grant = { ...skipping, save: 'skipped' }
      await commit()
    }
    return undefined
  }

  /** The lasting grant of an entry of this workspace, while its save reads `save`. */
  const savedAt = (entry: ResolvedEntry, save: GrantSave): LastingGrant | undefined => (entry.workspace === workspace && entry.grant?.save === save ? entry.grant : undefined)
  const owedHere = (entry: ResolvedEntry): LastingGrant | undefined => savedAt(entry, 'owed')
  /** Whether a settling pass has work: a grant owed, or a skip whose grant is not confirmed gone. */
  const unsettled = (state: State): boolean => state.resolved.some(entry => entry.workspace === workspace && entry.grant !== undefined && UNSETTLED_SAVES.has(entry.grant.save))

  /** Drops this workspace's owed grants that `undone` names, so none is written, and says how many it dropped. */
  function dropOwed(state: State, undone: (grant: LastingGrant) => boolean): number {
    const dropped = state.resolved.filter((entry) => {
      const owed = owedHere(entry)
      return owed !== undefined && undone(owed)
    })
    for (const entry of dropped) delete entry.grant
    return dropped.length
  }

  /**
   * Drops the owed grants the revokes and session ends recorded while approvals.json could not be read would write again,
   * then forgets them. Every update that may write an owed grant runs it first, under the approvals lock that recording
   * one takes too, so each reaches the grants decided before it and none after. A damaged revocations file refuses the
   * update, as a damaged approvals.json does.
   */
  async function applyRevocations(state: State, commit: () => Promise<void>): Promise<void> {
    if (!existsSync(revocationsPath)) return
    const { revoked } = revocations.read()
    if (dropOwed(state, grant => revoked.some(revocation => undoes(revocation, grant))) > 0) await commit()
    rmSync(revocationsPath, { force: true })
  }

  /**
   * Drops, under the approvals lock, every owed grant that would write again what the revocation removes, then removes it.
   * While approvals.json cannot be read, the revocation is recorded in its own file first, still under that lock, and
   * the next decision or opening applies it before any owed grant is written; a revocations file that cannot be written
   * then fails the removal.
   */
  async function withOwedDropped<R>(input: { revocation: Revocation; remove: () => Promise<R> }): Promise<R> {
    let read = false
    try {
      return await update(async (state, commit) => {
        read = true
        if (dropOwed(state, grant => undoes(input.revocation, grant)) > 0) await commit()
        return input.remove()
      })
    } catch (error) {
      if (read || !(error instanceof StateFileError)) throw error
      return store.locked(async () => {
        await revocations.update((file) => { file.revoked.push(input.revocation) })
        logger.warn('Removed grants while the approvals file is unreadable; the decisions it records will not write them again once it is repaired', { error: withoutCause(error) })
        return input.remove()
      })
    }
  }

  async function revoke(id: string): Promise<boolean> {
    const record = grantStore.list().find(grant => grant.id === id)
    if (record === undefined) return false
    return withOwedDropped({ revocation: { grant: record }, remove: () => grantStore.revoke(id) })
  }

  // Read through at each call, so the registry's own writes and every caller's meet the same store. A revoke or a session end
  // also drops the owed grants that would write again what it removed.
  const grants: GrantStore = {
    workspace,
    activeSubjects: input => grantStore.activeSubjects(input),
    activePatterns: input => grantStore.activePatterns(input),
    grant: input => grantStore.grant(input),
    list: () => grantStore.list(),
    revoke,
    endSession: sessionId => withOwedDropped({ revocation: { sessionId }, remove: () => grantStore.endSession(sessionId) }),
  }

  /**
   * One decision under the approvals lock: the guard's verdict, then the resolved entry, its notice and its once, which
   * `progress` holds. A decision that makes a grant, or meets one owed, commits before any grant is written.
   */
  async function applyDecision(input: { state: State; commit: () => Promise<void>; claim: DecisionClaim; options: ResolveOptions; progress: DecisionProgress }): Promise<Resolution> {
    const { state, commit, options, progress } = input
    const { token } = input.claim.decision
    const now = Date.now()
    const previous = state.resolved.find(entry => entry.workspace === workspace && entry.decision.token === token)
    const approval = previous === undefined ? state.pending.find(entry => entry.workspace === workspace && entry.request.token === token) : undefined
    const decision = widened({ decision: input.claim.decision, widen: options.widen, request: (approval ?? previous)?.request })
    if (decision === null) return { ok: false, code: 'scope_not_offered', reason: 'This ask has no wider subject to grant' }
    const claim: DecisionClaim = { ...input.claim, decision }
    const waiting = approval === undefined ? undefined : waitingView(withCall(approval), options.challenge)
    const ledger: LedgerView = { ...(previous === undefined ? {} : { resolved: previous }), ...(waiting === undefined ? {} : { waiting }) }
    const verdict = guardDecision({ claim, ledger, now })
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason }
    if ('repeated' in verdict) {
      const repeated: Extract<Resolution, { ok: true }> = { ok: true, repeated: true, ...(verdict.asked ? { asked: verdict.asked } : {}) }
      if (previous === undefined) return repeated
      progress.decided = { resolution: repeated, entry: previous }
      progress.recorded = true
      if (unsettled(state)) progress.saveError = await settleGrants(state, commit)
      return savedAs({ decided: progress.decided, saveError: progress.saveError })
    }
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
    const holder = { sessionId: approval.sessionId, ...(actor === undefined ? {} : { actor }) }
    if (!decision.approved && decision.scope !== 'once') {
      const unsaved = await writeDenial({ state, commit, progress, holder, rule, subject, scope: decision.scope, decider })
      if (unsaved) return unsaved
    }
    const grant = lastingGrantOf({ decision, holder, rule, subject, widenedTo, wider, decider, source: input.claim.source })
    state.pending = state.pending.filter(entry => entry.request.token !== decision.token)
    const resolved: ResolvedEntry = {
      workspace, decision, ...(widenedTo ? { widenedTo } : {}), expiresAt, request: approval.request, sessionId: approval.sessionId,
      ...(requestId === undefined ? {} : { requestId }), ...(actor === undefined ? {} : { actor }), ...(approval.fingerprint === undefined ? {} : { fingerprint: approval.fingerprint }), ...decider,
      ...(grant === undefined ? {} : { grant }),
    }
    state.resolved.push(resolved)
    if (approval.notify || durableNotices) enqueueOutcome(state, workspace, {
      token: decision.token, event: decision.approved ? 'answered' : 'denied', at: new Date(now).toISOString(), scope: decision.scope,
      ...(decision.approved && decision.scope === 'once' && options.consumeNotAfter !== undefined ? { consumeNotAfter: new Date(options.consumeNotAfter).toISOString() } : {}),
    })
    const onceFor = (): OnceEntry => ({ workspace, token: decision.token, subject: { rule, subject }, sessionId: approval.sessionId, ...(actor === undefined ? {} : { actor }), tool, expiresAt, ...(requestId === undefined ? {} : { requestId }), ...bound, ...decider, ...coded })
    if (decision.approved && decision.scope === 'once') state.once.push(onceFor())
    const answered = { rule, subject }
    const resolution: Extract<Resolution, { ok: true }> = wider ? { ok: true, asked: answered, granted: wider } : widenedTo ? { ok: true, widened: { pattern: widenedTo, askedBy: subject }, asked: answered } : { ok: true, asked: answered }
    progress.decided = { resolution, entry: resolved }
    // The subject can carry a command's arguments, so the log names its size only; the action log keeps it.
    if (decision.approved) logger.info('Approval granted', { rule, scope: decision.scope, tool, subjectLength: subject.length, ...(widenedTo || wider ? { widened: true } : {}) })
    if (!unsettled(state)) return resolution
    // The call that asked still runs, once, on an approval whose lasting grant did not save: it gets less than the person
    // granted, never more. Any other call asks until the grant saves. Committed with the decision, so it stands whenever
    // the decision does, and dropped once the grant saves.
    const fallback = grant === undefined ? undefined : onceFor()
    if (fallback) state.once.push(fallback)
    await commit()
    progress.recorded = true
    progress.saveError = await settleGrants(state, commit)
    if (fallback && !owedHere(resolved)) state.once = state.once.filter(entry => entry !== fallback)
    return savedAs({ decided: progress.decided, saveError: progress.saveError })
  }

  /**
   * A lasting denial stands before its decision commits: the owed approvals it takes the place of in the grant store are
   * dropped and committed first, since one settled after it would replace it there, then it is written. One that cannot be
   * written is refused as `grant_unsaved`, with nothing recorded, so its ask waits.
   */
  async function writeDenial(input: { state: State; commit: () => Promise<void>; progress: DecisionProgress; holder: GrantHolder; rule: PermissionRuleId; subject: string; scope: 'session' | 'always'; decider: { decidedBy?: string } }): Promise<Extract<Resolution, { ok: false }> | undefined> {
    const { holder, rule, subject, scope } = input
    const slot: GrantSlot = { rule, subject, scope, sessionId: holder.sessionId, actor: holder.actor ?? null }
    if (dropOwed(input.state, grant => writesAgain(grant, slot)) > 0) await input.commit()
    try {
      input.progress.denial = await grants.grant({ ...holder, rule, subject, scope, denied: true, ...input.decider })
      return undefined
    } catch (error) {
      logger.warn('A lasting denial was not written, so nothing was recorded and its ask still waits', { error: withoutCause(error) })
      const saveError = saveFailure(error)
      return { ok: false, code: 'grant_unsaved', reason: `The denial could not be saved (${saveError}), so nothing was recorded and the call still waits`, saveError, retryable: true }
    }
  }

  // A lasting denial whose decision was not recorded is taken back, so its ask waits with nothing in force.
  async function withdrawDenial(denial: GrantRecord): Promise<void> {
    try {
      await grantStore.revoke(denial.id)
    } catch (error) {
      logger.warn('A lasting denial was written, but its decision was not recorded and the denial could not be taken back; it stands until revoked with buckle grants revoke', { error: withoutCause(error) })
    }
  }

  // Where the decision's lasting grant stands, and why, while the settling pass left it unsettled.
  function savedAs(input: { decided: AppliedDecision; saveError: string | undefined }): Extract<Resolution, { ok: true }> {
    const { decided, saveError } = input
    const save = decided.entry.grant?.save
    if (save === undefined) return decided.resolution
    return { ...decided.resolution, save, ...(UNSETTLED_SAVES.has(save) && saveError !== undefined ? { saveError } : {}) }
  }

  /**
   * One skip under the approvals lock: the entry turns `skipping` and commits first, so no settling pass, retry, or opening
   * writes its grant again, then a grant already in the store is removed by the id the entry kept, and the entry turns
   * `skipped`. That covers a pass that went first, and a grant a stopped process wrote while its entry still read `owed`;
   * one left `skipping` is finished by the next settling pass.
   */
  async function skipIn(input: { state: State; commit: () => Promise<void>; token: string; source: ApprovalSource }): Promise<SkipResolution> {
    const entry = input.state.resolved.find(candidate => candidate.workspace === workspace && candidate.decision.token === input.token)
    const recorded = entry === undefined ? undefined : { approved: entry.decision.approved, scope: entry.decision.scope, ...(entry.grant ? { source: entry.grant.source } : {}) }
    const verdict = guardSkip({ source: input.source, recorded })
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason }
    // A revoke or a session end already dropped the grant, so none stands and none is written.
    if (entry?.grant === undefined || entry.grant.save === 'skipped') return { ok: true, repeated: true }
    const { grant } = entry
    const repeated = grant.save === 'skipping' ? { repeated: true as const } : {}
    if (grant.save !== 'skipping') {
      entry.grant = { ...grant, save: 'skipping' }
      await input.commit()
    }
    const removal = await removeGrant(grant.id)
    if ('saveError' in removal) return { ok: true, ...repeated, unfinished: removal }
    entry.grant = { ...grant, save: 'skipped' }
    return { ok: true, ...repeated, ...(removal.removed ? { removed: true as const } : {}) }
  }

  // Read first: a grant never written needs no write to the grant store, which may be the very file that cannot be written.
  async function removeGrant(id: string): Promise<{ removed: boolean } | UnfinishedRemoval> {
    let held: boolean
    try {
      held = grantStore.list().some(record => record.id === id)
    } catch (error) {
      logger.warn('The grants could not be read to remove a skipped grant; the next settling pass removes it if it saved', { error: withoutCause(error) })
      return { stands: false, saveError: saveFailure(error) }
    }
    if (!held) return { removed: false }
    try {
      return { removed: await grantStore.revoke(id) }
    } catch (error) {
      logger.warn('A skipped grant could not be removed; it stands until the next settling pass or the skip sent again removes it', { error: withoutCause(error) })
      return { stands: true, saveError: saveFailure(error) }
    }
  }

  // An ask the ledger does not hold keeps the decision as sent, which the decision guard refuses.
  function widened(input: { decision: ApprovalDecision; widen: ResolveOptions['widen']; request: ApprovalRequest | undefined }): ApprovalDecision | null {
    if (input.widen === undefined || input.request === undefined) return input.decision
    const wider = input.request.widerSubject
    return wider === undefined ? null : { ...input.decision, subject: wider }
  }

  const registry: ApprovalRegistry = {
    grants,

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
      departed(evicted.map(entry => entry.request.token), { type: 'cancelled', reason: 'evicted' })
      return result
    },

    async resolve(decision, source, options = {}) {
      const claim: DecisionClaim = {
        decision, source, ...(options.widenTo === undefined ? {} : { widenTo: options.widenTo }),
        ...(options.challenge === undefined ? {} : { challenge: options.challenge.digest }), ...(options.consumeNotAfter === undefined ? {} : { consumeNotAfter: options.consumeNotAfter }),
      }
      // Refused before the lock, so these come back even when the approvals file cannot be read.
      const screened = screenDecision(claim)
      if (!screened.ok) {
        if (screened.code === 'assurance_too_low') logger.warn('A lasting decision was refused: its source is relayed', { scope: decision.scope, source: source.id })
        return { ok: false, code: screened.code, reason: screened.reason }
      }
      const progress: DecisionProgress = {}
      try {
        return await update(async (state, commit) => {
          await applyRevocations(state, commit)
          const answer = await applyDecision({ state, commit, claim, options, progress })
          if (!answer.ok) progress.refused = answer
          return answer
        }, () => { progress.recorded = true })
      } catch (error) {
        // A failure after the decision is on disk leaves it applied, its denial in force: the answer says so, and names a
        // grant it still owes. A refusal recorded nothing, so a step after it that fails changes no answer.
        const { decided, recorded, denial, refused } = progress
        if (refused !== undefined) return refused
        if (decided === undefined || !recorded) {
          if (denial !== undefined) await withdrawDenial(denial)
          throw error
        }
        const answer = savedAs({ decided, saveError: progress.saveError })
        logger.warn('A decision was recorded, but a step after it failed', { error: withoutCause(error), ...(answer.save === undefined ? {} : { save: answer.save }) })
        return answer
      }
    },

    async skipSave({ token, source }) {
      let skipped: SkipResolution | undefined
      try {
        return await update(async (state, commit) => {
          skipped = await skipIn({ state, commit, token, source })
          return skipped
        })
      } catch (error) {
        // The skip is on disk once skipIn returns, so a step after it that fails undoes none of it.
        if (skipped === undefined) throw error
        logger.warn('A skip was recorded, but a step after it failed', { error: withoutCause(error) })
        return skipped
      }
    },

    evaluate(spend) {
      const { tokens, check, admit } = spend
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
      // Spent under the same lock as the execution claim `admit` makes.
      return update(state => {
        const { outcome, kept } = spendOnces(state.once, { workspace, spend })
        state.once = kept
        return outcome
      })
    },

    unspent: sessionId => unspentOnces(read().once, { workspace, sessionId }),

    async recover() {
      try {
        const owed = unsettled(read())
        if (!owed && !existsSync(revocationsPath)) return
        const settled = await update(async (state, commit) => {
          await applyRevocations(state, commit)
          await settleGrants(state, commit)
          return !unsettled(state)
        })
        if (owed && settled) logger.info('Wrote the grants a stopped process left owed, and removed those it left skipping')
      } catch (error) {
        // Fail closed: the grant stays owed and its calls ask again, while the workspace opens as it did.
        if (!alreadyReported(error)) logger.warn('Could not write the grants decisions left owed; they are written at the next decision', { error: withoutCause(error) })
      }
    },

    wasDenied: tokens => read().resolved.some(entry => entry.workspace === workspace && tokens.includes(entry.decision.token) && !entry.decision.approved),

    departures(tokens) {
      const found = new Map<string, Departure>()
      for (const token of tokens) {
        const seen = departedHere.get(token)
        if (seen) found.set(token, seen)
      }
      for (const entry of read().resolved) if (entry.workspace === workspace && tokens.includes(entry.decision.token)) found.set(entry.decision.token, { type: entry.decision.approved ? 'answered' : 'denied' })
      return found
    },

    async cancel(tokens) {
      const withdrawn = await update(state => {
        const selected = state.pending.filter(entry => entry.workspace === workspace && tokens.includes(entry.request.token))
        const withdrawn = selected.map(entry => entry.request.token)
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !tokens.includes(entry.request.token))
        state.once = dropOnces(state.once, { workspace, tokens: new Set(tokens) }).kept
        for (const entry of selected) if (entry.notify || durableNotices) enqueueOutcome(state, workspace, { token: entry.request.token, event: 'cancelled', at: new Date().toISOString() })
        return withdrawn
      })
      departed(withdrawn, { type: 'cancelled', reason: 'caller_cancelled' })
      return withdrawn
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

    async cancelGroup(selector) {
      const withdrawal = await update((state): GroupWithdrawal => {
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
        const { kept, dropped } = dropOnces(state.once, { workspace, tokens: group })
        state.pending = state.pending.filter(entry => entry.workspace !== workspace || !group.has(entry.request.token))
        state.once = kept
        for (const entry of pending.filter(entry => group.has(entry.request.token))) if (entry.notify || durableNotices) enqueueOutcome(state, workspace, { token: entry.request.token, event: 'cancelled', at: new Date().toISOString() })
        return { withdrawn, dropped }
      })
      departed(withdrawal.withdrawn, { type: 'cancelled', reason: 'withdrawn_by_owner' })
      return withdrawal
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

/** The session or always grant an approval makes, owed until written: its subject, widened where it was, and who recorded it. */
function lastingGrantOf(input: { decision: ApprovalDecision; holder: GrantHolder; rule: PermissionRuleId; subject: string; widenedTo: string | undefined; wider: string | undefined; decider: { decidedBy?: string }; source: ApprovalSource }): LastingGrant | undefined {
  const { decision } = input
  if (!decision.approved || decision.scope === 'once') return undefined
  return { id: randomUUID(), ...input.holder, rule: input.rule, subject: input.widenedTo ?? input.wider ?? input.subject, scope: decision.scope, ...(input.widenedTo ? { pattern: true as const } : {}), ...input.decider, source: { id: input.source.id, kind: input.source.kind }, save: 'owed' }
}

/** Whether a revoke or a session end removes what an owed grant would write. */
function undoes(revocation: Revocation, owed: LastingGrant): boolean {
  if ('sessionId' in revocation) return owed.scope === 'session' && owed.sessionId === revocation.sessionId
  return owed.id === revocation.grant.id || writesAgain(owed, revocation.grant)
}

/** Where the grant store keeps a record: one per rule, subject, scope, and holder, approved or denied. */
type GrantSlot = Pick<GrantRecord, 'rule' | 'subject' | 'scope' | 'sessionId' | 'actor' | 'pattern'>

/** Whether an owed grant, once written, would stand where this record does. */
function writesAgain(owed: LastingGrant, record: GrantSlot): boolean {
  const holder = owed.scope === 'always' || servesHolder(record, owed)
  return owed.rule === record.rule && owed.subject === record.subject && owed.scope === record.scope && holder && Boolean(owed.pattern) === Boolean(record.pattern)
}

/** A waiting ask as the decision guard reads it: whether its whole call was kept, and the challenges it was shown under. */
// No build records an ask's routes yet, so each reads as sent down today's set.
function waitingView(asked: PendingAsk, challenge: ResolveOptions['challenge']): NonNullable<LedgerView['waiting']> {
  return {
    request: asked.request, complete: asked.call?.complete === true, challenges: challenge === undefined ? [] : challenge.shown(asked),
    marks: { floor: asked.floor, destructive: asked.destructive }, routes: TODAYS_ROUTES,
  }
}

/** Drops everything past its expiry, returning the asks that expired unanswered. */
function prune(state: State): State['pending'] {
  const now = Date.now()
  state.outbox = state.outbox.filter(entry => Date.parse(entry.expiresAt) > now)
  const expired = state.pending.filter(entry => lapseOf(entry) <= now)
  state.pending = state.pending.filter(entry => lapseOf(entry) > now)
  state.once = liveOnces(state.once, now)
  // A decision whose grant is still owed, or not confirmed removed, stays until the settling pass settles it.
  state.resolved = state.resolved.filter(entry => (entry.grant !== undefined && UNSETTLED_SAVES.has(entry.grant.save)) || Date.parse(entry.expiresAt) > now)
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
