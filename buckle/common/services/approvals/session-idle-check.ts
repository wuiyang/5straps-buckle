import { idleVerdict, type ActivityReading, type IdleVerdict } from '../../domain/approval/session-idle.js'
import { holderKey, type GrantHolder } from '../../domain/permission/grant-holder.js'
import { logger, withoutCause } from '../../runtime/log.js'
import { ACTIVITY_STORE, ActivityBusyError } from '../history/activity.js'
import { isStateBusy } from '../state-busy.js'
import type { ApprovalService } from './approval-service.js'

/** How often an open runtime checks whether its workspace's sessions idled past their window, beside the check before each call. */
export const SESSION_SWEEP_MS = 60_000

/**
 * While a session's activity cannot be read, whether its session approvals still clear calls: no, so each asks again until
 * it can, while the session's denials bind either way. True keeps them clearing meanwhile.
 */
export const SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN: boolean = false

/**
 * What the idle check names where it cannot read: the history's activity store, the grants it falls back to, the executing
 * marks, or the ledger.
 */
const STORES = Object.freeze({ activity: ACTIVITY_STORE, grants: 'grants.json', marks: 'the active-work marks', ledger: 'the approvals ledger' })

/**
 * One workspace's idle check: each of its sessions, its id under its actor, ends once it has had no activity of its own for
 * longer than the window, while the others keep theirs; an ask of it still waiting for a person is activity until it is
 * answered, withdrawn, or lapses. Where a session's activity cannot be read, it does not end, and its session approvals
 * clear no call until it can (SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN).
 */
export interface SessionIdleCheck {
  /**
   * Ends the session where it idled past its window, as before one of its calls; without one, every session the workspace
   * holds anything of that did. Never throws: a failure counts as unknown activity.
   */
  check(session?: GrantHolder): Promise<void>
  /** This process saw the session's activity: one of its calls started or ended, an ask, or a decision. */
  saw(session: GrantHolder): void
  /** Whether the session's approvals clear no call now, as while its activity is unknown. */
  sessionApprovalsSuspended(session: GrantHolder): boolean
}

export interface SessionIdleInput {
  workspaceId: string
  /** The window in force, in milliseconds; 0 ends no session at idle. */
  idleMs: () => number
  /** The session's newest activity, undefined where none was recorded; throws where it cannot be read, ActivityBusyError where busy. */
  lastActivity: (session: GrantHolder) => number | undefined
  /**
   * When the session's newest session grant was made, its last activity where the activity store holds none of it, as
   * after it was lost; throws where the grants cannot be read. Absent, a session the store holds none of reads as idle.
   */
  sessionGrantMade?: (session: GrantHolder) => number | undefined
  /**
   * The sessions whose tools run, or whose calls are held for an answer, in the workspace now, in any process (`running`),
   * and those a mark names that went stale while the process that wrote it still runs (`stalled`), which skip this check;
   * throws where the marks cannot be read.
   */
  executing: () => { running: readonly GrantHolder[]; stalled: readonly GrantHolder[] }
  /** The sessions with an ask still waiting for a person, held by a call or not; throws where the ledger cannot be read. */
  asking: () => readonly GrantHolder[]
  /** Whether a tool of the session runs, or a call of it is held for an answer, in this runtime now. */
  runningHere: (session: GrantHolder) => boolean
  /** The sessions that hold anything an end removes; throws where neither the ledger nor the grants can be read. */
  held: () => readonly GrantHolder[]
  sessions: Pick<ApprovalService, 'endSessions'>
  now?: () => number
}

/** The sweep's turn among the checks this process runs at once, beside each session's own. */
const SWEEP = 'sweep'

export function createSessionIdleCheck(input: SessionIdleInput): SessionIdleCheck {
  const clock = input.now ?? Date.now
  // The latest time this process knows each session was active, on a chain of checks and its activity since: within the
  // window of it, nothing is read. Not trusted while its activity is unknown, since the session may have ended unseen.
  const seenAt = new Map<string, number>()
  // The sessions whose activity could not be read, each with the store that failed.
  const unknown = new Map<string, string>()
  // The store last warned of, said once until no session's activity is unknown.
  let warned: string | undefined
  const checking = new Map<string, Promise<void>>()

  const seen = (session: GrantHolder, now: number): number | undefined => {
    const key = holderKey(session)
    if (unknown.has(key)) return undefined
    return input.runningHere(session) ? now : seenAt.get(key)
  }

  // The marks and the asks are read once per check, whatever number of sessions it reads.
  const readerOf = (): ((session: GrantHolder) => ActivityReading) => {
    let marked: { running: ReadonlySet<string>; stalled: ReadonlySet<string> } | undefined
    let asking: ReadonlySet<string> | undefined
    return (session) => {
      let lastAt: number | undefined
      try { lastAt = input.lastActivity(session) } catch (error) { return error instanceof ActivityBusyError ? { busy: STORES.activity } : { unreadable: STORES.activity } }
      if (lastAt === undefined) {
        try { lastAt = input.sessionGrantMade?.(session) } catch (error) { return isStateBusy(error) ? { busy: STORES.grants } : { unreadable: STORES.grants } }
      }
      try {
        if (marked === undefined) {
          const { running, stalled } = input.executing()
          marked = { running: new Set(running.map(holderKey)), stalled: new Set(stalled.map(holderKey)) }
        }
      } catch { return { unreadable: STORES.marks } }
      try { asking ??= new Set(input.asking().map(holderKey)) } catch (error) { return isStateBusy(error) ? { busy: STORES.ledger } : { unreadable: STORES.ledger } }
      const key = holderKey(session)
      const executing = marked.running.has(key) ? 1 : 0
      const waiting = asking.has(key)
      // A mark whose process stalled says nothing either way of its sessions, so the check skips them this time.
      if (executing === 0 && !waiting && marked.stalled.has(key)) return { busy: STORES.marks }
      return { lastAt, executing, ...(waiting ? { waiting: true as const } : {}) }
    }
  }

  const verdictOf = (session: GrantHolder, idleMs: number, read: (session: GrantHolder) => ActivityReading): IdleVerdict => {
    const now = clock()
    const at = seen(session, now)
    return idleVerdict({ now, idleMs, ...(at === undefined ? {} : { seenAt: at }), read: () => read(session) })
  }

  function known(session: GrantHolder, at: number): void {
    const key = holderKey(session)
    unknown.delete(key)
    if (unknown.size === 0) warned = undefined
    seenAt.set(key, Math.max(seenAt.get(key) ?? at, at))
  }

  function cannotTell(store: string, error?: unknown): void {
    if (warned === store) return
    warned = store
    logger.warn(`Cannot tell whether this workspace's sessions are idle, as ${store} cannot be read: no session ends${SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN ? '' : ', and no session approval clears a call until it can'}`, { workspaceId: input.workspaceId, store, ...(error === undefined ? {} : { error: withoutCause(error) }) })
  }

  function settle(session: GrantHolder, verdict: IdleVerdict): void {
    if (verdict.kind === 'active') known(session, verdict.at)
    else if (verdict.kind === 'unknown') {
      unknown.set(holderKey(session), verdict.store)
      cannotTell(verdict.store)
    } else if (verdict.kind === 'off') unknown.delete(holderKey(session))
    else if (verdict.kind === 'busy') logger.debug(`Skipped the idle check this time, as another process held ${verdict.store} busy`, { workspaceId: input.workspaceId, store: verdict.store })
  }

  /**
   * Read again under the approvals lock: a call or a tool of a session that started since the first read keeps it. A lock
   * another process held past its wait only skips this check, as a busy read does.
   */
  async function endIdle(idle: GrantHolder[], idleMs: number): Promise<void> {
    const again = new Map<string, IdleVerdict>()
    const read = readerOf()
    try {
      await input.sessions.endSessions({
        ending: { sessions: idle },
        cause: 'idle',
        due: (session) => {
          const verdict = verdictOf(session, idleMs, read)
          again.set(holderKey(session), verdict)
          return verdict.kind === 'idle'
        },
      })
    } catch (error) {
      if (isStateBusy(error)) logger.debug(`Skipped the idle check this time, as another process held ${STORES.ledger} busy`, { workspaceId: input.workspaceId, store: STORES.ledger })
      else {
        for (const session of idle) unknown.set(holderKey(session), STORES.ledger)
        cannotTell(STORES.ledger, error)
      }
      return
    }
    for (const session of idle) {
      const verdict = again.get(holderKey(session)) ?? { kind: 'idle' }
      if (verdict.kind === 'idle') known(session, clock())
      else settle(session, verdict)
    }
  }

  async function checkSessions(sessions: readonly GrantHolder[]): Promise<void> {
    const idleMs = input.idleMs()
    const read = readerOf()
    const idle: GrantHolder[] = []
    for (const session of sessions) {
      const verdict = verdictOf(session, idleMs, read)
      if (verdict.kind === 'idle') idle.push(session)
      else settle(session, verdict)
    }
    if (idle.length > 0) await endIdle(idle, idleMs)
  }

  async function sweep(): Promise<void> {
    let held: readonly GrantHolder[]
    try { held = input.held() } catch (error) {
      if (!isStateBusy(error)) cannotTell(STORES.ledger, error)
      return
    }
    forgetStale(held)
    await checkSessions(held)
  }

  /** Drops what this process kept of sessions that hold nothing now and that it saw no activity of within the window. */
  function forgetStale(held: readonly GrantHolder[]): void {
    const holding = new Set(held.map(holderKey))
    const now = clock()
    const idleMs = input.idleMs()
    for (const [key, at] of seenAt) if (!holding.has(key) && now - at > idleMs) seenAt.delete(key)
    for (const key of unknown.keys()) if (!holding.has(key)) unknown.delete(key)
  }

  function once(key: string, run: () => Promise<void>): Promise<void> {
    const running = checking.get(key)
    if (running !== undefined) return running
    const started = run().finally(() => { checking.delete(key) })
    checking.set(key, started)
    return started
  }

  return {
    check(session) {
      if (session === undefined) return once(SWEEP, sweep)
      return once(holderKey(session), () => checkSessions([session]))
    },
    saw(session) {
      const key = holderKey(session)
      const now = clock()
      const at = seenAt.get(key)
      // Only a chain still within the window goes on: activity after a gap waits for a check to read the gap first.
      if (!unknown.has(key) && at !== undefined && now - at <= input.idleMs()) seenAt.set(key, now)
    },
    sessionApprovalsSuspended: session => unknown.has(holderKey(session)) && !SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN,
  }
}
