import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { isPlainName } from '../domain/paths.js'
import { ToolInputError } from '../domain/tool.js'
import { LinkAppearedError, openBeneath, type PinnedDirectory } from './beneath.js'
import { isHeldOpen, replaceFile, type RenameIo } from './replace-file.js'

/** The name a delivery is written into before it replaces its target: hidden, and new for each one. */
export const PARTIAL_PREFIX = '.buckle-delivery-'

/**
 * Fills a new file beside `name`, in a directory reached without following a link, created exclusively, and renames it
 * onto `name` once `fill` succeeded and the signal has not fired. On any failure or abort the new file is removed and
 * `name` is left as it was. A target that is a link, as one swapped in after the check, or not a regular file, is
 * refused before anything is made. The file is made as `fs_write` makes one: a new one with the mode the kernel gives
 * (the umask, and any default ACL of the folder), and in place of an existing one with that one's mode, given as the
 * mode it is created with, which the kernel only narrows, and then set exactly, so it is never more open than the file it
 * replaces (re-checks of 2026-10-14: a mode worked out from the umask missed a folder's default ACL, and a private
 * target's copy was briefly open to others). An access ACL on the old file is not kept. Where Windows holds the target
 * open the rename is tried again a few times (replaceFile), and a target still held is refused in words that say so.
 */
export async function replaceBeneath(input: { directory: PinnedDirectory; name: string; named: string; signal: AbortSignal; fill: (descriptor: number) => Promise<void>; /** The rename and the pause, for a test to hand in its own. */ io?: RenameIo }): Promise<void> {
  const mode = existingMode(input.directory.child(input.name), input.named)
  const partial = `${PARTIAL_PREFIX}${randomUUID()}`
  const descriptor = openBeneath(input.directory, partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, { shown: input.named }, mode ?? undefined)
  let replaced = false
  try {
    try {
      if (mode !== null) fchmodSync(descriptor, mode)
      await input.fill(descriptor)
    } finally { closeSync(descriptor) }
    input.signal.throwIfAborted()
    await replaceOnto(input, partial)
    replaced = true
  } finally {
    if (!replaced) rmSync(input.directory.child(partial), { force: true })
  }
}

/**
 * Removes the partial deliveries a node stopped mid-copy left in a target's directory: regular files named with
 * PARTIAL_PREFIX older than `staleAfterMs`, which no call can still be writing, so none is left for good.
 */
export function sweepPartials(directory: PinnedDirectory, staleAfterMs: number, now = Date.now()): void {
  for (const name of readdirSync(directory.self).filter(entry => entry.startsWith(PARTIAL_PREFIX) && isPlainName(entry))) {
    const path = directory.child(name)
    try {
      const entry = lstatSync(path)
      if (entry.isFile() && now - entry.mtimeMs > staleAfterMs) rmSync(path, { force: true })
    } catch { /* Gone meanwhile, or another process sweeps it. */ }
  }
}

/** The permission bits of the regular file at `path`, null where there is none; a link or any other entry is refused. */
function existingMode(path: string, named: string): number | null {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry === undefined) return null
  if (entry.isSymbolicLink()) throw new LinkAppearedError(named)
  if (!entry.isFile()) throw new ToolInputError(`Not a regular file: ${named}`)
  return entry.mode & 0o777
}

async function replaceOnto(input: { directory: PinnedDirectory; name: string; named: string; io?: RenameIo }, partial: string): Promise<void> {
  try {
    await replaceFile(input.directory.child(partial), input.directory.child(input.name), input.io)
  } catch (error) {
    if (isHeldOpen(error)) throw new ToolInputError(`${input.named} is held open by another program, so it was not replaced; close it and send the call again`, { code: 'ENTRY_HELD' })
    throw error
  }
}
