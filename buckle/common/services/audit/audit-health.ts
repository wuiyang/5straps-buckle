import { logger } from '../../runtime/log.js'
import type { AuditHealth } from '../../types/ports/action-log.js'

/** How often readiness may probe a failing log again: a supervisor polling every second probes it at this pace. */
export const AUDIT_PROBE_INTERVAL_MS = 2_000

interface Failing { probe: () => Promise<void>; workspaceId: string }

/**
 * Health per log (review M2 of B18-B19): one workspace's broken log keeps the node out of rotation
 * however many other logs write, and a repaired log is seen through readiness polls alone. The last
 * failure time of each log stays after a repair, for the owner's status (review M4 of B20-B22).
 */
export function createAuditHealth(options: { now?: () => number; probeIntervalMs?: number } = {}): AuditHealth {
  const now = options.now ?? Date.now
  const interval = options.probeIntervalMs ?? AUDIT_PROBE_INTERVAL_MS
  const failing = new Map<string, Failing>()
  const lastFailure = new Map<string, number>()
  let probedAt = -Infinity
  let probing: Promise<void> | undefined

  async function probeAll(): Promise<void> {
    await Promise.all([...failing].map(([log, entry]) => probeOne(log, entry)))
  }

  async function probeOne(log: string, entry: Failing): Promise<void> {
    try {
      await entry.probe()
      if (failing.get(log) === entry) failing.delete(log)
      logger.info('The audit log takes writes again', { log })
    } catch {
      // Still failing; the write that marked it logged the cause.
      lastFailure.set(log, now())
    }
  }

  return {
    get available() { return failing.size === 0 },
    failing: log => failing.has(log),
    lastFailureAt: (log) => {
      const at = lastFailure.get(log)
      return at === undefined ? null : new Date(at).toISOString()
    },
    failingWorkspaces: () => [...new Set([...failing.values()].map(entry => entry.workspaceId))].sort(),
    succeeded: (log) => { failing.delete(log) },
    failed: (log, input) => {
      failing.set(log, input)
      lastFailure.set(log, now())
    },
    forget: (log) => { failing.delete(log) },
    recheck() {
      if (probing) return probing
      if (failing.size === 0 || now() - probedAt < interval) return Promise.resolve()
      probedAt = now()
      probing = probeAll().finally(() => { probing = undefined })
      return probing
    },
  }
}
