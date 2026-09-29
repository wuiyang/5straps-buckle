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
  /** A name inside the directory, as a path the kernel resolves beneath it. */
  child(name: string): string
  close(): void
}

/** A link appeared in a path after Buckle checked it: the operation is refused, not followed. */
export class LinkAppearedError extends ToolInputError {
  constructor(path: string) {
    super(`A symbolic link appeared in ${path} after it was checked, so nothing was written there`, { code: 'PERMISSION_DENIED' })
  }
}

/** Opens a real (link-free) directory path, creating missing directories when asked. */
export function openRealDirectory(realPath: string, options: { create?: boolean } = {}): PinnedDirectory {
  const parts = realPath.split('/').filter(Boolean)
  return PINNED ? pinnedWalk(realPath, parts, options.create === true) : checkedWalk(realPath, parts, options.create === true)
}

function pinnedWalk(realPath: string, parts: string[], create: boolean): PinnedDirectory {
  let descriptor = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const part of parts) {
      const next = `/proc/self/fd/${descriptor}/${part}`
      let opened: number
      try {
        opened = openSync(next, DIRECTORY)
      } catch (error) {
        // O_DIRECTORY with O_NOFOLLOW answers ENOTDIR for a link, as for a file.
        if (errorCode(error) === 'ENOTDIR' && isLink(next)) throw new LinkAppearedError(realPath)
        if (!create || errorCode(error) !== 'ENOENT') throw asRefusal(error, realPath)
        mkdirSync(next)
        opened = openSync(next, DIRECTORY)
      }
      closeSync(descriptor)
      descriptor = opened
    }
  } catch (error) {
    closeSync(descriptor)
    throw asRefusal(error, realPath)
  }
  const pinned = descriptor
  return { child: name => `/proc/self/fd/${pinned}/${name}`, close: () => closeSync(pinned) }
}

function checkedWalk(realPath: string, parts: string[], create: boolean): PinnedDirectory {
  let current = '/'
  for (const part of parts) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new LinkAppearedError(realPath)
    } catch (error) {
      if (!create || errorCode(error) !== 'ENOENT') throw error
      mkdirSync(current)
    }
  }
  return { child: name => join(realPath, name), close: () => {} }
}

/**
 * Runs `operation` on a regular file opened beneath its pinned parent, never through a link. `target`
 * must be where the permission rules judged the call would write (resolveTarget).
 */
export function withFileBeneath<T>(target: string, input: { flags: number; createParents?: boolean }, operation: (descriptor: number) => T): T {
  const directory = openRealDirectory(dirname(target), { create: input.createParents === true })
  try {
    const descriptor = openBeneath(directory, basename(target), input.flags, target)
    try {
      if (!fstatSync(descriptor).isFile()) throw new ToolInputError(`Not a regular file: ${target}`)
      return operation(descriptor)
    } finally { closeSync(descriptor) }
  } finally { directory.close() }
}

/** Opens a name beneath a pinned directory without following a link in its place. */
export function openBeneath(directory: PinnedDirectory, name: string, flags: number, shown: string, mode?: number): number {
  try {
    return openSync(directory.child(name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode)
  } catch (error) {
    throw asRefusal(error, shown)
  }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function asRefusal(error: unknown, path: string): unknown {
  return errorCode(error) === 'ELOOP' ? new LinkAppearedError(path) : error
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
