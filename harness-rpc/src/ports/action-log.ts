import type { JsonValue } from '@5straps/protocol'

/** One attempted tool call, recorded whether it ran, was gated, or failed. */
export interface ActionLogEntry {
  auditId?: string
  event?: 'attempt' | 'result'
  workspaceId?: string
  runId?: string
  stageId?: string
  at: string
  requestId: string
  sessionId: string
  tool: string
  outcome: 'started' | 'ok' | 'error' | 'denied' | 'approval_required'
  durationMs: number
  /** What the call actually touched, after symlinks were resolved. */
  effects: string[]
  args: JsonValue
  /** Gates that stopped the call, as `rule:subject`. */
  asked?: string[]
  /** Grants that let the call through, as `rule:subject`. */
  approvedBy?: string[]
  detail?: string
}

export interface ActionLog {
  record(entry: ActionLogEntry): void
  /** Most recent entries last, so the tail of the file reads in the order things happened. */
  read(limit: number): ActionLogEntry[]
  page(input: { limit: number; before?: number }): { entries: ActionLogEntry[]; nextCursor: string | null }
}
