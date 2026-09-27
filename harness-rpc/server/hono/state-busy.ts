import type { Context } from 'hono'
import { StateBusyError } from '../../common/adapters/json-file-store.js'
import { isStateBusy, STATE_BUSY_MESSAGE } from '../../common/services/state-busy.js'

// State held by another process past the wait is temporary: 503, so the caller retries. Only a JSON
// state file's message names its path; the history lock and section waits answer the plain reason.
export function stateBusyResponse(error: Error, context: Context): Response | undefined {
  if (!isStateBusy(error)) return undefined
  return context.json({ error: error instanceof StateBusyError ? error.message : STATE_BUSY_MESSAGE }, 503)
}
