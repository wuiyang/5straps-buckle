import { closeSync, constants, fstatSync, lstatSync, readdirSync, readFile, readlinkSync, type Stats } from 'node:fs'
import { promisify } from 'node:util'
import { openNoFollow } from '../../adapters/beneath.js'
import { MAX_MASS_DELETE_LIMIT } from '../../domain/delete-policy.js'
import { childPath, isInsideAny, isPlainName, parentDirectory } from '../../domain/paths.js'
import { blobId, type ObjectStore } from './object-store.js'
import type { Entry, Snapshot } from './snapshot.js'

const readDescriptor = promisify(readFile)

/**
 * One path a call's checkpoint records (Slice F2, item 1): the path itself, and with `tree` (a folder a call deletes or
 * moves, or lands whole) every entry under it when it is a folder.
 */
export interface ScopePath { path: string; tree?: boolean }

/** How many entries one folder's tree may hold before it is recorded without content: the largest mass-delete limit. */
export const SCOPE_TREE_ENTRIES = MAX_MASS_DELETE_LIMIT

export interface ScopeCapture {
  scope: readonly ScopePath[]
  /** Where content is kept; absent, each file is hashed only, as a restore checks the current state. */
  store?: Pick<ObjectStore, 'put'>
  maxFileBytes: number
  /** The bytes one folder's tree may hold before it is recorded without content (reason `limit`). */
  maxTreeBytes: number
  maxTreeEntries?: number
  /** Buckle's own state and the protected roots: never recorded. */
  excluded: string[]
  platform?: NodeJS.Platform
}

/**
 * The state of each path in `scope` as it stands now, read from the disk directly: nothing walks the rest of the
 * workspace, no ignore rule is read, and no program starts. A path that is absent has no key. A file over the content cap
 * is recorded with its size and reason `size`, one that cannot be read as `unreadable`, and a special file with reason
 * `special`, so no entry ever refuses the call; a folder tree past its bounds is recorded as that folder alone, reason
 * `limit`, so a restore never puts half of it back.
 */
export async function captureScope(input: ScopeCapture): Promise<Snapshot> {
  const result: Snapshot = {}
  const platform = input.platform ?? process.platform
  for (const { path, tree } of input.scope) {
    if (isInsideAny(input.excluded, path)) continue
    const stat = inspect(path)
    if (stat === null) { result[path] = { kind: 'unreadable', mode: 0 }; continue }
    if (!stat) continue
    if (tree && stat.isDirectory()) await captureTree(path, stat)
    else if (!Object.hasOwn(result, path)) await record(path, stat)
  }
  return result

  async function record(path: string, stat: Stats): Promise<void> {
    const entry = await entryOf({ path, stat, input, platform })
    if (entry) result[path] = entry
    else delete result[path]
  }

  async function captureTree(root: string, rootStat: Stats): Promise<void> {
    const found: Array<[string, Stats | null]> = []
    const misnamed: Array<[string, number]> = []
    let bytes = 0
    const limit = input.maxTreeEntries ?? SCOPE_TREE_ENTRIES
    const pending: Array<[string, Stats]> = [[root, rootStat]]
    while (pending.length) {
      const [path, stat] = pending.pop()!
      found.push([path, stat])
      if (found.length + misnamed.length > limit + 1) { result[root] = { kind: 'excluded', mode: modeOf(rootStat), reason: 'limit' }; return }
      if (stat.isFile() && stat.size <= input.maxFileBytes) bytes += stat.size
      if (bytes > input.maxTreeBytes) { result[root] = { kind: 'excluded', mode: modeOf(rootStat), reason: 'limit' }; return }
      if (!stat.isDirectory()) continue
      let names: string[]
      try { names = readdirSync(path) } catch { found[found.length - 1] = [path, null]; continue }
      for (const name of names) {
        // Joined as listed: pathe would read a backslash in a Linux name as a separator (isPlainName).
        const child = childPath(path, name)
        if (isInsideAny(input.excluded, child)) continue
        const childStat = inspect(child)
        if (childStat === undefined) continue
        if (!isPlainName(name, platform)) { misnamed.push([child, childStat ? modeOf(childStat) : 0]); continue }
        if (childStat === null) found.push([child, null])
        else pending.push([child, childStat])
      }
    }
    for (const [path, stat] of found) {
      if (stat === null) result[path] = { kind: 'unreadable', mode: 0 }
      else await record(path, stat)
    }
    for (const [path, mode] of misnamed) result[path] = { kind: 'excluded', mode }
  }
}

/**
 * The state of each child of `directory` on disk that `known` does not hold, by kind and mode alone: what a restore
 * that removes the folder would also remove, which it refuses (assertSnapshotMatches).
 */
export function unknownChildren(directory: string, known: Snapshot): Snapshot {
  const found: Snapshot = {}
  let names: string[]
  try { names = readdirSync(directory) } catch { return found }
  for (const name of names) {
    const child = childPath(directory, name)
    if (Object.hasOwn(known, child)) continue
    const stat = inspect(child)
    found[child] = stat ? { kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mode: modeOf(stat) } : { kind: 'unreadable', mode: 0 }
  }
  return found
}

/** The folders above `path` that do not exist yet, nearest first: a write that makes its parents makes these. */
export function missingParents(path: string): string[] {
  const missing: string[] = []
  for (let parent = parentDirectory(path); parent !== parentDirectory(parent) && inspect(parent) === undefined; parent = parentDirectory(parent)) missing.push(parent)
  return missing
}

async function entryOf(input: { path: string; stat: Stats; input: ScopeCapture; platform: NodeJS.Platform }): Promise<Entry | undefined> {
  const { path, stat } = input
  const mode = modeOf(stat)
  if (stat.isSymbolicLink()) {
    try { return { kind: 'symlink', mode, target: readlinkSync(path) } } catch (error) { return isMissing(error) ? undefined : { kind: 'unreadable', mode } }
  }
  if (stat.isDirectory()) return { kind: 'directory', mode }
  if (!stat.isFile()) return { kind: 'excluded', mode, reason: 'special' }
  if (stat.size > input.input.maxFileBytes) return { kind: 'excluded', mode, size: stat.size, reason: 'size' }
  const content = await readStable(path, stat, input.platform) ?? await readStable(path, inspect(path) ?? stat, input.platform)
  if (content === undefined) return undefined
  if (content === null) return { kind: 'unreadable', mode }
  const hash = input.input.store ? await input.input.store.put(content) : blobId(content)
  return { kind: 'file', mode, hash }
}

/**
 * A regular file's bytes, read through a descriptor opened without following a link and checked to be the file `stat`
 * saw, unchanged by the read. undefined where it is gone, null where it cannot be read or changed as it was read.
 */
async function readStable(path: string, stat: Stats, platform: NodeJS.Platform): Promise<Buffer | null | undefined> {
  let descriptor: number
  try { descriptor = openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK, undefined, platform) }
  catch (error) { return isMissing(error) ? undefined : null }
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return null
    const content = await readDescriptor(descriptor)
    const after = fstatSync(descriptor)
    if (content.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null
    return content
  } catch { return null }
  finally { closeSync(descriptor) }
}

/** lstat without following the last link; undefined where nothing is there, null where it cannot be looked at. */
function inspect(path: string): Stats | null | undefined {
  try { return lstatSync(path, { throwIfNoEntry: false }) } catch (error) { return isMissing(error) ? undefined : null }
}

/** A mode as history records it: the permission bits, read on Windows as its read-only flag gives them (git's 644 and 755). */
function modeOf(stat: Stats): number {
  const mode = stat.mode & 0o777
  if (process.platform !== 'win32' || stat.isSymbolicLink()) return mode
  if (stat.isDirectory()) return mode & 0o200 ? 0o755 : 0o555
  return mode & 0o200 ? 0o644 : 0o444
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
