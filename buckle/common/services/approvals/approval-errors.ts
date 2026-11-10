/** A call re-sent under the same requestId asked for something else: HTTP 409. */
export class ApprovalConflictError extends Error {}

/**
 * A call re-sent under the requestId of an ask still waiting (or denied) carries other arguments: it is another call,
 * refused as REQUEST_ID_REUSED (HTTP 409), and never joins the ask a person sees.
 */
export class RequestIdReusedError extends Error {}

/** The asks one cap counts: the session's (its id under its actor), the actor's, or the whole workspace's. */
export type LimitRoom = 'session' | 'actor' | 'workspace'

/** The session or the workspace already has its cap of asks waiting: retryable once some are answered or expire. */
export class ApprovalLimitError extends Error {
  /** Whose cap refused: the abandoned asks there are the ones withdrawn to make room. */
  constructor(message: string, readonly room: LimitRoom = 'workspace') { super(message) }
}

/** One ask would hold more than MAX_ASK_BYTES: refused whole before anything is asked, never shown in part (owner decision D17). */
export class ActionTooLargeError extends Error {
  readonly code = 'ACTION_TOO_LARGE'
}

/**
 * The receiver of lifecycle notices answered that it refuses what it was sent (HTTP 400, 413, or 422), as one on an older
 * protocol does for a notice it cannot read. The link works, so the notices are the trouble, and the queue sends them apart.
 */
export class NoticeRefusedError extends Error {
  constructor(readonly status: number) { super(`Approval lifecycle webhook returned HTTP ${status}`) }
}
