import type { ActionReport, DeniedRunReport } from '@5straps/protocol'

/**
 * Where this node's tool calls are announced: a refusal the moment it happens, and the full
 * action log in batches, per `BUCKLE-D06: Buckle reports the full action log`.
 */
export interface Reporter {
  readonly configured: boolean
  report(report: DeniedRunReport): Promise<void>
  /** Queues one entry for the next batch. Never holds up the call that produced it. */
  record(entry: ActionReport): void
  /** Posts whatever is queued now, and resolves once nothing is left to send. */
  flush(): Promise<void>
}

export const nullReporter: Reporter = {
  configured: false,
  report: () => Promise.resolve(),
  record: () => undefined,
  flush: () => Promise.resolve(),
}
