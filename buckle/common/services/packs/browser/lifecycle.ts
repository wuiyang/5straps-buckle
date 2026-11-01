import { randomUUID } from 'node:crypto'
import type { JsonFileStore } from '../../../adapters/json-file-store.js'
import { logger } from '../../../runtime/log.js'
import type { BrowserModeName } from './mode.js'
import { isWriter, keyOf, liveSibling, recordsWhere, sessionKey, stranded, upgradeSessions, type Caller, type Sessions, type Writer } from './sessions.js'

/** Who a call is for, and what its browser is started with, which a session it takes must have been started under. */
export interface CallScope {
  kind: BrowserModeName
  caller: Caller
  /** modeFingerprint of the pack's settings. */
  fingerprint: string
  /** The profile folder's one session, which every caller shares; null in the other modes. */
  own: string | null
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
  /** Run under the lock after sessions are forgotten, so the hold their fills left can end with them. */
  forgotten(state: Sessions): void
}

/** How long the closes before a call, or at shutdown, wait for the daemons, all of them together. */
export const CLOSE_TIMEOUT_MS = 5_000

/** The session a call runs on, and why it changed: the list a relaunched one last ran with, or a sibling's settings. */
export interface TakenSession {
  session: string
  /** The --allowed-domains a session closed for this call last ran with, null for none; absent where none was. */
  relaunchedFrom?: string | null
  /** A live Buckle process on other settings holds the key: its session is left running. */
  sibling: boolean
}

interface Claims { names: string[]; relaunchedFrom?: string | null; sibling: boolean }

/**
 * The session a call runs on (Slice F4, items 3 and 4): its caller's, stage's, and alias's, started under this pack's
 * settings. First, under the lock, every session left with no one to end it (stranded) is claimed, and so is a session
 * of the key started under other settings, or a fresh one last run under another list: each is closed, and a new one
 * named under the same key, so no record is left under the old settings; a live sibling's is left to it. Each value the
 * call fills is recorded under the same lock as the session, before the browser is handed it.
 */
export async function takeSession(lifecycle: Lifecycle, input: { scope: CallScope; record: (state: Sessions) => void }): Promise<TakenSession> {
  const { store } = lifecycle
  const first = await store.update((state): { taken: TakenSession } | { claims: Claims } => {
    upgradeSessions(state)
    input.record(state)
    const claims = claimsFor(lifecycle, state, input.scope)
    if (claims.names.length > 0) {
      for (const name of claims.names) state.browsers[name]!.closing = true
      return { claims }
    }
    const taken = take(lifecycle, state, input.scope)
    return { taken: { ...taken, sibling: taken.sibling || claims.sibling } }
  })
  if ('taken' in first) return first.taken
  const { claims } = first
  const closed = await closeEach(lifecycle, claims.names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session Buckle ended before a call did not close; the next start ends it')
  return store.update((state) => {
    upgradeSessions(state)
    forget(lifecycle, state, closed)
    const taken = take(lifecycle, state, input.scope)
    return { ...taken, sibling: taken.sibling || claims.sibling, ...(claims.relaunchedFrom === undefined ? {} : { relaunchedFrom: claims.relaunchedFrom }) }
  })
}

/**
 * The sessions to close before a call runs: every stranded one, whatever its key; and of the call's key, one started
 * under other settings that no live sibling holds, and a fresh one last run under another list, as a daemon keeps the
 * list it was launched with (fix brief 4, finding 9).
 */
function claimsFor(lifecycle: Lifecycle, state: Sessions, scope: CallScope): Claims {
  const key = sessionKey(scope.kind, scope.caller)
  const now = Date.now()
  const names: string[] = []
  let relaunchedFrom: string | null | undefined
  let sibling = false
  for (const [name, record] of Object.entries(state.browsers)) {
    if (record.closing) continue
    if (stranded(record, lifecycle.me, now, lifecycle.longestCallMs)) {
      names.push(name)
      continue
    }
    if (keyOf(record) !== key) continue
    // On a profile folder the key is every caller's: another folder's session is replaced as other settings are.
    if (record.mode !== scope.fingerprint || (scope.own !== null && name !== scope.own)) {
      if (liveSibling(record, lifecycle.me)) sibling = true
      else names.push(name)
    } else if (scope.kind === 'fresh' && record.allowedDomains !== undefined && record.allowedDomains !== scope.flag) {
      names.push(name)
      relaunchedFrom = record.allowedDomains
    }
  }
  return { names, sibling, ...(relaunchedFrom === undefined ? {} : { relaunchedFrom }) }
}

/**
 * Takes the call's session and records it as this process's, used now. On a profile folder it is the folder's one
 * session, whose name never changes, so one marked closing is taken up again; one a live sibling wrote under other
 * settings is reused as it is, as closing it would relaunch Chrome at each call either process makes. Elsewhere it is
 * the key's session from these settings, or a new one.
 */
function take(lifecycle: Lifecycle, state: Sessions, scope: CallScope): { session: string; sibling: boolean } {
  const now = Date.now()
  const fields = { ...scope.caller, mode: scope.fingerprint, writer: lifecycle.me, usedAt: now, idleTimeoutMs: lifecycle.idleTimeoutMs }
  if (scope.own !== null) {
    const record = state.browsers[scope.own]
    if (record !== undefined && !record.closing && record.mode !== scope.fingerprint && liveSibling(record, lifecycle.me)) {
      record.usedAt = now
      return { session: scope.own, sibling: true }
    }
    state.browsers[scope.own] = { kind: 'profile', ...fields }
    return { session: scope.own, sibling: false }
  }
  const key = sessionKey(scope.kind, scope.caller)
  const session = recordsWhere(state, record => !record.closing && keyOf(record) === key && record.mode === scope.fingerprint)[0] ?? `buckle-${randomUUID()}`
  // A daemon starts under this list at this call's first command, whether the call then succeeds, fails, or times out,
  // so the list is recorded before it runs: a later change then relaunches it.
  state.browsers[session] = { kind: scope.kind, ...fields, ...(scope.kind === 'fresh' ? { allowedDomains: scope.flag } : {}) }
  return { session, sibling: false }
}

/**
 * An agent's close: every session of its key, except one a live sibling holds under other settings, which the caller
 * closes under its own timeout; and every stranded session, as before any call. Its own are empty where the key records
 * none, so nothing of the caller's runs.
 */
export async function claimCaller(lifecycle: Lifecycle, scope: CallScope): Promise<{ own: string[]; stranded: string[] }> {
  return lifecycle.store.update((state) => {
    upgradeSessions(state)
    const key = sessionKey(scope.kind, scope.caller)
    const now = Date.now()
    const own = scope.own !== null
      ? (state.browsers[scope.own] === undefined ? [] : [scope.own])
      : recordsWhere(state, record => !record.closing && keyOf(record) === key && !(record.mode !== scope.fingerprint && liveSibling(record, lifecycle.me)))
    const left = recordsWhere(state, (record, name) => !record.closing && !own.includes(name) && stranded(record, lifecycle.me, now, lifecycle.longestCallMs))
    for (const name of [...own, ...left]) state.browsers[name]!.closing = true
    return { own, stranded: left }
  })
}

/**
 * At pack start (Slice F4, item 4): ends every session left with no one to end it, a stopped writer's, one past its
 * idle timeout, or one a close failed for, with a bare close, then forgets it. One whose close fails again stays marked
 * closing, for the next start. An earlier Buckle's store is taken up here too, its sessions last used at an unknown
 * time, so each is ended.
 */
export async function endStranded(lifecycle: Lifecycle): Promise<void> {
  const now = Date.now()
  const left = (state: Sessions) => recordsWhere(state, record => record.closing === true || stranded(record, lifecycle.me, now, lifecycle.longestCallMs))
  const seen = lifecycle.store.read()
  upgradeSessions(seen)
  if (left(seen).length === 0) return
  const names = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const names = left(state)
    for (const name of names) state.browsers[name]!.closing = true
    return names
  })
  const closed = await closeEach(lifecycle, names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session a stopped Buckle process left did not close; the next start ends it')
  await settleClaims(lifecycle, closed)
}

/**
 * At shutdown (Slice F4, item 4): closes every session this process wrote, whichever pack started it and in whichever
 * mode, a profile folder's too, and forgets each that closed; one that did not stays marked closing, for the next start.
 */
export async function closeWritten(lifecycle: Lifecycle): Promise<void> {
  if (recordsWhere(lifecycle.store.read(), record => isWriter(record, lifecycle.me)).length === 0) return
  const names = await lifecycle.store.update((state) => {
    upgradeSessions(state)
    const names = recordsWhere(state, record => isWriter(record, lifecycle.me))
    for (const name of names) state.browsers[name]!.closing = true
    return names
  })
  const closed = await closeEach(lifecycle, names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session did not close at shutdown; the next start ends it')
  await settleClaims(lifecycle, closed)
}

/** Records how each claimed close went: a closed session is forgotten, one that did not close stays marked closing. */
export async function settleClaims(lifecycle: Lifecycle, closed: ReadonlyMap<string, boolean>): Promise<void> {
  if (closed.size === 0) return
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    forget(lifecycle, state, closed)
  })
}

/** Forgets each closed session still marked closing, then lets the hold its fills left end with it. */
function forget(lifecycle: Lifecycle, state: Sessions, closed: ReadonlyMap<string, boolean>): void {
  for (const [name, done] of closed) {
    if (done && state.browsers[name]?.closing === true) delete state.browsers[name]
  }
  lifecycle.forgotten(state)
}

/** Closes each session in parallel under one bound, so a few stuck daemons cannot hold up the rest. */
export async function closeEach(lifecycle: Lifecycle, names: readonly string[]): Promise<Map<string, boolean>> {
  if (names.length === 0) return new Map()
  const bound = AbortSignal.timeout(CLOSE_TIMEOUT_MS)
  return new Map(await Promise.all(names.map(async name => [name, await lifecycle.close(name, bound)] as const)))
}
