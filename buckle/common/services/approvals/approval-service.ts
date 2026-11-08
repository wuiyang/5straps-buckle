import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { useScopeSafe } from '@5straps/runtime'
import type { ApprovalDecision, ApprovalRequest, ApprovalSkipReason, ApprovalWait } from '@5straps/protocol'
import { callDigestOf, canonicalJson, challengeBytes, shownCallDigestOf, SIGNED_REQUEST_VERSION, WORKSPACE_NAME_MAX, type ApprovalChallenge, type ShownApprovalCall } from '@5straps/protocol/signed-request'
import { requestIdKey } from '../invocation/executions.js'
import type { ApprovalKey } from '@5straps/protocol/envelope'
import type { NonceClaims } from '../../types/ports/nonce-claims.js'
import { MAX_TIMER_MS, remainingMs } from '../../domain/approval/expiry.js'
import { reachOf, rightsOf } from '../../domain/approval/assurance.js'
import type { AnswerSender, ApprovalBackend, ApprovalHold, ApprovalHost, DecisionBody, DecisionInput, DecisionReceipt, FullAsk, LifecycleEvent, SkipReceipt } from '../../types/ports/approval-backend.js'
import { FORMS_SOURCES, SOURCES, type ApprovalSource, type FormsFace } from '../../types/ports/approval-source.js'
import type { DecisionAudit, DecisionEnding, DecisionProofKind } from '../../types/ports/decision-audit.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import type { CodeBinding } from '../../domain/permission/judged.js'
import { logger, withoutCause } from '../../runtime/log.js'
import { openApprovalDecision } from './approval-envelope.js'
import { listedApprovals } from './approval-listing.js'
import { createApprovalNotices, type ApprovalNotices } from './approval-notices.js'
import { backendDecisionOf, backendReceipt, decisionOf, decisionRecord, INVALID_BACKEND_DECISION, readInput, receiptOf, skipReceiptOf, type ChallengeListing, type CoreApprovalApi } from './core-approval-api.js'
import { fullAskOf, joinKey, ledgerAskOf, type AskSetting } from './full-ask.js'
import type { AskedCall } from '../../domain/approval/asked-call.js'
import type { ApprovalRegistry, Departure, PendingAsk, Resolution, SkipResolution } from './approval-registry.js'
import { maskHeld, maskHeldJson, masksHeld } from '../secrets/mask.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** How quickly an answer written by another process (buckle approve, a second node process) is noticed. */
const POLL_INTERVAL_MS = 400
/**
 * A whole shown call larger than this is not repeated inside each of its asks'
 * challenges: each carries its digest, and the listing carries the call once (review M1 of the slice 5 re-review).
 */
export const INLINE_CALL_BYTES = 16 * 1_024
const SWEEP_MARGIN_MS = 1_000
/** An operation nobody bound holds its call only while its terminal asks, and it has none. */
const UNBOUND_HOLD: ApprovalHold = 'prompt'

export interface ApprovalAskInput {
  sessionId: string
  requestId: string
  tool: string
  asks: Ask[]
  /**
   * The caller's own signal. Its abort ends this caller's wait; what becomes of the asks depends on
   * `isCancel` (owner decision D4, rpc.md: resumable waiting).
   */
  signal?: AbortSignal
  /**
   * Whether an abort is the caller's explicit cancel (MCP notifications/cancelled), which withdraws
   * the asks. Any other abort is a transport that dropped: the asks stay pending, as after an
   * elapsed hold, and a re-send with the same requestId joins them. HTTP cannot tell a stop from a
   * dropped connection, so it passes none and every abort keeps the asks.
   */
  isCancel?: (reason: unknown) => boolean
  wait?: ApprovalWait
  /**
   * When the call's hold must end at the latest, on the `performance.now()` clock, whatever sets the hold: a script's
   * call (owner decision D82) waits no later than its script's deadline less a margin, so it answers
   * approval_required rather than being cut by that deadline. The time left is read just before the wait starts,
   * after the ask is recorded and announced, and the announce of such a call is held to it too (review of the
   * code-mode slice, finding approvals-replay 685; re-review, finding fixes-hold invoker.ts:712).
   */
  holdUntil?: number
  /**
   * Whether the face sends a call again that it left undecided, which then joins its ask (the MCP faces and the files
   * route). An ask that states no deadline (wait 0) lapses ten minutes after the last hold on it ended only for such a
   * face; on /v1/invoke, where Rings parks a run on its ask, it lives until answered, as before the MCP asks brief (review
   * finding M3). A caller that left abandons its ask whatever the face.
   */
  resends?: boolean
  /** The call's tool and whole arguments, hashed (requestFingerprint): a re-send joins only with the same one. */
  fingerprint?: string
  /** The whole call as the node's signed challenge shows it (owner decisions D9 and D17): redacted arguments, their directory, the node's description and the judged effects. */
  call?: AskedCall
}

/**
 * Settled: every token was answered or left the queue, or one was denied, so the caller checks again.
 * `answered` names this call's asks answered before it joined them; its check counts them too.
 * `superseded`: a newer call with the same requestId joined the wait and carries it on, so this one
 * must not run (review M1: a joined re-send never executes twice).
 */
export interface ApprovalWaitResult {
  settled: boolean
  approvals: ApprovalRequest[]
  answered: string[]
  superseded?: true
}

export interface ApprovalAnswer {
  decision: ApprovalDecision
  source: ApprovalSource
  /** `BUCKLE-D18`: a host pattern, which only `buckle approve --host` passes. */
  widenTo?: string
  /** The digest of the challenge a person's key decided on: it must be the ask's own (B24). */
  challenge?: string
  /** key:<fingerprint> for a decision a person's enrolled key signed; recorded with it and its grant. */
  decidedBy?: string
  consumeNotAfter?: number
  /** The code an approved `once` binds to, where the decision AI's thorough stage approved it on request (fix brief 9, B31). */
  code?: CodeBinding
  /** Grant the ask's wider subject in place of its own, as the ledger records it. */
  widen?: 'below'
  /** What carried it beyond its route, whose nonce reading it already claimed; none when absent. */
  proof?: Exclude<DecisionProofKind, 'none'>
  /** The sender's caller, which core takes from a forms host alone. */
  caller?: string
}

export interface ApprovalService extends CoreApprovalApi {
  /** Issues the asks (or joins the ones the same call already made), then waits as the caller's entry point holds it. */
  request(input: ApprovalAskInput): Promise<ApprovalWaitResult>
  /**
   * Core's one way a verdict is recorded, under any source: checks it against the ask, then wakes whoever waits on it.
   * A core client decides through `decide` and a backend through its host, each under the source core holds for it.
   */
  answer(input: ApprovalAnswer): Promise<Resolution>
  /** Core's one way a skip is recorded, under any source; only the source that recorded the decision may skip its save. */
  skip(input: { token: string; source: ApprovalSource; caller?: string }): Promise<SkipResolution>
  /** Withdraws the asks among `tokens` still waiting, telling the webhook they were cancelled. */
  withdraw(tokens: string[]): Promise<void>
  /** Opens an MCP host's forms under its face's forms source, which core holds and rates; closed with the service. */
  openFormsBackend(backend: ApprovalBackend, face: FormsFace): void
  /**
   * Settles every open wait as still pending and ends its questions, then waits for the lifecycle
   * notices still in flight; the asks stay in the durable queue.
   */
  close(): Promise<void>
}

/** The service as the faces hold it: the core approval API alone, so no face reaches `answer`, `request`, or `withdraw`. */
export function approvalFaceOf(service: ApprovalService): CoreApprovalApi {
  return {
    decide: input => service.decide(input),
    skipSave: input => service.skipSave(input),
    pending: () => service.pending(),
    waiting: () => service.waiting(),
    waitingAsk: token => service.waitingAsk(token),
    listing: () => service.listing(),
    challengeListing: options => service.challengeListing(options),
    withdrawCall: selector => service.withdrawCall(selector),
    decisionRecord: receipt => service.decisionRecord(receipt),
  }
}

/** The ledger reads and writes the service makes. */
export type ApprovalLedger = Pick<ApprovalRegistry, 'ask' | 'resolve' | 'skipSave' | 'cancel' | 'cancelGroup' | 'holdEnded' | 'pending' | 'waiting' | 'waitingAsk' | 'wasDenied' | 'departures' | 'sweep' | 'sweepIfDue'>

export interface ApprovalServiceOptions {
  registry: ApprovalLedger
  workspaceId: string
  /** The workspace's name, which each question names beside its id; read at each ask, so a rename shows at once. */
  workspaceName?: string
  /** The node's serverId, which each challenge names. */
  serverId: string
  /**
   * The workspace's approvalWaitMs: how long a `grace` hold lasts when the caller sends no wait, in positive ms; null
   * holds it until answered. Read at each ask, so a runtime may pass a getter that follows its workspace.json (Q2).
   */
  graceMs: number | null
  /** The hold the current operation's transport chose, which sets how long a call waits; undefined outside a bound operation. */
  hold: () => Promise<ApprovalHold | undefined>
  /** Asks a person at this process's terminal, over the operation's requester. */
  terminal: ApprovalBackend
  /**
   * Told once an ask is issued, from every entry point, so a person can be reached away from the machine: the
   * requests and, when it was kept whole, the one call they all came from (review M1).
   */
  announce?: (requests: ApprovalRequest[], call?: AskedCall) => Promise<void>
  /** What became of the announced asks, on the same path; nothing is sent without one. */
  notices?: ApprovalNotices
  /** The key Rings minted at pairing; without one a plain decision is accepted and an envelope refused. */
  decisionKey?: ApprovalKey
  /** Replay protection for opened envelopes. */
  nonces: NonceClaims
  /** Told of each decision as received, then how it ended; it never holds up or refuses an answer. */
  decisionAudit: DecisionAudit
  pollMs?: number
}

/**
 * One ask, shared by every in-process call that joined it (same requestId, session and actor), so its
 * questions are asked once. Only the newest joined caller waits on it; each earlier one is superseded.
 */
interface OpenAsk {
  readonly key: string
  /** The requests its questions are about: those still waiting when it opened. */
  readonly approvals: ApprovalRequest[]
  /** Those plus the ones answered before it opened: a denial among them settles it too. */
  readonly tokens: string[]
  /** Names the group to a backend: the same tokens are the same group. */
  readonly group: string
  /** One controller per waiting caller; aborting it supersedes that caller. */
  readonly participants: Set<AbortController>
  /** Ends the questions and the watch. */
  readonly stop: AbortController
  /** Resolves once every token left the pending set, or one was denied. */
  readonly settled: PromiseWithResolvers<void>
  /** The terminal questions; settles when they end. */
  prompting: Promise<void> | undefined
  promptEnded: boolean
  /** A decision this process is recording on one of its asks; settles once its answer is known. */
  deciding: Promise<void> | undefined
  /** A decision this process recorded on it left its lasting grant owed, so its person may be asked to retry or skip. */
  saving: boolean
  /** The tokens the terminal was told have left the queue. */
  readonly told: Set<string>
}

type Ending = 'settled' | 'elapsed' | 'prompt_ended' | 'aborted' | 'closed' | 'superseded'

/**
 * The single answerer (ruling 4 of 2026-09-28; nitro/coordination.md, Completion and queue).
 *
 * An ask is issued to the durable queue before anyone is asked, so every entry point has a token and
 * a missing listener is never an approval. The call then races the terminal questions, an answer
 * from another route (in this process at once, from another process within the poll interval), its
 * entry point's hold and the caller's signal. A caller that cancels inside the wait withdraws the
 * asks; a caller whose transport drops leaves them pending for a re-send to join. When a `grace`
 * hold ends first, or the caller drops, the call reports back and the terminal keeps asking until
 * the request expires or another route answers.
 */
export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  // By join key; `live` also holds an ask a newer group under the same key replaced, until it ends.
  const open = new Map<string, OpenAsk>()
  const live = new Set<OpenAsk>()
  const closing = new AbortController()
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS
  const { nonces } = options
  const notices = options.notices ?? createApprovalNotices()
  // One sweep per issued ask at its expiry, so an ask nobody answered is reported expired on time.
  const sweeps = new Set<NodeJS.Timeout>()
  // Calls still waiting and terminal questions still running, so close lets each call report back and
  // an answer already being recorded finish before the notices are flushed.
  const waiting = new Set<Promise<unknown>>()
  let unreadable = false
  // The asks handed to the terminal, by token, while it asks them.
  const routed = new Map<string, FullAsk>()
  let opening: Promise<unknown> | undefined
  const callKeys = randomBytes(32)
  const callKeyOf = (key: string) => createHmac('sha256', callKeys).update(JSON.stringify([options.workspaceId, key])).digest('base64url')
  const workspace: FullAsk['workspace'] = { id: options.workspaceId, node: options.serverId, get name() { return options.workspaceName } }
  const log: ApprovalHost['log'] = (level, message, fields) => { logger[level](message, fields) }
  const host: ApprovalHost = {
    source: SOURCES.terminal,
    reach: reachOf(rightsOf(SOURCES.terminal.kind)),
    decide: input => readBackendDecision(input, decideRouted),
    skipSave: token => skipAs({ source: SOURCES.terminal, token }),
    pending: () => {
      const state = readQueue([...routed.keys()])
      return state ? [...routed.values()].filter(asked => state.pending.has(asked.token)) : []
    },
    ask: token => (readQueue([token])?.pending.has(token) ? routed.get(token) : undefined),
    log,
  }
  // Today's routes hand an MCP host's forms every waiting ask; each answer carries its sender's caller into core.
  const formsHostOf = (source: ApprovalSource): ApprovalHost => ({
    source,
    reach: reachOf(rightsOf(source.kind)),
    decide: (input, sender) => readBackendDecision(input, body => decideAs({ source, body, sender })),
    skipSave: (token, sender) => skipAs({ source, token, sender }),
    pending: () => options.registry.waiting().map(asked => ledgerAskOf(asked, { workspace, idempotencyKey: callKeyOf })),
    ask: (token) => {
      const asked = options.registry.waitingAsk(token)
      return asked === undefined ? undefined : ledgerAskOf(asked, { workspace, idempotencyKey: callKeyOf })
    },
    log,
  })
  const formsBackends = new Set<ApprovalBackend>()
  // What expired, or a call file left over, while no process of this node ran is dropped now (review L1 of the slice 5 re-review).
  track(options.registry.sweepIfDue().catch((error: unknown) => { logger.warn('Could not sweep expired approvals', { error: withoutCause(error) }) }))

  const service: ApprovalService = {
    async request(asked) {
      // What a person reads of the ask, masked by every secret value a call holds now (docs/user/how-to/secrets.md); the subject a
      // grant binds stays as the rule named it.
      const input = masksHeld() ? { ...asked, asks: asked.asks.map(ask => ({ ...ask, reason: maskHeld(ask.reason) })), ...(asked.call === undefined ? {} : { call: maskHeldJson(asked.call) }) } : asked
      input.signal?.throwIfAborted()
      const hold = (await options.hold()) ?? UNBOUND_HOLD
      const scope = useScopeSafe()
      const actor = scope?.context.actor
      const key = joinKey({ ...input, actor })
      const ownHold = holdFor({ hold, graceMs: options.graceMs, hint: input.wait })
      // The hold the asks are recorded with: an ask that states no deadline lapses ten minutes after it where the face sends the call again (the MCP asks brief, item 5).
      const issued = await options.registry.ask({ tool: input.tool, sessionId: input.sessionId, asks: input.asks, requestId: input.requestId, waitMs: askLifetime(options.graceMs, input.wait), ...(input.resends ? { holdMs: ownHold } : {}), ...(actor === undefined ? {} : { actor }), ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }), ...(input.call === undefined ? {} : { call: input.call }) })
      const { requests: approvals, answered } = issued
      if (issued.evicted?.length) notices.cancelled(issued.evicted)
      if (issued.lapsesAt !== undefined) scheduleSweepAt(issued.lapsesAt)
      // Joined to asks all answered, one of them denied: nothing to wait for, and the caller refuses.
      if (issued.joined && approvals.length === 0) return { settled: true, approvals, answered }
      const tokens = approvals.map(approval => approval.token)
      if (!issued.joined) {
        const announcing = announce(options.announce, approvals, input.call)
        // A slow webhook never holds a script's call past its deadline: the post goes on in the background, and close
        // still waits for it.
        if (input.holdUntil === undefined) await announcing
        else {
          track(announcing)
          await settledOrAt(announcing, input.holdUntil)
        }
        scheduleSweep(approvals)
      }
      // Checked before any question is drawn: a caller that cancelled during the announce is asked about no more (review L5).
      await cancelIfCancelled({ key, tokens, signal: input.signal, isCancel: input.isCancel })
      // A hold until answered that ends before it starts still starts its asks' ten minutes (the MCP asks brief, item 5).
      const unheld = async (reason: ApprovalSkipReason) => {
        if (input.resends && ownHold === null) await holdEnded({ tokens, abandoned: false })
        return skip({ approvals, answered, reason })
      }
      if (closing.signal.aborted) return unheld('shutdown')
      const holdMs = atMost(ownHold, input.holdUntil === undefined ? undefined : Math.max(0, Math.floor(input.holdUntil - performance.now())))
      // No hold left for a script's call is a wait that elapsed, not one the caller declined.
      const zeroHold: ApprovalSkipReason = ownHold === 0 ? 'caller_declined_wait' : 'wait_elapsed'
      // The hint sets how long the caller is held and never who is asked: a `grace` entry point asks
      // its terminal whatever the hint says, and keeps asking after the caller returns (owner ruling).
      const keepAsking = hold === 'grace'
      // A hold of 0 comes only from the caller's hint `none`: the node's own is positive or null (D3).
      if (holdMs === 0 && !keepAsking) return unheld(zeroHold)

      const ask = openAsk({ key, approvals, answered, joined: issued.joined })
      const setting: AskSetting = { workspace, group: ask.group, correlationId: scope?.context.correlationId ?? input.requestId, requestId: input.requestId, actor: actor ?? null, sessionId: input.sessionId, idempotencyKey: callKeyOf(key), hold, ...(input.call === undefined ? {} : { call: input.call }) }
      if (!ask.prompting) track(ask.prompting = startQuestions({ ask, asks: ask.approvals.map(approval => fullAskOf({ request: approval, floor: atTheFloor(input.asks, approval) }, setting)), resend: issued.joined }))
      // The newest joined caller carries the wait; every earlier one ends without running (review M1).
      // A re-send whose own transport already dropped carries nothing on, so the earlier one keeps it.
      if (!input.signal?.aborted) for (const earlier of ask.participants) earlier.abort()
      if (holdMs === 0) {
        if (ask.participants.size === 0) release({ ask, keepAsking: true })
        return unheld(zeroHold)
      }
      const participant = new AbortController()
      ask.participants.add(participant)
      const result = waitFor({ ask, participant, hold, holdMs, signal: input.signal })
        .then(ending => finish({ ask, participant, ending, hold, held: ownHold, resends: input.resends === true, signal: input.signal, isCancel: input.isCancel, own: { approvals, answered } }))
      track(result)
      return result
    },

    async answer(input) {
      const { challenge } = input
      const asks = [...live].filter(ask => ask.tokens.includes(input.decision.token))
      const recording = Promise.withResolvers<void>()
      for (const ask of asks) ask.deciding = recording.promise
      try {
        const received = options.decisionAudit.received({ token: input.decision.token, approved: input.decision.approved, scope: input.decision.scope, source: input.source, proof: input.proof ?? 'none', ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }), ...(input.caller === undefined ? {} : { caller: input.caller }) })
        let result: Resolution
        try {
          result = await options.registry.resolve(input.decision, input.source, {
            ...(input.widenTo === undefined ? {} : { widenTo: input.widenTo }),
            ...(challenge === undefined ? {} : { challenge: { digest: challenge, shown: shownDigests } }),
            ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }),
            ...(input.consumeNotAfter === undefined ? {} : { consumeNotAfter: input.consumeNotAfter }),
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.widen === undefined ? {} : { widen: input.widen }),
            ...(input.caller === undefined ? {} : { caller: input.caller }),
          })
        } catch (error) {
          received.failed()
          throw error
        }
        endDecision({ received, source: input.source, result })
        if (!result.ok) return result
        if (result.save === 'owed') for (const ask of asks) ask.saving = true
        if (!result.repeated) notices.answered({ ...input.decision, ...(input.decision.approved && input.decision.scope === 'once' && input.consumeNotAfter !== undefined ? { consumeNotAfter: new Date(input.consumeNotAfter).toISOString() } : {}) })
        wake(input.decision.token)
        return result
      } finally {
        recording.resolve()
      }
    },

    async decide(input) {
      const read = await readInput(input, { open: body => nonces.withClaims(seen => openApprovalDecision({ key: options.decisionKey, body, workspaceId: options.workspaceId, seen })) })
      if (!read.ok) return read.receipt
      return receiptOf({ answer: read.answer, result: await service.answer(read.answer) })
    },

    async skip(input) {
      const received = options.decisionAudit.skipReceived(input)
      let result: SkipResolution
      try {
        result = await options.registry.skipSave(input)
      } catch (error) {
        received.failed()
        throw error
      }
      if (result.ok) received.applied({ repeated: result.repeated === true, removed: result.removed === true, ...(result.unfinished ? { unfinished: true as const } : {}) })
      else received.refused({ code: result.code })
      if (result.ok && !result.repeated) logger.info('Skipped the save of an approval\'s grant', { source: input.source.id, ...(result.removed ? { removed: true } : {}), ...(result.unfinished ? { unfinished: true } : {}) })
      return result
    },

    skipSave: input => skipAs({ source: SOURCES[input.source], token: input.token }),

    challengeListing(listing) {
      const shown = createCallShapes()
      const calls: ChallengeListing['calls'] = {}
      const challenges = options.registry.waiting().map((ask) => {
        const challenge = challengeOf(ask, shown, listing?.workspaceName === true)
        if (challenge?.callRef !== undefined && ask.call) calls[challenge.callRef] = shownCallOf(challenge.tool, ask.call)
        return { token: ask.request.token, challenge }
      })
      return { challenges, calls }
    },

    withdraw: tokens => withdraw(tokens),

    openFormsBackend(backend, face) {
      formsBackends.add(backend)
      track(backend.open(formsHostOf(FORMS_SOURCES[face])).catch((error: unknown) => { logger.warn('Could not open the MCP host\'s approval forms', { error: withoutCause(error) }) }))
    },

    async withdrawCall(selector) {
      // The registry keeps a call's requestId hashed, as the invoker joins it.
      const hashed = 'token' in selector ? { token: selector.token } : { requestId: requestIdKey(selector.requestId), sessionId: selector.sessionId, ...(selector.actor === undefined ? {} : { actor: selector.actor }) }
      const result = await options.registry.cancelGroup(hashed)
      notices.cancelled(result.withdrawn)
      for (const token of result.withdrawn) wake(token)
      if (result.withdrawn.length > 0 || result.dropped.length > 0) logger.info('Withdrew a call\'s approvals through the setup face', { withdrawn: result.withdrawn.length, dropped: result.dropped.length, workspaceId: options.workspaceId })
      return { ...result, selector: hashed }
    },

    pending: () => options.registry.pending(),

    waiting: () => options.registry.waiting(),

    waitingAsk: token => options.registry.waitingAsk(token),

    listing: () => listedApprovals(options.registry.waiting()),

    decisionRecord,

    async close() {
      closing.abort()
      for (const ask of [...live]) ask.stop.abort()
      for (const sweep of sweeps) clearTimeout(sweep)
      sweeps.clear()
      // Every backend is told to close at once, so a submit that settles only as its backend closes holds nothing up.
      const backends = [...(opening ? [options.terminal] : []), ...formsBackends]
      await Promise.allSettled([...waiting, ...backends.map(backend => backend.close())])
      await notices.settle()
    },
  }

  /** The digests of the challenges a device may have been shown for an ask, with the workspace's name and without it. */
  function shownDigests(ask: PendingAsk): string[] {
    const shapes = createCallShapes()
    return [false, true].flatMap((named) => {
      const shown = challengeOf(ask, shapes, named)
      return shown === null ? [] : [challengeBytes(shown).digest]
    })
  }

  // Each challenge signs either the whole inline call or the digest of every shared display field. The workspace's name is
  // read as it is signed, so a rename shows, and travels beside its id for a device that asked for it to show (D85, Q15).
  function challengeOf(ask: PendingAsk, shapes: CallShapes, withName = false): ApprovalChallenge | null {
    const { request, call } = ask
    if (!call?.complete) return null
    const { digest, callRef, inline } = shapes(request.tool, call)
    const name = withName ? options.workspaceName : undefined
    return {
      v: SIGNED_REQUEST_VERSION, purpose: 'buckle-approval-challenge', node: options.serverId, workspace: options.workspaceId,
      ...(name && name.length <= WORKSPACE_NAME_MAX ? { workspaceName: name } : {}),
      token: request.token, requestId: ask.requestId ?? null, sessionId: ask.sessionId, actor: ask.actor ?? null,
      tool: request.tool, rule: request.rule, subject: request.subject, reason: request.reason, offeredScopes: request.offeredScopes,
      arguments: inline ? call.arguments : null, cwd: inline ? call.cwd : null, callDigest: digest,
      ...(inline ? {} : { callRef }),
      description: inline ? call.description : null, effects: inline ? call.effects ?? [] : null, expiresAt: request.expiresAt,
    }
  }

  function skip(input: { approvals: ApprovalRequest[]; answered: string[]; reason: ApprovalSkipReason }): ApprovalWaitResult {
    notices.skipped(input.approvals.map(approval => approval.token), input.reason)
    return { settled: false, approvals: input.approvals, answered: input.answered }
  }

  function track(work: Promise<unknown>): void {
    const tracked = work.then(() => undefined, () => undefined)
    waiting.add(tracked)
    void tracked.finally(() => waiting.delete(tracked))
  }

  function scheduleSweep(approvals: ApprovalRequest[]): void {
    if (approvals.length === 0) return
    sweepIn(Math.max(...approvals.map(approval => remainingMs(approval.expiresAt))))
  }

  /** A sweep at the moment an ask lapses, so it is reported expired on time (the MCP asks brief, item 5). */
  function scheduleSweepAt(at: number): void {
    sweepIn(Math.max(0, at - Date.now()))
  }

  function sweepIn(remaining: number): void {
    if (remaining === Infinity || closing.signal.aborted) return
    const sweep = setTimeout(() => {
      sweeps.delete(sweep)
      track(Promise.resolve().then(() => options.registry.sweep()).catch((error: unknown) => { logger.warn('Could not sweep expired approvals', { error: withoutCause(error) }) }))
    }, Math.min(remaining + SWEEP_MARGIN_MS, MAX_TIMER_MS))
    // A one-shot command does not stay open for it; the next update anywhere reports the expiry instead.
    sweep.unref()
    sweeps.add(sweep)
  }

  /** The open ask a joined call shares, or a new one: a freshly issued group never reuses an older ask. */
  function openAsk(input: { key: string; approvals: ApprovalRequest[]; answered: string[]; joined: boolean }): OpenAsk {
    const { key } = input
    const existing = open.get(key)
    if (existing && input.joined && input.approvals.every(approval => existing.tokens.includes(approval.token))) return existing
    const tokens = [...input.approvals.map(approval => approval.token), ...input.answered]
    const ask: OpenAsk = {
      key, approvals: input.approvals, tokens, group: groupOf(tokens), participants: new Set(),
      stop: new AbortController(), settled: Promise.withResolvers<void>(), prompting: undefined, promptEnded: false, deciding: undefined, saving: false, told: new Set(),
    }
    open.set(key, ask)
    live.add(ask)
    const watch = setInterval(() => check(ask), pollMs)
    ask.stop.signal.addEventListener('abort', () => {
      clearInterval(watch)
      live.delete(ask)
      if (open.get(key) === ask) open.delete(key)
    }, { once: true })
    return ask
  }

  /** Reads the queue: tells the terminal of each ask that left it, and settles the ask once every token did. */
  function check(ask: OpenAsk): void {
    const state = readQueue(ask.tokens)
    if (!state) return
    tellClosed(ask, state.pending)
    if (state.denied || ask.tokens.every(token => !state.pending.has(token))) ask.settled.resolve()
  }

  function tellClosed(ask: OpenAsk, pending: ReadonlySet<string>): void {
    const left = ask.approvals.filter(approval => !pending.has(approval.token) && !ask.told.has(approval.token))
    if (left.length === 0 || opening === undefined) return
    let departures: Map<string, Departure>
    try {
      departures = options.registry.departures(left.map(approval => approval.token))
    } catch (error) {
      // Told at the next poll.
      logger.warn('Could not read how an approval ended', { error: withoutCause(error) })
      return
    }
    for (const approval of left) ask.told.add(approval.token)
    const events = left.map(approval => closingEvent(approval, departures.get(approval.token)))
    opening.then(() => options.terminal.notify(events)).catch((error: unknown) => { logger.warn('Could not tell the terminal that an approval left the queue', { error: withoutCause(error) }) })
  }

  function readQueue(tokens: string[]): { pending: Set<string>; denied: boolean } | null {
    try {
      const state = { pending: new Set(options.registry.pending().map(request => request.token)), denied: options.registry.wasDenied(tokens) }
      unreadable = false
      return state
    } catch (error) {
      // Retried at the next poll, and the hold still ends the call; said once until a read succeeds.
      if (!unreadable) logger.warn('Could not read the approval queue', { error: withoutCause(error) })
      unreadable = true
      return null
    }
  }

  function isSettled(tokens: string[]): boolean {
    const state = readQueue(tokens)
    return state !== null && (state.denied || tokens.every(token => !state.pending.has(token)))
  }

  function wake(token: string): void {
    for (const ask of [...live]) if (ask.tokens.includes(token)) check(ask)
  }

  /** The terminal asks the call's asks in turn; the asks stay routed to it until its questions end. */
  function startQuestions(input: { ask: OpenAsk; asks: FullAsk[]; resend: boolean }): Promise<void> {
    for (const asked of input.asks) routed.set(asked.token, asked)
    opening ??= options.terminal.open(host)
    return opening
      .then(() => options.terminal.submit(input.asks, { signal: input.ask.stop.signal, resend: input.resend }))
      .then(() => undefined, (error: unknown) => { logger.warn('A terminal approval question failed; the request stays waiting', { error: withoutCause(error) }) })
      .finally(() => {
        input.ask.promptEnded = true
        for (const asked of input.asks) if (routed.get(asked.token) === asked) routed.delete(asked.token)
      })
  }

  /** A terminal decision on an ask routed to it, as the decision guard then rates it; one never routed to it is audited as refused. */
  async function decideRouted(body: DecisionBody): Promise<DecisionReceipt> {
    const { source } = host
    if (routed.has(body.token)) return decideAs({ source, body })
    const decision = decisionOf(body)
    const result: Resolution = { ok: false, code: 'approver_not_allowed', reason: 'This ask was not routed to the terminal' }
    endDecision({ received: options.decisionAudit.received({ token: body.token, approved: decision.approved, scope: body.scope, source, proof: 'none' }), source, result })
    return backendReceipt(receiptOf({ answer: { decision, source }, result }))
  }

  async function skipAs(input: { source: ApprovalSource; token: string; sender?: AnswerSender }): Promise<SkipReceipt> {
    const { source, token, sender } = input
    return skipReceiptOf(await service.skip({ token, source, ...(sender === undefined ? {} : { caller: sender.caller }) }))
  }

  /** A backend's plain decision, under the source core holds for it, with the caller a forms host's sender names. */
  async function decideAs(input: { source: ApprovalSource; body: DecisionBody; sender?: AnswerSender }): Promise<DecisionReceipt> {
    const { source, body, sender } = input
    const answer: ApprovalAnswer = { decision: decisionOf(body), source, ...(body.widen === undefined ? {} : { widen: body.widen }), ...(sender === undefined ? {} : { caller: sender.caller }) }
    return backendReceipt(receiptOf({ answer, result: await service.answer(answer) }))
  }

  function waitFor(input: { ask: OpenAsk; participant: AbortController; hold: ApprovalHold; holdMs: number | null; signal?: AbortSignal }): Promise<Ending> {
    const { promise, resolve } = Promise.withResolvers<Ending>()
    const cleanups: Array<() => void> = []
    let finished = false
    const done = (ending: Ending) => {
      if (finished) return
      finished = true
      for (const cleanup of cleanups) cleanup()
      resolve(ending)
    }
    if (input.hold === 'prompt') {
      // A one-shot prompt's call waits for the save question its person's own decision raised, so the command is still
      // there to take the answer; it runs once the terminal's questions end.
      const { ask } = input
      void ask.settled.promise.then(() => ask.deciding).then(() => { if (!ask.saving || ask.prompting === undefined || ask.promptEnded) done('settled') })
      void ask.prompting?.then(() => done('prompt_ended'))
    } else {
      void input.ask.settled.promise.then(() => done('settled'))
    }
    if (input.holdMs !== null) {
      const timer = setTimeout(() => done('elapsed'), Math.min(input.holdMs, MAX_TIMER_MS))
      cleanups.push(() => clearTimeout(timer))
    }
    const endings = [[input.signal, 'aborted'], [closing.signal, 'closed'], [input.participant.signal, 'superseded']] as const
    for (const [signal, ending] of endings) {
      if (!signal) continue
      const listener = () => done(ending)
      signal.addEventListener('abort', listener, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', listener))
    }
    for (const [signal, ending] of endings) if (signal?.aborted) done(ending)
    // An answer may have landed between the ask and the first poll.
    if (!finished) check(input.ask)
    return promise
  }

  async function finish(input: { ask: OpenAsk; participant: AbortController; ending: Ending; hold: ApprovalHold; /** The hold the asks were recorded with (ownHold). */ held: number | null; resends: boolean; signal?: AbortSignal; isCancel?: (reason: unknown) => boolean; own: { approvals: ApprovalRequest[]; answered: string[] } }): Promise<ApprovalWaitResult> {
    const { ask, ending, own } = input
    ask.participants.delete(input.participant)
    const last = ask.participants.size === 0
    // The last hold on the asks ended with them unanswered: a caller that left marks them abandoned, and one held until
    // answered starts their ten minutes (the MCP asks brief, item 5). A finite hold set its lapse when it asked.
    const dropped = ending === 'aborted' && !cancels(input.signal, input.isCancel)
    if (last && ending !== 'settled' && ending !== 'superseded' && (dropped || (input.resends && input.held === null))) await holdEnded({ tokens: stillPending(ask.tokens), abandoned: dropped })
    if (ending === 'superseded') {
      // The newer caller carries the ask on; this one reports back without running.
      if (last) release({ ask, keepAsking: input.hold === 'grace' })
      return { settled: false, approvals: own.approvals, answered: own.answered, superseded: true }
    }
    if (ending === 'aborted') {
      if (last && cancels(input.signal, input.isCancel)) {
        ask.stop.abort()
        await withdraw(ask.tokens)
      } else if (last) {
        // A dropped transport: the asks stay pending and a `grace` terminal keeps asking, as after an elapsed hold.
        release({ ask, keepAsking: input.hold === 'grace' })
      }
      input.signal?.throwIfAborted()
    }
    const settled = ending === 'settled' || (ending !== 'closed' && isSettled(ask.tokens))
    if (last) release({ ask, keepAsking: !settled && ending === 'elapsed' && input.hold === 'grace' })
    if (!settled) notices.skipped(stillPending(ask.tokens), skipReason(ending))
    return { settled, approvals: own.approvals, answered: own.answered }
  }

  async function withdraw(tokens: string[]): Promise<void> {
    notices.cancelled(await options.registry.cancel(tokens))
  }

  /** Records that the last hold on these asks ended; a failure to is logged, never the caller's (its asks keep their expiry). */
  async function holdEnded(input: { tokens: string[]; abandoned: boolean }): Promise<void> {
    if (input.tokens.length === 0) return
    try {
      const lapse = await options.registry.holdEnded(input)
      if (lapse !== undefined) scheduleSweepAt(lapse)
    } catch (error) {
      logger.warn('Could not record that an approval\'s hold ended; it keeps its expiry', { error: withoutCause(error) })
    }
  }

  /** The tokens still waiting; all of them when the queue cannot be read. */
  function stillPending(tokens: string[]): string[] {
    const state = readQueue(tokens)
    return state ? tokens.filter(token => state.pending.has(token)) : tokens
  }

  /**
   * The last caller has left. A `grace` hold that ran out leaves its terminal question open until the
   * request expires or another route answers (both leave the pending set); otherwise all ends now.
   */
  function release(input: { ask: OpenAsk; keepAsking: boolean }): void {
    const { ask } = input
    if (!input.keepAsking || ask.promptEnded || !ask.prompting) {
      ask.stop.abort()
      return
    }
    void Promise.race([ask.settled.promise, ask.prompting]).then(() => {
      if (ask.participants.size === 0) ask.stop.abort()
    })
  }

  /**
   * Withdraws the asks when the caller already cancelled and no joined caller still waits, as a
   * cancel inside the wait does. A caller whose transport dropped goes on to the wait, which ends at
   * once and leaves the asks pending.
   */
  async function cancelIfCancelled(input: { key: string; tokens: string[]; signal?: AbortSignal; isCancel?: (reason: unknown) => boolean }): Promise<void> {
    if (!input.signal?.aborted || !cancels(input.signal, input.isCancel)) return
    if (!open.get(input.key)?.participants.size) await withdraw(input.tokens)
    input.signal.throwIfAborted()
  }

  return service
}

/** A backend's decision, read whole before anything else sees it. */
function readBackendDecision(input: DecisionInput, decide: (body: DecisionBody) => Promise<DecisionReceipt>): Promise<DecisionReceipt> {
  const body = backendDecisionOf(input)
  return body === null ? Promise.resolve(INVALID_BACKEND_DECISION) : decide(body)
}

/** Whether the caller's abort is an explicit cancel; without a way to tell, it is a dropped transport. */
function cancels(signal: AbortSignal | undefined, isCancel: ((reason: unknown) => boolean) | undefined): boolean {
  return signal?.aborted === true && isCancel?.(signal.reason) === true
}

function groupOf(tokens: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...tokens].sort())).digest('hex')
}

/** Why a call stopped waiting while its ask stays pending. */
function skipReason(ending: Ending): ApprovalSkipReason {
  if (ending === 'closed') return 'shutdown'
  if (ending === 'prompt_ended') return 'no_approver'
  return 'wait_elapsed'
}

/** The shorter of two hints: none beats any finite wait, and a hint beats no hint. */
export function shorterWait(left: ApprovalWait | undefined, right: ApprovalWait | undefined): ApprovalWait | undefined {
  if (!left || !right) return left ?? right
  if (left.mode === 'none' || right.mode === 'none') return { mode: 'none' }
  return { mode: 'finite', ms: Math.min(left.ms, right.ms) }
}

/**
 * How long the caller is held: its hint when it sends one, shorter or longer than the entry point's
 * own hold, and the entry point's own otherwise (`grace`: BUCKLE_APPROVAL_TIMEOUT_MS; `prompt`: while
 * the terminal asks). Owner ruling of 2026-09-28: the caller (Rings) owns the run's state, so its
 * wait overrides Buckle's; a standalone caller sends none and gets Buckle's own.
 */
export function holdFor(input: { hold: ApprovalHold; graceMs: number | null; hint?: ApprovalWait }): number | null {
  if (input.hint) return input.hint.mode === 'none' ? 0 : input.hint.ms
  return input.hold === 'grace' ? input.graceMs : null
}

/** Once `work` settles, or at `until` on the `performance.now()` clock, whichever comes first; never rejects. */
async function settledOrAt(work: Promise<unknown>, until: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, until - performance.now())) }),
  ])
  clearTimeout(timer)
}

/** A hold no longer than `limit`, when there is one: an endless hold becomes the limit. */
function atMost(holdMs: number | null, limit: number | undefined): number | null {
  if (limit === undefined) return holdMs
  return holdMs === null ? limit : Math.min(holdMs, limit)
}

/** How long an issued ask stays answerable beyond its ten minutes: at least as long as the node's own hold, and the caller's when it holds longer. */
function askLifetime(graceMs: number | null, hint: ApprovalWait | undefined): number | null {
  if (graceMs === null) return null
  return hint?.mode === 'finite' ? Math.max(graceMs, hint.ms) : graceMs
}

async function announce(notify: ApprovalServiceOptions['announce'], requests: ApprovalRequest[], call: AskedCall | undefined): Promise<void> {
  if (!notify) return
  try {
    await notify(requests, call)
  } catch (error) {
    // Failing to reach someone must not also fail the call they would have approved.
    logger.warn('Could not announce a pending approval', { message: error instanceof Error ? error.message : 'Unknown error' })
  }
}

/** Tells a received decision's audit how the guard and the ledger ended it, rated as the guard rates its source. */
function endDecision(input: { received: DecisionEnding; source: ApprovalSource; result: Resolution }): void {
  const { received, result } = input
  if (result.ok) received.applied({ assurance: rightsOf(input.source.kind).assurance, repeated: result.repeated === true, ...(result.save === undefined ? {} : { save: result.save }) })
  else received.refused({ code: result.code })
}

/** How an ask that left the queue ended; one another process dropped is expired past its stated expiry, else cancelled. */
function closingEvent(approval: ApprovalRequest, departure: Departure | undefined): LifecycleEvent {
  const event = { eventId: randomUUID(), token: approval.token, at: new Date().toISOString() }
  if (departure === undefined) return { ...event, type: remainingMs(approval.expiresAt) === 0 ? 'expired' : 'cancelled' }
  return { ...event, type: departure.type, ...('reason' in departure ? { reason: departure.reason } : {}) }
}

// Hash and size each group's whole call once, however many asks share it.
type CallShape = { digest: string; callRef: string; inline: boolean }
type CallShapes = (tool: string, call: AskedCall) => CallShape

function createCallShapes(): CallShapes {
  const known = new WeakMap<AskedCall, Map<string, CallShape>>()
  return (tool, call) => {
    const byTool = known.get(call) ?? new Map<string, CallShape>()
    known.set(call, byTool)
    const cached = byTool.get(tool)
    if (cached) return cached
    const shown = shownCallOf(tool, call)
    const shape = { digest: callDigestOf(shown), callRef: shownCallDigestOf(shown), inline: Buffer.byteLength(canonicalJson(shown)) <= INLINE_CALL_BYTES }
    byTool.set(tool, shape)
    return shape
  }
}

function shownCallOf(tool: string, call: AskedCall): ShownApprovalCall {
  return { tool, arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] }
}

/** Whether the call's ask behind a request is at the floor: its rule's ask carries the mark, and the request does not. */
function atTheFloor(asks: readonly Ask[], request: ApprovalRequest): boolean {
  return asks.some(ask => ask.floor && ask.rule === request.rule && ask.subject === request.subject)
}
