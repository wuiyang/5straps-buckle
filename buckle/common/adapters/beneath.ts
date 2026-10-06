import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, statSync, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'pathe'
import { isInside, isPlainName, pathRoot } from '../domain/paths.js'
import { ToolInputError } from '../domain/tool.js'

const PINNED = process.platform === 'linux'
// The pinned walk runs on Linux only, where both flags exist; elsewhere they are undefined and this is never used.
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/**
 * A directory reached from its root (`/`, or a drive such as `C:/`) one component at a time without
 * following any link, so what is made beneath it lands where it was checked (filesystem-boundary.md,
 * "File tool resolution"; review H1 of B23-B25). On Linux each name is resolved beneath the opened
 * descriptor through /proc/self/fd, the openat that Node lacks. Elsewhere each component is lstat'ed
 * first, which leaves a narrow race.
 */
export interface PinnedDirectory {
  /** The directory itself, as a path the kernel resolves to the opened directory. */
  readonly self: string
  /** A name inside the directory, as a path the kernel resolves beneath it; anything but one plain name is refused (isPlainName). */
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

/** Opens a real (link-free) absolute directory path in pathe's form, creating missing directories when asked. */
export function openRealDirectory(realPath: string, options: { create?: boolean; refusal?: Refusal } = {}): PinnedDirectory {
  const root = pathRoot(realPath)
  if (root === '') throw new ToolInputError(`${realPath} is not an absolute path, so it is not opened`)
  const parts = realPath.slice(root.length).split('/').filter(Boolean)
  const refusal = options.refusal ?? { shown: realPath }
  return PINNED ? pinnedWalk(root, parts, options.create === true, refusal) : checkedWalk(realPath, root, parts, options.create === true, refusal)
}

function pinnedWalk(root: string, parts: string[], create: boolean, refusal: Refusal): PinnedDirectory {
  let descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY)
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
  return { self: `/proc/self/fd/${descriptor}`, child: name => `/proc/self/fd/${descriptor}/${plainName(name)}`, close: () => closeSync(descriptor) }
}

function checkedWalk(realPath: string, root: string, parts: string[], create: boolean, refusal: Refusal): PinnedDirectory {
  let current = root
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
  return { self: realPath, child: name => join(realPath, plainName(name)), close: () => {} }
}

/**
 * A name a pinned directory opens is the one its caller judged: pathe would read `a\..\x` as a path that climbs out,
 * where the kernel opens one entry, so anything but one plain name is refused.
 */
function plainName(name: string): string {
  if (!isPlainName(name)) throw new ToolInputError(`${name} is not one plain name in its directory, so it is not opened`, { code: 'PERMISSION_DENIED' })
  return name
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

interface FileBeneath {
  flags: number
  createParents?: boolean
  shown?: string
  /**
   * Buckle's protected roots: a read of a hard-linked file on a device that holds one of them is refused
   * (isLinkedOnStateDevice). Absent, hard links are read as any file.
   */
  protectedRoots?: readonly string[]
  /** The workspace roots: only a node_modules component below one of them exempts a hard link (isLinkedOnStateDevice). */
  roots?: readonly string[]
}

/**
 * Runs `operation` on a regular file opened beneath its pinned parent, never through a link. `target`
 * must be where the permission rules judged the call would reach (resolveTarget). `shown` names the
 * file in a refusal (the target when absent); a read-only open is told it read nothing.
 */
export function withFileBeneath<T>(target: string, input: FileBeneath, operation: (descriptor: number) => T): T {
  const file = openFileBeneath(target, input)
  try { return operation(file.descriptor) } finally { file.close() }
}

/** withFileBeneath for an operation that awaits, such as a copy a call's signal can stop; the file stays open until it settles. */
export async function withFileBeneathAsync<T>(target: string, input: FileBeneath, operation: (descriptor: number) => Promise<T>): Promise<T> {
  const file = openFileBeneath(target, input)
  try { return await operation(file.descriptor) } finally { file.close() }
}

function openFileBeneath(target: string, input: FileBeneath): { descriptor: number; close: () => void } {
  const reading = (input.flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
  const refusal: Refusal = { shown: input.shown ?? target, ...(reading ? { outcome: NOT_READ } : {}) }
  const directory = openRealDirectory(dirname(target), { create: input.createParents === true, refusal })
  let descriptor: number
  try {
    descriptor = openBeneath(directory, basename(target), input.flags, refusal)
  } catch (error) {
    directory.close()
    throw error
  }
  const close = () => { try { closeSync(descriptor) } finally { directory.close() } }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw new ToolInputError(`Not a regular file: ${refusal.shown}`)
    if (reading && input.protectedRoots && isLinkedOnStateDevice({ info, path: target, protectedRoots: input.protectedRoots, roots: input.roots ?? [] })) {
      throw new ToolInputError(`${refusal.shown} is a hard link on the disk that holds Buckle's state, so nothing was read`, { code: 'PERMISSION_DENIED' })
    }
  } catch (error) {
    close()
    throw error
  }
  return { descriptor, close }
}

/**
 * Whether a regular file is a hard link (more than one name) on a device that holds one of Buckle's
 * protected roots, outside a node_modules tree of the workspace. A hard link is the same file as whatever
 * else names it, so a workspace name for a state file would read that state past every path check (review
 * L3 of the second proof-of-possession re-review). pnpm links node_modules files from its store, so a
 * node_modules component below a workspace root keeps a file readable; a hard link to state placed there
 * is the residual.
 */
export function isLinkedOnStateDevice(input: { info: { nlink: number; dev: number }; path: string; protectedRoots: readonly string[]; roots: readonly string[] }): boolean {
  if (input.info.nlink <= 1 || isDependencyBelowRoot(input.path, input.roots)) return false
  return input.protectedRoots.some(root => deviceOf(root) === input.info.dev)
}

/**
 * Whether a path has a node_modules component below a root that holds it. The root's own components never
 * count, so a root beneath a node_modules directory exempts nothing, and a path outside every root has none
 * (review L3).
 */
export function isDependencyBelowRoot(path: string, roots: readonly string[]): boolean {
  return roots.some(root => isInside(root, path) && relative(root, path).split('/').includes('node_modules'))
}

/** A protected root that is absent, or that this process cannot stat, holds no state a link could reach through it. */
function deviceOf(path: string): number | undefined {
  try { return statSync(path).dev } catch { return undefined }
}

/** Opens a name beneath a pinned directory without following a link in its place. */
export function openBeneath(directory: PinnedDirectory, name: string, flags: number, refusal: string | Refusal, mode?: number): number {
  try {
    return openNoFollow(directory.child(name), flags | constants.O_NONBLOCK, mode)
  } catch (error) {
    throw asRefusal(error, typeof refusal === 'string' ? { shown: refusal } : refusal)
  }
}

/** Windows defines neither O_NOFOLLOW nor O_DIRECTORY: `flags | undefined` is `flags`, which would follow a link silently. */
function hasNoFollowFlag(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/**
 * Opens a path without following a link in its last component. Linux and macOS refuse one in the open itself
 * (O_NOFOLLOW), with ELOOP. Windows has no such flag, so there the path is lstat'ed first and a link or junction is
 * refused with the same ELOOP; once opened, the file must be the one lstat saw (its volume and file ID, where the
 * volume reports them), or, for a file the open created, the name must still be no link. A link swapped in and out
 * again between the check and the open is the race that remains there (known-limits.md). The platform is a parameter
 * so a test can imitate Windows.
 */
export function openNoFollow(path: string, flags: number, mode?: number, platform: NodeJS.Platform = process.platform): number {
  if (hasNoFollowFlag(platform)) return openSync(path, flags | constants.O_NOFOLLOW, mode)
  const seen = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  refuseLink(path, seen)
  const descriptor = openSync(path, flags, mode)
  try {
    refuseSwap(path, seen, fstatSync(descriptor, { bigint: true }), () => lstatSync(path, { bigint: true, throwIfNoEntry: false }))
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
  return descriptor
}

/** openNoFollow for a caller that holds a FileHandle. */
export async function openHandleNoFollow(path: string, flags: number, platform: NodeJS.Platform = process.platform): Promise<FileHandle> {
  if (hasNoFollowFlag(platform)) return open(path, flags | constants.O_NOFOLLOW)
  const seen = await lstat(path, { bigint: true }).catch((error: unknown) => { if (errorCode(error) === 'ENOENT') return undefined; throw error })
  refuseLink(path, seen)
  const handle = await open(path, flags)
  try {
    const after = seen ? undefined : await lstat(path, { bigint: true }).catch(() => undefined)
    refuseSwap(path, seen, await handle.stat({ bigint: true }), () => after)
  } catch (error) {
    await handle.close()
    throw error
  }
  return handle
}

function refuseLink(path: string, seen: BigIntStats | undefined): void {
  if (seen?.isSymbolicLink()) throw linkInTheWay(path)
}

function refuseSwap(path: string, seen: BigIntStats | undefined, opened: BigIntStats, now: () => BigIntStats | undefined): void {
  if (seen ? !sameFile(seen, opened) : now()?.isSymbolicLink()) throw linkInTheWay(path)
}

/** The same file by volume and file ID; a volume that reports no file ID (0) cannot tell, so it passes. */
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  if (left.ino === 0n || right.ino === 0n) return true
  return left.ino === right.ino && left.dev === right.dev
}

/** The error O_NOFOLLOW raises, so every caller treats a link Windows met the same way. */
function linkInTheWay(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ELOOP: a symbolic link or junction is in the way, open '${path}'`), { code: 'ELOOP', syscall: 'open', path })
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
