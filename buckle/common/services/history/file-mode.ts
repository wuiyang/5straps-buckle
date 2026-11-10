import type { Stats } from 'node:fs'

/** A mode as history records it: the permission bits, read on Windows as its read-only flag gives them (git's 644 and 755). */
export function modeOf(stat: Stats): number {
  const mode = stat.mode & 0o777
  if (process.platform !== 'win32' || stat.isSymbolicLink()) return mode
  if (stat.isDirectory()) return mode & 0o200 ? 0o755 : 0o555
  return mode & 0o200 ? 0o644 : 0o444
}
