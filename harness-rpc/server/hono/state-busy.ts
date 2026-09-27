import type { Context } from 'hono'
import { StateBusyError } from '../../common/adapters/json-file-store.js'

// A state file held by another process past the wait is temporary: 503, so the caller retries.
export function stateBusyResponse(error: Error, context: Context): Response | undefined {
  return error instanceof StateBusyError ? context.json({ error: error.message }, 503) : undefined
}
