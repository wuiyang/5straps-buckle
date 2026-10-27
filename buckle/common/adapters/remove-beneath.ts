import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { MAX_COUNTED_ENTRIES, type TreeCount } from '../domain/effect.js'
import { isPlainName } from '../domain/paths.js'
import { ToolInputError } from '../domain/tool.js'
import { openDirectoryBeneath, type PinnedDirectory } from './beneath.js'
import { isHeldOpen } from './replace-file.js'

/** How many times a removal Windows refuses as held is tried, and the pause before the next try, which grows each time (replace-file.ts). */
const REMOVE_ATTEMPTS = 5
const REMOVE_PAUSE_MS = 20
/** How deep a folder removed whole is walked; each level holds one open directory while the walk is beneath it. */
const MAX_REMOVE_DEPTH = 256

/** The removals and the pause removeBeneath uses; a test hands in its own. */
export interface RemoveIo {
  unlink(path: string): void
  rmdir(path: string): void
  pause(ms: number): Promise<void>
}

const SYSTEM_REMOVE: RemoveIo = { unlink: unlinkSync, rmdir: rmdirSync, pause: ms => delay(ms) }

/** A folder that holds entries, removed without `recursive`. */
export const FOLDER_NOT_EMPTY = 'FOLDER_NOT_EMPTY'

/**
 * Removes `name` from a folder reached without following a link: a file or a link is unlinked, the link itself and never
 * what it points to; a folder is removed when empty, or with everything in it where `tree` is set, each level opened
 * beneath the one above it (openDirectoryBeneath), so a link swapped in for a folder during the walk is refused rather
 * than followed. Where Windows refuses a removal as held (EPERM, EBUSY) it is tried again a few times, as a rename over a
 * held file is (replaceFile), and then refused in words that name the entry as held. `platform`: the host's unless a test
 * imitates another.
 */
export async function removeBeneath(input: { directory: PinnedDirectory; name: string; shown: string; tree: boolean; io?: RemoveIo; platform?: NodeJS.Platform }): Promise<void> {
  const io = input.io ?? SYSTEM_REMOVE
  const removal = { io, platform: input.platform ?? process.platform }
  const path = input.directory.child(input.name)
  const entry = lstatSync(path)
  if (!entry.isDirectory()) return retried(removal, input.shown, () => io.unlink(path))
  if (input.tree) await removeTree({ ...removal, parent: input.directory, name: input.name, shown: input.shown, depth: 0 })
  else await removeFolder(removal, path, input.shown)
}

/**
 * What a folder holds, counted from beneath its parent without following a link, up to MAX_COUNTED_ENTRIES and `more`
 * past that: every entry that is not a folder counts as a file, a link included.
 */
export function countTree(parent: PinnedDirectory, name: string, shown: string): TreeCount {
  const count = { files: 0, folders: 0, more: false }
  const walk = (directory: PinnedDirectory, depth: number): void => {
    for (const child of readdirSync(directory.self, { withFileTypes: true })) {
      if (count.files + count.folders >= MAX_COUNTED_ENTRIES) { count.more = true; return }
      const descend = child.isDirectory() && isPlainName(child.name) && depth < MAX_REMOVE_DEPTH
      if (!child.isDirectory()) { count.files++; continue }
      count.folders++
      if (!descend) continue
      const below = openDirectoryBeneath(directory, child.name, shown)
      try { walk(below, depth + 1) } finally { below.close() }
    }
  }
  const directory = openDirectoryBeneath(parent, name, shown)
  try { walk(directory, 0) } finally { directory.close() }
  return { counted: true, ...count }
}

interface Removal { io: RemoveIo; platform: NodeJS.Platform }

async function removeTree(input: Removal & { parent: PinnedDirectory; name: string; shown: string; depth: number }): Promise<void> {
  if (input.depth >= MAX_REMOVE_DEPTH) throw new ToolInputError(`${input.shown} nests more than ${MAX_REMOVE_DEPTH} folders deep, so it was removed only in part: delete its deepest folders first`)
  const directory = openDirectoryBeneath(input.parent, input.name, input.shown)
  try {
    for (const child of readdirSync(directory.self, { withFileTypes: true })) {
      // A name read as another path (a backslash on Linux, a dot or a space that ends it on Windows) is never removed by name.
      if (!isPlainName(child.name, input.platform)) throw new ToolInputError(`${input.shown} holds an entry whose name Buckle would read as another path, so it was removed only in part`)
      const path = directory.child(child.name)
      if (lstatSync(path).isDirectory()) await removeTree({ ...input, parent: directory, name: child.name, shown: `${input.shown}/${child.name}`, depth: input.depth + 1 })
      else await retried(input, `${input.shown}/${child.name}`, () => input.io.unlink(path))
    }
  } finally { directory.close() }
  await removeFolder(input, input.parent.child(input.name), input.shown)
}

async function removeFolder(removal: Removal, path: string, shown: string): Promise<void> {
  try {
    await retried(removal, shown, () => removal.io.rmdir(path))
  } catch (error) {
    if (errorCode(error) === 'ENOTEMPTY' || errorCode(error) === 'EEXIST') throw new ToolInputError(`${shown} is a folder that holds entries: send recursive: true to delete it and everything in it`, { code: FOLDER_NOT_EMPTY })
    throw error
  }
}

/** One removal, tried again where Windows refuses it as held, then refused naming the entry as held. */
async function retried(removal: Removal, shown: string, remove: () => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      remove()
      return
    } catch (error) {
      if (removal.platform !== 'win32' || !isHeldOpen(error)) throw error
      if (attempt >= REMOVE_ATTEMPTS) throw new ToolInputError(`${shown} is held open by another program, or Windows keeps it read-only, so it was not removed; close it and send the call again`, { code: 'ENTRY_HELD' })
      await removal.io.pause(REMOVE_PAUSE_MS * attempt)
    }
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
