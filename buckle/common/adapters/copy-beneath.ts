import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, readdirSync, readlinkSync, readSync, statSync, symlinkSync, writeSync } from 'node:fs'
import { win32 } from 'node:path'
import { isPlainName } from '../domain/paths.js'
import { ToolInputError } from '../domain/tool.js'
import { openBeneath, openDirectoryBeneath, type PinnedDirectory } from './beneath.js'

/** A link made at a path: the system's symlinkSync, or a test's own. */
export type SymlinkIo = (target: string, path: string, type?: 'file' | 'dir' | 'junction') => void

const CHUNK_BYTES = 1_048_576
/** How deep a folder copied whole is walked; each level holds one open directory on each side while the walk is beneath it. */
const MAX_COPY_DEPTH = 256

/**
 * Copies the entry `name` of one folder to `as` in another, both reached without following a link, for a move across
 * devices or mounts: a file's bytes and permission bits into a file created exclusively, a link as a link to the same
 * target, never followed, and a folder with everything in it, each level opened beneath the one above it. Anything else
 * (a socket, a device, a pipe) is refused. What it made is the caller's to remove where the copy fails.
 */
export function copyBeneath(input: { from: PinnedDirectory; name: string; to: PinnedDirectory; as: string; shown: string; depth?: number; /** The host's unless a test imitates another. */ platform?: NodeJS.Platform; symlink?: SymlinkIo }): void {
  const depth = input.depth ?? 0
  const source = input.from.child(input.name)
  const entry = lstatSync(source)
  if (entry.isSymbolicLink()) { copyLink(input, source); return }
  if (entry.isFile()) { copyFile(input); return }
  if (!entry.isDirectory()) throw new ToolInputError(`${input.shown} holds an entry that is neither a file, a link, nor a folder, so it was not copied`)
  if (depth >= MAX_COPY_DEPTH) throw new ToolInputError(`${input.shown} nests more than ${MAX_COPY_DEPTH} folders deep, so it was not copied`)
  mkdirSync(input.to.child(input.as), { mode: entry.mode & 0o777 })
  const from = openDirectoryBeneath(input.from, input.name, input.shown)
  try {
    const to = openDirectoryBeneath(input.to, input.as, input.shown)
    try {
      for (const child of readdirSync(from.self)) {
        if (!isPlainName(child)) throw new ToolInputError(`${input.shown} holds an entry whose name Buckle would read as another path, so it was not copied`)
        copyBeneath({ from, name: child, to, as: child, shown: `${input.shown}/${child}`, depth: depth + 1, ...(input.platform ? { platform: input.platform } : {}), ...(input.symlink ? { symlink: input.symlink } : {}) })
      }
    } finally { to.close() }
  } finally { from.close() }
}

/**
 * A link copied as a link to the same target. Windows makes a link of a kind: a file link, a folder link, or a junction (a
 * folder link to an absolute path, which any user may make, where the other two need the symbolic-link privilege or
 * Developer Mode). A folder link with an absolute target is made a junction; where Windows refuses a link, the copy says
 * which link and why, and nothing is moved.
 */
function copyLink(input: { to: PinnedDirectory; as: string; shown: string; platform?: NodeJS.Platform; symlink?: SymlinkIo }, source: string): void {
  const platform = input.platform ?? process.platform
  const target = readlinkSync(source)
  const make = input.symlink ?? ((to, path, type) => symlinkSync(to, path, type))
  const type = platform === 'win32' ? (statSync(source, { throwIfNoEntry: false })?.isDirectory() ? (win32.isAbsolute(target) ? 'junction' : 'dir') : 'file') : undefined
  try {
    make(target, input.to.child(input.as), type)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) throw new ToolInputError(`${input.shown} is a link, and Windows lets only an administrator, or a user with Developer Mode on, make one, so it was not copied`)
    throw error
  }
}

function copyFile(input: { from: PinnedDirectory; name: string; to: PinnedDirectory; as: string; shown: string }): void {
  const reading = openBeneath(input.from, input.name, constants.O_RDONLY, { shown: input.shown, outcome: 'nothing was copied' })
  try {
    const mode = fstatSync(reading).mode & 0o777
    const writing = openBeneath(input.to, input.as, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, { shown: input.shown }, mode)
    try {
      // Created with the mode, which the umask only narrows; a folder that holds no modes (a FAT mount) refuses the exact one.
      try { fchmodSync(writing, mode) } catch { /* The file stands with the mode it was created with. */ }
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      for (;;) {
        const count = readSync(reading, buffer, 0, buffer.byteLength, null)
        if (count === 0) break
        let written = 0
        while (written < count) written += writeSync(writing, buffer, written, count - written)
      }
    } finally { closeSync(writing) }
  } finally { closeSync(reading) }
}
