import { randomUUID } from 'node:crypto'
import type { SessionEndCause } from '../../types/ports/decision-audit.js'

/** The session a Buckle process's own face holds in each workspace it opens, and when that session ends there. */
export interface FaceSession {
  readonly sessionId: string
  /** Ended as the process opens a workspace, before it serves a call there: what an earlier process of the face left. */
  readonly endsAtOpen?: SessionEndCause
  /** Ended at the process's close, in each workspace it has open. */
  readonly endsAtClose: SessionEndCause
}

/** The one session HTTP MCP calls share: `/mcp` is served stateless, so no client names a session of its own. */
export const HTTP_MCP_SESSION = 'mcp'

/** `buckle serve`'s: the HTTP MCP session lasts as long as the serve, and one that crashed left it for the next to end. */
export const SERVE_SESSION: FaceSession = Object.freeze({ sessionId: HTTP_MCP_SESSION, endsAtOpen: 'serve_started', endsAtClose: 'serve_stopped' })

/** Each `buckle mcp` process's own, so one ending leaves the others' approvals, and a restarted server starts afresh. */
export function stdioSession(): FaceSession {
  return { sessionId: `stdio:${randomUUID()}`, endsAtClose: 'stdio_closed' }
}
