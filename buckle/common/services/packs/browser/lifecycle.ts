import { randomUUID } from 'node:crypto'
import type { JsonFileStore } from '../../../adapters/json-file-store.js'
import { printable, workspaceArgument } from '../../../domain/approval-instruction.js'
import { ToolExecutionError, ToolInputError, type FilledSecret, type HeldSecret } from '../../../domain/tool.js'
import { logger } from '../../../runtime/log.js'
import type { BrowserModeName } from './mode.js'
import type { BrowserCloseCounts } from '../../../domain/pack.js'
import { busy, closerLive, filledKey, isWriter, keyOf, liveLeases, liveSibling, mergeFilled, recordsWhere, sessionKey, stranded, upgradeSessions, type BrowserRecord, type Caller, type Closer, type Lease, type Sessions, type Writer } from './sessions.js'

/** Who a call is for, and what its browser is started with, which a session it takes must have been started under. */
export interface CallScope {
  kind: BrowserModeName
  caller: Caller
  /** modeFingerprint of the pack's settings. */
  fingerprint: string
  /** The profile folder's one session, which every caller shares; null in the other modes. */
  own: string | null
  /** The attached Chrome the call reaches (attachedChrome), whose hold masks it; null in the other modes. */
  chrome: string | null
  /** The --allowed-domains the call passes, null for none. */
  flag: string | null
}

export interface Lifecycle {
  store: JsonFileStore<Sessions>
  me: Writer
  /** The idle timeout a session this pack starts is given. */
  idleTimeoutMs: number
  /** The longest call the node runs: a session's idle time starts once its last call ends. */
  longestCallMs: number
  /** Sends one bare close, as shutdown does: whether it closed. */
  close(session: string, signal: AbortSignal): Promise<boolean>
  /** The workspace's name, which the owner's command names; read at each refusal, as a rename takes effect at once. */
  workspaceName?: () => string
  /**
   * The attached Chrome the workspace attaches to (attachedChrome), where its endpoint is found closed (endpointClosed),
   * else null: a close only disconnects from it, and it keeps its pages until it is closed. Absent in the other modes.
   */
  chromeClosed?: () => Promise<string | null>
}

/** How many filled values one browser is masked by at most. */
const MAX_FILLED = 256

/** How long the closes before a call, or at shutdown, wait for the daemons, all of them together. */
export const CLOSE_TIMEOUT_MS = 5_000

/** How long past its own timeout a call's lease lasts: what the call does around its command, and its release. */
const LEASE_MARGIN_MS = CLOSE_TIMEOUT_MS

/** How often a call waiting for a session's daemon to start looks again. */
const START_POLL_MS = 25

/** Fixed text: a close came while a call ran on the profile folder's one browser, which the last call to end ends. */
const PROFILE_CLOSING = 'The profile folder\'s browser is being closed: a close came while a call still runs on it, and it ends when that call does; call again then'

/** Why a call on a profile folder is refused where its browser's close failed, and failed again when the call sent it. */
function profileNotClosed(lifecycle: Lifecycle): string {
  return `The profile folder's browser did not close when a close was sent to it, so no call runs on it while its page may still show what it held; call again to send the close again, or end it with the owner's ${ownerCommand(lifecycle)}`
}

/** A close this process sends now, with how long it may take: no call takes the session it marks meanwhile. */
function closerFor(lifecycle: Lifecycle, timeoutMs: number, now: number): Closer {
  return { id: randomUUID(), writer: lifecycle.me, until: now + timeoutMs + LEASE_MARGIN_MS }
}

/** Marks a session closing, under the sessions lock, by the close on its way to it, which alone forgets it (forget). */
function markClosing(record: BrowserRecord, closer: Closer): void {
  record.closing = true
  record.closer = closer
}

/** The session a call runs on, and why it changed: the list a relaunched one last ran with, or a sibling's settings. */
export interface TakenSession {
  session: string
  /** The call's lease on it (LeaseSchema), which releaseSession ends. */
  lease: string
  /** The --allowed-domains a session closed for this call last ran with, null for none; absent where none was. */
  relaunchedFrom?: string | null
  /** A live Buckle process on other settings holds the key: its session is left running. */
  sibling: boolean
}

interface Claims { names: string[]; relaunchedFrom?: string | null; sibling: boolean }

interface TakeInput {
  scope: CallScope
  fills: readonly FilledSecret[]
  /** The call's own timeout, which bounds its lease. */
  timeoutMs: number
  /** The call's signal: a call waiting for a session's daemon to start stops waiting when it ends. */
  signal?: AbortSignal
}

/** What a take answers where another call is starting the session's daemon: look again once it has. */
const WAIT = Symbol('wait')

/**
 * The session a call runs on (Slice F4, items 3 to 5): its caller's, stage's, and alias's, started under this pack's
 * settings, with a lease on it until releaseSession (Codex review L3). First, under the lock, every session left with no
 * one to end it (stranded) is claimed, and so is a session of the key started under other settings, or a fresh one last
 * run under another list: each is closed, and a new one named under the same key, so no record is left under the old
 * settings; a live sibling's is left to it, and so is one a call runs on. Each value the call fills is held by the
 * session it takes, under the same lock, before the browser is handed it. A session whose daemon another call is
 * starting is waited for, so two calls never start two daemons for one session (agent-browser #2074), and so is a close
 * on its way to a session the call would take (Codex recheck M1, L3).
 */
export async function takeSession(lifecycle: Lifecycle, input: TakeInput): Promise<TakenSession> {
  for (;;) {
    const taken = await takeOnce(lifecycle, input)
    if (taken !== WAIT) return taken
    if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new ToolExecutionError('The browser call ended while it waited for its browser to start', { code: 'BROWSER_COMMAND_FAILED' })
    await new Promise(resolve => setTimeout(resolve, START_POLL_MS))
  }
}

async function takeOnce(lifecycle: Lifecycle, input: TakeInput): Promise<TakenSession | typeof WAIT> {
  const { store } = lifecycle
  const first = await store.update((state): Taking<TakenSession | typeof WAIT> | { claims: Claims; closer: string } => {
    upgradeSessions(state)
    const claims = claimsFor(lifecycle, state, input.scope)
    if (claims.names.length > 0) {
      const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, Date.now())
      for (const name of claims.names) markClosing(state.browsers[name]!, closer)
      return { claims, closer: closer.id }
    }
    return taking(() => {
      const taken = take(lifecycle, state, input)
      return taken === WAIT ? WAIT : { ...taken, sibling: taken.sibling || claims.sibling }
    })
  })
  if (!('claims' in first)) return taken(first)
  const { claims, closer } = first
  const closed = await closeEach(lifecycle, claims.names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session Buckle ended before a call did not close; the next start ends it')
  return taken(await store.update((state) => {
    upgradeSessions(state)
    forget(state, closed, closer)
    return taking(() => {
      const taken = take(lifecycle, state, input)
      return taken === WAIT ? WAIT : { ...taken, sibling: taken.sibling || claims.sibling, ...(claims.relaunchedFrom === undefined ? {} : { relaunchedFrom: claims.relaunchedFrom }) }
    })
  }))
}

/** A take, or the refusal it met, which is thrown once the store keeps what the update changed before it. */
type Taking<T> = { taken: T } | { refused: ToolInputError | ToolExecutionError }

function taking<T>(run: () => T): Taking<T> {
  try {
    return { taken: run() }
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof ToolExecutionError) return { refused: error }
    throw error
  }
}

function taken<T>(result: Taking<T>): T {
  if ('refused' in result) throw result.refused
  return result.taken
}

/**
 * The sessions to close before a call runs: every stranded one, whatever its key; and of the call's key, one started
 * under other settings that no live sibling holds, and a fresh one last run under another list, as a daemon keeps the
 * list it was launched with (fix brief 4, finding 9). None a call runs on: its next call after closes it. And the
 * profile folder's one session where a close failed: no call takes a session marked closing, and a call on the folder
 * can name no other, so its close is sent again first (Codex recheck L3).
 */
function claimsFor(lifecycle: Lifecycle, state: Sessions, scope: CallScope): Claims {
  const key = sessionKey(scope.kind, scope.caller)
  const now = Date.now()
  const names: string[] = []
  let relaunchedFrom: string | null | undefined
  let sibling = false
  for (const [name, record] of Object.entries(state.browsers)) {
    if (record.closing) {
      if (name === scope.own && !busy(record, now) && !closerLive(record, now)) names.push(name)
      continue
    }
    const running = busy(record, now)
    if (stranded(record, lifecycle.me, now, lifecycle.longestCallMs)) {
      if (!running) names.push(name)
      continue
    }
    if (keyOf(record) !== key) continue
    // On a profile folder the key is every caller's: another folder's session is replaced as other settings are.
    if (record.mode !== scope.fingerprint || (scope.own !== null && name !== scope.own)) {
      if (liveSibling(record, lifecycle.me)) sibling = true
      else if (!running) names.push(name)
    } else if (scope.kind === 'fresh' && record.allowedDomains !== undefined && record.allowedDomains !== scope.flag && !running) {
      names.push(name)
      relaunchedFrom = record.allowedDomains
    }
  }
  return { names, sibling, ...(relaunchedFrom === undefined ? {} : { relaunchedFrom }) }
}

/**
 * Takes the call's session and records it as this process's, used now, holding what the call fills, with the call's
 * lease on it. No call takes a session marked closing (Codex recheck M1, L3), as the close, once it ended the browser,
 * forgets the session and its hold, and the call's command would start that browser again with neither left. On a
 * profile folder it is the folder's one session, whose name never changes: a close on its way to it is waited for; one a
 * call still runs on, which that call's end sends, refuses the call (Codex review L3); and so does one that failed, and
 * failed again when claimsFor sent it. One a live sibling wrote under other settings, or one a call runs on, is reused as
 * it is, as closing it would relaunch Chrome at each call either process makes, or under the running call. Elsewhere it
 * is the key's session from these settings and list, or a new one, once no close is on its way to a session of the key.
 * An attached Chrome's fills are its own hold, which no session ends. Where another call is starting the session's
 * daemon, or a close is on its way, nothing is taken: WAIT.
 */
function take(lifecycle: Lifecycle, state: Sessions, input: TakeInput): { session: string; sibling: boolean; lease: string } | typeof WAIT {
  const { scope, fills } = input
  const now = Date.now()
  const fields = { ...scope.caller, mode: scope.fingerprint, writer: lifecycle.me, usedAt: now, idleTimeoutMs: lifecycle.idleTimeoutMs }
  const held = (record: BrowserRecord | undefined) => {
    const kept = withFilled(lifecycle, record?.held ?? [], scope.kind === 'attached' ? [] : fills)
    return kept.length > 0 ? { held: kept } : {}
  }
  const lease = (record: BrowserRecord | undefined, cold: boolean): { leases: Lease[]; id: string } => {
    const id = randomUUID()
    const mine: Lease = { id, writer: lifecycle.me, until: now + input.timeoutMs + LEASE_MARGIN_MS, ...(cold ? { starting: true as const } : {}) }
    return { leases: [...record === undefined ? [] : liveLeases(record, now), mine], id }
  }
  if (scope.own !== null) {
    const record = state.browsers[scope.own]
    if (record?.closing) {
      if (closerLive(record, now)) return WAIT
      throw new ToolExecutionError(busy(record, now) ? PROFILE_CLOSING : profileNotClosed(lifecycle), { code: 'BROWSER_COMMAND_FAILED' })
    }
    if (record !== undefined && starting(record, now)) return WAIT
    const cold = record === undefined || idle(record, now)
    if (record !== undefined && record.mode !== scope.fingerprint && (liveSibling(record, lifecycle.me) || busy(record, now))) {
      const kept = held(record)
      const { leases, id } = lease(record, cold)
      Object.assign(record, kept, { usedAt: now, leases })
      return { session: scope.own, sibling: liveSibling(record, lifecycle.me), lease: id }
    }
    const kept = held(record)
    const { leases, id } = lease(record, cold)
    state.browsers[scope.own] = { kind: 'profile', ...fields, ...kept, leases }
    return { session: scope.own, sibling: false, lease: id }
  }
  const key = sessionKey(scope.kind, scope.caller)
  // A close on its way to a session of the key is waited for rather than passed over for a new name, so the key keeps
  // one browser, and a session a retire closed and left is still found, and replaced with the relaunch told.
  if (Object.values(state.browsers).some(record => keyOf(record) === key && closerLive(record, now))) return WAIT
  const found = recordsWhere(state, record => !record.closing && keyOf(record) === key && record.mode === scope.fingerprint && (scope.kind !== 'fresh' || record.allowedDomains === undefined || record.allowedDomains === scope.flag))[0]
  const record = found === undefined ? undefined : state.browsers[found]
  if (record !== undefined && starting(record, now)) return WAIT
  const session = found ?? `buckle-${randomUUID()}`
  const kept = held(record)
  if (scope.kind === 'attached' && fills.length > 0) {
    // Checked against all the Chrome is masked by, an earlier Buckle's hold included; kept as the Chrome's own.
    withFilled(lifecycle, chromeHold(state, scope.chrome!), fills)
    state.chromes = { ...state.chromes, [scope.chrome!]: mergeFilled(state.chromes?.[scope.chrome!] ?? [], fills) }
  }
  const { leases, id } = lease(record, record === undefined || idle(record, now))
  // A daemon starts under this list at this call's first command, whether the call then succeeds, fails, or times out,
  // so the list is recorded before it runs: a later change then relaunches it.
  state.browsers[session] = { kind: scope.kind, ...fields, ...(scope.kind === 'fresh' ? { allowedDomains: scope.flag } : {}), ...kept, leases }
  return { session, sibling: false, lease: id }
}

/** Whether another call is starting a session's daemon now, which this one waits for. */
function starting(record: BrowserRecord, now: number): boolean {
  return liveLeases(record, now).some(lease => lease.starting === true)
}

/** Whether a session's daemon may have ended by its idle timeout: no call runs on it, and none has for that long. */
function idle(record: BrowserRecord, now: number): boolean {
  return !busy(record, now) && now - record.usedAt >= record.idleTimeoutMs
}

/**
 * Ends a call's lease (Codex review L3), with the session used now, and answers what the session held as it ended, which
 * the call's own late masking reads. Where a close came while it ran, and no other call runs on the session, the close
 * is this call's to send: it marks the session as its own close's, sends it, and the session is forgotten with its hold
 * once it closed.
 */
export async function releaseSession(lifecycle: Lifecycle, session: string, lease: string): Promise<FilledSecret[]> {
  const ended = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const record = state.browsers[session]
    if (record === undefined) return { held: [], closer: null }
    const now = Date.now()
    const leases = liveLeases(record, now).filter(item => item.id !== lease)
    if (leases.length > 0) record.leases = leases
    else delete record.leases
    record.usedAt = now
    const held = [...record.held ?? []]
    if (record.closing !== true || leases.length > 0 || closerLive(record, now)) return { held, closer: null }
    const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, now)
    markClosing(record, closer)
    return { held, closer: closer.id }
  })
  if (ended.closer !== null) {
    const closed = await closeEach(lifecycle, [session])
    if ([...closed.values()].includes(false)) logger.warn('A browser session a close came for while a call ran did not close; the next start ends it')
    await settleClaims(lifecycle, closed, ended.closer)
  }
  return ended.held
}

/**
 * A hold with a call's fills in it, refused past MAX_FILLED values, and refused where the browser holds another value of
 * a reference the call fills (Codex review L4): two fills that each passed their checks before either was held, the file
 * rotated between their reads, would leave both values on the page, and no later call could be masked by the first.
 */
function withFilled(lifecycle: Lifecycle, held: readonly FilledSecret[], added: readonly FilledSecret[]): FilledSecret[] {
  const other = added.find(entry => held.some(kept => filledKey(kept) === filledKey(entry) && kept.digest !== entry.digest))
  if (other) throw new ToolInputError(`The secret ${other.name} in ${other.written} changed since this browser was filled with it, so it is not filled with another value beside the first; end this browser with browser_command close, or the owner's ${ownerCommand(lifecycle)}, then fill again`, { code: 'PERMISSION_DENIED' })
  const merged = mergeFilled(held, added)
  if (merged.length > MAX_FILLED && merged.length > held.length) throw new ToolInputError(`A browser is masked by at most ${MAX_FILLED} filled secret values; end it with browser_command close, or the owner's ${ownerCommand(lifecycle)}, to fill more`, { code: 'PERMISSION_DENIED' })
  return merged
}

/** The owner's command that ends every browser of the workspace (Slice F4, item 6), as a refusal names it. */
function ownerCommand(lifecycle: Lifecycle): string {
  const name = lifecycle.workspaceName?.()
  return `buckle browser close${name === undefined ? '' : ` --workspace ${workspaceArgument(name)}`}`
}

/**
 * The values a browser call is masked by (Slice F4, item 5), those of the browser it reaches alone (Codex review L6):
 * on a fresh browser, what its own session holds, the one the call will run on; on a profile folder, what the folder's
 * one session holds, one a close failed for included; on an attached Chrome, that Chrome's hold. A session about to be
 * ended before the call runs is left out, as the call never reaches it.
 */
export function heldFor(lifecycle: Lifecycle, state: Sessions, scope: CallScope): HeldSecret[] {
  const now = Date.now()
  const ending = (record: BrowserRecord) => !record.closing && !busy(record, now) && stranded(record, lifecycle.me, now, lifecycle.longestCallMs)
  const key = sessionKey(scope.kind, scope.caller)
  const shared = scope.own === null ? undefined : state.browsers[scope.own]
  const values = scope.kind === 'fresh'
    ? [...Object.values(state.browsers).find(record => !record.closing && !ending(record) && keyOf(record) === key && record.mode === scope.fingerprint && (record.allowedDomains === undefined || record.allowedDomains === scope.flag))?.held ?? []]
    : scope.kind === 'profile' ? (shared === undefined || ending(shared) ? [] : [...shared.held ?? []]) : chromeHold(state, scope.chrome!)
  const command = ownerCommand(lifecycle)
  return values.map(value => ({ ...value, holders: holdersOf(state, value), ownerCommand: command }))
}

/** What an attached Chrome is masked by: its own hold, and one an earlier Buckle kept for a Chrome it did not name. */
function chromeHold(state: Sessions, chrome: string): FilledSecret[] {
  return mergeFilled(state.attached ?? [], state.chromes?.[chrome] ?? [])
}

/** What a refusal names for an attached Chrome, which a close only disconnects from. */
const ATTACHED_HOLDER = 'the owner\'s attached Chrome, which keeps its pages through a close, so only the owner\'s command ends its hold'

/** Every browser of the workspace that holds a value, as a refusal names it (Slice F4, item 7). */
function holdersOf(state: Sessions, value: FilledSecret): string[] {
  const key = filledKey(value)
  const holders = Object.values(state.browsers).filter(record => (record.held ?? []).some(entry => filledKey(entry) === key)).map(describeHolder)
  if ([...state.attached ?? [], ...Object.values(state.chromes ?? {}).flat()].some(entry => filledKey(entry) === key)) holders.push(ATTACHED_HOLDER)
  return holders
}

/** One browser by whom it serves and when it was last used, and the agent's close that ends it. */
function describeHolder(record: BrowserRecord): string {
  const used = new Date(record.usedAt).toISOString()
  if (record.kind === 'profile') return `the profile folder's browser, which every caller shares, last used ${used}, which browser_command close from any caller ends`
  const alias = record.alias === 'default' ? null : printable(record.alias)
  const stage = record.stage === 'default' ? null : printable(record.stage)
  const close = `browser_command close${alias === null ? '' : ` with session ${alias}`} from that caller${stage === null ? '' : ' and stage'} ends`
  return `the fresh browser of caller ${printable(record.caller)}${alias === null ? '' : `, session ${alias}`}${stage === null ? '' : `, stage ${stage}`}, last used ${used}, which ${close}`
}

/**
 * An agent's close: every session of its key, except one a live sibling holds under other settings, which the caller
 * closes under its own timeout; and every stranded session, as before any call. Its own are empty where the key records
 * none, so nothing of the caller's runs. One a call runs on is marked closing and left to the last call on it to end
 * (Codex review L3): `waiting` counts them. One another close is on its way to is left to that close (Codex recheck L3),
 * which `closing` says. The rest are marked as `closer`'s, the close the caller sends, under its own timeout.
 */
export async function claimCaller(lifecycle: Lifecycle, scope: CallScope, timeoutMs: number): Promise<{ own: string[]; waiting: number; closing: boolean; stranded: string[]; closer: string }> {
  return lifecycle.store.update((state) => {
    upgradeSessions(state)
    const key = sessionKey(scope.kind, scope.caller)
    const now = Date.now()
    const closer = closerFor(lifecycle, Math.max(timeoutMs, CLOSE_TIMEOUT_MS), now)
    const caller = (record: BrowserRecord, name: string) => (scope.own !== null ? name === scope.own : keyOf(record) === key)
    const own = scope.own !== null
      ? (state.browsers[scope.own] === undefined || closerLive(state.browsers[scope.own]!, now) ? [] : [scope.own])
      : recordsWhere(state, record => !record.closing && keyOf(record) === key && !(record.mode !== scope.fingerprint && liveSibling(record, lifecycle.me)))
    const left = recordsWhere(state, (record, name) => !record.closing && !own.includes(name) && !busy(record, now) && stranded(record, lifecycle.me, now, lifecycle.longestCallMs))
    const closable = own.filter(name => !busy(state.browsers[name]!, now))
    for (const name of own) state.browsers[name]!.closing = true
    for (const name of [...closable, ...left]) markClosing(state.browsers[name]!, closer)
    const closing = recordsWhere(state, (record, name) => caller(record, name) && closerLive(record, now) && record.closer!.id !== closer.id).length > 0
    return { own: closable, waiting: own.length - closable.length, closing, stranded: left, closer: closer.id }
  })
}

/**
 * At pack start (Slice F4, item 4): ends every session left with no one to end it, a stopped writer's, one past its
 * idle timeout, or one a close failed for, with a bare close, then forgets it. One whose close fails again stays marked
 * closing, for the next start. An earlier Buckle's store is taken up here too, its sessions last used at an unknown
 * time, so each is ended.
 */
export async function endStranded(lifecycle: Lifecycle): Promise<void> {
  // One a call runs on is that call's to end, once a close marked it (Codex review L3), and one a close is on its way to
  // is that close's (Codex recheck L3).
  const left = (state: Sessions, now: number) => recordsWhere(state, record => !busy(record, now) && !closerLive(record, now) && (record.closing === true || stranded(record, lifecycle.me, now, lifecycle.longestCallMs)))
  const seen = lifecycle.store.read()
  upgradeSessions(seen)
  if (left(seen, Date.now()).length === 0) return
  const { names, closer } = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const now = Date.now()
    const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, now)
    const names = left(state, now)
    for (const name of names) markClosing(state.browsers[name]!, closer)
    return { names, closer: closer.id }
  })
  const closed = await closeEach(lifecycle, names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session a stopped Buckle process left did not close; the next start ends it')
  await settleClaims(lifecycle, closed, closer)
}

/**
 * When the settings change (fix brief 2, R2): each browser the replaced pack started closes, and its record stays for
 * the successor, which at the session's next call closes it again and starts a browser under a new name, saying it was
 * relaunched where the list changed. A browser that closed holds nothing any more. Each is marked closing under the
 * sessions lock before its close is sent, so no call takes it meanwhile (Codex recheck M1), and its record is changed
 * after only where it is still marked by this close. One that did not close stays marked closing with its hold, for the
 * next start.
 */
export async function retireSessions(lifecycle: Lifecycle, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  const { ending, closer } = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const now = Date.now()
    const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, now)
    // One a call runs on, a sibling's on the same key, is left to it (Codex review L3); its next call replaces it. One
    // already closing, or forgotten, is another close's.
    const ending = names.filter((name) => {
      const record = state.browsers[name]
      return record !== undefined && !record.closing && !busy(record, now)
    })
    for (const name of ending) markClosing(state.browsers[name]!, closer)
    return { ending, closer: closer.id }
  })
  const closed = await closeEach(lifecycle, ending)
  if ([...closed.values()].includes(false)) logger.warn('A browser session did not close when its settings changed; the next start ends it')
  if (closed.size === 0) return
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    for (const [name, done] of closed) {
      const record = state.browsers[name]
      if (record?.closer?.id !== closer) continue
      delete record.closer
      if (!done) continue
      delete record.closing
      delete record.held
    }
  })
}

/**
 * At shutdown (Slice F4, item 4): closes every session this process wrote, whichever pack started it and in whichever
 * mode, a profile folder's too, and forgets each that closed; one that did not stays marked closing, for the next start.
 * One a call runs on, a sibling's on a profile folder, is marked closing and left to the last call on it (Codex review L3),
 * and one a close is on its way to is left to that close (Codex recheck L3).
 */
export async function closeWritten(lifecycle: Lifecycle): Promise<void> {
  if (recordsWhere(lifecycle.store.read(), record => isWriter(record, lifecycle.me)).length === 0) return
  const { names, closer } = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const now = Date.now()
    const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, now)
    const mine = recordsWhere(state, record => isWriter(record, lifecycle.me) && !closerLive(record, now))
    for (const name of mine) state.browsers[name]!.closing = true
    const names = mine.filter(name => !busy(state.browsers[name]!, now))
    for (const name of names) markClosing(state.browsers[name]!, closer)
    return { names, closer: closer.id }
  })
  const closed = await closeEach(lifecycle, names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session did not close at shutdown; the next start ends it')
  await settleClaims(lifecycle, closed, closer)
}

/**
 * The owner's buckle browser close (Slice F4, item 6): under the sessions lock, held all through, so no call starts a
 * browser meanwhile, every recorded session is closed, a live sibling's too, with a bare close in parallel under one
 * bound. Each that closed is forgotten with its hold. One that did not stays marked closing with its hold (Codex review
 * L1), as a profile folder's keeps its name and a call would reach its page again: the next start, or this command, ends
 * it. One a call runs on is marked closing with its hold, and the last call on it ends it (Codex review L3), as a close
 * now would leave the call's command to start it again. One a close sent outside this lock is on its way to stays that
 * close's to end and forget (Codex recheck L3), and is counted as one that did not close: it keeps its hold meanwhile.
 * An attached Chrome keeps its pages through a close, so its hold is forgotten only once the Chrome the workspace
 * attaches to is found closed (Codex review L2), and with it an earlier Buckle's, which named no Chrome; another Chrome's
 * stays, as nothing here can check it, until the workspace attaches to it again and this command finds it closed.
 */
export async function closeAll(lifecycle: Lifecycle): Promise<BrowserCloseCounts> {
  return lifecycle.store.update(async (state) => {
    upgradeSessions(state)
    const names = Object.keys(state.browsers)
    const before = heldValues(state)
    const now = Date.now()
    const closer = closerFor(lifecycle, CLOSE_TIMEOUT_MS, now)
    const ours = names.filter(name => !closerLive(state.browsers[name]!, now))
    const running = ours.filter(name => busy(state.browsers[name]!, now))
    const ending = ours.filter(name => !running.includes(name))
    for (const name of running) state.browsers[name]!.closing = true
    for (const name of ending) markClosing(state.browsers[name]!, closer)
    const closed = await closeEach(lifecycle, ending)
    forget(state, closed, closer.id)
    const chrome = state.chromes !== undefined || state.attached !== undefined ? await lifecycle.chromeClosed?.() ?? null : null
    if (chrome !== null) {
      delete state.chromes?.[chrome]
      delete state.attached
    }
    if (state.chromes !== undefined && Object.keys(state.chromes).length === 0) delete state.chromes
    const after = heldValues(state)
    const kept = after.size
    const chromes = Object.keys(state.chromes ?? {}).length + (state.attached === undefined ? 0 : 1)
    return { browsers: names.length, closed: [...closed.values()].filter(Boolean).length, held: [...before].filter(value => !after.has(value)).length, ...(kept > 0 ? { kept } : {}), ...(chromes > 0 ? { chromes } : {}), ...(running.length > 0 ? { busy: running.length } : {}) }
  })
}

/** Every value the workspace's browsers hold, each once, by file, NAME, and digest. */
function heldValues(state: Sessions): Set<string> {
  return new Set([...state.attached ?? [], ...Object.values(state.chromes ?? {}).flat(), ...Object.values(state.browsers).flatMap(record => record.held ?? [])].map(entry => `${filledKey(entry)}\u0000${entry.digest}`))
}

/** Records, under the sessions lock, how each close `closer` sent went (forget). */
export async function settleClaims(lifecycle: Lifecycle, closed: ReadonlyMap<string, boolean>, closer: string): Promise<void> {
  if (closed.size === 0) return
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    forget(state, closed, closer)
  })
}

/**
 * Records how each close `closer` sent went, for a session still marked by it (Codex recheck M1, L3), never one another
 * close marked or a call took since: one that closed is forgotten with the hold its fills left, and one that did not
 * stays marked closing with its hold, for the next start, with no close on its way.
 */
function forget(state: Sessions, closed: ReadonlyMap<string, boolean>, closer: string): void {
  for (const [name, done] of closed) {
    const record = state.browsers[name]
    if (record?.closer?.id !== closer) continue
    if (done) delete state.browsers[name]
    else delete record.closer
  }
}

/** Closes each session in parallel under one bound, so a few stuck daemons cannot hold up the rest. */
export async function closeEach(lifecycle: Lifecycle, names: readonly string[]): Promise<Map<string, boolean>> {
  if (names.length === 0) return new Map()
  const bound = AbortSignal.timeout(CLOSE_TIMEOUT_MS)
  return new Map(await Promise.all(names.map(async name => [name, await lifecycle.close(name, bound)] as const)))
}
