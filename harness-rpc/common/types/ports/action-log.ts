import type { JsonValue } from '@5straps/protocol'

/** One attempted tool call, recorded whether it ran, was gated, or failed. */
export interface ActionLogEntry {
  auditId?: string
  event?: 'attempt' | 'result'
  workspaceId?: string
  runId?: string
  stageId?: string
  chatId?: string
  projectId?: string
  actorId?: string
  agentId?: string
  at: string
  requestId: string
  sessionId: string
  tool: string
  outcome: 'interrupted' | 'started' | 'ok' | 'error' | 'denied' | 'approval_required'
  durationMs: number
  /** What the call actually touched, after symlinks were resolved. */
  effects: string[]
  args: JsonValue
  /** Gates that stopped the call, as `rule:subject`. */
  asked?: string[]
  /** Grants that let the call through, as `rule:subject`. */
  approvedBy?: string[]
  /** The enrolled keys (key:<fingerprint>) whose `once` decisions the call spent. */
  decidedBy?: string[]
  detail?: string
}

export interface ActionLog {
  /** Resolves once the entry is durable; a rejection means execution must not continue. */
  record(entry: ActionLogEntry): Promise<void>
  recoverInterrupted(): Promise<number>
  /** Most recent entries last, so the tail of the file reads in the order things happened. */
  read(limit: number): ActionLogEntry[]
  page(input: { limit: number; before?: number }): { entries: ActionLogEntry[]; nextCursor: string | null }
}

/**
 * Whether the node's audit logs take their writes, for readiness and the owner's status (B19). One
 * per process, shared by every workspace's log, and kept per log: the node is ready while no log
 * fails (review M2 of B18-B19).
 */
export interface AuditHealth {
  /** No log's last write, or last probe, failed. */
  readonly available: boolean
  failing(log: string): boolean
  /** When the log last failed a write or a probe in this process, as an ISO time; null when it never has (review M4 of B20-B22). */
  lastFailureAt(log: string): string | null
  /** The workspaces whose logs fail now (review L5 of B20-B22). */
  failingWorkspaces(): string[]
  succeeded(log: string): void
  /** `probe` tries what a write needs without writing an entry, and rejects while that still fails. */
  failed(log: string, input: { probe: () => Promise<void>; workspaceId: string }): void
  /** Stops counting a log, whose workspace was retired or disabled (review L5 of B20-B22). */
  forget(log: string): void
  /** Probes each failing log, at most once per interval; a probe that succeeds clears its log. */
  recheck(): Promise<void>
}
