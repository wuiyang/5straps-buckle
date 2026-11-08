/** Why a write failed, by its error's code, in words that name no path. */
const WRITE_FAILURES: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space is left on the disk',
  EDQUOT: 'the disk quota is used up',
  EIO: 'a disk I/O error',
}
const SYSTEM_CODE = /^E[A-Z0-9]{1,15}$/

/** An error's code, where it carries one as a node error does. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Why a write failed, naming no path: a node error's message quotes the file it failed on. */
export function writeFailure(error: unknown): string {
  const code = errorCode(error)
  if (code === undefined) return 'an unexpected error'
  return WRITE_FAILURES[code] ?? (SYSTEM_CODE.test(code) ? `system error ${code}` : 'an unexpected error')
}
