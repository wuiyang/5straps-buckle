export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Whether an operation failed because another handle holds a file open, as Windows reports it. */
export function isHeldOpen(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EBUSY')
}
