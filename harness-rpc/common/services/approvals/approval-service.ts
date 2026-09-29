import { useScopeSafe, type CliOutcome, type CliRequest, type CliWait } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, ApprovalDecisionSchema, SignedApprovalDecisionSchema, type ApprovalDecision, type ApprovalRequest, type ApprovalSkipReason, type ApprovalWait, type ApprovalWithdraw, type JsonValue } from '@5straps/protocol'
import { callDigestOf, challengeBytes, SIGNED_REQUEST_VERSION, type ApprovalChallenge } from '@5straps/protocol/signed-request'
import { requestIdKey } from '../invocation/executions.js'
import type { ApprovalKey } from '@5straps/protocol/envelope'
import { createMemoryNonceClaims, type NonceClaims } from '../../adapters/approval/file-nonce-store.js'
import { remainingMs } from '../../domain/approval-deadline.js'
import { approveCommand } from '../../domain/approval-instruction.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import { logger } from '../../runtime/log.js'
import { openApprovalDecision, type DecisionRefusal } from './approval-envelope.js'
import { createApprovalNotices, type ApprovalNotices } from './approval-notices.js'
import type { ApprovalAuthority, ApprovalRegistry, GroupWithdrawal, PendingAsk, Resolution } from './approval-registry.js'
import { APPROVAL_REQUEST_KIND, NO_INTERACTION, type ApprovalHold, type Interaction, type InteractionSource } from './interaction.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** How quickly an answer written by another process (buckle approve, a second node process) is noticed. */
const POLL_INTERVAL_MS = 400
const SWEEP_MARGIN_MS = 1_000
const MAX_TIMER_MS = 2_147_483_647

/** What a terminal answer may choose. Its token is always the one its question asked about. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny' | 'deny_session' | 'deny_always'

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
  /** The call's tool and whole arguments, hashed (requestFingerprint): a re-send joins only with the same one. */
  fingerprint?: string
  /** The call as the node's signed challenge shows it (owner decision D9): redacted arguments and their directory. */
  call?: { arguments: JsonValue; cwd: string }
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
  authority: ApprovalAuthority
  /** `BUCKLE-D18`: a host pattern, which only `buckle approve --host` passes. */
  widenTo?: string
  /** The digest of the challenge a person's key decided on: it must be the ask's own (B24). */
  challenge?: string
  /** key:<fingerprint> for a decision a person's enrolled key signed; recorded with it and its grant. */
  decidedBy?: string
}

/** What a decision from Rings came to; the setup face answers 401, 400, 409 or 200 from it. */
export type SealedDecisionResult =
  | { status: 'refused'; reason: DecisionRefusal }
  | { status: 'invalid' }
  | { status: 'rejected'; reason: string }
  | { status: 'answered' }

export interface ApprovalService {
  /** Issues the asks (or joins the ones the same call already made), then waits as the caller's entry point holds it. */
  request(input: ApprovalAskInput): Promise<ApprovalWaitResult>
  /**
   * The only path that records a verdict: checks it against the ask, then wakes whoever waits on it.
   * Every route answers here: the terminal, `buckle approve`, `buckle approvals --watch`, MCP
   * elicitation and the setup face.
   */
  answer(input: ApprovalAnswer): Promise<Resolution>
  /**
   * `RINGS-D20`: opens a decision envelope under the nonce store's lock (the claim stays a synchronous
   * view of the locked state), then answers with the admin authority the setup face was opened with.
   * A decision in a request an enrolled key signed (`signedBy`) is plain: its signature is the proof.
   */
  decideSealed(input: { body: unknown; signedBy?: string }): Promise<SealedDecisionResult>
  /**
   * What each waiting ask is, as the node signs it for a person's client (owner ruling H4 of
   * 2026-09-28): built from the durable queue, so one ask always gives the same challenge.
   */
  challenges(): Array<{ token: string; challenge: ApprovalChallenge }>
  /** Withdraws the asks among `tokens` still waiting, telling the webhook they were cancelled. */
  withdraw(tokens: string[]): Promise<void>
  /**
   * The setup face's explicit cancel for one call (owner decision D6): withdraws its asks still
   * waiting, tells the webhook they were cancelled, and wakes the callers and questions waiting on
   * them; drops its answered `once` approvals no call spent. Returns both lists of tokens.
   */
  withdrawCall(selector: ApprovalWithdraw): Promise<CallWithdrawal>
  /** The requests still waiting in this workspace's queue. */
  pending(): ApprovalRequest[]
  /**
   * Settles every open wait as still pending and ends its questions, then waits for the lifecycle
   * notices still in flight; the asks stay in the durable queue.
   */
  close(): Promise<void>
}

/** A withdrawal, with its selector as the registry keeps it (a requestId hashed) for the audit entry (review L14 of B23-B25). */
export interface CallWithdrawal extends GroupWithdrawal {
  selector: { token: string } | { requestId: string; sessionId: string }
}

export interface ApprovalServiceOptions {
  registry: ApprovalRegistry
  workspaceId: string
  /** The node's serverId, which each challenge names. */
  serverId: string
  /** `BUCKLE_APPROVAL_TIMEOUT_MS`: how long a `grace` hold lasts when the caller sends no wait, in positive ms; null holds it until answered. */
  graceMs: number | null
  /** The current operation's interaction; an unbound operation asks nobody. */
  interaction: InteractionSource
  /** Told once an ask is issued, from every entry point, so a person can be reached away from the machine. */
  announce?: (requests: ApprovalRequest[]) => Promise<void>
  /** What became of the announced asks, on the same path; nothing is sent without one. */
  notices?: ApprovalNotices
  /** The key Rings minted at pairing; without one a plain decision is accepted and an envelope refused. */
  decisionKey?: ApprovalKey
  /** Replay protection for opened envelopes; in memory when no key is paired. */
  nonces?: NonceClaims
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
  /** One controller per waiting caller; aborting it supersedes that caller. */
  readonly participants: Set<AbortController>
  /** Ends the questions and the watch. */
  readonly stop: AbortController
  /** Resolves once every token left the pending set, or one was denied. */
  readonly settled: PromiseWithResolvers<void>
  /** The terminal questions; settles when they end. */
  prompting: Promise<void> | undefined
  promptEnded: boolean
  /** The question on screen for each token, withdrawn once its token is answered elsewhere. */
  readonly questions: Map<string, AbortController>
}

type Ending = 'settled' | 'elapsed' | 'prompt_ended' | 'aborted' | 'closed' | 'superseded'

interface QuestionContext {
  correlationId: string
  actor?: string
  sessionId: string
}

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
  const nonces = options.nonces ?? createMemoryNonceClaims()
  const notices = options.notices ?? createApprovalNotices()
  // One sweep per issued ask at its expiry, so an ask nobody answered is reported expired on time.
  const sweeps = new Set<NodeJS.Timeout>()
  // Calls still waiting and terminal questions still running, so close lets each call report back and
  // an answer already being recorded finish before the notices are flushed.
  const waiting = new Set<Promise<unknown>>()
  let unreadable = false

  const service: ApprovalService = {
    async request(input) {
      input.signal?.throwIfAborted()
      const interaction = (await options.interaction()) ?? NO_INTERACTION
      const scope = useScopeSafe()
      const actor = scope?.context.actor
      const key = joinKey({ ...input, actor })
      const issued = await options.registry.ask({ tool: input.tool, sessionId: input.sessionId, asks: input.asks, requestId: input.requestId, waitMs: askLifetime(options.graceMs, input.wait), ...(actor === undefined ? {} : { actor }), ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }), ...(input.call === undefined ? {} : { call: input.call }) })
      const { requests: approvals, answered } = issued
      // Joined to asks all answered, one of them denied: nothing to wait for, and the caller refuses.
      if (issued.joined && approvals.length === 0) return { settled: true, approvals, answered }
      const tokens = approvals.map(approval => approval.token)
      if (!issued.joined) {
        await announce(options.announce, approvals)
        scheduleSweep(approvals)
      }
      // Checked before any question is drawn: a caller that cancelled during the announce is asked about no more (review L5).
      await cancelIfCancelled({ key, tokens, signal: input.signal, isCancel: input.isCancel })
      if (closing.signal.aborted) return skip({ approvals, answered, reason: 'shutdown' })
      const holdMs = holdFor({ hold: interaction.hold, graceMs: options.graceMs, hint: input.wait })
      // The hint sets how long the caller is held and never who is asked: a `grace` entry point asks
      // its terminal whatever the hint says, and keeps asking after the caller returns (owner ruling).
      const keepAsking = interaction.hold === 'grace'
      // A hold of 0 comes only from the caller's hint `none`: the node's own is positive or null (D3).
      if (holdMs === 0 && !keepAsking) return skip({ approvals, answered, reason: 'caller_declined_wait' })

      const ask = openAsk({ key, approvals, answered, joined: issued.joined })
      const context = { correlationId: scope?.context.correlationId ?? input.requestId, ...(actor === undefined ? {} : { actor }), sessionId: input.sessionId }
      if (!ask.prompting) track(ask.prompting = startQuestions({ ask, interaction, context }))
      // The newest joined caller carries the wait; every earlier one ends without running (review M1).
      // A re-send whose own transport already dropped carries nothing on, so the earlier one keeps it.
      if (!input.signal?.aborted) for (const earlier of ask.participants) earlier.abort()
      if (holdMs === 0) {
        if (ask.participants.size === 0) release({ ask, keepAsking: true })
        return skip({ approvals, answered, reason: 'caller_declined_wait' })
      }
      const participant = new AbortController()
      ask.participants.add(participant)
      const result = waitFor({ ask, participant, hold: interaction.hold, holdMs, signal: input.signal })
        .then(ending => finish({ ask, participant, ending, hold: interaction.hold, signal: input.signal, isCancel: input.isCancel, own: { approvals, answered } }))
      track(result)
      return result
    },

    async answer(input) {
      const { challenge } = input
      const result = await options.registry.resolve(input.decision, input.authority, {
        ...(input.widenTo === undefined ? {} : { widenTo: input.widenTo }),
        ...(challenge === undefined ? {} : { expect: (ask: PendingAsk) => challengeBytes(challengeOf(ask)).digest === challenge }),
        ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }),
      })
      if (!result.ok) return result
      if (!result.repeated) notices.answered(input.decision)
      wake(input.decision.token)
      return result
    },

    async decideSealed(input) {
      if (input.signedBy) {
        // B24: a person's key decides on the challenge the node signed, named by its digest, and on nothing else.
        const signed = SignedApprovalDecisionSchema.safeParse(input.body)
        if (!signed.success) return { status: 'invalid' }
        const { challenge, ...decision } = signed.data
        const result = await service.answer({ decision, authority: 'admin', challenge, decidedBy: input.signedBy })
        return result.ok ? { status: 'answered' } : { status: 'rejected', reason: result.reason }
      }
      const opened = await nonces.withClaims(seen => openApprovalDecision({ key: options.decisionKey, body: input.body, workspaceId: options.workspaceId, seen }))
      if (!opened.ok) return { status: 'refused', reason: opened.reason }
      const parsed = ApprovalDecisionSchema.safeParse(opened.body)
      if (!parsed.success) return { status: 'invalid' }
      const result = await service.answer({ decision: parsed.data, authority: 'admin' })
      return result.ok ? { status: 'answered' } : { status: 'rejected', reason: result.reason }
    },

    challenges: () => options.registry.waiting().map(ask => ({ token: ask.request.token, challenge: challengeOf(ask) })),

    withdraw: tokens => withdraw(tokens),

    async withdrawCall(selector) {
      // The registry keeps a call's requestId hashed, as the invoker joins it.
      const hashed = 'token' in selector ? { token: selector.token } : { requestId: requestIdKey(selector.requestId), sessionId: selector.sessionId }
      const result = await options.registry.cancelGroup(hashed)
      notices.cancelled(result.withdrawn)
      for (const token of result.withdrawn) wake(token)
      if (result.withdrawn.length > 0 || result.dropped.length > 0) logger.info('Withdrew a call\'s approvals through the setup face', { withdrawn: result.withdrawn.length, dropped: result.dropped.length, workspaceId: options.workspaceId })
      return { ...result, selector: hashed }
    },

    pending: () => options.registry.pending(),

    async close() {
      closing.abort()
      for (const ask of [...live]) ask.stop.abort()
      for (const sweep of sweeps) clearTimeout(sweep)
      sweeps.clear()
      await Promise.allSettled([...waiting])
      await notices.settle()
    },
  }

  /**
   * The challenge for one ask: every field from the durable queue, so the same ask always signs the same
   * bytes. It carries the call as shown, and its digest, which a person's client recomputes (D9).
   */
  function challengeOf(ask: PendingAsk): ApprovalChallenge {
    const { request, call } = ask
    return {
      v: SIGNED_REQUEST_VERSION, purpose: 'buckle-approval-challenge', node: options.serverId, workspace: options.workspaceId,
      token: request.token, requestId: ask.requestId ?? null, sessionId: ask.sessionId, actor: ask.actor ?? null,
      tool: request.tool, rule: request.rule, subject: request.subject, reason: request.reason, offeredScopes: request.offeredScopes,
      arguments: call?.arguments ?? null, cwd: call?.cwd ?? null,
      callDigest: call ? callDigestOf({ tool: request.tool, arguments: call.arguments }) : null, expiresAt: request.expiresAt,
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
    const remaining = Math.max(...approvals.map(approval => remainingMs(approval.expiresAt)))
    if (remaining === Infinity || closing.signal.aborted) return
    const sweep = setTimeout(() => {
      sweeps.delete(sweep)
      Promise.resolve().then(() => options.registry.sweep()).catch((error: unknown) => { logger.warn('Could not sweep expired approvals', { error }) })
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
    const ask: OpenAsk = {
      key, approvals: input.approvals, tokens: [...input.approvals.map(approval => approval.token), ...input.answered], participants: new Set(),
      stop: new AbortController(), settled: Promise.withResolvers<void>(), prompting: undefined, promptEnded: false, questions: new Map(),
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

  /** Reads the queue: withdraws a question whose token left it, and settles the ask once every token did. */
  function check(ask: OpenAsk): void {
    const state = readQueue(ask.tokens)
    if (!state) return
    for (const [token, question] of ask.questions) if (!state.pending.has(token)) question.abort()
    if (state.denied || ask.tokens.every(token => !state.pending.has(token))) ask.settled.resolve()
  }

  function readQueue(tokens: string[]): { pending: Set<string>; denied: boolean } | null {
    try {
      const state = { pending: new Set(options.registry.pending().map(request => request.token)), denied: options.registry.wasDenied(tokens) }
      unreadable = false
      return state
    } catch (error) {
      // Retried at the next poll, and the hold still ends the call; said once until a read succeeds.
      if (!unreadable) logger.warn('Could not read the approval queue', { error })
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

  function startQuestions(input: { ask: OpenAsk; interaction: Interaction; context: QuestionContext }): Promise<void> {
    return askInTurn(input)
      .catch((error: unknown) => { logger.warn('A terminal approval question failed; the request stays waiting', { error }) })
      .finally(() => { input.ask.promptEnded = true })
  }

  /** One question per token, in order. A denial ends them, since the call is refused either way. */
  async function askInTurn(input: { ask: OpenAsk; interaction: Interaction; context: QuestionContext }): Promise<void> {
    const { ask } = input
    for (const approval of ask.approvals) {
      if (ask.stop.signal.aborted) return
      if (!readQueue([approval.token])?.pending.has(approval.token)) continue
      const question = new AbortController()
      ask.questions.set(approval.token, question)
      let outcome: CliOutcome
      try {
        outcome = await input.interaction.requestCli(questionFor({ approval, workspaceId: options.workspaceId, context: input.context }), { signal: AbortSignal.any([ask.stop.signal, question.signal]) })
      } finally {
        ask.questions.delete(approval.token)
      }
      if (outcome.status === 'answered' || outcome.status === 'denied') {
        // The owner's own terminal: the owner's authority, as `buckle approve` has.
        const decision = decisionFor(approval, outcome)
        const result = await service.answer({ decision, authority: 'admin' })
        if (!result.ok) logger.warn('Approval decision rejected', { reason: result.reason })
        if (!decision.approved) return
        continue
      }
      // Its token was answered elsewhere while on screen; the next one is still worth asking.
      if (outcome.status === 'cancelled' && question.signal.aborted && !ask.stop.signal.aborted) continue
      return
    }
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
    void input.ask.settled.promise.then(() => done('settled'))
    if (input.hold === 'prompt') void input.ask.prompting?.then(() => done('prompt_ended'))
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

  async function finish(input: { ask: OpenAsk; participant: AbortController; ending: Ending; hold: ApprovalHold; signal?: AbortSignal; isCancel?: (reason: unknown) => boolean; own: { approvals: ApprovalRequest[]; answered: string[] } }): Promise<ApprovalWaitResult> {
    const { ask, ending, own } = input
    ask.participants.delete(input.participant)
    const last = ask.participants.size === 0
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

/** Whether the caller's abort is an explicit cancel; without a way to tell, it is a dropped transport. */
function cancels(signal: AbortSignal | undefined, isCancel: ((reason: unknown) => boolean) | undefined): boolean {
  return signal?.aborted === true && isCancel?.(signal.reason) === true
}

/** The in-process twin of the registry's join: the same requestId, session and actor. */
function joinKey(input: { sessionId: string; requestId: string; actor?: string }): string {
  return JSON.stringify([input.sessionId, input.actor ?? null, input.requestId])
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

/** How long an issued ask stays answerable beyond its ten minutes: at least as long as the node's own hold, and the caller's when it holds longer. */
function askLifetime(graceMs: number | null, hint: ApprovalWait | undefined): number | null {
  if (graceMs === null) return null
  return hint?.mode === 'finite' ? Math.max(graceMs, hint.ms) : graceMs
}

async function announce(notify: ApprovalServiceOptions['announce'], requests: ApprovalRequest[]): Promise<void> {
  if (!notify) return
  try {
    await notify(requests)
  } catch (error) {
    // Failing to reach someone must not also fail the call they would have approved.
    logger.warn('Could not announce a pending approval', { message: error instanceof Error ? error.message : 'Unknown error' })
  }
}

/** The question the terminal shows: what the call wants and the command that answers it elsewhere. */
export function questionFor(input: { approval: ApprovalRequest; workspaceId: string; context: QuestionContext }): CliRequest {
  const { approval, workspaceId, context } = input
  return {
    id: `approval:${workspaceId}:${approval.token}`,
    kind: APPROVAL_REQUEST_KIND,
    correlationId: context.correlationId,
    ...(context.actor === undefined ? {} : { actor: context.actor }),
    sessionId: context.sessionId,
    target: workspaceId,
    action: {
      summary: `${approval.tool} needs approval`,
      details: {
        tool: approval.tool, rule: approval.rule, subject: approval.subject, reason: approval.reason,
        scopes: approval.offeredScopes.join(','), expiresAt: approval.expiresAt, workspace: workspaceId,
        approve: approveCommand({ request: approval, workspaceId }),
      },
    },
    wait: questionWait(approval.expiresAt),
  }
}

/** A question lasts as long as its request: a terminal someone sits at, not the call's grace period. */
function questionWait(expiresAt: string): CliWait {
  if (expiresAt === APPROVAL_NO_DEADLINE) return { mode: 'indefinite' }
  return { mode: 'finite', timeoutMs: Math.min(Math.max(remainingMs(expiresAt), 1), MAX_TIMER_MS) }
}

/** The verdict for the asked token alone; anything but a known approving choice denies once. */
function decisionFor(approval: ApprovalRequest, outcome: Extract<CliOutcome, { status: 'answered' | 'denied' }>): ApprovalDecision {
  const choice = outcome.status === 'answered' ? outcome.answer.choice : 'deny'
  if (choice === 'once' || choice === 'session' || choice === 'always') return { token: approval.token, approved: true, scope: choice }
  if (choice === 'deny_session') return { token: approval.token, approved: false, scope: 'session' }
  if (choice === 'deny_always') return { token: approval.token, approved: false, scope: 'always' }
  return { token: approval.token, approved: false, scope: 'once' }
}
