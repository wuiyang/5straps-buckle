import { closeSync, constants, fstatSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { isLinkedOnStateDevice, openBeneath, openDirectoryBeneath, openRealDirectory, type PinnedDirectory } from '../../../adapters/beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { childPath, isInsideAny, isPlainName, parentDirectory } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { IGNORE_FILES, isIgnored, parseIgnoreFile, passesGlob, type IgnoreRule } from './ignore-files.js'
import type * as schemas from './schemas.js'

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
/** How deep the walk descends; each level holds one open directory while the walk is beneath it. */
const MAX_DEPTH = 256

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
 */
export async function searchBuiltin(input: {
  args: z.output<typeof schemas.searchInput>
  paths: PathView
  signal: AbortSignal
  authorizeRead: (path: string) => Promise<boolean>
  protectedRoots: readonly string[]
  known?: (target: string) => void
  platform?: NodeJS.Platform
  /** The bytes read in all, SCAN_BUDGET_BYTES unless a test sets a smaller one. */
  scanBudgetBytes?: number
}): Promise<JsonValue> {
  const pattern = compile(input.args.pattern, input.args.caseSensitive)
  const root = resolveTarget(input.paths.resolve(input.args.path), { shares: input.paths.shares })
  const platform = input.platform ?? process.platform
  const directory = openRealDirectory(root, { refusal: { shown: input.args.path, outcome: 'nothing was searched' } })
  const state: Walk = { matches: [], files: 0, bytes: 0, budget: input.scanBudgetBytes ?? SCAN_BUDGET_BYTES, excluded: 0, cut: false }
  try {
    const above = ancestorRules({ root, paths: input.paths })
    await walk({ ...input, pattern, platform, state }, { directory, real: root, shown: '', rules: [...above.rules, ...ignoreRules(directory, '', above.repository)], repository: above.repository, depth: 0 })
  } finally { directory.close() }
  return { matches: state.matches, truncated: state.cut || state.matches.length >= input.args.limit, excludedFiles: state.excluded }
}

interface Walk { matches: JsonObject[]; files: number; bytes: number; budget: number; excluded: number; cut: boolean }

interface Level { directory: PinnedDirectory; real: string; shown: string; rules: readonly IgnoreRule[]; repository: boolean; depth: number }

async function walk(input: { args: z.output<typeof schemas.searchInput>; pattern: RegExp; signal: AbortSignal; authorizeRead: (path: string) => Promise<boolean>; protectedRoots: readonly string[]; paths: PathView; known?: (target: string) => void; platform: NodeJS.Platform; state: Walk }, level: Level): Promise<void> {
  const { state } = input
  for (const name of readdirSync(level.directory.self).sort()) {
    input.signal.throwIfAborted()
    if (state.cut || state.matches.length >= input.args.limit) return
    // Hidden names are left out, as ripgrep leaves them out, and a name read as another path is never judged as one.
    if (name.startsWith('.') || !isPlainName(name, input.platform)) continue
    const shown = level.shown === '' ? name : `${level.shown}/${name}`
    const info = lstatSync(level.directory.child(name))
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue
    if (isIgnored(level.rules, shown, info.isDirectory())) continue
    const real = childPath(level.real, name)
    if (info.isDirectory()) {
      if (level.depth >= MAX_DEPTH) { state.cut = true; continue }
      const below = openDirectoryBeneath(level.directory, name, shown)
      try {
        await walk(input, { directory: below, real, shown, rules: [...level.rules, ...ignoreRules(below, shown, level.repository)], repository: level.repository, depth: level.depth + 1 })
      } finally { below.close() }
      continue
    }
    if (!passesGlob(input.args.glob, shown)) continue
    if (++state.files > MAX_FILES) { state.cut = true; return }
    await searchFile(input, { directory: level.directory, name, real, shown })
  }
}

async function searchFile(input: { args: z.output<typeof schemas.searchInput>; pattern: RegExp; authorizeRead: (path: string) => Promise<boolean>; protectedRoots: readonly string[]; paths: PathView; known?: (target: string) => void; state: Walk }, file: { directory: PinnedDirectory; name: string; real: string; shown: string }): Promise<void> {
  const { state } = input
  if (!await input.authorizeRead(file.real)) { state.excluded++; return }
  let descriptor: number
  try {
    descriptor = openBeneath(file.directory, file.name, constants.O_RDONLY, { shown: file.shown, outcome: 'nothing was read' })
  } catch {
    state.excluded++
    return
  }
  let content: Buffer
  try {
    const held = fstatSync(descriptor)
    if (!held.isFile() || held.size > MAX_FILE_BYTES || isLinkedOnStateDevice({ info: held, path: file.real, protectedRoots: input.protectedRoots, roots: input.paths.reachableRoots })) { state.excluded++; return }
    if (state.bytes + held.size > state.budget) { state.cut = true; return }
    state.bytes += held.size
    content = readFileSync(descriptor)
  } finally { closeQuietly(descriptor) }
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return
  const found = state.matches.length
  const lines = content.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const [index, raw] of lines.entries()) {
    if (state.matches.length >= input.args.limit) break
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const ranges = rangesOf(input.pattern, text)
    if (ranges.length > 0) state.matches.push({ path: `./${file.shown}`, line: index + 1, text, ranges })
  }
  if (state.matches.length > found) input.known?.(file.real)
}

/** Each match on a line, as ripgrep reports it: its start and end in bytes of the line's UTF-8. */
function rangesOf(pattern: RegExp, text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = Buffer.byteLength(text.slice(0, match.index))
    ranges.push({ start, end: start + Buffer.byteLength(match[0]) })
    if (match[0] === '') pattern.lastIndex++
  }
  return ranges
}

function compile(pattern: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? 'g' : 'gi'
  try { return new RegExp(pattern, `${flags}u`) } catch { /* Not valid with Unicode: read it without. */ }
  try { return new RegExp(pattern, flags) } catch {
    throw new ToolInputError(`${pattern} is not a regular expression this search reads (ripgrep is not installed here, so JavaScript's syntax applies)`)
  }
}

/** The rules of each ignore file in one folder, .gitignore only inside a git repository, as ripgrep reads them. */
function ignoreRules(directory: PinnedDirectory, base: string, repository: boolean): IgnoreRule[] {
  return IGNORE_FILES.filter(name => repository || name !== '.gitignore').flatMap(name => {
    const text = readSmallFile(directory, name)
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
  const hasGit = (folder: string) => lstatSync(childPath(folder, '.git'), { throwIfNoEntry: false }) !== undefined
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

function readSmallFile(directory: PinnedDirectory, name: string): string | null {
  let descriptor: number
  try { descriptor = openBeneath(directory, name, constants.O_RDONLY, name) } catch { return null }
  try {
    const info = fstatSync(descriptor)
    return info.isFile() && info.size <= MAX_IGNORE_BYTES ? readFileSync(descriptor, 'utf8') : null
  } finally { closeQuietly(descriptor) }
}

function closeQuietly(descriptor: number): void {
  try { closeSync(descriptor) } catch { /* Closed already. */ }
}
