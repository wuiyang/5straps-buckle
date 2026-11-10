import type { JsonObject } from '@5straps/protocol'
import { CALL_REPLAY_WINDOW_MS, requestFingerprint } from '../common/domain/call-identity.js'
import { EXECUTION_LIMIT } from '../common/services/invocation/executions.js'

/**
 * What makes two MCP tool calls the same call (the MCP asks brief, item 2), defined here alone: the same tool, the same
 * arguments byte for byte once their keys are put in order (requestFingerprint, which a `once` approval binds to as
 * well), from the same session and the same actor. Nothing else counts: not the JSON-RPC id, which restarts with each
 * client, nor the stage or the wait a call names.
 */
export function sameCallKey(input: { sessionId: string; actor: string | undefined; tool: string; args: JsonObject }): string {
  return JSON.stringify([input.sessionId, input.actor ?? null, requestFingerprint({ tool: input.tool, args: input.args })])
}

/**
 * The MCP calls of one runtime that asked a person, by sameCallKey, each with the requestId it was given, so an identical
 * re-send reuses it: it joins the ask still pending, supersedes a call still held, or replays the run its client missed
 * through the execution replay, and a call never runs twice for one decision. A call stays for the replay window, ten
 * minutes from its last use and 256 calls at most, the oldest dropped first; the face forgets it sooner once its outcome
 * reached a client still there (mcp/server.ts).
 */
export interface ResendJoin {
  /** The requestId an identical call that asked was given, while it is remembered. */
  requestIdOf(key: string): string | undefined
  /** Remembers the call under `key`, or keeps it ten minutes more. */
  remember(key: string, requestId: string): void
  forget(key: string): void
}

export function createResendJoin(options: { now?: () => number } = {}): ResendJoin {
  const now = options.now ?? (() => Date.now())
  const calls = new Map<string, { requestId: string; expiresAt: number }>()
  return {
    requestIdOf(key) {
      const call = calls.get(key)
      if (call && call.expiresAt <= now()) calls.delete(key)
      return calls.get(key)?.requestId
    },
    remember(key, requestId) {
      calls.delete(key)
      calls.set(key, { requestId, expiresAt: now() + CALL_REPLAY_WINDOW_MS })
      for (const oldest of calls.keys()) {
        if (calls.size <= EXECUTION_LIMIT) break
        calls.delete(oldest)
      }
    },
    forget: (key) => { calls.delete(key) },
  }
}
