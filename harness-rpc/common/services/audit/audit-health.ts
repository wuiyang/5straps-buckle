import { logger } from '../../runtime/log.js'
import type { AuditHealth } from '../../types/ports/action-log.js'

/** How often readiness may probe a failing log again: a supervisor polling every second probes it at this pace. */
export const AUDIT_PROBE_INTERVAL_MS = 2_000

/**
 * Health per log (review M2 of B18-B19): one workspace's broken log keeps the node out of rotation
 * however many other logs write, and a repaired log is seen through readiness polls alone.
 */
export function createAuditHealth(options: { now?: () => number; probeIntervalMs?: number } = {}): AuditHealth {
  const now = options.now ?? Date.now
  const interval = options.probeIntervalMs ?? AUDIT_PROBE_INTERVAL_MS
  // Each failing log with the probe that tries it again.
  const failing = new Map<string, () => void>()
  let probedAt = -Infinity
  return {
    get available() { return failing.size === 0 },
    failing: log => failing.has(log),
    succeeded: (log) => { failing.delete(log) },
    failed: (log, probe) => { failing.set(log, probe) },
    recheck() {
      if (failing.size === 0 || now() - probedAt < interval) return
      probedAt = now()
      for (const [log, probe] of failing) {
        try {
          probe()
          failing.delete(log)
          logger.info('The audit log takes writes again', { log })
        } catch {
          // Still failing; the write that marked it logged the cause.
        }
      }
    },
  }
}
