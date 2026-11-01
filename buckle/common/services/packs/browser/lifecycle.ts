import { randomUUID } from 'node:crypto'
import type { JsonFileStore } from '../../../adapters/json-file-store.js'
import { printable, workspaceArgument } from '../../../domain/approval-instruction.js'
import { ToolInputError, type FilledSecret, type HeldSecret } from '../../../domain/tool.js'
import { logger } from '../../../runtime/log.js'
import type { BrowserModeName } from './mode.js'
import type { BrowserCloseCounts } from '../../../domain/pack.js'
import { filledKey, isWriter, keyOf, liveSibling, mergeFilled, recordsWhere, sessionKey, stranded, upgradeSessions, type BrowserRecord, type Caller, type Sessions, type Writer } from './sessions.js'

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
}

/** How many filled values one browser is masked by at most. */
const MAX_FILLED = 256

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
 * The session a call runs on (Slice F4, items 3 to 5): its caller's, stage's, and alias's, started under this pack's
 * settings. First, under the lock, every session left with no one to end it (stranded) is claimed, and so is a session
 * of the key started under other settings, or a fresh one last run under another list: each is closed, and a new one
 * named under the same key, so no record is left under the old settings; a live sibling's is left to it. Each value the
 * call fills is held by the session it takes, under the same lock, before the browser is handed it.
 */
export async function takeSession(lifecycle: Lifecycle, input: { scope: CallScope; fills: readonly FilledSecret[] }): Promise<TakenSession> {
  const { store } = lifecycle
  const first = await store.update((state): Taking<TakenSession> | { claims: Claims } => {
    upgradeSessions(state)
    const claims = claimsFor(lifecycle, state, input.scope)
    if (claims.names.length > 0) {
      for (const name of claims.names) state.browsers[name]!.closing = true
      return { claims }
    }
    return taking(() => {
      const taken = take(lifecycle, state, input.scope, input.fills)
      return { ...taken, sibling: taken.sibling || claims.sibling }
    })
  })
  if (!('claims' in first)) return taken(first)
  const { claims } = first
  const closed = await closeEach(lifecycle, claims.names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session Buckle ended before a call did not close; the next start ends it')
  return taken(await store.update((state) => {
    upgradeSessions(state)
    forget(state, closed)
    return taking(() => {
      const taken = take(lifecycle, state, input.scope, input.fills)
      return { ...taken, sibling: taken.sibling || claims.sibling, ...(claims.relaunchedFrom === undefined ? {} : { relaunchedFrom: claims.relaunchedFrom }) }
    })
  }))
}

/** A take, or the refusal it met, which is thrown once the store keeps what the update changed before it. */
type Taking<T> = { taken: T } | { refused: ToolInputError }

function taking<T>(run: () => T): Taking<T> {
  try {
    return { taken: run() }
  } catch (error) {
    if (error instanceof ToolInputError) return { refused: error }
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
 * Takes the call's session and records it as this process's, used now, holding what the call fills. On a profile
 * folder it is the folder's one session, whose name never changes, so one marked closing is taken up again with its
 * hold, as a browser that did not close may still show it; one a live sibling wrote under other settings is reused as
 * it is, as closing it would relaunch Chrome at each call either process makes. Elsewhere it is the key's session from
 * these settings, or a new one. An attached Chrome's fills are its own hold, which no session ends.
 */
function take(lifecycle: Lifecycle, state: Sessions, scope: CallScope, fills: readonly FilledSecret[]): { session: string; sibling: boolean } {
  const now = Date.now()
  const fields = { ...scope.caller, mode: scope.fingerprint, writer: lifecycle.me, usedAt: now, idleTimeoutMs: lifecycle.idleTimeoutMs }
  if (scope.kind === 'attached' && fills.length > 0) {
    // Checked against all the Chrome is masked by, an earlier Buckle's hold included; kept as the Chrome's own.
    withFilled(lifecycle, chromeHold(state, scope.chrome!), fills)
    state.chromes = { ...state.chromes, [scope.chrome!]: mergeFilled(state.chromes?.[scope.chrome!] ?? [], fills) }
  }
  const held = (record: BrowserRecord | undefined) => {
    const kept = withFilled(lifecycle, record?.held ?? [], scope.kind === 'attached' ? [] : fills)
    return kept.length > 0 ? { held: kept } : {}
  }
  if (scope.own !== null) {
    const record = state.browsers[scope.own]
    if (record !== undefined && !record.closing && record.mode !== scope.fingerprint && liveSibling(record, lifecycle.me)) {
      record.usedAt = now
      Object.assign(record, held(record))
      return { session: scope.own, sibling: true }
    }
    state.browsers[scope.own] = { kind: 'profile', ...fields, ...held(record) }
    return { session: scope.own, sibling: false }
  }
  const key = sessionKey(scope.kind, scope.caller)
  const session = recordsWhere(state, record => !record.closing && keyOf(record) === key && record.mode === scope.fingerprint)[0] ?? `buckle-${randomUUID()}`
  // A daemon starts under this list at this call's first command, whether the call then succeeds, fails, or times out,
  // so the list is recorded before it runs: a later change then relaunches it.
  state.browsers[session] = { kind: scope.kind, ...fields, ...(scope.kind === 'fresh' ? { allowedDomains: scope.flag } : {}), ...held(state.browsers[session]) }
  return { session, sibling: false }
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
  const ending = (record: BrowserRecord) => !record.closing && stranded(record, lifecycle.me, now, lifecycle.longestCallMs)
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
 * When the settings change (fix brief 2, R2): each browser the replaced pack started closes, and its record stays for
 * the successor, which at the session's next call closes it again and starts a browser under a new name, saying it was
 * relaunched where the list changed. A browser that closed holds nothing any more.
 */
export async function retireSessions(lifecycle: Lifecycle, names: readonly string[]): Promise<void> {
  const closed = await closeEach(lifecycle, names)
  if ([...closed.values()].includes(false)) logger.warn('A browser session did not close when its settings changed; the next call of its session closes it again')
  const done = [...closed].flatMap(([name, ok]) => (ok ? [name] : []))
  if (done.length === 0) return
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    for (const name of done) delete state.browsers[name]?.held
  })
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

/**
 * The owner's buckle browser close (Slice F4, item 6): under the sessions lock, held all through, so no call starts a
 * browser meanwhile, every recorded session is closed, a live sibling's too, with a bare close in parallel under one
 * bound. Each that closed is forgotten with its hold. One that did not stays marked closing with its hold (Codex review
 * L1), as a profile folder's keeps its name and a call would reach its page again: the next start, or this command, ends
 * it. An attached Chrome's hold is forgotten too.
 */
export async function closeAll(lifecycle: Lifecycle): Promise<BrowserCloseCounts> {
  return lifecycle.store.update(async (state) => {
    upgradeSessions(state)
    const names = Object.keys(state.browsers)
    const before = heldValues(state)
    for (const name of names) state.browsers[name]!.closing = true
    const closed = await closeEach(lifecycle, names)
    forget(state, closed)
    delete state.attached
    delete state.chromes
    const after = heldValues(state)
    const kept = after.size
    return { browsers: names.length, closed: [...closed.values()].filter(Boolean).length, held: [...before].filter(value => !after.has(value)).length, ...(kept > 0 ? { kept } : {}) }
  })
}

/** Every value the workspace's browsers hold, each once, by file, NAME, and digest. */
function heldValues(state: Sessions): Set<string> {
  return new Set([...state.attached ?? [], ...Object.values(state.chromes ?? {}).flat(), ...Object.values(state.browsers).flatMap(record => record.held ?? [])].map(entry => `${filledKey(entry)}\u0000${entry.digest}`))
}

/** Records how each claimed close went: a closed session is forgotten, one that did not close stays marked closing. */
export async function settleClaims(lifecycle: Lifecycle, closed: ReadonlyMap<string, boolean>): Promise<void> {
  if (closed.size === 0) return
  await lifecycle.store.update((state) => {
    upgradeSessions(state)
    forget(state, closed)
  })
}

/** Forgets each closed session still marked closing, and the hold its fills left with it. */
function forget(state: Sessions, closed: ReadonlyMap<string, boolean>): void {
  for (const [name, done] of closed) {
    if (done && state.browsers[name]?.closing === true) delete state.browsers[name]
  }
}

/** Closes each session in parallel under one bound, so a few stuck daemons cannot hold up the rest. */
export async function closeEach(lifecycle: Lifecycle, names: readonly string[]): Promise<Map<string, boolean>> {
  if (names.length === 0) return new Map()
  const bound = AbortSignal.timeout(CLOSE_TIMEOUT_MS)
  return new Map(await Promise.all(names.map(async name => [name, await lifecycle.close(name, bound)] as const)))
}
