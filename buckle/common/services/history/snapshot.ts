import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, type Stats, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { isDependencyBelowRoot, openBeneath, openNoFollow, openRealDirectory, type PinnedDirectory } from '../../adapters/beneath.js'
import { setDescriptorMode } from '../../adapters/file-modes.js'
import { entryBelowRoot, isInside, isInsideAny, isPlainName, nativePath, parentDirectory } from '../../domain/paths.js'

/**
 * Two kinds are recorded without content, and history never restores, removes or rewrites one: each is left out of
 * every change set, listed as not restorable when it changes, and a restore that would remove a directory holding one
 * is a conflict. `excluded`: a hard-linked file under a node_modules directory below a snapshot root (pnpm links its
 * store there), or, in history, an entry whose name holds a backslash on Linux or macOS, which pathe would read as
 * another path; its key is its directory and its name joined as listed. `unreadable`: on Windows, a file another
 * program held open without read sharing (EBUSY), so its content could not be read.
 */
export const entrySchema = z.object({ kind: z.enum(['file', 'directory', 'symlink', 'excluded', 'unreadable']), mode: z.number(), hash: z.string().optional(), target: z.string().optional() })
export const snapshotSchema = z.record(z.string(), entrySchema)
export type Snapshot = z.infer<typeof snapshotSchema>
export type Entry = z.infer<typeof entrySchema>

/**
 * `excludeLinkedDependencies`: a history snapshot records a hard-linked file under a node_modules
 * component below a snapshot root (never one of the root's own, review L3) as `excluded` instead of refusing
 * the whole snapshot, so a pnpm workspace still records an unrelated write (GPT review of c71dee5, history
 * snapshots). A hard link anywhere else is still refused, since restoring one would write through to the
 * other names of the same file.
 *
 * `onBackslashName`: given, an entry whose name is not one plain name (a backslash on Linux or macOS) is recorded as
 * `excluded` and named to it relative to its root, backslash as listed, so one such name does not stop every write;
 * absent, the snapshot is refused and the refusal names it the same way. pathe would read the name as another path,
 * so it is never captured or restored as one. `platform`: on Windows a file another program holds open without read
 * sharing is recorded as `unreadable` rather than failing the capture.
 */
export function snapshot(input: { roots: string[]; excluded: string[]; maxBytes: number; save: (hash: string, content: Buffer) => void; excludeLinkedDependencies?: boolean; onBackslashName?: (shown: string, root: string) => void; platform?: NodeJS.Platform }): Snapshot {
  const result: Snapshot = {}
  const roots = input.roots.map(root => resolve(root))
  const platform = input.platform ?? process.platform
  let bytes = 0
  let count = 0
  function visit(path: string, root: string): void {
    if (isInsideAny(input.excluded, path) || Object.hasOwn(result, path)) return
    if (++count > 100_000) throw new Error('History snapshot exceeds 100,000 entries; narrow the workspace')
    let stat
    try { stat = lstatSync(path) } catch (error) { if (isMissing(error)) return; throw error }
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) result[path] = { kind: 'symlink', mode, target: readlinkSync(path) }
    else if (stat.isDirectory()) {
      result[path] = { kind: 'directory', mode }
      for (const name of readdirSync(path)) {
        if (isPlainName(name)) visit(join(path, name), root)
        else excludeName({ directory: path, name, root })
      }
    } else if (stat.isFile()) {
      if (stat.nlink > 1 && input.excludeLinkedDependencies && isDependencyBelowRoot(path, roots)) {
        result[path] = { kind: 'excluded', mode }
        return
      }
      if (stat.nlink > 1) throw new Error('History cannot safely restore hard-linked files')
      bytes += stat.size
      if (bytes > input.maxBytes) throw new Error('History snapshot exceeds its configured byte limit')
      const content = captureFile(path, stat, platform)
      if (content === null) { result[path] = { kind: 'unreadable', mode }; return }
      const hash = createHash('sha256').update(content).digest('hex')
      input.save(hash, content)
      result[path] = { kind: 'file', mode, hash }
    } else throw new Error('History cannot capture special filesystem entries')
  }
  /** Joined as listed, never by pathe, which would read the backslash as a separator. */
  function excludeName(entry: { directory: string; name: string; root: string }): void {
    const shown = entryBelowRoot(entry.root, entry.directory, entry.name)
    if (!input.onBackslashName) throw new Error(`History cannot capture ${shown}, whose name holds a backslash, which Buckle reads as a separator`)
    if (++count > 100_000) throw new Error('History snapshot exceeds 100,000 entries; narrow the workspace')
    const path = `${entry.directory.endsWith('/') ? entry.directory : `${entry.directory}/`}${entry.name}`
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) return
    result[path] = { kind: 'excluded', mode: stat.mode & 0o777 }
    input.onBackslashName(shown, entry.root)
  }
  for (const root of roots) visit(root, root)
  return result
}

/**
 * A regular file's content, read through a descriptor opened without following a link; null on Windows when another
 * program holds the file open without read sharing, which the open or the read answers with EBUSY.
 */
function captureFile(path: string, stat: Stats, platform: NodeJS.Platform): Buffer | null {
  let descriptor: number
  try { descriptor = openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK, undefined, platform) }
  catch (error) { if (isHeldOpen(error, platform)) return null; throw error }
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error('File changed during history capture')
    let content: Buffer
    try { content = readFileSync(descriptor) } catch (error) { if (isHeldOpen(error, platform)) return null; throw error }
    const after = fstatSync(descriptor)
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('File changed during history capture; retry when the workspace is idle')
    return content
  } finally { closeSync(descriptor) }
}

function isHeldOpen(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EBUSY'
}

/** An entry history records without content (entrySchema): it never restores, removes or rewrites one. */
function isUncaptured(entry: Entry | undefined): boolean {
  return entry?.kind === 'excluded' || entry?.kind === 'unreadable'
}

/** The paths whose entry differs, never one recorded without content on either side: history leaves those as it finds them. */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => !isUncaptured(before[path]) && !isUncaptured(after[path]) && !sameEntry(before[path], after[path])).sort()
}

/**
 * The paths whose entry differs where either side was recorded without content (an excluded or unreadable entry): a
 * change no restore puts back. Listed as not restorable.
 */
export function notRestorablePaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => (isUncaptured(before[path]) || isUncaptured(after[path])) && !sameEntry(before[path], after[path])).sort()
}

export function sameEntry(left: Entry | undefined, right: Entry | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Makes `paths` match `target`. Every entry is made beneath its parent directory opened from the real
 * root down without following a link, and files are written to a fresh name and renamed into place,
 * so a link swapped into the tree after the checkpoint check is refused instead of followed (review H1
 * of B23-B25). `roots` are the directories the snapshots were taken from; every path is inside one.
 */
export function applySnapshot(input: { target: Snapshot; current: Snapshot; paths: string[]; content: (hash: string) => Buffer; roots: string[]; platform?: NodeJS.Platform }): void {
  const directories = createDirectoryCache(input.roots)
  try {
    // Children leave before parents. Never recursively delete untracked contents.
    for (const path of [...input.paths].sort((a, b) => b.length - a.length)) {
      const current = input.current[path]
      const target = input.target[path]
      if (current && (!target || target.kind !== current.kind || current.kind === 'symlink')) {
        const { directory, name } = directories.parentOf(path, false)
        if (current.kind === 'directory') rmdirSync(directory.child(name))
        else rmSync(directory.child(name))
      }
    }
    // A directory removed above may be made again below: nothing opened before stands in for it.
    directories.close()
    for (const path of [...input.paths].sort((a, b) => a.length - b.length)) {
      const entry = input.target[path]
      if (!entry) continue
      const { directory, name } = directories.parentOf(path, true)
      if (entry.kind === 'directory') {
        try { mkdirSync(directory.child(name), { mode: 0o700 }) } catch (error) { if (!isExisting(error)) throw error }
        changeMode(directory, name, entry.mode | 0o700, path)
      }
      else if (entry.kind === 'symlink') restoreLink({ target: entry.target!, at: directory.child(name), parent: directory.self, shown: path, platform: input.platform })
      else if (entry.kind === 'file') writeRestoredFile({ directory, name, path, content: input.content(entry.hash!), mode: entry.mode })
    }
    for (const path of [...input.paths].sort((a, b) => b.length - a.length)) {
      const entry = input.target[path]
      if (entry?.kind !== 'directory') continue
      const { directory, name } = directories.parentOf(path, false)
      changeMode(directory, name, entry.mode, path)
    }
  } finally { directories.close() }
}

/** How many opened parent directories one apply keeps; snapshots list siblings together, so few are needed. */
const OPEN_DIRECTORIES = 64

function createDirectoryCache(roots: string[]) {
  const open = new Map<string, PinnedDirectory>()
  const realRoots = new Map<string, string>()
  const closeAll = () => { for (const directory of open.values()) directory.close(); open.clear() }
  return {
    /** The pinned parent of a snapshot path, reached from its root's real path. */
    parentOf(path: string, create: boolean): { directory: PinnedDirectory; name: string } {
      const root = roots.find(candidate => isInside(candidate, path))
      if (!root) throw new Error('A checkpoint path is outside the roots it was taken from')
      const anchor = path === root ? parentDirectory(root) : root
      if (!realRoots.has(anchor)) realRoots.set(anchor, nativePath(realpathSync(anchor)))
      const parent = join(realRoots.get(anchor)!, relative(anchor, parentDirectory(path)))
      let directory = open.get(parent)
      if (!directory) {
        if (open.size >= OPEN_DIRECTORIES) closeAll()
        directory = openRealDirectory(parent, { create })
        open.set(parent, directory)
      }
      return { directory, name: basename(path) }
    },
    close: closeAll,
  }
}

/**
 * symlinkSync's type for a restored link on Windows, decided as Node decides it, from the target as seen from the
 * link's directory: a junction for a directory, which needs no privilege, and a file link otherwise. Elsewhere none.
 */
export function restoredLinkType(input: { target: string; parent: string; platform?: NodeJS.Platform }): 'junction' | 'file' | undefined {
  if ((input.platform ?? process.platform) !== 'win32') return undefined
  return statSync(resolve(input.parent, input.target), { throwIfNoEntry: false })?.isDirectory() ? 'junction' : 'file'
}

/**
 * Makes a recorded link again. A file link on Windows needs Developer Mode or an administrator; without either the
 * restore stops there with that reason, not with the system's bare EPERM.
 */
export function restoreLink(input: { target: string; at: string; parent: string; shown: string; platform?: NodeJS.Platform; symlink?: typeof symlinkSync }): void {
  const type = restoredLinkType(input)
  try {
    (input.symlink ?? symlinkSync)(input.target, input.at, type)
  } catch (error) {
    if (type === undefined || !(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error
    throw new Error(`Windows refused to make the symbolic link ${input.shown}: a file link needs Developer Mode or an administrator, so the restore stopped there`, { cause: error })
  }
}

function changeMode(directory: PinnedDirectory, name: string, mode: number, shown: string): void {
  const descriptor = openBeneath(directory, name, constants.O_RDONLY, shown)
  try { setDescriptorMode(descriptor, mode) } finally { closeSync(descriptor) }
}

function writeRestoredFile(input: { directory: PinnedDirectory; name: string; path: string; content: Buffer; mode: number }): void {
  const temporary = `${input.name}.buckle-restore-${randomUUID()}`
  // Reserved before the cleanup below owns the name, so a name already taken is never removed.
  const descriptor = openBeneath(input.directory, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, input.path, input.mode)
  try {
    try {
      writeFileSync(descriptor, input.content)
      setDescriptorMode(descriptor, input.mode)
    } finally { closeSync(descriptor) }
    renameSync(input.directory.child(temporary), input.directory.child(input.name))
  } finally { rmSync(input.directory.child(temporary), { force: true }) }
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function assertSnapshotMatches(input: { current: Snapshot; expected: Snapshot; target: Snapshot; paths: string[]; operation: 'Restore' | 'Promotion' }): void {
  if (input.paths.some(path => !sameEntry(input.current[path], input.expected[path]))) throw new Error(`${input.operation} conflict: a changed path no longer matches the checkpoint`)
  for (const path of input.paths) {
    for (let parent = parentDirectory(path); parent !== parentDirectory(parent); parent = parentDirectory(parent)) {
      if (!sameEntry(input.current[parent], input.expected[parent])) throw new Error(`${input.operation} conflict: a parent directory changed since the checkpoint`)
    }
  }
  for (const path of input.paths) if (input.expected[path]?.kind === 'directory' && input.target[path]?.kind !== 'directory') {
    // Snapshot paths are in pathe's form, so `/` separates them on every platform.
    const below = path.endsWith('/') ? path : `${path}/`
    if (Object.keys(input.current).some(child => child.startsWith(below) && !Object.hasOwn(input.expected, child))) throw new Error(`${input.operation} conflict: a directory contains newer files`)
    // Removing it would remove a file history never captured and leaves untouched.
    const uncaptured = [...Object.entries(input.current), ...Object.entries(input.expected)].filter(([child, entry]) => isUncaptured(entry) && child.startsWith(below))
    if (uncaptured.some(([child]) => child.includes('\\'))) throw new Error(`${input.operation} conflict: a directory holds a name with a backslash, which history does not capture; rename or remove it and restore again`)
    if (uncaptured.some(([, entry]) => entry.kind === 'unreadable')) throw new Error(`${input.operation} conflict: a directory holds a file another program held open, which history could not read; close that program and restore again`)
    if (uncaptured.length) throw new Error(`${input.operation} conflict: a directory holds hard-linked dependency files history does not capture; remove only those hard-linked files (a package manager puts them back) and restore again`)
  }
}
