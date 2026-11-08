import type { JsonValue } from '@5straps/protocol'
import type { AppendOptions } from './log-service.js'

/** A standing grant a call used, as its audit entry names it. */
export interface GrantUse {
  rule: string
  scope: 'session' | 'always'
  decidedBy?: string
}

/** What the decision AI's quick stage said (D91, addendum 2 B): its choice with the probabilities, or why it gave none. */
export type QuickAudit =
  | { provider: string; model: string; level: 'safe' | 'warning' | 'danger'; confidence: number; probabilities: Record<'safe' | 'warning' | 'danger', number>; latencyMs: number }
  | { provider: string; model: string; unavailable: string }

/**
 * How a rating acted: the thorough stage, whose safe verdict alone runs or approves a call (`passedBy`; addendum 3 R1), an
 * allowed command the quick stage made ask, or one it let run; `socket: 'unavailable'` where the Socket lookup for its
 * packages failed, so its verdict was not kept; and `changed` where the code it rated changed before the program
 * started, so its pass ran nothing and a person decides (fix brief 9, B31); and `codeUnread`, why the reader did not read
 * a screened allowed command's code, which the quick stage then rated on its command line (fix brief 9, B35).
 */
interface JudgeMarks { passedBy?: 'thorough'; flagged?: true; screened?: true; socket?: 'unavailable'; changed?: true; codeUnread?: string }

/**
 * What the decision AI said of a call (D91): the thorough stage's verdict and whether a stage passed the call, or why it
 * gave none, with the quick stage's beside it where it rated; or the quick stage's alone. The reasoning is the model's,
 * with the credentials the display hides hidden; the prompt is kept as its digest alone.
 */
export type JudgeAudit =
  | ({ provider: string; model: string; level: 'safe' | 'warning' | 'danger'; confidence: number; reasoning: string; latencyMs: number; promptDigest: string; passed: boolean; quick?: QuickAudit } & JudgeMarks)
  | ({ provider: string; model: string; unavailable: string; passed: false; quick?: QuickAudit } & JudgeMarks)
  | ({ quick: QuickAudit; passed: boolean } & JudgeMarks)

/** A call's attempt entry, by its auditId and the requestId it logged: what a later record names to join that call. */
export interface CallAttempt { auditId: string; requestId: string }

/** One attempted tool call, recorded whether it ran, was gated, or failed. */
export interface ActionLogEntry {
  /**
   * This line's own id, kept across every attempt at writing it, so a write tried again leaves out a line it reads back
   * in the file; best effort, as a line a failed sync left may sit in the page cache alone. Whoever holds an entry across
   * attempts gives it before the first; the writer gives one to an entry without.
   */
  entryId?: string
  auditId?: string
  event?: 'attempt' | 'result'
  workspaceId?: string
  /** The workspace's name when the entry was written (D85, Q15): the id is a UUID, so a reader sees the handle the owner knows. */
  workspaceName?: string
  runId?: string
  stageId?: string
  chatId?: string
  projectId?: string
  /**
   * Who the entry is attributed to: on a tool call, the actor its transport authenticated (`agent:<token
   * id>`, `workbench:<id>`, `local-owner`, `mcp-stdio`), with `actorTrust` authenticated; on a setup
   * change, the admin credential or the key that signed it. Never what a caller claims.
   */
  actorId?: string
  actorTrust?: 'authenticated'
  /**
   * The requester a tool call's caller named in its context (`context.actorId`), kept beside the
   * authenticated actor with trust claimed, never in its place (GPT review of c71dee5, requester attribution).
   */
  claimedActorId?: string
  claimedActorTrust?: 'claimed'
  agentId?: string
  /**
   * On a call a code_run script made, the requestId of that code_run call, the script that made it; its stage is the
   * caller's own, as on a direct call (final review of 0.1.4, finding invoker 701).
   */
  parentRequestId?: string
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
  /** The enrolled keys (key:<fingerprint>) whose decisions the call used: `once` approvals it spent, and standing grants it relied on. */
  decidedBy?: string[]
  /**
   * The standing (session or always) grants the call relied on, by rule and scope, each with the key that
   * decided it when a person's enrolled key did (keys-provisioning.md: consumption is logged with key
   * identity and scope; review M4 of the second proof-of-possession re-review). Never a subject.
   */
  grantUses?: GrantUse[]
  /** Where the decision AI rated the call (D91): what it said, and whether that ran the call. */
  judge?: JudgeAudit
  detail?: string
}

/** The owner's choice for a change whose record cannot be written: stop it (false), or run it with the record queued. */
export interface OwnerRecordChoice { ignoreWarning: boolean }

export interface ActionLog {
  /** Resolves once the entry is durable; a rejection means execution must not continue. */
  record(entry: ActionLogEntry): Promise<void>
  /**
   * Hands the entry to the process's log service, masked and named now, and returns at once; never throws. For a record
   * nothing waits on: a refusal, the result of work already done, and an owner's change the owner runs anyway.
   */
  append(entry: ActionLogEntry, options?: AppendOptions): void
  /**
   * The attempt of the owner's own change: recorded before the change runs while OWNER_RECORDS_WAIT (log-budget.ts) holds,
   * so a broken log stops it, and appended where it does not or the owner ignores the warning. Rejects only where it is
   * recorded, with an OwnerRecordError.
   */
  ownerAttempt(entry: ActionLogEntry, choice: OwnerRecordChoice): Promise<void>
  /** The entries as one batch, one append and one sync, in their order; resolves once all are durable, or rejects for all. */
  recordMany(entries: readonly ActionLogEntry[]): Promise<void>
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
