/** How long a workspace may go without activity before its sessions end: 15 minutes, as the owner ruled. */
export const DEFAULT_SESSION_IDLE_MS = 900_000

/** The windows a workspace or the node may set besides 0, which turns idle ends off: a minute to a day. */
export const SESSION_IDLE_BOUNDS = Object.freeze({ min: 60_000, max: 86_400_000 })

/** Whether a window is one Buckle takes: 0, or milliseconds within the bounds. */
export function isSessionIdle(value: number): boolean {
  return Number.isSafeInteger(value) && (value === 0 || (value >= SESSION_IDLE_BOUNDS.min && value <= SESSION_IDLE_BOUNDS.max))
}

/** A window as typed, in milliseconds, or null where Buckle does not take it. */
export function parseSessionIdle(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,9}$/.test(text)) return null
  const value = Number(text)
  return isSessionIdle(value) ? value : null
}

/**
 * When the newest session grant was made, for a workspace whose activity store holds nothing, as after it was lost: the
 * decision that made it was activity, so an old grant still ends at idle and one just made does not.
 */
export function newestSessionGrant(grants: ReadonlyArray<{ scope: string; createdAt: string }>): number | undefined {
  const made = grants.filter(grant => grant.scope === 'session').map(grant => Date.parse(grant.createdAt))
  return made.length === 0 ? undefined : Math.max(...made)
}

/**
 * The workspace's activity as read now: its newest call start, call end, ask, or decision, and how many instances run a
 * tool; or the store that could not be read, or that another process held busy past its wait.
 */
export type ActivityReading = { lastAt: number | undefined; executing: number } | { unreadable: string } | { busy: string }

/**
 * `active` as of `at`, the latest time the workspace is known active, so a later check within the window need not read.
 * `busy`: the store was busy this time, which says nothing either way, so nothing ends and nothing changes.
 */
export type IdleVerdict = { kind: 'off' } | { kind: 'active'; at: number } | { kind: 'idle' } | { kind: 'unknown'; store: string } | { kind: 'busy'; store: string }

/**
 * Whether the workspace's sessions end now. Off at a window of 0. Active, reading nothing, where this process itself saw
 * activity within the window (`seenAt`); otherwise read: a tool running anywhere, or activity within the window, is active,
 * and anything older, or none ever recorded, is idle.
 */
export function idleVerdict(input: { now: number; idleMs: number; seenAt?: number; read: () => ActivityReading }): IdleVerdict {
  const { now, idleMs, seenAt } = input
  if (idleMs === 0) return { kind: 'off' }
  if (seenAt !== undefined && now - seenAt <= idleMs) return { kind: 'active', at: seenAt }
  const reading = input.read()
  if ('unreadable' in reading) return { kind: 'unknown', store: reading.unreadable }
  if ('busy' in reading) return { kind: 'busy', store: reading.busy }
  if (reading.executing > 0) return { kind: 'active', at: now }
  if (reading.lastAt !== undefined && now - reading.lastAt <= idleMs) return { kind: 'active', at: reading.lastAt }
  return { kind: 'idle' }
}
