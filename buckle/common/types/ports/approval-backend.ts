import type { ApprovalSeverity, GrantScope, JsonValue, PermissionRuleId } from '@5straps/protocol'
import type { ApprovalSource, Assurance } from './approval-source.js'

// The approval backend contract, as far as this build fills it: core implements ApprovalHost, a backend ApprovalBackend.
// A backend carries asks out and decisions in, and enforces nothing; the decision guard runs every check.

export type ContractVersion = 1

/**
 * The one line a floor ask's note carries: the built-in floor (sudo and the destructive commands) or the workspace's
 * destructive list asked, and no stage of the decision AI ever passes such a call. The ledger records these words, so a
 * change to them must still read the words recorded before it.
 */
export const FLOOR_WARNING = 'a command at the destructive floor always needs a person'

/**
 * How long a gated call is held for an answer:
 * - `grace`: for `BUCKLE_APPROVAL_TIMEOUT_MS`, while any route may answer (serve and mcp). A terminal
 *   question still open when it ends keeps asking until the request expires or is answered.
 * - `prompt`: only while this process's own terminal asks (a CLI command); without one, not at all.
 */
export type ApprovalHold = 'grace' | 'prompt'

/** The whole call the asks came from (D9, D17), as the node recorded it, masked by the secrets a call holds. */
export interface FullAction {
  arguments: JsonValue
  cwd: string
  description: string | null
  effects?: string[]
}

export type RiskLevel = 'safe' | 'warning' | 'danger'

/** What the decision AI's quick stage said: its verdict, or why it gave none. */
export type QuickRating = { level: RiskLevel; confidence: number; model: string; latencyMs: number } | { unavailable: string }

/**
 * What the decision AI said of one command (D91), as the judge line shows it: the thorough stage's verdict or why it gave
 * none, with the quick stage's beside it; the quick stage's alone; or that it was not asked yet. The reasoning is the
 * model's, credentials hidden. A floor ask's note carries the floor's warning, never a reasoning.
 */
export type RatingNote = (
  | { subject: string; level: RiskLevel; confidence: number; model: string; reasoning: string; latencyMs?: number; quick?: QuickRating }
  | { subject: string; unavailable: string; quick?: QuickRating }
  | { subject: string; onRequest: true }
  | { subject: string; quick: QuickRating }
) & { warning?: typeof FLOOR_WARNING }

/** One ask, whole: every field a person needs to decide on it. */
export interface FullAsk {
  egress: 'full'
  contractVersion: ContractVersion
  token: string
  /** Shared by every ask one call made: its tokens, answered ones included. */
  group: string
  /**
   * The call's key: an HMAC of its workspace, session, actor, and requestId under a secret this process holds, so it names
   * none of them. A new group under it is a new request: the earlier group left the queue unanswered.
   */
  idempotencyKey: string
  correlation: { correlationId: string; requestId: string }
  /** `name` is read as it is shown, so a rename shows at once. */
  workspace: { id: string; name?: string; node: string }
  requester: { actor: string | null; sessionId: string }
  tool: string
  policy: { rule: PermissionRuleId; subject: string; reason: string; offeredScopes: GrantScope[]; widerSubject?: string }
  /** `notes`: what the decision AI said of the call's command asks (D91). */
  risk: { severity?: ApprovalSeverity; notes: readonly RatingNote[] }
  deadline: { expiresAt: string; hold: ApprovalHold | null }
  /** Absent where the ask kept no call: it can only be denied. */
  action?: FullAction
}

/** An ask cut to its route's egress; every route this build has is full. */
export type Ask = FullAsk

export type Outcome = 'approve' | 'deny'

export interface DecisionBody {
  token: string
  outcome: Outcome
  scope: GrantScope
  /** Grant the ask's wider subject instead. */
  widen?: 'below'
}

/** A plain decision has no proof: core takes its approvals only from a source whose kind approves. */
export type DecisionInput = { kind: 'plain'; decision: DecisionBody }

/**
 * Who sent an answer: the actor the transport that carried it authenticated, never one the body or a header names. Core
 * reads it from the forms sources alone, and holds an HTTP form answer to the asks its own caller raised.
 */
export interface AnswerSender { caller: string }

/**
 * `grant_unsaved`: a lasting denial whose grant could not be written, so nothing was recorded and its ask still waits.
 * It is retryable, by its person: the same denial sent again tries the write again.
 */
export type ApprovalErrorCode =
  | 'unknown_ask' | 'ask_closed' | 'conflicting_decision' | 'action_mismatch' | 'incomplete_action'
  | 'scope_not_offered' | 'scope_forbidden' | 'statement_invalid' | 'proof_invalid' | 'proof_expired' | 'replayed'
  | 'approver_not_allowed' | 'assurance_too_low' | 'capability_exceeded'
  | 'unsupported_version' | 'rate_limited' | 'too_large' | 'grant_unsaved'

/** `saveError`: why a `grant_unsaved` denial was not saved, naming no path, for the route to put into words. */
export interface ApprovalError {
  code: ApprovalErrorCode
  message: string
  retryable: boolean
  retryAfterMs?: number
  saveError?: string
}

export type AskState = 'pending' | 'abandoned' | 'approved' | 'denied' | 'expired' | 'withdrawn'

/**
 * Where a session or always approval's grant stands: `owed` until written, then `saved`; `skipped` once its person gave it
 * up, and `skipping` while a grant given up that may have saved is not yet confirmed removed, which the next decision or
 * the workspace opening again removes; `dropped` once a revoke, its session's end, or a lasting denial in its place
 * removed it or kept it from being written.
 */
export const GRANT_SAVES = ['owed', 'saved', 'skipping', 'skipped', 'dropped'] as const
export type GrantSave = (typeof GRANT_SAVES)[number]

/**
 * `save`: where the grant of a session or always approval stands. While it is `owed`, only the call that asked runs on
 * it, and `saveError` says why, naming no path; the same decision sent again tries the write again. While it is
 * `skipping`, `saveError` says why its removal is not confirmed.
 */
export type DecisionReceipt =
  | { status: 'applied'; state: 'approved' | 'denied'; assurance: Assurance; save?: GrantSave; saveError?: string }
  | { status: 'repeated'; state: AskState; save?: GrantSave; saveError?: string }
  | { status: 'refused'; error: ApprovalError }

/**
 * What a skip came to: `repeated` where the save was skipped already, `removed` where its grant had saved and is gone.
 * `unfinished`: skipped, but a grant that may have saved is not confirmed removed: `stands` where it had saved and could
 * not be removed, false where the grants could not be read. The next decision, the workspace opening again, or the skip
 * sent again removes it; `saveError` says why, naming no path.
 */
export type SkipReceipt =
  | { status: 'skipped' | 'repeated'; removed?: true }
  | { status: 'unfinished'; stands: boolean; saveError: string }
  | { status: 'refused'; error: ApprovalError }

export type EventType =
  | 'issued' | 'renewed' | 'abandoned' | 'answered' | 'denied'
  | 'expired' | 'cancelled' | 'skipped' | 'spent' | 'revoked'

/** Why an ask was cancelled, where this process saw it go; `session_ended`: its session ended, as at idle. */
export type EventReason = 'caller_cancelled' | 'evicted' | 'withdrawn_by_owner' | 'session_ended'

export interface LifecycleEvent {
  eventId: string
  type: EventType
  token: string
  at: string
  reason?: EventReason
}

/** What a backend can do. Core never trusts a capability for safety. */
export interface BackendCapabilities {
  contractVersion: ContractVersion
  /** False: a notify route, whose denials core still accepts. */
  decides: boolean
  scopes: GrantScope[]
  cancels: boolean
  revokes: boolean
}

export interface SubmitContext {
  /**
   * Aborted when the ask closes or core shuts down; the backend opens nothing more for it, save the question its person's
   * own decision raised when it did not save, which may stay open until they answer it or the backend closes.
   */
  signal: AbortSignal
  resend: boolean
}

/** Never a decision: decisions enter through host.decide alone. */
export type SubmitResult =
  | { kind: 'accepted'; refs: Array<{ token: string; ref: string; url?: string }> }
  | { kind: 'declined'; reason: string }

/**
 * Whose asks the decision guard lets a source answer, read from the row it rates the source's kind by: where `sameCaller`
 * holds, only those its answer's own caller raised. A backend offers each of those asks what the ask offers; the guard
 * still checks every answer.
 */
export interface SourceReach { sameCaller: boolean }

/** What core hands a backend at open, bound to the source core holds for it. */
export interface ApprovalHost {
  readonly source: ApprovalSource
  readonly reach: SourceReach
  /** The one way a decision enters; the decision guard checks it before anything applies. */
  decide(input: DecisionInput, sender?: AnswerSender): Promise<DecisionReceipt>
  /**
   * Gives up the grant of a session or always approval this source recorded, on its person's say alone: it is never
   * written, or is removed where it already was. A `once` the call that asked got for it stays.
   */
  skipSave(token: string, sender?: AnswerSender): Promise<SkipReceipt>
  /** The asks still waiting that were routed to this source. */
  pending(): Ask[]
  /** The ask while it waits, if it was routed to this source; undefined otherwise. */
  ask(token: string): Ask | undefined
  log(level: 'debug' | 'info' | 'warn', message: string, fields?: Record<string, JsonValue>): void
}

/** One approval backend. Its methods may fail; core treats every failure as no decision. */
export interface ApprovalBackend {
  open(host: ApprovalHost): Promise<BackendCapabilities>
  /** One call's asks together; the same idempotencyKey and group open no second request while the first still asks. */
  submit(asks: Ask[], context: SubmitContext): Promise<SubmitResult>
  notify(events: LifecycleEvent[]): Promise<void>
  /** Once it resolves, the backend calls nothing on the host. */
  close(): Promise<void>
}
