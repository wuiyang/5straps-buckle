import { chmodSync, fchmodSync, statSync } from 'node:fs'
import type { Logger } from '@5straps/runtime'
import { SKIP_OWNER_ONLY_FLAG } from '../domain/global-flags.js'
import { logger } from '../runtime/log.js'

export { SKIP_OWNER_ONLY_FLAG }

// Set once by main from the command line, as the root logger is; a check's own `skip` wins.
let skipFromCommandLine = false

/** Main calls this before any command runs, with whether the command line carried the flag. */
export function configureOwnerOnlyCheck(input: { skip: boolean }): void {
  skipFromCommandLine = input.skip
}

/**
 * Windows keeps no POSIX modes: Node reports 0o666 for every path there, and chmod sets only the
 * read-only flag. Buckle neither reads nor changes a mode on it; the profile's own access control
 * protects the state directory. The platform is a parameter so a test can imitate another one.
 */
export function hasFileModes(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** chmod where the platform keeps modes; nothing on Windows. */
export function setMode(path: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (hasFileModes(platform)) chmodSync(path, mode)
}

/** fchmod where the platform keeps modes; nothing on Windows. */
export function setDescriptorMode(descriptor: number, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (hasFileModes(platform)) fchmodSync(descriptor, mode)
}

/** Whether group or other users have any access to an existing path; never on Windows. */
export function isOpenToOthers(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return looseMode(path, platform) !== undefined
}

export interface OwnerOnlyCheck {
  /** Warn and go on instead of refusing; the command line's --skip-owner-only-check by default. */
  skip?: boolean
  platform?: NodeJS.Platform
  /** Where the warning goes; the process's logger by default. */
  logger?: Pick<Logger, 'warn'>
}

/** A credential file or directory other users can reach, refused; the message names the chmod and the flag. */
export class OwnerOnlyError extends Error {
  override readonly name = 'OwnerOnlyError'
}

/**
 * Refuses a file or directory holding credentials that other users can reach, as ssh refuses an
 * unprotected key. With --skip-owner-only-check one warning names it and it is used. A missing path
 * passes: whoever creates it makes it owner-only.
 */
export function requireOwnerOnly(path: string, kind: 'file' | 'directory', check: OwnerOnlyCheck = {}): void {
  const mode = looseMode(path, check.platform)
  if (mode === undefined) return
  const open = kind === 'directory'
    ? `Directory ${path} is accessible to other users (mode ${mode.toString(8)})`
    : `${path} can be read by other users (mode ${mode.toString(8)})`
  const repair = `chmod ${kind === 'directory' ? '700' : '600'} ${path}`
  if (check.skip ?? skipFromCommandLine) {
    (check.logger ?? logger).warn(`${open}; used anyway because of ${SKIP_OWNER_ONLY_FLAG}. ${repair} makes it owner-only`, { path })
    return
  }
  throw new OwnerOnlyError(`${open}; it holds credentials and must be owner-only: ${repair}, or pass ${SKIP_OWNER_ONLY_FLAG} to use it as it is`)
}

// The mode when group or other users have any access; undefined when owner-only, missing, or on Windows.
function looseMode(path: string, platform: NodeJS.Platform = process.platform): number | undefined {
  if (!hasFileModes(platform)) return undefined
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat) return undefined
  const mode = stat.mode & 0o777
  return (mode & 0o077) === 0 ? undefined : mode
}
