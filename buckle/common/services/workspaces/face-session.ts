import { randomUUID } from 'node:crypto'
import type { SessionEndCause } from '../../types/ports/decision-audit.js'

/**
 * The session id a Buckle process's own face names its calls by in each workspace it opens, and when the sessions under it
 * end there, every caller's.
 */
export interface FaceSession {
  readonly sessionId: string
  /**
   * Ended as the process first opens a workspace after it starts, before it serves a call there: what an earlier process
   * of the face left. A later open, as after the workspace went offline and back, ends nothing.
   */
  readonly endsAtFirstOpen?: SessionEndCause
  /** Ended at the process's close, in each workspace it has open. */
  readonly endsAtClose: SessionEndCause
}

/**
 * The session id every HTTP MCP call is named by: `/mcp` is served stateless, so no client names a session of its own, and
 * each caller's session is this id under its token.
 */
export const HTTP_MCP_SESSION = 'mcp'

/** `buckle serve`'s: the HTTP MCP sessions last as long as the serve, and one that crashed left them for the next to end. */
export const SERVE_SESSION: FaceSession = Object.freeze({ sessionId: HTTP_MCP_SESSION, endsAtFirstOpen: 'serve_started', endsAtClose: 'serve_stopped' })

/** Each `buckle mcp` process's own, so one ending leaves the others' approvals, and a restarted server starts afresh. */
export function stdioSession(): FaceSession {
  return { sessionId: `stdio:${randomUUID()}`, endsAtClose: 'stdio_closed' }
}
