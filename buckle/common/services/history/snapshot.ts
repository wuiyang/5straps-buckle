import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { isDependencyBelowRoot, openBeneath, openRealDirectory, type PinnedDirectory } from '../../adapters/beneath.js'
import { setDescriptorMode } from '../../adapters/file-modes.js'
import { isInside, isInsideAny } from '../../domain/paths.js'

/**
 * `excluded`: a hard-linked file under a node_modules directory below a snapshot root (pnpm links its store
 * there), recorded without its content. History never restores, removes or rewrites one, so it is left out of
 * every change set, and a restore that would remove a directory holding one is a conflict.
 */
export const entrySchema = z.object({ kind: z.enum(['file', 'directory', 'symlink', 'excluded']), mode: z.number(), hash: z.string().optional(), target: z.string().optional() })
export const snapshotSchema = z.record(z.string(), entrySchema)
export type Snapshot = z.infer<typeof snapshotSchema>
export type Entry = z.infer<typeof entrySchema>

/**
 * `excludeLinkedDependencies`: a history snapshot records a hard-linked file under a node_modules
 * component below a snapshot root (never one of the root's own, review L3) as `excluded` instead of refusing
 * the whole snapshot, so a pnpm workspace still records an unrelated write (GPT review of c71dee5, history
 * snapshots). A hard link anywhere else is still refused, since restoring one would write through to the
 * other names of the same file.
 */
export function snapshot(input: { roots: string[]; excluded: string[]; maxBytes: number; save: (hash: string, content: Buffer) => void; excludeLinkedDependencies?: boolean }): Snapshot {
  const result: Snapshot = {}
  const roots = input.roots.map(root => resolve(root))
  let bytes = 0
  let count = 0
  function visit(path: string): void {
    if (isInsideAny(input.excluded, path) || Object.hasOwn(result, path)) return
    if (++count > 100_000) throw new Error('History snapshot exceeds 100,000 entries; narrow the workspace')
    let stat
    try { stat = lstatSync(path) } catch (error) { if (isMissing(error)) return; throw error }
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) result[path] = { kind: 'symlink', mode, target: readlinkSync(path) }
    else if (stat.isDirectory()) {
      result[path] = { kind: 'directory', mode }
      for (const name of readdirSync(path)) visit(join(path, name))
    } else if (stat.isFile()) {
      if (stat.nlink > 1 && input.excludeLinkedDependencies && isDependencyBelowRoot(path, roots)) {
        result[path] = { kind: 'excluded', mode }
        return
      }
      if (stat.nlink > 1) throw new Error('History cannot safely restore hard-linked files')
      bytes += stat.size
      if (bytes > input.maxBytes) throw new Error('History snapshot exceeds its configured byte limit')
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let content: Buffer
      try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error('File changed during history capture')
        content = readFileSync(descriptor)
        const after = fstatSync(descriptor)
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('File changed during history capture; retry when the workspace is idle')
      } finally { closeSync(descriptor) }
      const hash = createHash('sha256').update(content).digest('hex')
      input.save(hash, content)
      result[path] = { kind: 'file', mode, hash }
    } else throw new Error('History cannot capture special filesystem entries')
  }
  for (const root of roots) visit(root)
  return result
}

/** The paths whose entry differs, never one excluded on either side: history leaves those as it finds them. */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path]?.kind !== 'excluded' && after[path]?.kind !== 'excluded' && !sameEntry(before[path], after[path])).sort()
}

/**
 * The paths whose entry differs where either side is an excluded hard-linked dependency: a change history
 * recorded without content, so no restore puts it back. Listed as not restorable (review L1).
 */
export function notRestorablePaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => (before[path]?.kind === 'excluded' || after[path]?.kind === 'excluded') && !sameEntry(before[path], after[path])).sort()
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
export function applySnapshot(input: { target: Snapshot; current: Snapshot; paths: string[]; content: (hash: string) => Buffer; roots: string[] }): void {
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
      else if (entry.kind === 'symlink') symlinkSync(entry.target!, directory.child(name))
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
      const anchor = path === root ? dirname(root) : root
      if (!realRoots.has(anchor)) realRoots.set(anchor, realpathSync(anchor))
      const parent = join(realRoots.get(anchor)!, relative(anchor, dirname(path)))
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
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
      if (!sameEntry(input.current[parent], input.expected[parent])) throw new Error(`${input.operation} conflict: a parent directory changed since the checkpoint`)
    }
  }
  for (const path of input.paths) if (input.expected[path]?.kind === 'directory' && input.target[path]?.kind !== 'directory') {
    if (Object.keys(input.current).some(child => child.startsWith(`${path}/`) && !Object.hasOwn(input.expected, child))) throw new Error(`${input.operation} conflict: a directory contains newer files`)
    // Removing it would remove a file history never captured and leaves untouched.
    if (Object.entries(input.current).some(([child, entry]) => entry.kind === 'excluded' && child.startsWith(`${path}/`))) throw new Error(`${input.operation} conflict: a directory holds hard-linked dependency files history does not capture; remove only those hard-linked files (a package manager puts them back) and restore again`)
  }
}
