import { createLogBudget } from '@5straps/runtime'

/**
 * Every log a Buckle process writes shares one bound: at most this many entries waiting or being written, across the
 * node log and every other log on the budget. When another arrives, the oldest not with its writer drops; an entry whose
 * write is past LOG_WRITE_DEADLINE_MS counts as not with it, and once dropped leaves the count, though its writer holds
 * it until the disk answers: beyond the limit, at most one batch per log (LOG_BATCH_LIMIT entries and a drop count, each
 * at most 64 KiB). The records a call waits for are not on the budget; MAX_WAITING_WRITES bounds those.
 */
export const LOG_HOLD_LIMIT = 30

/** A failed write is tried again after each of these waits; then its entries drop and are counted. */
export const LOG_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000]

/** A write unanswered by then counts as failed, so a stalled disk cannot keep newer entries out of the budget. */
export const LOG_WRITE_DEADLINE_MS = 1_000

/** At most this many entries of one log go to its writer at once, so one stalled log never holds the whole budget. */
export const LOG_BATCH_LIMIT = 10

/**
 * Whether the owner's own changes (cli_* commands, the dangerously-allow switch, setup and registry changes) wait for their
 * attempt's record. False: a broken log never stops one. True: each attempt is recorded before its change runs, so a broken
 * log stops the change, as it stops an agent's call.
 */
export const OWNER_RECORDS_WAIT: boolean = false

/** How long a closing process waits for its logs to drain; what is left is counted on stderr. */
export const LOG_CLOSE_DEADLINE_MS = 2_000

export const processLogBudget = createLogBudget({ limit: LOG_HOLD_LIMIT, overflow: 'drop-oldest' })

/** What every log queue of the process takes; the logger writes one line at a time to each sink. */
export const PROCESS_LOG_QUEUE = { budget: processLogBudget, retryDelaysMs: LOG_RETRY_DELAYS_MS, writeDeadlineMs: LOG_WRITE_DEADLINE_MS, maxBatch: LOG_BATCH_LIMIT } as const
