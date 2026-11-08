import { idleVerdict, type ActivityReading, type IdleVerdict } from '../../domain/approval/session-idle.js'
import { logger, withoutCause } from '../../runtime/log.js'
import { ACTIVITY_STORE, ActivityBusyError } from '../history/activity.js'
import { isStateBusy } from '../state-busy.js'
import type { ApprovalService } from './approval-service.js'

/** How often an open runtime checks whether its workspace idled past its window, beside the check before each call. */
export const SESSION_SWEEP_MS = 60_000

/**
 * While activity cannot be read, whether session approvals still clear calls: no, so each asks again until it can, while
 * the session's denials bind either way. True keeps them clearing meanwhile.
 */
export const SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN: boolean = false

/**
 * What the idle check names where it cannot read: the history's activity store, the grants it falls back to, the executing
 * marks, or the ledger.
 */
const STORES = Object.freeze({ activity: ACTIVITY_STORE, grants: 'grants.json', marks: 'the active-work marks', ledger: 'the approvals ledger' })

/**
 * One workspace's idle check: its sessions end once it has had no activity for longer than its window. Where activity
 * cannot be read, no session ends, and its session approvals clear no call until it can (SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN).
 */
export interface SessionIdleCheck {
  /** Ends every session of the workspace where it idled past its window. Never throws: a failure counts as unknown activity. */
  check(): Promise<void>
  /** This process saw activity: a call started or ended, an ask, or a decision. */
  saw(): void
  /** Whether session approvals clear no call now, as while activity is unknown. */
  sessionApprovalsSuspended(): boolean
}

export interface SessionIdleInput {
  workspaceId: string
  /** The window in force, in milliseconds; 0 ends no session at idle. */
  idleMs: () => number
  /** The workspace's newest activity, undefined where none was recorded; throws where it cannot be read, ActivityBusyError where busy. */
  lastActivity: () => number | undefined
  /**
   * When the newest session grant was made, the last activity where the activity store holds none, as after it was lost;
   * throws where the grants cannot be read. Absent, a store that holds none reads as idle.
   */
  sessionGrantMade?: () => number | undefined
  /** The instances running a tool in the workspace now; throws where the marks cannot be read. */
  executing: () => readonly string[]
  /** Whether a tool of this runtime runs now. */
  runningHere: () => boolean
  sessions: Pick<ApprovalService, 'endSessions'>
  now?: () => number
}

export function createSessionIdleCheck(input: SessionIdleInput): SessionIdleCheck {
  const clock = input.now ?? Date.now
  // The latest time this process knows the workspace was active, on a chain of checks and its own activity since: within
  // the window of it, nothing is read. Not trusted while activity is unknown, since the session may have ended unseen.
  let seenAt: number | undefined
  let unknown: string | undefined
  let checking: Promise<void> | undefined

  const seen = (now: number): number | undefined => {
    if (unknown !== undefined) return undefined
    return input.runningHere() ? now : seenAt
  }

  const read = (): ActivityReading => {
    let lastAt: number | undefined
    try { lastAt = input.lastActivity() } catch (error) { return error instanceof ActivityBusyError ? { busy: STORES.activity } : { unreadable: STORES.activity } }
    if (lastAt === undefined) {
      try { lastAt = input.sessionGrantMade?.() } catch (error) { return isStateBusy(error) ? { busy: STORES.grants } : { unreadable: STORES.grants } }
    }
    try { return { lastAt, executing: input.executing().length } } catch { return { unreadable: STORES.marks } }
  }

  const verdictNow = (idleMs: number): IdleVerdict => {
    const now = clock()
    return idleVerdict({ now, idleMs, ...withSeen(seen(now)), read })
  }

  function known(at: number): void {
    unknown = undefined
    seenAt = Math.max(seenAt ?? at, at)
  }

  function cannotTell(store: string, error?: unknown): void {
    if (unknown !== store) {
      logger.warn(`Cannot tell whether this workspace is idle, as ${store} cannot be read: no session ends${SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN ? '' : ', and no session approval clears a call until it can'}`, { workspaceId: input.workspaceId, store, ...(error === undefined ? {} : { error: withoutCause(error) }) })
    }
    unknown = store
  }

  function settle(verdict: IdleVerdict): void {
    if (verdict.kind === 'active') known(verdict.at)
    else if (verdict.kind === 'unknown') cannotTell(verdict.store)
    else if (verdict.kind === 'off') unknown = undefined
    else if (verdict.kind === 'busy') logger.debug(`Skipped the idle check this time, as another process held ${verdict.store} busy`, { workspaceId: input.workspaceId, store: verdict.store })
  }

  /**
   * Read again under the approvals lock: a call or a tool that started since the first read keeps every session. A lock
   * another process held past its wait only skips this check, as a busy read does.
   */
  async function endIdle(idleMs: number): Promise<void> {
    let again: IdleVerdict = { kind: 'idle' }
    try {
      await input.sessions.endSessions({ ending: { allSessions: true }, cause: 'idle', due: () => { again = verdictNow(idleMs); return again.kind === 'idle' } })
    } catch (error) {
      if (isStateBusy(error)) settle({ kind: 'busy', store: STORES.ledger })
      else cannotTell(STORES.ledger, error)
      return
    }
    if (again.kind === 'idle') known(clock())
    else settle(again)
  }

  async function run(): Promise<void> {
    const idleMs = input.idleMs()
    const verdict = verdictNow(idleMs)
    if (verdict.kind === 'idle') await endIdle(idleMs)
    else settle(verdict)
  }

  return {
    check() {
      checking ??= run().finally(() => { checking = undefined })
      return checking
    },
    saw() {
      const now = clock()
      // Only a chain still within the window goes on: activity after a gap waits for a check to read the gap first.
      if (unknown === undefined && seenAt !== undefined && now - seenAt <= input.idleMs()) seenAt = now
    },
    sessionApprovalsSuspended: () => unknown !== undefined && !SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN,
  }
}

function withSeen(seenAt: number | undefined): { seenAt?: number } {
  return seenAt === undefined ? {} : { seenAt }
}
