import { STATE_BUSY, StateFileError } from '../../adapters/json-file-store.js'
import { errorCode, writeFailure } from '../../domain/write-failure.js'

/** Why a grant was not saved, naming no path: a node error's message quotes the file it failed on. */
export function saveFailure(error: unknown): string {
  if (error instanceof StateFileError) return 'a state file is unreadable or invalid'
  if (errorCode(error) === STATE_BUSY) return 'another Buckle process holds the file'
  return writeFailure(error)
}
