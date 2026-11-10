import { closeSync, constants, fstatSync, lstatSync, readSync, readdirSync, type Stats } from 'node:fs'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { EntryAppearedError, isLinkedOnStateDevice, LinkAppearedError, openBeneath, openDirectoryBeneath, openRealDirectory, type PinnedDirectory } from '../../../adapters/beneath.js'
import { isHeldOpen } from '../../../domain/filesystem-errors.js'
import type { PathView } from '../../../domain/path-view.js'
import { childPath, isInsideAny, isPlainName, parentDirectory } from '../../../domain/paths.js'
import { ToolExecutionError, ToolInputError } from '../../../domain/tool.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { IGNORE_FILES, isIgnored, parseIgnoreFile, passesGlob, type IgnoreRule } from './ignore-files.js'
import { createLineMatcher, MatchFailedError, type LineMatcher, type MatchedLine } from './line-matcher.js'
import type * as schemas from './schemas.js'
import { FILE_NOT_FOUND, SEARCH_ROOT_UNREADABLE } from './transfer.js'

/** The most files one search reads, as the ripgrep search lists at most (search.ts). */
const MAX_FILES = 5_000
/** A file larger than this is left out, as fs_read refuses one. */
const MAX_FILE_BYTES = 10 * 1_048_576
/** The most bytes one search reads in all, past which it stops and says it was cut short. */
export const SCAN_BUDGET_BYTES = 64 * 1_048_576
/** A file with a NUL byte this early is binary, and is skipped. */
const BINARY_SNIFF_BYTES = 8_192
/** The largest ignore file read; a larger one is skipped, as it is no list of patterns. */
const MAX_IGNORE_BYTES = 1_048_576
/** The most entries (files and folders) one search looks at, past which it stops and says it was cut short (a coordinator default, reversible). */
const MAX_ENTRIES = 200_000
/** How many entries the walk looks at before it gives the node's other work a turn. */
const ENTRIES_PER_TURN = 64
/** How deep the walk descends; each level holds one open directory while the walk is beneath it. */
const MAX_DEPTH = 256
/** The most skipped files the result lists; the rest are counted in `skippedMore`. */
const MAX_SKIPPED = 100
/** How many files may time out before the search stops, so a pattern that backtracks does not cost its bound on every file. */
const MAX_TIMEOUTS = 3

/** Why the walk left a file or a folder out, as the result words it. */
type SkipReason = 'held' | 'vanished' | 'changed' | 'unreadable' | 'too-large' | 'binary' | 'timeout'
const INVALID_PATTERN = 'INVALID_PATTERN'
const SEARCH_TIMED_OUT = 'SEARCH_TIMED_OUT'

/**
 * fs_search_content where ripgrep is not installed (the fs-verbs brief): a walk of the judged folder in Buckle itself,
 * each level opened beneath the one above it without following a link, with ripgrep's own ignore rules (hidden names
 * left out; .gitignore inside a git repository, .ignore, and .rgignore, each in the folder it lies in), the call's glob
 * as ripgrep reads one, and its output: each matching line as `./<path>`, its 1-based number, its text without the line
 * ending, and the byte ranges of each match. Every file is judged where it lands before it is read (`authorizeRead`), a
 * hard link on the state device is left out as fs_read refuses one, a file over 10 MiB is left out, and one with a NUL
 * byte in its first 8 KiB is skipped as binary. At most 5,000 files and 64 MiB are read; past either the result says it
 * was cut short. The pattern is a JavaScript regular expression, read with Unicode where it can be, folded for case
 * where the call asks.
 *
 * The walk never fails whole for one file or folder. One it cannot stat, open, list, or read, that vanished or changed
 * while it was read, or that the pattern or its worker failed on, is left out and listed in `skipped` with a reason (at
 * most 100, the rest counted in `skippedMore`), and the search goes on. Only a failure of the search itself ends it, as an
 * error with a code and a message that names the cause: the folder cannot be opened, the pattern is no regular
 * expression, the call's time ran out.
 */
export async function searchBuiltin(input: {
  args: z.output<typeof schemas.searchInput>
  paths: PathView
  signal: AbortSignal
  authorizeRead: (path: string) => Promise<boolean>
  protectedRoots: readonly string[]
  known?: (target: string) => void
  platform?: NodeJS.Platform
  /** The call's time limit, which the error names when the search runs past it. */
  timeoutMs?: number
  /** The bytes read in all, SCAN_BUDGET_BYTES unless a test sets a smaller one. */
  scanBudgetBytes?: number
  /** How long the pattern may take on one file, MATCH_TIMEOUT_MS unless a test sets another. */
  matchTimeoutMs?: number
}): Promise<JsonValue> {
  const compiled = compile(input.args.pattern, input.args.caseSensitive)
  const platform = input.platform ?? process.platform
  const { root, directory } = openRoot(input.args.path, input.paths)
  const state: Walk = { matches: [], files: 0, entries: 0, bytes: 0, budget: input.scanBudgetBytes ?? SCAN_BUDGET_BYTES, excluded: 0, cut: false, skipped: [], skippedMore: 0, timeouts: 0 }
  const pattern = createLineMatcher({ source: input.args.pattern, flags: compiled, signal: input.signal, ...(input.matchTimeoutMs ? { timeoutMs: input.matchTimeoutMs } : {}) })
  try {
    const above = ancestorRules({ root, paths: input.paths })
    const search: Search = { args: input.args, pattern, signal: input.signal, authorizeRead: input.authorizeRead, protectedRoots: input.protectedRoots, paths: input.paths, platform, state, ...(input.known ? { known: input.known } : {}) }
    await walk(search, { directory, real: root, shown: '', rules: [...above.rules, ...ignoreRules(directory, '', above.repository, search)], repository: above.repository, depth: 0 })
  } catch (error) {
    throw searchFailure(error, { signal: input.signal, state, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) })
  } finally {
    pattern.close()
    directory.close()
  }
  return { matches: state.matches, truncated: state.cut || state.matches.length >= input.args.limit, excludedFiles: state.excluded, skipped: state.skipped, skippedMore: state.skippedMore }
}

interface Walk {
  matches: JsonObject[]; files: number; entries: number; bytes: number; budget: number; excluded: number; cut: boolean
  /** The files and folders left out with a reason, at most MAX_SKIPPED, and how many more there were. */
  skipped: JsonObject[]; skippedMore: number
  /** The files the pattern or its worker failed on. */
  timeouts: number
}

interface Search {
  args: z.output<typeof schemas.searchInput>
  pattern: LineMatcher
  signal: AbortSignal
  authorizeRead: (path: string) => Promise<boolean>
  protectedRoots: readonly string[]
  paths: PathView
  known?: (target: string) => void
  platform: NodeJS.Platform
  state: Walk
}

interface Level { directory: PinnedDirectory; real: string; shown: string; rules: readonly IgnoreRule[]; repository: boolean; depth: number }

async function walk(search: Search, level: Level): Promise<void> {
  const { state } = search
  let names: string[]
  try {
    names = readdirSync(level.directory.self).sort()
  } catch (error) {
    if (level.depth === 0) throw rootRefusal(search.args.path, error)
    leaveOut(search, `./${level.shown}/`, error, false)
    return
  }
  for (const name of names) {
    // The walk reads folders and entries in one turn of the event loop; it gives the rest of the node a turn every so many
    // entries, so the call's timeout and cancel can end it and no other session waits on it.
    if (++state.entries % ENTRIES_PER_TURN === 0) await new Promise<void>(resolve => setImmediate(resolve))
    search.signal.throwIfAborted()
    if (state.cut || state.matches.length >= search.args.limit) return
    if (state.entries > MAX_ENTRIES) { state.cut = true; return }
    // Hidden names are left out, as ripgrep leaves them out, and a name read as another path is never judged as one.
    if (name.startsWith('.') || !isPlainName(name, search.platform)) continue
    const shown = level.shown === '' ? name : `${level.shown}/${name}`
    // An entry listed a moment ago may be gone, or held by a program that is writing it (a file being received into this folder).
    let info: Stats
    try {
      info = lstatSync(level.directory.child(name))
    } catch (error) {
      leaveOut(search, `./${shown}`, error)
      continue
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue
    if (isIgnored(level.rules, shown, info.isDirectory())) continue
    const real = childPath(level.real, name)
    if (info.isDirectory()) {
      if (level.depth >= MAX_DEPTH) { state.cut = true; continue }
      let below: PinnedDirectory
      try {
        below = openDirectoryBeneath(level.directory, name, shown)
      } catch (error) {
        leaveOut(search, `./${shown}/`, error, false)
        continue
      }
      try {
        await walk(search, { directory: below, real, shown, rules: [...level.rules, ...ignoreRules(below, shown, level.repository, search)], repository: level.repository, depth: level.depth + 1 })
      } finally { below.close() }
      continue
    }
    if (!passesGlob(search.args.glob, shown)) continue
    if (++state.files > MAX_FILES) { state.cut = true; return }
    await searchFile(search, { directory: level.directory, name, real, shown })
  }
}

async function searchFile(search: Search, file: { directory: PinnedDirectory; name: string; real: string; shown: string }): Promise<void> {
  const { state } = search
  const path = `./${file.shown}`
  let allowed: boolean
  try {
    allowed = await search.authorizeRead(file.real)
  } catch (error) {
    // Where the check could not reach the file (its own stat failed); any other failure of the check, such as an audit that cannot be written, stops the call.
    leaveOut(search, path, error)
    return
  }
  if (!allowed) { state.excluded++; return }
  const content = readFile(search, file)
  if (content === null) return
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) { skip(state, path, 'binary', false); return }
  const found = state.matches.length
  let lines: MatchedLine[]
  try {
    lines = await search.pattern.search(content, search.args.limit - found)
  } catch (error) {
    // The pattern ran past its bound on this file, or its worker failed: the file is left out. A cancel or the call's deadline is no such failure and goes on up.
    if (!(error instanceof MatchFailedError)) throw error
    skip(state, path, 'timeout')
    if (++state.timeouts >= MAX_TIMEOUTS) state.cut = true
    return
  }
  for (const match of lines) state.matches.push({ path, ...match })
  if (state.matches.length > found) search.known?.(file.real)
}

/**
 * The bytes of a file as its size said they would be, or null where it was left out and the reason recorded: it could not
 * be opened or read, it is not the regular file it was, it is over the cap, or it held another number of bytes when read.
 */
function readFile(search: Search, file: { directory: PinnedDirectory; name: string; real: string; shown: string }): Buffer | null {
  const { state } = search
  const path = `./${file.shown}`
  let descriptor: number
  try {
    descriptor = openBeneath(file.directory, file.name, constants.O_RDONLY, { shown: file.shown, outcome: 'nothing was read' })
  } catch (error) {
    leaveOut(search, path, error)
    return null
  }
  try {
    const held = fstatSync(descriptor)
    if (!held.isFile()) { skip(state, path, 'changed'); return null }
    if (isLinkedOnStateDevice({ info: held, path: file.real, protectedRoots: search.protectedRoots, roots: search.paths.reachableRoots })) { state.excluded++; return null }
    if (held.size > MAX_FILE_BYTES) { skip(state, path, 'too-large'); return null }
    if (state.bytes + held.size > state.budget) { state.cut = true; return null }
    state.bytes += held.size
    const content = readWhole(descriptor, held.size)
    if (content === null) skip(state, path, 'changed')
    return content
  } catch (error) {
    leaveOut(search, path, error)
    return null
  } finally { closeQuietly(descriptor) }
}

/**
 * Exactly `size` bytes from the start of an open file, the size taken from it a moment before. A file another program is
 * writing may hold more or fewer by now, and what it grew to may be past the cap the size was checked against: null then.
 */
function readWhole(descriptor: number, size: number): Buffer | null {
  const content = Buffer.allocUnsafe(size)
  let read = 0
  while (read < size) {
    const count = readSync(descriptor, content, read, size - read, null)
    if (count === 0) return null
    read += count
  }
  return readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) === 0 ? content : null
}

/** Records a file or a folder left out, with the reason; `counted` also counts it in `excludedFiles`, as a file the walk could not search. */
function skip(state: Walk, path: string, reason: SkipReason, counted = true): void {
  if (counted) state.excluded++
  if (state.skipped.length < MAX_SKIPPED) state.skipped.push({ path, reason })
  else state.skippedMore++
}

/** Leaves out what an error of the system failed on; an error that is no failure of that entry stops the search (searchFailure). */
function leaveOut(search: Search, path: string, error: unknown, counted = true): void {
  const reason = reasonOf(error, search.platform)
  if (reason === null) throw error
  skip(search.state, path, reason, counted)
}

/**
 * Why the system could not give an entry: gone (ENOENT, ENOTDIR), replaced by a link or a file since it was listed,
 * held open by another program (on Windows, where a writer's lock answers EBUSY or EPERM; elsewhere the same codes mean
 * a mode or an immutable file), or unreadable for any other reason it names. Null for an error that is none of these.
 */
function reasonOf(error: unknown, platform: NodeJS.Platform): SkipReason | null {
  if (error instanceof LinkAppearedError || error instanceof EntryAppearedError) return 'changed'
  const code = errnoOf(error)
  if (code === undefined) return null
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'vanished'
  if (code === 'ELOOP') return 'changed'
  return platform === 'win32' && isHeldOpen(error) ? 'held' : 'unreadable'
}

function errnoOf(error: unknown): string | undefined {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : undefined
}

/** The folder the search starts in, opened beneath its root; a refusal names the cause, with a code the agent can read. */
function openRoot(shown: string, paths: PathView): { root: string; directory: PinnedDirectory } {
  try {
    const root = resolveTarget(paths.resolve(shown), { shares: paths.shares })
    return { root, directory: openRealDirectory(root, { refusal: { shown, outcome: 'nothing was searched' } }) }
  } catch (error) {
    throw rootRefusal(shown, error)
  }
}

/** What the system said of the search's folder, as a refusal that names it: missing, not a folder, not allowed, or not readable. Any other error is returned as it is. */
function rootRefusal(shown: string, error: unknown): unknown {
  const code = errnoOf(error)
  if (code === undefined) return error
  if (code === 'ENOENT') return new ToolInputError(`There is no folder at ${shown}, so nothing was searched`, { code: FILE_NOT_FOUND })
  if (code === 'ENOTDIR') return new ToolInputError(`${shown} is not a folder, so nothing was searched; to search one file, name its folder and give the file as the glob`, { code: SEARCH_ROOT_UNREADABLE })
  if (code === 'EACCES' || code === 'EPERM') return new ToolInputError(`${shown} is a folder this node is not allowed to open (${code}), so nothing was searched`, { code: SEARCH_ROOT_UNREADABLE })
  return new ToolInputError(`${shown} could not be opened or listed (${code}), so nothing was searched`, { code: SEARCH_ROOT_UNREADABLE })
}

/**
 * The error a search that cannot go on answers with. The call's own timer ends the walk with the default abort reason,
 * which the invoker answers as a tool that failed; a cancel, the shutdown, and a script's end give a reason of their own,
 * which it answers by name, and it is kept. Every other error is kept as it is, for the invoker to answer: the walk
 * turns each error of the system into a skip or a refusal, so one left is a failure of Buckle's own, such as an audit
 * entry that cannot be written.
 */
function searchFailure(error: unknown, input: { signal: AbortSignal; state: Walk; timeoutMs?: number }): unknown {
  if (!input.signal.aborted || error !== input.signal.reason || !(error instanceof DOMException && error.name === 'AbortError')) return error
  const limit = input.timeoutMs === undefined ? 'the time this call is given' : `the ${input.timeoutMs / 1000} seconds this call is given`
  return new ToolExecutionError(`The search ran past ${limit} after looking at ${input.state.entries} entries, so it returned nothing: search a smaller folder, name a glob, or try again when the node is less busy`, { code: SEARCH_TIMED_OUT })
}

/** The flags the pattern is run with: Unicode where the pattern is valid with it, and case folded where the call asks. */
function compile(pattern: string, caseSensitive: boolean): string {
  const flags = caseSensitive ? 'g' : 'gi'
  try { new RegExp(pattern, `${flags}u`); return `${flags}u` } catch { /* Not valid with Unicode: read it without. */ }
  try { new RegExp(pattern, flags); return flags } catch {
    throw new ToolInputError(`${pattern} is not a regular expression this search reads (ripgrep is not installed here, so JavaScript's syntax applies)`, { code: INVALID_PATTERN })
  }
}

/**
 * The rules of each ignore file in one folder, .gitignore only inside a git repository, as ripgrep reads them. One that
 * is there but cannot be read is listed in `skipped` and its rules are not applied, as ripgrep goes on without one; where
 * no `search` is given (the folders above the root) nothing is recorded.
 */
function ignoreRules(directory: PinnedDirectory, base: string, repository: boolean, search?: Pick<Search, 'state' | 'platform'>): IgnoreRule[] {
  return IGNORE_FILES.filter(name => repository || name !== '.gitignore').flatMap(name => {
    const text = readIgnoreFile(directory, name, search?.platform ?? process.platform, (reason) => {
      if (search) skip(search.state, `./${base === '' ? name : `${base}/${name}`}`, reason, false)
    })
    return text === null ? [] : parseIgnoreFile(text, base)
  })
}

/**
 * Whether the search root lies in a git repository (a `.git` in it or in a folder above it), and the rules of the ignore
 * files in the folders above it, as ripgrep reads its parents': only those inside the roots the agent may name, as no
 * read beyond them was judged, the farthest first. They apply from the search root down, and only a pattern with no `/`
 * among them, which matches a name at any depth whichever folder it lies in.
 */
function ancestorRules(input: { root: string; paths: PathView }): { rules: IgnoreRule[]; repository: boolean } {
  // A folder above the root this node cannot look in holds no repository it could find, as for ripgrep.
  const hasGit = (folder: string) => {
    try { return lstatSync(childPath(folder, '.git'), { throwIfNoEntry: false }) !== undefined } catch { return false }
  }
  const above: string[] = []
  let repository = hasGit(input.root)
  // Of a folder outside those roots only whether it holds a `.git` is looked at, as ripgrep looks for its repository.
  let inside = true
  for (let folder = parentDirectory(input.root), below = input.root; folder !== below; below = folder, folder = parentDirectory(folder)) {
    inside &&= isInsideAny(input.paths.reachableRoots, folder)
    if (inside) above.unshift(folder)
    repository ||= hasGit(folder)
  }
  const rules = above.flatMap((folder) => {
    try {
      const directory = openRealDirectory(folder)
      try { return ignoreRules(directory, '', repository).filter(rule => !rule.anchored) } finally { directory.close() }
    } catch { return [] }
  })
  return { rules, repository }
}

/** An ignore file's text, or null where there is none or it cannot be used, the reason given to `report` unless it is simply not there. */
function readIgnoreFile(directory: PinnedDirectory, name: string, platform: NodeJS.Platform, report: (reason: SkipReason) => void): string | null {
  let descriptor: number
  try {
    descriptor = openBeneath(directory, name, constants.O_RDONLY, name)
  } catch (error) {
    const reason = reasonOf(error, platform)
    if (reason !== 'vanished') report(reason ?? 'unreadable')
    return null
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) return null
    if (info.size > MAX_IGNORE_BYTES) { report('too-large'); return null }
    const content = readWhole(descriptor, info.size)
    if (content === null) { report('changed'); return null }
    return content.toString('utf8')
  } catch (error) {
    report(reasonOf(error, platform) ?? 'unreadable')
    return null
  } finally { closeQuietly(descriptor) }
}

function closeQuietly(descriptor: number): void {
  try { closeSync(descriptor) } catch { /* Closed already. */ }
}
