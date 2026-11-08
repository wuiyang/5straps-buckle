import { createLogBudget } from '@5straps/runtime'

/**
 * Every log a Buckle process writes shares one bound: at most this many entries held in memory, waiting or being
 * written, across the node log and every other log on the budget. When another arrives, the oldest not yet handed to
 * its writer drops.
 */
export const LOG_HOLD_LIMIT = 30

/** A failed write is tried again after each of these waits; then its entries drop and are counted. */
export const LOG_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000]

/** How long a closing process waits for its logs to drain; what is left is counted on stderr. */
export const LOG_CLOSE_DEADLINE_MS = 2_000

export const processLogBudget = createLogBudget({ limit: LOG_HOLD_LIMIT, overflow: 'drop-oldest' })
