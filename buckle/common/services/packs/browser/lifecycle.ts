import { randomUUID } from 'node:crypto'
import type { JsonFileStore } from '../../../adapters/json-file-store.js'
import { logger } from '../../../runtime/log.js'
import type { BrowserModeName } from './mode.js'
import { keyOf, liveSibling, recordsWhere, sessionKey, upgradeSessions, type Caller, type Sessions, type Writer } from './sessions.js'

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
  /** Sends one bare close, as shutdown does: whether it closed. */
  close(session: string, signal: AbortSignal): Promise<boolean>
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

/**
 * The session a call runs on (Slice F4, item 3): its caller's, stage's, and alias's, started under this pack's
 * settings. A session of the key started under other settings, or a fresh one last run under another list, is closed
 * first and a new one named under the same key, so no record is left under the old settings; a live sibling's is left
 * to it. Each value the call fills is recorded under the same lock, before the browser is handed it.
 */
export async function takeSession(lifecycle: Lifecycle, input: { scope: CallScope; now: number; record: (state: Sessions) => void }): Promise<TakenSession> {
  const { store, me } = lifecycle
  const first = await store.update((state): { taken: TakenSession } | { claims: Claims } => {
    upgradeSessions(state)
    input.record(state)
    const claims = claimsFor(state, input.scope, me)
    if (claims.names.length > 0) {
      for (const name of claims.names) state.browsers[name]!.closing = true
      return { claims }
    }
    const taken = take(state, input.scope, me, input.now)
    return { taken: { ...taken, sibling: taken.sibling || claims.sibling } }
  })
  if ('taken' in first) return first.taken
  const { claims } = first
  const closed = await closeEach(lifecycle, claims.names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session from other settings did not close; its idle timeout ends it')
  return store.update((state) => {
    upgradeSessions(state)
    forget(state, closed)
    const taken = take(state, input.scope, me, input.now)
    return { ...taken, sibling: taken.sibling || claims.sibling, ...(claims.relaunchedFrom === undefined ? {} : { relaunchedFrom: claims.relaunchedFrom }) }
  })
}

interface Claims { names: string[]; relaunchedFrom?: string | null; sibling: boolean }

/**
 * The sessions of a call's key to close before it runs: one started under other settings that no live sibling holds,
 * and a fresh one last run under another list, as a daemon keeps the list it was launched with (fix brief 4, finding 9).
 */
function claimsFor(state: Sessions, scope: CallScope, me: Writer): Claims {
  const key = sessionKey(scope.kind, scope.caller)
  const names: string[] = []
  let relaunchedFrom: string | null | undefined
  let sibling = false
  for (const [name, record] of Object.entries(state.browsers)) {
    if (record.closing || keyOf(record) !== key) continue
    // On a profile folder the key is every caller's: another folder's session is replaced as other settings are.
    if (record.mode !== scope.fingerprint || (scope.own !== null && name !== scope.own)) {
      if (liveSibling(record, me)) sibling = true
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
 * session; one a live sibling wrote under other settings is reused as it is, as closing it would relaunch Chrome at
 * each call either process makes. Elsewhere it is the key's session from these settings, or a new one.
 */
function take(state: Sessions, scope: CallScope, me: Writer, now: number): { session: string; sibling: boolean } {
  const fields = { ...scope.caller, mode: scope.fingerprint, writer: me, usedAt: now }
  if (scope.own !== null) {
    const record = state.browsers[scope.own]
    if (record !== undefined && !record.closing && record.mode !== scope.fingerprint && liveSibling(record, me)) {
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
 * An agent's close: every session of its key, closed with the call's own timeout, except one a live sibling holds
 * under other settings. Null where the key records none, so nothing runs.
 */
export async function claimCaller(lifecycle: Lifecycle, scope: CallScope): Promise<string[]> {
  return lifecycle.store.update((state) => {
    upgradeSessions(state)
    const key = sessionKey(scope.kind, scope.caller)
    const names = scope.own !== null
      ? (state.browsers[scope.own] === undefined ? [] : [scope.own])
      : recordsWhere(state, record => !record.closing && keyOf(record) === key && !(record.mode !== scope.fingerprint && liveSibling(record, lifecycle.me)))
    for (const name of names) state.browsers[name]!.closing = true
    return names
  })
}

/** Records how each claimed close went: a closed session is forgotten, one that did not close is taken up again. */
export async function settleClaims(lifecycle: Lifecycle, closed: ReadonlyMap<string, boolean>, after?: (state: Sessions) => void): Promise<void> {
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    forget(state, closed)
    after?.(state)
  })
}

/** Forgets each closed session still marked closing; one that did not close is marked closing no more. */
function forget(state: Sessions, closed: ReadonlyMap<string, boolean>): void {
  for (const [name, done] of closed) {
    const record = state.browsers[name]
    if (record?.closing !== true) continue
    if (done) delete state.browsers[name]
    else delete record.closing
  }
}

/** Closes each session in parallel under one bound, so a few stuck daemons cannot hold up the rest. */
export async function closeEach(lifecycle: Lifecycle, names: readonly string[]): Promise<Map<string, boolean>> {
  const bound = AbortSignal.timeout(CLOSE_TIMEOUT_MS)
  return new Map(await Promise.all(names.map(async name => [name, await lifecycle.close(name, bound)] as const)))
}

