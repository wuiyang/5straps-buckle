import type { LogDrops, LogQueueStats } from '@5straps/runtime'
import type { ActionLogEntry } from './action-log.js'

/** One log the service writes: entries of one name share one queue, written in batches by the destination last handed in. */
export interface LogDestination {
  readonly name: string
  write(batch: readonly ActionLogEntry[]): Promise<void>
  /** The entry that says how many of this log's entries were dropped, and when; written ahead of its next batch. */
  dropped(drops: LogDrops): ActionLogEntry
}

/**
 * `untrusted`: a record anyone can make Buckle write, such as the refusal of a caller with no credential or of the
 * agent's own malformed request; it gives way to every other held entry, so a flood of them pushes none of those out.
 */
export interface AppendOptions {
  untrusted?: boolean
}

export interface LogServiceStats {
  /** Entries the process holds under its one budget, the node log's lines included. */
  held: number
  logs: Record<string, LogQueueStats>
}

/**
 * The process's records that nothing waits on, held under its one log budget (log-budget.ts) and written in the
 * background: a full budget drops the oldest, a failed write is tried again, and each log counts its own drops.
 */
export interface LogService {
  /** Returns at once and never throws. */
  append(destination: LogDestination, entry: ActionLogEntry, options?: AppendOptions): void
  /** Resolves once every log has written or dropped what it held. */
  flush(): Promise<void>
  /** Writes what is held until the deadline; what is left is dropped, counted on stderr, and returned. A later append starts again. */
  close(options: { deadlineMs: number }): Promise<{ left: number }>
  stats(): LogServiceStats
}
