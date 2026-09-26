const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

// node:sqlite reports the SQLite result code on `errcode`; extended codes keep the primary code in the low byte.
export function isSqliteBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  if (typeof errcode !== 'number') return false
  const primary = errcode & 0xff
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED
}
