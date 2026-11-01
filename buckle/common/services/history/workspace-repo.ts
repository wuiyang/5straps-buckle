import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'pathe'

/**
 * Slice F3 (owner question X6): a command's folder that lies in a git repository with a commit refers to that
 * repository's objects instead of copying them. These are the pure parts: the repository's index read, the seed written
 * from it, git's object listings read, and the record that names the repository a shadow index refers to.
 */

/** One index entry as read: its 40 bytes of stat data (ctime to size), blob id, flags, extended flags, and name. */
export interface IndexEntry { stat: Buffer; id: string; flags: number; extended: number; name: Buffer }

/** Where `git rev-parse` found the repository a folder lies in, all absolute: its work tree's top, index, and objects. */
export interface RepositoryLocation { top: string; index: string; objects: string }

/** The record, in a root's shadow git folder, of the repository whose objects its shadow index refers to. */
export interface SourceRecord { objects: string; stamp: string }

const SOURCE_RECORD = 'source'
/** Beside it, each blob id the seed found the repository holding, 20 bytes each: what the sweep need not keep a copy of. */
const SOURCE_IDS = 'source-ids'
const STAGE_MASK = 0x3000
const ASSUME_VALID = 0x8000
const EXTENDED = 0x4000
const SKIP_WORKTREE = 0x4000
const NAME_MASK = 0x0fff
/** The modes a seed keeps: a file, an executable one, and a link. A nested repository (160000) git adds on its own. */
const SEEDED_MODES = new Set([0o100644, 0o100755, 0o120000])

/** The arguments of the one `git rev-parse` that locates a folder's repository; its answer reads with `parseLocation`. */
export const LOCATE_ARGS = ['rev-parse', '--path-format=absolute', '--show-object-format', '--show-toplevel', '--git-path', 'index', '--git-path', 'objects', 'HEAD^{commit}']

/**
 * The repository `LOCATE_ARGS` answered: SHA-1 objects, a work tree, and a commit at HEAD. undefined for any other
 * answer, as from a git too old to know an option, which it echoes back.
 */
export function parseLocation(output: string): RepositoryLocation | undefined {
  const lines = output.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== 5) return undefined
  const [format, top, index, objects, commit] = lines as [string, string, string, string, string]
  if (format !== 'sha1' || !/^[0-9a-f]{40}$/.test(commit) || ![top, index, objects].every(path => isAbsolute(path))) return undefined
  return { top, index, objects }
}

/** `root` as a path below the repository's top, `''` for the top itself; undefined where it is not inside it. */
export function prefixWithin(top: string, root: string): string | undefined {
  let real: { top: string; root: string }
  try { real = { top: realpathSync.native(top), root: realpathSync.native(root) } } catch { return undefined }
  const path = relative(real.top, real.root)
  return path === '..' || path.startsWith('../') || isAbsolute(path) ? undefined : path
}

/** The repository's index as read, with its file's modification time in whole seconds, where git's racy check counts. */
export function readRepositoryIndex(path: string): { index: Buffer; mtimeSeconds: number } | undefined {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) return undefined
    const index = Buffer.alloc(stat.size)
    let read = 0
    while (read < index.length) { const bytes = readSync(descriptor, index, read, index.length - read, read); if (!bytes) return undefined; read += bytes }
    return { index, mtimeSeconds: Math.floor(stat.mtimeMs / 1000) }
  } catch { return undefined }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

/**
 * A git index read in full, version 2 to 4, its trailing checksum checked (all zero where `index.skipHash` left it).
 * `plain` holds where git needs nothing beyond the entries to read it: no extension a reader must understand (a split
 * index's `link`, a sparse index's `sdir`) and no entry outside a sparse checkout (skip-worktree). undefined for
 * anything else, or data cut short.
 */
export function parseIndex(index: Buffer): { entries: IndexEntry[]; plain: boolean } | undefined {
  if (index.length < 32 || index.toString('latin1', 0, 4) !== 'DIRC') return undefined
  const version = index.readUInt32BE(4)
  if (version < 2 || version > 4) return undefined
  const end = index.length - 20
  const sum = index.subarray(end)
  if (!sum.every(byte => byte === 0) && !createHash('sha1').update(index.subarray(0, end)).digest().equals(sum)) return undefined
  const count = index.readUInt32BE(8)
  const entries: IndexEntry[] = []
  let plain = true
  let offset = 12
  let previous: Buffer = Buffer.alloc(0)
  for (let entry = 0; entry < count; entry++) {
    const start = offset
    if (start + 62 > end) return undefined
    const flags = index.readUInt16BE(start + 60)
    let at = start + 62
    let extended = 0
    if (flags & EXTENDED) { if (version < 3 || at + 2 > end) return undefined; extended = index.readUInt16BE(at); at += 2 }
    let name: Buffer
    if (version === 4) {
      // The bytes to drop from the end of the previous name, as git's varint, then the rest of this one, NUL-ended.
      let byte = index[at++]
      if (byte === undefined) return undefined
      let strip = byte & 127
      while (byte & 128) { byte = index[at++]; if (byte === undefined || at > end) return undefined; strip = (strip + 1) * 128 + (byte & 127) }
      const nul = index.indexOf(0, at)
      if (nul < 0 || nul >= end || strip > previous.length) return undefined
      name = Buffer.concat([previous.subarray(0, previous.length - strip), index.subarray(at, nul)])
      offset = nul + 1
    } else {
      const nul = index.indexOf(0, at)
      if (nul < 0 || nul >= end) return undefined
      name = index.subarray(at, nul)
      offset = start + Math.ceil((nul - start + 1) / 8) * 8
    }
    if (extended & SKIP_WORKTREE) plain = false
    entries.push({ stat: index.subarray(start, start + 40), id: index.toString('hex', start + 40, start + 60), flags, extended, name })
    previous = name
  }
  if (offset > end) return undefined
  while (offset < end) {
    if (offset + 8 > end) return undefined
    const size = index.readUInt32BE(offset + 4)
    if (offset + 8 + size > end) return undefined
    if (!/^[A-Z]/.test(index.toString('latin1', offset, offset + 4))) plain = false
    offset += 8 + size
  }
  return { entries, plain }
}

/**
 * The entries of the repository's index a shadow index may start from, named below the folder: each of stage 0 with a
 * file's or a link's mode, outside every protected name (`protect`, below the folder too), neither assumed unchanged nor
 * added with intent only, and older than the index file itself by its whole second, as git checks the content of any
 * entry as new as its index (racily clean) and a copy of it written later would not.
 */
export function seedCandidates(input: { entries: IndexEntry[]; mtimeSeconds: number; prefix: string; protect: string[] }): IndexEntry[] {
  const prefix = input.prefix === '' ? Buffer.alloc(0) : Buffer.from(`${input.prefix}/`)
  const protect = input.protect.map(name => Buffer.from(name))
  const found: IndexEntry[] = []
  for (const entry of input.entries) {
    if (entry.flags & (STAGE_MASK | ASSUME_VALID) || entry.extended) continue
    if (!SEEDED_MODES.has(entry.stat.readUInt32BE(24)) || entry.stat.readUInt32BE(8) >= input.mtimeSeconds) continue
    if (!entry.name.subarray(0, prefix.length).equals(prefix)) continue
    const name = entry.name.subarray(prefix.length)
    if (protect.some(hidden => name.equals(hidden) || (name.length > hidden.length && name[hidden.length] === 0x2f && name.subarray(0, hidden.length).equals(hidden)))) continue
    found.push({ ...entry, name })
  }
  return found
}

/** The stat size an entry holds, which git keeps as its low 32 bits. */
export function entrySize(entry: IndexEntry): number { return entry.stat.readUInt32BE(36) }
/** Whether an entry names a blob: a file's or a link's, never a nested repository's commit. */
export function namesBlob(entry: IndexEntry): boolean { return SEEDED_MODES.has(entry.stat.readUInt32BE(24)) }

/** A version 2 index of `entries`, in their order, with no extension: what a shadow index is seeded with. */
export function writeIndex(entries: IndexEntry[]): Buffer {
  const parts: Buffer[] = []
  const header = Buffer.alloc(12); header.write('DIRC', 0, 'latin1'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8)
  parts.push(header)
  for (const entry of entries) {
    const fixed = Buffer.alloc(62)
    entry.stat.copy(fixed, 0); fixed.write(entry.id, 40, 'hex'); fixed.writeUInt16BE(Math.min(entry.name.length, NAME_MASK), 60)
    const length = 62 + entry.name.length
    parts.push(fixed, entry.name, Buffer.alloc(Math.ceil((length + 1) / 8) * 8 - length))
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}

/** `git cat-file --batch-check` read: each id's size where it names a blob; absent where git answers it missing or another kind. */
export function parseBatchCheck(output: Buffer): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of output.toString('latin1').split('\n')) {
    const found = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(line)
    if (found) sizes.set(found[1]!, Number(found[2]))
  }
  return sizes
}

/** `git cat-file --batch` read: each blob's content by id; an id git answers missing, or another kind, is absent. */
export function parseBatch(output: Buffer): Map<string, Buffer> | undefined {
  const contents = new Map<string, Buffer>()
  let at = 0
  while (at < output.length) {
    const newline = output.indexOf(10, at)
    if (newline < 0) return undefined
    const header = output.toString('latin1', at, newline)
    at = newline + 1
    const found = /^([0-9a-f]{40}) ([a-z]+) ([0-9]+)$/.exec(header)
    if (!found) { if (/^[0-9a-f]{40} missing$/.test(header)) continue; return undefined }
    const size = Number(found[3])
    if (at + size + 1 > output.length || output[at + size] !== 10) return undefined
    if (found[2] === 'blob') contents.set(found[1]!, output.subarray(at, at + size))
    at += size + 1
  }
  return contents
}

/** The value of `GIT_ALTERNATE_OBJECT_DIRECTORIES` naming one folder, quoted as git reads it, so no character splits it. */
export function alternateValue(objects: string): string { return `"${objects.replace(/[\\"]/g, '\\$&')}"` }

/**
 * Where the repository's objects stand on disk: the identity of its objects folder and of its pack folder, which a
 * collection, a fetch, a deletion, or a new repository in its place changes. Read with no git at each capture.
 */
export function sourceStamp(objects: string): string {
  return [objects, join(objects, 'pack')].map(path => { const stat = lstatSync(path, { throwIfNoEntry: false }); return stat?.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}` : '-' }).join('|')
}

/** The record of a root's shadow git folder: undefined where none stands, `invalid` where one does not read. */
export function readSource(git: string): SourceRecord | 'invalid' | undefined {
  let text: string
  try { text = readFileSync(join(git, SOURCE_RECORD), 'utf8') } catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? undefined : 'invalid' }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'objects' in parsed && 'stamp' in parsed && typeof parsed.objects === 'string' && typeof parsed.stamp === 'string' && isAbsolute(parsed.objects)) return { objects: parsed.objects, stamp: parsed.stamp }
  } catch { /* invalid below */ }
  return 'invalid'
}
export function writeSource(git: string, record: SourceRecord, ids?: string[]): void {
  if (ids) writeFileSync(join(git, SOURCE_IDS), Buffer.from(ids.join(''), 'hex'), { mode: 0o600 })
  writeFileSync(join(git, SOURCE_RECORD), JSON.stringify(record), { mode: 0o600 })
}
/** The record and its ids, the ids last, so ids never stand without the record that says they still read. */
export function removeSource(git: string): void { rmSync(join(git, SOURCE_RECORD), { force: true }); rmSync(join(git, SOURCE_IDS), { force: true }) }
/**
 * The blob ids a root's seed found its repository holding, where its record stands: the sweep keeps no copy of one an
 * index names, as a command that changes its file copies it from the repository. Empty where none stand; undefined
 * where they do not read, so the sweep keeps all an index names.
 */
export function readSourceIds(git: string): Set<string> | undefined {
  if (!lstatSync(join(git, SOURCE_RECORD), { throwIfNoEntry: false })) return new Set()
  let data: Buffer
  try { data = readFileSync(join(git, SOURCE_IDS)) } catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? new Set() : undefined }
  if (data.length % 20) return undefined
  const ids = new Set<string>()
  for (let at = 0; at < data.length; at += 20) ids.add(data.toString('hex', at, at + 20))
  return ids
}
