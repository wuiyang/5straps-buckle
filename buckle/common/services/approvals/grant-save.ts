import { STATE_BUSY, StateFileError } from '../../adapters/json-file-store.js'

/** A lasting scope as a person reads it beside a failed save. */
const LASTING_SCOPE_WORDS: Readonly<Record<'session' | 'always', string>> = { session: 'for the session', always: 'for every session' }

/** Why a grant's write failed, by the error's code, in words that name no path. */
const SAVE_FAILURES: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space is left on the disk',
  EDQUOT: 'the disk quota is used up',
  EIO: 'a disk I/O error',
  [STATE_BUSY]: 'another Buckle process holds the file',
}
const SYSTEM_CODE = /^E[A-Z0-9]{1,15}$/

/** Why a grant was not saved, naming no path: a node error's message quotes the file it failed on. */
export function saveFailure(error: unknown): string {
  if (error instanceof StateFileError) return 'a state file is unreadable or invalid'
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code === undefined) return 'an unexpected error'
  return SAVE_FAILURES[code] ?? (SYSTEM_CODE.test(code) ? `system error ${code}` : 'an unexpected error')
}

/** The refusal of a lasting denial whose grant could not be written: nothing is recorded, and the call still waits. */
export function unsavedDenial(input: { scope: 'session' | 'always'; reason: string }): string {
  return `Not denied ${LASTING_SCOPE_WORDS[input.scope]}: saving failed: ${input.reason}; the call still waits`
}
