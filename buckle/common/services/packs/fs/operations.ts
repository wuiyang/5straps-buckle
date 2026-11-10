import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { constants, fstatSync, ftruncateSync, lstatSync, readFileSync, writeSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'pathe'
// node:path's matchesGlob, not pathe's, which matches otherwise: here a `*` leaves dot names out and a leading `!` is
// literal, as the name search always matched. Case is folded where the volume ignores it (nameMatches).
import { matchesGlob } from 'node:path'
import type { JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openDirectoryBeneath, openRealDirectory, withFileBeneath, type PinnedDirectory } from '../../../adapters/beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { childPath, comparablePath, ignoresCase, isPlainName } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { isMissingPathError } from '../../../domain/filesystem-errors.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { isIgnoredDirectory } from './ignore.js'
import { folderRefusal, missingRefusal, parentRefusal, refusing } from './missing-path.js'
import { pageLines } from './read-lines.js'
import type * as schemas from './schemas.js'

const MAX_FILE_BYTES = 10 * 1_048_576
const MAX_TREE_ENTRIES = 5_000
/** How deep a name search descends; each level holds one open directory while the walk is beneath it. */
const MAX_FIND_DEPTH = 256

export interface FsContext {
  paths: PathView
  /** Buckle's protected roots: a hard-linked file on their device is not read (isLinkedOnStateDevice). */
  protectedRoots?: readonly string[]
  /** Judges a host path where it lands now (ToolContext.authorizeRead). */
  authorizeRead?: (path: string) => Promise<boolean>
  authorizeReadTarget?: (target: string) => boolean
  authorizeWrite?: (target: string) => boolean
  /** Marks a real path whose content this session now has, read or written (ToolContext.known). */
  known?: (target: string) => void
  /** The host's unless a test imitates another: on Windows and macOS a name search ignores case. */
  platform?: NodeJS.Platform
}

/**
 * A read opens the target its permission check judged, beneath a parent reached without following a
 * link, and never the name again, so a link swapped in after the check is refused rather than followed
 * (filesystem-boundary.md, "File tool resolution"; review item 4 of the proof-of-possession fixes).
 */
export async function readFileEntry(
  input: z.output<typeof schemas.readInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const target = judgedTarget(path, 'read', context)
  const { buffer, size } = refusing(() => withFileBeneath(target, { flags: constants.O_RDONLY, shown: input.path, ...(context.protectedRoots ? { protectedRoots: context.protectedRoots, roots: context.paths.reachableRoots } : {}) }, (descriptor) => {
    const info = fstatSync(descriptor)
    if (info.size > MAX_FILE_BYTES) throw new ToolInputError(`File exceeds ${MAX_FILE_BYTES} bytes`)
    return { buffer: readFileSync(descriptor), size: info.size }
  }), error => missingRefusal(error, { named: input.path, wanted: 'file', outcome: 'nothing was read' }))
  context.known?.(target)
  const hash = createHash('sha256').update(buffer).digest('hex')
  if (input.encoding === 'base64') {
    return { path: context.paths.display(path), encoding: 'base64', hash, content: buffer.toString('base64'), size }
  }

  return {
    path: context.paths.display(path),
    encoding: 'utf8',
    validUtf8: isUtf8(buffer),
    hash,
    size,
    ...pageLines(buffer.toString('utf8'), input),
  }
}

export async function writeFileEntry(
  input: z.output<typeof schemas.writeInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const content = Buffer.from(input.content, input.encoding)
  if (content.byteLength > MAX_FILE_BYTES) throw new ToolInputError(`Content exceeds ${MAX_FILE_BYTES} bytes`)
  const target = judgedTarget(path, 'write', context)
  const createParents = input.createParents === true
  if (input.expectedHash) {
    // Buckle's comparison and write share one descriptor and one event-loop turn; host editors remain independent.
    const expected = input.expectedHash
    try {
      withFileBeneath(target, { flags: constants.O_RDWR, createParents }, (descriptor) => {
        if (createHash('sha256').update(readFileSync(descriptor)).digest('hex') !== expected) throw new ToolInputError('File changed since it was opened. Reload before saving.')
        replaceContent(descriptor, content)
      })
    } catch (error) {
      if (isMissingPathError(error)) throw new ToolInputError('File changed or is unavailable. Reload before saving.')
      throw error
    }
  } else {
    // The open creates the file, so a path of nothing is its folder's.
    refusing(() => withFileBeneath(target, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, createParents }, descriptor => writeAll(descriptor, content)), error => parentRefusal(error, input.path))
  }
  context.known?.(target)
  return { path: context.paths.display(path), size: content.byteLength, hash: createHash('sha256').update(content).digest('hex') }
}

export async function patchFile(
  input: z.output<typeof schemas.patchInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const target = judgedTarget(path, 'write', context)
  const patched = refusing(() => withFileBeneath(target, { flags: constants.O_RDWR }, (descriptor) => {
    // As fs_read and fs_apply_patch hold it: a file this size is not read whole, and the destructive-write check cannot size its result.
    if (fstatSync(descriptor).size > MAX_FILE_BYTES) throw new ToolInputError(`${input.path} exceeds ${MAX_FILE_BYTES} bytes, so nothing was patched`)
    const { content, replacements } = applyEdits(readFileSync(descriptor, 'utf8'), input.edits)
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ToolInputError(`Patched file exceeds ${MAX_FILE_BYTES} bytes`)
    replaceContent(descriptor, Buffer.from(content, 'utf8'))
    return { path: context.paths.display(path), replacements, size: Buffer.byteLength(content) }
  }), error => missingRefusal(error, { named: input.path, wanted: 'file', outcome: 'nothing was patched' }))
  context.known?.(target)
  return patched
}

/** fs_patch's edits applied in order to a file's text; one that matches nowhere, or more than once without replaceAll, is refused. */
export function applyEdits(text: string, edits: z.output<typeof schemas.patchInput>['edits']): { content: string; replacements: number[] } {
  let content = text
  const replacements: number[] = []
  for (const edit of edits) {
    const count = countOccurrences(content, edit.oldText)
    if (count === 0) throw new ToolInputError('Patch text was not found')
    if (!edit.replaceAll && count !== 1) {
      throw new ToolInputError(`Patch text matched ${count} times; set replaceAll or add surrounding context`)
    }
    // A replacer function, not the string: `$&`, `$$`, and `$1` in newText are written as typed, as on the split/join branch.
    content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, () => edit.newText)
    replacements.push(edit.replaceAll ? count : 1)
  }
  return { content, replacements }
}

/** What fs_patch leaves of its file, for the destructive-write check: worked out from the file as it stands, where it may be read. */
export function patchedSize(input: z.output<typeof schemas.patchInput>, current: (path: string) => Buffer | null): Array<{ path: string; size: number }> {
  const before = current(input.path)
  if (before === null) return []
  try {
    return [{ path: input.path, size: Buffer.byteLength(applyEdits(before.toString('utf8'), input.edits).content) }]
  } catch {
    return []
  }
}

/** What fs_write and each file of fs_write_batch leaves: the content it writes. */
export function writtenSize(input: z.output<typeof schemas.writeInput>): { path: string; size: number } {
  // The bytes the writer decodes, not the length the text promises: Buffer.byteLength overstates malformed base64.
  return { path: input.path, size: input.encoding === 'base64' ? Buffer.from(input.content, 'base64').byteLength : Buffer.byteLength(input.content) }
}

/**
 * Where a read or write lands: the named path with every link followed, dangling ones included, which
 * is what the permission rules judged (resolve-effects.ts). When the call carries its judged targets, a
 * path that resolves anywhere else now (a link swapped in while the call waited) is refused.
 */
function judgedTarget(path: string, operation: 'read' | 'write', context: FsContext): string {
  const target = resolveTarget(path, { shares: context.paths.shares })
  const authorize = operation === 'read' ? context.authorizeReadTarget : context.authorizeWrite
  if (authorize && !authorize(target)) {
    throw new ToolInputError(`${context.paths.display(path)} now resolves to a place its permission check did not see; send the call again`, { code: 'PERMISSION_DENIED' })
  }
  return target
}

function replaceContent(descriptor: number, content: Buffer): void {
  ftruncateSync(descriptor, 0)
  writeAll(descriptor, content)
}

function writeAll(descriptor: number, content: Buffer): void {
  let offset = 0
  while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset, offset)
}

export async function listTree(
  input: z.output<typeof schemas.listInput>,
  context: FsContext,
): Promise<JsonValue> {
  const root = context.paths.resolve(input.path)
  const entries: JsonValue[] = []
  await withDirectoryBeneath(root, context, { named: input.path, outcome: 'nothing was listed' }, (directory, real) => walkTree({ real, shown: '', directory, depth: input.depth, includeIgnored: input.includeIgnored, entries, authorizeRead: context.authorizeRead, platform: context.platform ?? process.platform }))
  return { path: context.paths.display(root), entries, truncated: entries.length >= MAX_TREE_ENTRIES }
}

export async function findNames(
  input: z.output<typeof schemas.findInput>,
  context: FsContext,
): Promise<JsonValue> {
  const root = context.paths.resolve(input.path)
  const matches: string[] = []
  const walk = { deep: false }
  await withDirectoryBeneath(root, context, { named: input.path, outcome: 'nothing was searched' }, (directory, real) => walkNames({ real, shown: '', directory, depth: 0, walk, pattern: input.pattern, limit: input.limit, includeIgnored: input.includeIgnored, matches, authorizeRead: context.authorizeRead, platform: context.platform ?? process.platform }))
  return { path: context.paths.display(root), matches, truncated: matches.length >= input.limit || walk.deep }
}

/**
 * A listing walks the judged directory from a descriptor reached without following a link, and each
 * level below it from its parent's, so a link swapped into the tree after a check is refused rather
 * than listed through (review item 4 of the proof-of-possession fixes). Each child is judged on its
 * own before it is shown, at its real path beneath the judged directory, never through the agent's
 * name, which a link flipped during the walk could point elsewhere (review H1 of the second
 * proof-of-possession re-review).
 */
async function withDirectoryBeneath(root: string, context: FsContext, sent: { named: string; outcome: string }, walk: (directory: PinnedDirectory, real: string) => Promise<void>): Promise<void> {
  const target = judgedTarget(root, 'read', context)
  const directory = refusing(() => openRealDirectory(target, { refusal: { shown: context.paths.display(root), outcome: 'it was not listed' } }), error => folderRefusal(error, { ...sent, target }))
  try { await walk(directory, target) } finally { directory.close() }
}

async function descend(input: { directory: PinnedDirectory; name: string; shown: string }, walk: (directory: PinnedDirectory) => Promise<void>): Promise<void> {
  const directory = openDirectoryBeneath(input.directory, input.name, input.shown)
  try { await walk(directory) } finally { directory.close() }
}

/**
 * `directory` is what is read; `real` is its judged real path, where each child is judged; `shown` names
 * it from the listed root, for display only.
 */
async function walkTree(input: {
  real: string
  shown: string
  directory: PinnedDirectory
  depth: number
  includeIgnored: boolean
  entries: JsonValue[]
  authorizeRead?: (path: string) => Promise<boolean>
  platform: NodeJS.Platform
}): Promise<void> {
  if (input.entries.length >= MAX_TREE_ENTRIES) return
  const children = (await readdir(input.directory.self, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const child of children) {
    if (input.entries.length >= MAX_TREE_ENTRIES) return
    if (child.isDirectory() && isIgnoredDirectory(child.name, input.includeIgnored)) continue
    // A name read as another path (a backslash on Linux, a dot or a space that ends it on Windows) would be judged there: left out.
    if (!isPlainName(child.name, input.platform)) continue

    const real = childPath(input.real, child.name)
    const shown = join(input.shown, child.name)
    if (input.authorizeRead && !await input.authorizeRead(real)) continue
    const info = lstatSync(input.directory.child(child.name))
    input.entries.push({
      path: shown,
      name: child.name,
      type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    })
    if (child.isDirectory() && !child.isSymbolicLink() && input.depth > 0) {
      await descend({ directory: input.directory, name: child.name, shown }, directory => walkTree({ ...input, real, shown, directory, depth: input.depth - 1 }))
    }
  }
}

/** As walkTree: children are judged at `real`, matched and shown by `shown`. */
async function walkNames(input: {
  real: string
  shown: string
  directory: PinnedDirectory
  depth: number
  /** Set when a level past MAX_FIND_DEPTH was left unsearched. */
  walk: { deep: boolean }
  pattern: string
  limit: number
  includeIgnored: boolean
  matches: string[]
  authorizeRead?: (path: string) => Promise<boolean>
  platform: NodeJS.Platform
}): Promise<void> {
  if (input.matches.length >= input.limit) return
  for (const child of await readdir(input.directory.self, { withFileTypes: true })) {
    if (input.matches.length >= input.limit) return
    if (child.isDirectory() && isIgnoredDirectory(child.name, input.includeIgnored)) continue
    if (!isPlainName(child.name, input.platform)) continue

    const real = childPath(input.real, child.name)
    const shown = join(input.shown, child.name)
    if (input.authorizeRead && !await input.authorizeRead(real)) continue
    if (nameMatches(shown, input.pattern, input.platform) || nameMatches(basename(shown), input.pattern, input.platform)) {
      input.matches.push(shown)
    }
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    if (input.depth >= MAX_FIND_DEPTH) { input.walk.deep = true; continue }
    await descend({ directory: input.directory, name: child.name, shown }, directory => walkNames({ ...input, real, shown, directory, depth: input.depth + 1 }))
  }
}

/** A glob match as the volume compares names: case folded on Windows and macOS (comparablePath), exact elsewhere. */
function nameMatches(name: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  return matchesGlob(comparablePath(name, ignoresCase(platform)), comparablePath(pattern, ignoresCase(platform)))
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let position = 0
  while ((position = content.indexOf(needle, position)) !== -1) {
    count += 1
    position += needle.length
  }
  return count
}

