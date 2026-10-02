import { isRuntimeError } from '@5straps/runtime'
import { SqliteErrorCode } from '@5straps/runtime/sqlite'
import { StateBusyError } from '../adapters/json-file-store.js'
import { HistoryBusyError } from './history/journal.js'

/** What an agent is told: no path, because the state directory is hidden from agents by design. */
export const STATE_BUSY_MESSAGE = 'Buckle state is busy in another process; retry shortly'

/** State another process or flow held past the wait. Temporary, so every face tells the caller to retry. */
export function isStateBusy(error: unknown): error is Error {
  return error instanceof StateBusyError || error instanceof HistoryBusyError || isRuntimeError(error, SqliteErrorCode.sectionWaitTimeout)
}
