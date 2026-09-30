import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ToolInputError } from '../domain/tool.js'

const PINNED = process.platform === 'linux'
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/**
 * A directory reached from `/` one component at a time without following any link, so what is made
 * beneath it lands where it was checked (filesystem-boundary.md, "File tool resolution"; review H1 of
 * B23-B25). On Linux each name is resolved beneath the opened descriptor through /proc/self/fd, the
 * openat that Node lacks. Elsewhere each component is lstat'ed first, which leaves a narrow race.
 */
export interface PinnedDirectory {
  /** The directory itself, as a path the kernel resolves to the opened directory. */
  readonly self: string
  /** A name inside the directory, as a path the kernel resolves beneath it. */
  child(name: string): string
  close(): void
}

/** A link appeared in a path after Buckle checked it: the operation is refused, not followed. */
export class LinkAppearedError extends ToolInputError {
  constructor(path: string, outcome = 'nothing was written there') {
    super(`A symbolic link appeared in ${path} after it was checked, so ${outcome}`, { code: 'PERMISSION_DENIED' })
  }
}

/** How a refusal names the path and what did not happen, so a read is not told nothing was written. */
interface Refusal { shown: string; outcome?: string }
const NOT_OPENED = 'it was not opened'
const NOT_READ = 'nothing was read'

/** Opens a real (link-free) directory path, creating missing directories when asked. */
export function openRealDirectory(realPath: string, options: { create?: boolean; refusal?: Refusal } = {}): PinnedDirectory {
  const parts = realPath.split('/').filter(Boolean)
  const refusal = options.refusal ?? { shown: realPath }
  return PINNED ? pinnedWalk(parts, options.create === true, refusal) : checkedWalk(realPath, parts, options.create === true, refusal)
}

function pinnedWalk(parts: string[], create: boolean, refusal: Refusal): PinnedDirectory {
  let descriptor = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const part of parts) {
      const next = `/proc/self/fd/${descriptor}/${part}`
      let opened: number
      try {
        opened = openSync(next, DIRECTORY)
      } catch (error) {
        // O_DIRECTORY with O_NOFOLLOW answers ENOTDIR for a link, as for a file.
        if (errorCode(error) === 'ENOTDIR' && isLink(next)) throw new LinkAppearedError(refusal.shown, refusal.outcome)
        if (!create || errorCode(error) !== 'ENOENT') throw asRefusal(error, refusal)
        mkdirSync(next)
        opened = openSync(next, DIRECTORY)
      }
      closeSync(descriptor)
      descriptor = opened
    }
  } catch (error) {
    closeSync(descriptor)
    throw asRefusal(error, refusal)
  }
  return pinnedAt(descriptor)
}

function pinnedAt(descriptor: number): PinnedDirectory {
  return { self: `/proc/self/fd/${descriptor}`, child: name => `/proc/self/fd/${descriptor}/${name}`, close: () => closeSync(descriptor) }
}

function checkedWalk(realPath: string, parts: string[], create: boolean, refusal: Refusal): PinnedDirectory {
  let current = '/'
  for (const part of parts) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new LinkAppearedError(refusal.shown, refusal.outcome)
    } catch (error) {
      if (!create || errorCode(error) !== 'ENOENT') throw error
      mkdirSync(current)
    }
  }
  return checkedAt(realPath)
}

function checkedAt(realPath: string): PinnedDirectory {
  return { self: realPath, child: name => join(realPath, name), close: () => {} }
}

/**
 * A directory inside a pinned one, opened without following a link in its place, so a walk that
 * descends through it stays where each level was listed (review item 4 of the proof-of-possession fixes).
 */
export function openDirectoryBeneath(parent: PinnedDirectory, name: string, shown: string): PinnedDirectory {
  const path = parent.child(name)
  if (!PINNED) {
    if (lstatSync(path).isSymbolicLink()) throw new LinkAppearedError(shown, NOT_OPENED)
    return checkedAt(path)
  }
  try {
    return pinnedAt(openSync(path, DIRECTORY))
  } catch (error) {
    if (errorCode(error) === 'ENOTDIR' && isLink(path)) throw new LinkAppearedError(shown, NOT_OPENED)
    throw asRefusal(error, { shown, outcome: NOT_OPENED })
  }
}

/**
 * Runs `operation` on a regular file opened beneath its pinned parent, never through a link. `target`
 * must be where the permission rules judged the call would reach (resolveTarget). `shown` names the
 * file in a refusal (the target when absent); a read-only open is told it read nothing.
 */
export function withFileBeneath<T>(target: string, input: { flags: number; createParents?: boolean; shown?: string }, operation: (descriptor: number) => T): T {
  const reading = (input.flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
  const refusal: Refusal = { shown: input.shown ?? target, ...(reading ? { outcome: NOT_READ } : {}) }
  const directory = openRealDirectory(dirname(target), { create: input.createParents === true, refusal })
  try {
    const descriptor = openBeneath(directory, basename(target), input.flags, refusal)
    try {
      if (!fstatSync(descriptor).isFile()) throw new ToolInputError(`Not a regular file: ${refusal.shown}`)
      return operation(descriptor)
    } finally { closeSync(descriptor) }
  } finally { directory.close() }
}

/** Opens a name beneath a pinned directory without following a link in its place. */
export function openBeneath(directory: PinnedDirectory, name: string, flags: number, refusal: string | Refusal, mode?: number): number {
  try {
    return openSync(directory.child(name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode)
  } catch (error) {
    throw asRefusal(error, typeof refusal === 'string' ? { shown: refusal } : refusal)
  }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function asRefusal(error: unknown, refusal: Refusal): unknown {
  return errorCode(error) === 'ELOOP' ? new LinkAppearedError(refusal.shown, refusal.outcome) : error
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
