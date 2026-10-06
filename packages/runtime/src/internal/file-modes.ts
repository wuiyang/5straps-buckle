import { chmodSync, statSync } from 'node:fs'

/**
 * Windows keeps no POSIX modes: Node reports 0o666 for every path there, and chmod sets only the
 * read-only flag. No mode is read or changed on it. The platform is a parameter so a test can
 * imitate another one.
 */
export function hasFileModes(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** chmod where the platform keeps modes; nothing on Windows. */
export function setMode(path: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (hasFileModes(platform)) chmodSync(path, mode)
}

/** The mode when group or other users have any access; undefined when owner-only, missing, or on Windows. */
export function looseMode(path: string, platform: NodeJS.Platform = process.platform): number | undefined {
  if (!hasFileModes(platform)) return undefined
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat) return undefined
  const mode = stat.mode & 0o777
  return (mode & 0o077) === 0 ? undefined : mode
}
