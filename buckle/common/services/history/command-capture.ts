import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { join, relative } from 'pathe'
import { replaceFile } from '../../adapters/replace-file.js'
import type { Program, UntrustedRoots } from '../../domain/executable.js'
import { childPath, isInside, isPlainName } from '../../domain/paths.js'
import { escapeIgnore, gitOperation, historyGitProgram, isolatedGit, ownerGitDirectory, RAW_ATTRIBUTES, regularFile, runProgram } from './git-store.js'
import { logger } from '../../runtime/log.js'
import type { ObjectStore } from './object-store.js'
import { modeOf } from './scoped-capture.js'
import type { Entry, Snapshot } from './snapshot.js'

/**
 * When a phase's capture must end, and the cancellation of its call, which stops the before phase (X14): git's children
 * are stopped there and waited for, and the call runs without restorable content.
 */
export interface CaptureBudget { deadline: number; signal?: AbortSignal }
/** How long one git step other than git add may run, as every history git child before (runProgram's default). */
const STEP_TIMEOUT_MS = 10_000
const SETUP_MARKER = 'buckle-setup-complete'
const ZERO = /^0+$/

/** How much of git's stderr a listing keeps to read the folders it could not open; past it, every folder it listed is unknown. */
const LISTING_ERRORS_BYTES = 1_048_576
/** git's warning for a folder it could not open, in the C locale its listing runs in (dir.c, open_cached_dir). */
const UNOPENED = /^warning: could not open directory '(.*)': [^']*$/

/**
 * One root as git saw it at one phase of a command: the folder's identity on disk, the tree its shadow index wrote, and
 * the ignored entries beside it. What git saw on disk but did not store is kept apart, so its absence from the tree is
 * never read as absence from the disk, and all of it comes from git's own listings, never a walk (R1.3 of the Codex
 * recheck): `unstored`, the files git listed and could not store; `untrackedFolders`, the folders it listed holding
 * nothing it stored (an empty one, or a nested repository); `unknown`, the folders it could not open, below which nothing
 * is known; and `stale`, the tracked files the index still holds an older state of, git having failed to read them (X5,
 * X10 of the Codex review of 670f1dc2..01d3b0c9).
 */
export interface CommandBaseline { root: string; identity: string; git: string; tree: string; ignored: Map<string, string>; partial: boolean; unstored: Set<string>; untrackedFolders: Set<string>; unknown: Set<string>; stale: Set<string> }

/** What a command changed, read from two baselines: each changed path's entries, and how many ignored entries changed. */
export interface CommandChanges { before: Snapshot; after: Snapshot; ignored: number; partial: boolean }

export class HostGitNeededError extends Error {}
/** A root that is no longer the folder it was, a link or another folder in its place: git would read where it lands. */
export class FolderReplacedError extends Error {}
/** A command's root whose first record history is still taking in the background (W2): the command runs, never waiting on it. */
export class BaselineWarmingError extends Error {}

/** The side index a first record taken in the background is built in, and the marker that names its process to every sweep. */
const WARM_INDEX = 'index.warm'
const WARM_MARKER = 'warming'

/**
 * Command capture (Slice F2, item 3, owner correction 2026-11-01): git itself, in a shadow repository per root with an
 * isolated config, reads the workspace's own ignore rules (every `.gitignore`, and the workspace repository's
 * `info/exclude`). Before and after a command, `git add -A` brings the shadow index up to date, re-hashing only the
 * files whose stat changed, and `write-tree` names that state; `diff-tree` lists what changed between the two. Buckle
 * never walks or reads the workspace itself. Git writes loose objects only (`gc.auto=0`, never a pack) into the history's
 * object store folder, which the in-process reader of item 4 reads, so a restore needs no git. An ignored path is never
 * stored, and only the count of ignored entries that changed is kept.
 */
export function createCommandCapture(input: { directory: string; objects: Pick<ObjectStore, 'root' | 'read' | 'size'>; excluded: () => string[]; allowed: () => boolean; untrusted?: () => UntrustedRoots; maxFileBytes: () => number }) {
  const folder = join(input.directory, 'commands')
  const warned = new Set<string>()
  const { environment, safety, empty } = isolatedGit(join(folder, 'private'))
  /**
   * The roots whose trees this process wrote again in full (W1): the first capture of each, and the next after a diff-tree
   * that failed, writes every tree once more, so no tree an earlier build or an outside removal took is ever named.
   */
  const rewritten = new Set<string>()
  /** Each root whose first record is being taken in the background, with what stops it (W2). */
  const warming = new Map<string, AbortController>()
  /** Each root a background record left files in that the system would not remove, tried again at its next capture and sweep (V1). */
  const leftovers = new Set<string>()

  function program(roots: string[]): Program | null {
    return historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
  }
  function gitDirectory(root: string): string { return join(folder, createHash('sha256').update(root).digest('hex').slice(0, 24)) }

  async function git(found: Program, state: { root: string; git: string }, args: string[], options: { budget?: CaptureBudget; whole?: boolean; extra?: string[]; data?: string; magic?: boolean; errors?: (chunk: Buffer) => void; index?: string } = {}): Promise<Buffer> {
    // `magic`: pathspec magic is read, for the literal excludes of the protected paths; every other call takes paths as given.
    // Each step takes STEP_TIMEOUT_MS at most, git add (`whole`) all that is left of the budget, which it bounds too.
    // `errors`: git's stderr, which it writes in the C locale, so its warnings read the same on every system.
    const left = options.budget ? Math.max(1, options.budget.deadline - Date.now()) : undefined
    const timeoutMs = left === undefined ? undefined : options.whole ? left : Math.min(STEP_TIMEOUT_MS, left)
    return runProgram({ program: found, operation: gitOperation(args), args: [...safety, ...options.extra ?? [], ...args], cwd: folder, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.root, GIT_INDEX_FILE: options.index ?? join(state.git, 'index'), GIT_OBJECT_DIRECTORY: input.objects.root, ...(options.magic ? { GIT_LITERAL_PATHSPECS: '0' } : {}), ...(options.errors ? { LC_ALL: 'C' } : {}) }, ...(options.data === undefined ? {} : { data: options.data }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(options.budget?.signal ? { signal: options.budget.signal } : {}), ...(options.errors ? { errors: options.errors } : {}) })
  }

  /**
   * The shadow repository for `root`, made once; its excludes name Buckle's own state and the protected paths, which no
   * capture records. `protect` names those inside the root, each excluded from every pathspec too, as a workspace
   * .gitignore outranks the shadow excludes and could re-include one (X3).
   */
  async function prepare(found: Program, root: string, budget: CaptureBudget): Promise<{ root: string; git: string; extra: string[]; protect: string[] }> {
    const state = { root, git: gitDirectory(root) }
    const attributes = join(state.git, 'info', 'attributes')
    if (!regularFile(join(state.git, SETUP_MARKER)) || !regularFile(join(state.git, 'HEAD')) || !regularFile(attributes, Buffer.byteLength(RAW_ATTRIBUTES))) {
      rmSync(join(state.git, SETUP_MARKER), { force: true })
      mkdirSync(state.git, { recursive: true, mode: 0o700 }); mkdirSync(input.objects.root, { recursive: true, mode: 0o700 })
      await git(found, state, ['init', '--quiet', `--template=${empty}`, state.git], { budget })
      mkdirSync(join(state.git, 'info'), { recursive: true, mode: 0o700 })
      writeFileSync(attributes, RAW_ATTRIBUTES, { mode: 0o600 })
      writeFileSync(join(state.git, SETUP_MARKER), '', { mode: 0o600 })
    }
    const protect = input.excluded().filter(path => isInside(root, path) && path !== root).map(path => relative(root, path))
    const excludes = protect.map(name => `/${escapeIgnore(name)}`).join('\n') + '\n'
    const file = join(state.git, 'info', 'exclude')
    if (readText(file) !== excludes) writeFileSync(file, excludes, { mode: 0o600 })
    // A killed child leaves its lock; under the execution lock no other capture of this root runs (A4, B6). A side index no
    // background record is building is a stopped one's (W2).
    rmSync(join(state.git, 'index.lock'), { force: true })
    if (!warming.has(root)) tidy(root)
    const owner = ownerGitDirectory(root)
    const own = owner === undefined ? undefined : join(owner, 'info', 'exclude')
    return { ...state, protect, extra: own !== undefined && regularFile(own) ? ['-c', `core.excludesFile=${own}`] : [] }
  }

  /**
   * Brings an index of `state`'s root up to date: first every tracked entry an ignore rule now covers, or a protected path
   * holds, leaves it, so git add never reads one (X3, X4); then git add, with each protected path excluded from its
   * pathspec. Answers the ignored entries git listed, and whether git add could not read some files (A7).
   */
  async function refresh(found: Program, state: { root: string; git: string; extra: string[]; protect: string[] }, budget: CaptureBudget, index?: string): Promise<{ ignored: string[]; partial: boolean }> {
    const on = index === undefined ? {} : { index }
    const excludes = state.protect.map(name => `:(exclude,literal)${name}`)
    const [listed, protectedTracked] = await Promise.all([
      git(found, state, ['ls-files', '-z', '-t', '--cached', '--others', '--ignored', '--exclude-standard', '--directory'], { extra: state.extra, budget, ...on }),
      state.protect.length ? git(found, state, ['ls-files', '-z', '--cached', '--', ...state.protect], { budget, ...on }) : Promise.resolve(Buffer.alloc(0)),
    ])
    const ignored = listed.toString().split('\0').filter(line => /^[H?] ./.test(line))
    const leaving = [...ignored.filter(line => line.startsWith('H ')).map(line => line.slice(2)), ...protectedTracked.toString().split('\0').filter(Boolean)]
    if (leaving.length) await git(found, state, ['update-index', '--force-remove', '-z', '--stdin'], { data: leaving.join('\0') + '\0', budget, ...on })
    // Exit 1: some files could not be read, and the index holds the rest (A7).
    const partial = await git(found, state, ['add', '-A', '--ignore-errors', '--', '.', ...excludes], { budget, whole: true, extra: state.extra, magic: excludes.length > 0, ...on }).then(() => false, (error: unknown) => { if (isExit(error, 1)) return true; throw error })
    return { ignored: ignored.map(line => line.slice(2)), partial }
  }

  /**
   * The tree of an index, written: git takes each tree the index's cache-tree names as written while that tree is there,
   * never looking below it (W1). So the first write of each root in this process, and the next after a diff-tree that
   * failed, ignores the cache-tree and writes every tree again; each other write trusts it, as the sweep keeps what a shadow
   * index names.
   */
  async function writeTree(found: Program, state: { root: string; git: string }, budget: CaptureBudget, side?: string): Promise<string> {
    const again = side !== undefined || !rewritten.has(state.root)
    const written = (await git(found, state, ['write-tree', '--missing-ok', ...again ? ['--ignore-cache-tree'] : []], { budget, ...side === undefined ? {} : { index: side } })).toString().trim()
    if (!/^[0-9a-f]{40}$/.test(written)) throw new Error('History git wrote no tree')
    if (side === undefined) rewritten.add(state.root)
    return written
  }

  /**
   * Each directory root's state now: the index brought up to date (refresh), then, together, its tree, the tracked files
   * whose index state git could not refresh, and what git saw on disk but did not store: its folders, its files, and the
   * folders it warned it could not open (X5, X10, R1.3). A root whose first record is still being taken in the background
   * is never read: the command runs without restorable content, at once (W2). `progress` names the root git reads.
   */
  async function baseline(roots: string[], budget: CaptureBudget, progress: { root?: string } = {}): Promise<CommandBaseline[]> {
    const found = program(roots)
    if (!found) throw new HostGitNeededError('Host git is not permitted')
    if (roots.some(root => warming.has(root))) throw new BaselineWarmingError('History is taking a first record of a folder in the background')
    const result: CommandBaseline[] = []
    for (const root of roots) {
      progress.root = root
      // Git follows a work tree that is a link, so a folder swapped for one is never read (folder-swap review).
      const identity = folderIdentity(root)
      if (identity === undefined) throw new FolderReplacedError('A folder history records is no longer a folder')
      const state = await prepare(found, root, budget)
      const excludes = state.protect.map(name => `:(exclude,literal)${name}`)
      const refreshed = await refresh(found, state, budget)
      const warnings = { chunks: [] as Buffer[], bytes: 0 }
      const keep = (chunk: Buffer) => { warnings.bytes += chunk.length; if (warnings.bytes <= LISTING_ERRORS_BYTES) warnings.chunks.push(chunk) }
      const [tree, stale, folders, files] = await Promise.all([
        writeTree(found, state, budget),
        git(found, state, ['diff-files', '--name-only', '-z'], { budget }),
        git(found, state, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--', '.', ...excludes], { extra: state.extra, magic: excludes.length > 0, budget }),
        // Without --directory git opens every folder it did not store, and warns of each it cannot open.
        git(found, state, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...excludes], { extra: state.extra, magic: excludes.length > 0, budget, errors: keep }),
      ])
      // Swapped while git read it: the index may name what the link held, so it goes, and nothing keeps that content.
      if (folderIdentity(root) !== identity) { rmSync(join(state.git, 'index'), { force: true }); throw new FolderReplacedError('A folder history records was replaced while git read it') }
      const seen = unstoredState([folders, files], { text: Buffer.concat(warnings.chunks).toString(), complete: warnings.bytes <= LISTING_ERRORS_BYTES })
      // A folder git could not open hides what changed in it: the checkpoint says so (PARTIAL_REASON).
      result.push({ root, identity, git: state.git, tree, ignored: ignoredState(root, refreshed.ignored), partial: refreshed.partial || seen.unknown.size > 0, ...seen, stale: new Set(stale.toString().split('\0').filter(Boolean)) })
    }
    return result
  }

  /**
   * A root's first record, taken off every call path once a command's budget cut it short (W2): its index is built in a
   * side file, within `budget`, with no execution lock, while a command in that root runs without reading it
   * (BaselineWarmingError). Then `exclusive` runs the swap under the lock: the side index becomes the shadow index unless
   * that changed since it was copied. A marker names this process to every sweep, which removes nothing while it stands,
   * as git writes objects no index names yet. Answers whether the record took its place.
   */
  async function warm(root: string, budget: CaptureBudget, exclusive: (step: () => Promise<void>, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (warming.has(root) || liveMarker(gitDirectory(root))) return false
    const stop = new AbortController()
    warming.set(root, stop)
    const signals = [stop.signal, ...budget.signal ? [budget.signal] : []]
    const background = { deadline: budget.deadline, signal: AbortSignal.any(signals) }
    let state: { root: string; git: string; extra: string[]; protect: string[] } | undefined
    try {
      const found = program([root])
      if (!found) throw new HostGitNeededError('Host git is not permitted')
      const identity = folderIdentity(root)
      if (identity === undefined) throw new FolderReplacedError('A folder history records is no longer a folder')
      state = await prepare(found, root, background)
      writeFileSync(join(state.git, WARM_MARKER), JSON.stringify({ pid: process.pid, until: budget.deadline }), { mode: 0o600 })
      const index = join(state.git, 'index'); const side = join(state.git, WARM_INDEX)
      for (const name of [side, `${side}.lock`]) rmSync(name, { force: true })
      const base = fileIdentity(index)
      if (base !== undefined) copyFileSync(index, side)
      await refresh(found, state, background, side)
      // Every tree written again, as a copied index may name one an earlier build removed (W1).
      await writeTree(found, state, background, side)
      if (folderIdentity(root) !== identity) throw new FolderReplacedError('A folder history records was replaced while git read it')
      let placed = false
      await exclusive(async () => { if (fileIdentity(index) === base && !stop.signal.aborted) { await replaceFile(side, index); placed = true } }, background.signal)
      if (placed) rewritten.add(root)
      return placed
    } finally {
      // The root is let go first, so a removal the system refuses never leaves it marked as taking a record (V1).
      warming.delete(root)
      if (state) tidy(root)
    }
  }

  /**
   * Removes what a background record of `root` made, each file on its own, unless a live other process takes one there. A
   * removal the system refuses, as Windows does while another handle holds the file, keeps the root among the leftovers,
   * tried again at its next capture and before each sweep (V1): its marker never names this process to itself, and the
   * sweep keeps what its side index names meanwhile.
   */
  function tidy(root: string): void {
    const git = gitDirectory(root)
    if (liveMarker(git)) return
    let refused: unknown
    for (const name of [WARM_INDEX, `${WARM_INDEX}.lock`, WARM_MARKER]) try { rmSync(join(git, name), { force: true }) } catch (error) { refused ??= error }
    if (refused === undefined) { leftovers.delete(root); return }
    if (!leftovers.has(root)) logger.warn('History could not remove what a background record left; it tries again before the next sweep', { code: systemCode(refused) ?? 'unknown' })
    leftovers.add(root)
  }
  /** What background records left that the system refused to remove, tried again where none runs (V1). */
  function tidyLeftovers(): void { for (const root of leftovers) if (!warming.has(root)) tidy(root) }

  /** Stops every first record this process takes in the background; each removes what it made as it ends. */
  function stopWarming(): void { for (const stop of warming.values()) stop.abort(new Error('History stopped its background record')) }

  /**
   * What changed between `before` and now, each changed path's entry on both sides. A side's mode is its file's own on
   * disk after the command, and before it the mode `prior` last recorded for the same content, else git's 644 or 755.
   * `progress` names the root git reads, as for a baseline.
   */
  async function changes(before: CommandBaseline[], prior: (path: string) => Entry | undefined, budget: CaptureBudget, progress: { root?: string } = {}): Promise<CommandChanges> {
    if (before.some(item => folderIdentity(item.root) !== item.identity)) throw new FolderReplacedError('A folder history records was replaced during the command')
    const after = await baseline(before.map(item => item.root), budget, progress)
    const found = program(before.map(item => item.root))!
    const result: CommandChanges = { before: {}, after: {}, ignored: 0, partial: after.some(item => item.partial) }
    for (const [index, left] of before.entries()) {
      const right = after[index]!
      result.ignored += ignoredChanges(left.ignored, right.ignored)
      if (left.tree === right.tree) continue
      // A tree that cannot be read: the next capture of this root writes every tree again (W1).
      const raw = await git(found, left, ['diff-tree', '-r', '-t', '-z', '--raw', '--no-renames', '--no-abbrev', '--no-commit-id', left.tree, right.tree], { budget }).catch((error: unknown) => { rewritten.delete(left.root); throw error })
      for (const change of parseRaw(raw)) {
        if (change.status === 'M' && change.oldMode === '040000' && change.newMode === '040000') continue
        const parts = change.name.split('/')
        const path = childPath(left.root, change.name)
        if (!parts.every(part => isPlainName(part))) {
          result.before[path] = { kind: 'excluded', mode: 0 }; result.after[path] = { kind: 'excluded', mode: 0, reason: 'special' }
          if (!warned.has(path)) { warned.add(path); logger.warn('History leaves out a name Buckle would read as another path', { name: change.name }) }
          continue
        }
        // A path absent from one side's tree that an ignore rule covered there, or a folder holding what one covered,
        // was on disk all along: history never knew it, so no restore writes or removes it (A1). One git saw there but
        // stored nothing of was there too, and a tracked file git could not read, or one in a folder it could not open,
        // holds an older state in its tree (X5, X10, R1.3).
        const now = ZERO.test(change.newMode) ? untracked(path, ignoredIn(right.ignored, change.name))
          : right.stale.has(change.name) || below(right.unknown, change.name) ? { kind: 'unreadable' as const, mode: inspect(path) ? modeOf(inspect(path)!) : 0o644 } : sideAfter(change.newMode, change.newId, path)
        const was = ZERO.test(change.oldMode) && ignoredIn(left.ignored, change.name) ? ignoredEntry(path)
          : below(left.unknown, change.name) ? { kind: 'unreadable' as const, mode: 0 }
          : ZERO.test(change.oldMode) ? notStored(left, change.name, now)
          : left.stale.has(change.name) ? { kind: 'unreadable' as const, mode: change.oldMode === '100755' ? 0o755 : 0o644 } : await sideBefore(change.oldMode, change.oldId, prior(path))
        if (was) result.before[path] = was
        if (now) result.after[path] = now
        // A folder the command made holds the ignored entries made in it, so a restore that would remove it says so.
        if (change.newMode === '040000' && ZERO.test(change.oldMode)) for (const name of right.ignored.keys()) {
          const inside = name.replace(/\/$/, '')
          if (inside.startsWith(`${change.name}/`)) result.after[childPath(left.root, inside)] ??= ignoredEntry(childPath(left.root, inside))
        }
      }
    }
    return result
  }

  async function sideBefore(mode: string, id: string, prior: Entry | undefined): Promise<Entry | undefined> {
    if (ZERO.test(mode)) return undefined
    if (mode === '160000') return { kind: 'excluded', mode: 0, reason: 'nested', hash: id }
    if (mode === '040000') return { kind: 'directory', mode: prior?.kind === 'directory' ? prior.mode : 0o755 }
    if (mode === '120000') {
      try { const target = (await input.objects.read(id)).toString(); return { kind: 'symlink', mode: prior?.kind === 'symlink' && prior.target === target ? prior.mode : 0o777, target } }
      catch { return { kind: 'unreadable', mode: 0o777 } }
    }
    const fallback = mode === '100755' ? 0o755 : 0o644
    const size = input.objects.size(id)
    if (size === undefined) return { kind: 'unreadable', mode: fallback }
    if (size > input.maxFileBytes()) return { kind: 'excluded', mode: fallback, size, reason: 'size' }
    return { kind: 'file', mode: prior?.kind === 'file' && prior.hash === id ? prior.mode : fallback, hash: id }
  }

  function sideAfter(mode: string, id: string, path: string): Entry | undefined {
    if (ZERO.test(mode)) return undefined
    if (mode === '160000') return { kind: 'excluded', mode: 0, reason: 'nested', hash: id }
    const stat = inspect(path)
    if (mode === '040000') return { kind: 'directory', mode: stat?.isDirectory() ? modeOf(stat) : 0o755 }
    if (mode === '120000') {
      let target: string | undefined
      try { target = readlinkSync(path) } catch { target = undefined }
      return target === undefined ? { kind: 'unreadable', mode: 0o777 } : { kind: 'symlink', mode: stat ? modeOf(stat) : 0o777, target }
    }
    const fallback = mode === '100755' ? 0o755 : 0o644
    const own = stat?.isFile() ? modeOf(stat) : fallback
    const size = stat?.isFile() ? stat.size : input.objects.size(id)
    if (size !== undefined && size > input.maxFileBytes()) return { kind: 'excluded', mode: own, size, ...(stat?.isFile() ? { mtime: stat.mtimeMs } : {}), reason: 'size' }
    return { kind: 'file', mode: own, hash: id }
  }

  /**
   * The objects each shadow index names, its side index included (W2): each blob, the content the next command's before
   * state reuses, one over the cap too, which git reads again only once its file changes (V4); and each tree its cache-tree
   * names, which git takes as written while it is there (W1). undefined where an index cannot be read, so nothing is swept
   * on a guess.
   */
  function indexed(): Set<string> | undefined {
    const ids = new Set<string>()
    let folders: string[]
    try { folders = readdirNames(folder) } catch { return undefined }
    for (const name of folders) {
      if (!/^[0-9a-f]{24}$/.test(name)) continue
      for (const file of ['index', WARM_INDEX]) {
        let index: Buffer
        try { index = readFileSync(join(folder, name, file)) } catch (error) { if (isMissing(error)) continue; return undefined }
        const read = readIndex(index)
        if (!read) return undefined
        for (const entry of read.entries) ids.add(entry.id)
        for (const tree of read.trees) ids.add(tree)
      }
    }
    return ids
  }

  /** Whether a first record is being taken in the background, by this process or by a live other one (W2). */
  function warmingAny(): boolean {
    if (warming.size) return true
    let names: string[]
    try { names = readdirNames(folder) } catch { return true }
    return names.some(name => /^[0-9a-f]{24}$/.test(name) && liveMarker(join(folder, name)))
  }

  return { baseline, changes, indexed, warm, stopWarming, tidyLeftovers, warming: warmingAny, available: (roots: string[]) => program(roots) !== null }
}

/**
 * What git listed beside its index after git add and stored nothing of, from its listings alone (R1.3 of the Codex
 * recheck): each folder named, with --directory, as holding nothing stored; each file named that git could not store;
 * and each folder the listing without --directory warns it could not open. A warning it does not read, or more than it keeps, leaves
 * every folder it listed unknown, so nothing below one is ever taken as absent.
 */
export function unstoredState(listings: Buffer[], warnings: { text: string; complete: boolean }): { unstored: Set<string>; untrackedFolders: Set<string>; unknown: Set<string> } {
  const unstored = new Set<string>()
  const untrackedFolders = new Set<string>()
  const unknown = new Set<string>()
  for (const listing of listings) for (const line of listing.toString().split('\0')) {
    if (line.endsWith('/')) untrackedFolders.add(line.slice(0, -1))
    else if (line) unstored.add(line)
  }
  let unread = !warnings.complete
  for (const line of warnings.text.split(/\r?\n/)) {
    if (!line) continue
    const found = UNOPENED.exec(line)
    if (found) unknown.add(found[1]!.replace(/\/$/, ''))
    else unread = true
  }
  if (unread) for (const name of untrackedFolders) unknown.add(name)
  return { unstored, untrackedFolders, unknown }
}

/**
 * A path absent from a baseline's tree as the disk held it, from git's listings: a file git listed and could not store; a
 * folder it listed as holding nothing it stored; below one, a folder the after side holds, there before where git listed
 * an entry inside it, and otherwise unknown, as git lists no empty folder below one it lists: reason `unlisted`, not
 * restorable, never taken as there before (R2.2 of the Codex recheck); else absent. Below a folder git could not open,
 * the caller reads it unknown.
 */
function notStored(baseline: CommandBaseline, name: string, after: Entry | undefined): Entry | undefined {
  if (baseline.unstored.has(name)) return { kind: 'unreadable', mode: 0 }
  const folder = enclosing(baseline.untrackedFolders, name)
  if (folder === name) return { kind: 'directory', mode: after?.kind === 'directory' ? after.mode : 0o755 }
  if (folder === undefined || after?.kind !== 'directory') return undefined
  return listedInside(baseline, name) ? { kind: 'directory', mode: after.mode } : { kind: 'unreadable', mode: 0, reason: 'unlisted' }
}

/** Whether git's listings name an entry inside the folder `name`: a file it could not store, a folder it listed, or one it could not open. */
function listedInside(baseline: CommandBaseline, name: string): boolean {
  const inside = `${name}/`
  return [baseline.unstored, baseline.untrackedFolders, baseline.unknown].some(names => [...names].some(listed => listed.startsWith(inside)))
}

/** `name` itself, or the nearest folder above it, where `folders` holds one. */
function enclosing(folders: Set<string>, name: string): string | undefined {
  for (let at = name; at; at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '') if (folders.has(at)) return at
  return undefined
}
function below(folders: Set<string>, name: string): boolean { return folders.size > 0 && enclosing(folders, name) !== undefined }

/** Each ignored entry git lists beside the index, by its stat: what a change among them is counted from. */
function ignoredState(root: string, listed: string[]): Map<string, string> {
  const state = new Map<string, string>()
  for (const name of listed) {
    if (!name) continue
    const stat = inspect(childPath(root, name.replace(/\/$/, '')))
    state.set(name, stat ? `${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f'}:${stat.size}:${stat.mtimeMs}` : '-')
  }
  return state
}

/** Whether git listed `name` as ignored, or a folder above it, or an entry below it (`name` a folder holding one). */
function ignoredIn(ignored: Map<string, string>, name: string): boolean {
  if (ignored.has(name) || ignored.has(`${name}/`)) return true
  for (let end = name.indexOf('/'); end !== -1; end = name.indexOf('/', end + 1)) if (ignored.has(name.slice(0, end + 1))) return true
  for (const listed of ignored.keys()) if (listed.startsWith(`${name}/`)) return true
  return false
}
/**
 * A path the tree after the command lacks, as the disk holds it: absent, an ignored entry, a folder git no longer
 * tracks a file in (empty, say), or else one git could not read.
 */
function untracked(path: string, ignored: boolean): Entry | undefined {
  if (ignored) return ignoredEntry(path)
  const stat = inspect(path)
  if (!stat) return undefined
  return stat.isDirectory() ? { kind: 'directory', mode: modeOf(stat) } : { kind: 'unreadable', mode: modeOf(stat) }
}
function ignoredEntry(path: string): Entry {
  const stat = inspect(path)
  return { kind: 'excluded', mode: stat ? modeOf(stat) : 0, reason: 'ignored' }
}

function ignoredChanges(before: Map<string, string>, after: Map<string, string>): number {
  let count = 0
  for (const [name, state] of after) if (before.get(name) !== state) count++
  for (const name of before.keys()) if (!after.has(name)) count++
  return count
}

interface RawChange { oldMode: string; newMode: string; oldId: string; newId: string; status: string; name: string }

/** `diff-tree --raw -z`: `:<old mode> <new mode> <old id> <new id> <status>` then the path, each ended by NUL. */
function parseRaw(raw: Buffer): RawChange[] {
  const fields = raw.toString().split('\0')
  const changes: RawChange[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]!.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])[0-9]*$/)
    const name = fields[index + 1]
    if (!header || !name) throw new Error('Unexpected history diff output')
    changes.push({ oldMode: header[1]!, newMode: header[2]!, oldId: header[3]!, newId: header[4]!, status: header[5]!, name })
  }
  return changes
}

/**
 * A git index read in-process: version 2 or 3, which an isolated config writes. Each entry's blob id and the file size its
 * stat gave, and each tree its cache-tree extension names as written (W1). undefined for any other form, an extension
 * git requires its reader to know, or one cut short, so nothing is swept on a guess.
 */
export function readIndex(index: Buffer): { entries: Array<{ id: string; size: number }>; trees: string[] } | undefined {
  if (index.length < 32 || index.toString('latin1', 0, 4) !== 'DIRC') return undefined
  const version = index.readUInt32BE(4)
  if (version !== 2 && version !== 3) return undefined
  const count = index.readUInt32BE(8)
  const entries: Array<{ id: string; size: number }> = []
  let offset = 12
  for (let entry = 0; entry < count; entry++) {
    if (offset + 62 > index.length) return undefined
    const size = index.readUInt32BE(offset + 36)
    const id = index.toString('hex', offset + 40, offset + 60)
    const flags = index.readUInt16BE(offset + 60)
    const extended = version === 3 && (flags & 0x4000) !== 0
    const nameStart = offset + 62 + (extended ? 2 : 0)
    const end = index.indexOf(0, nameStart)
    if (end < 0) return undefined
    offset += Math.ceil((end - offset + 1) / 8) * 8
    entries.push({ id, size })
  }
  const trees: string[] = []
  // Extensions run to the 20-byte checksum; one whose name starts lowercase must be understood (index-format.txt).
  const end = index.length - 20
  if (offset > end) return undefined
  while (offset < end) {
    if (offset + 8 > end) return undefined
    const signature = index.toString('latin1', offset, offset + 4)
    const size = index.readUInt32BE(offset + 4)
    const start = offset + 8
    if (start + size > end || !/^[A-Z]/.test(signature)) return undefined
    if (signature === 'TREE' && !cacheTrees(index.subarray(start, start + size), trees)) return undefined
    offset = start + size
  }
  return { entries, trees }
}

/**
 * The trees a cache-tree extension names, into `trees`: each node a NUL-ended name, its entry count and subtree count, and,
 * where the count is not negative (a node git has not invalidated), its tree id. Answers false for data it cannot read.
 */
function cacheTrees(data: Buffer, trees: string[]): boolean {
  let at = 0
  while (at < data.length) {
    const name = data.indexOf(0, at)
    const line = name < 0 ? -1 : data.indexOf(10, name + 1)
    const counts = line < 0 ? null : /^(-?[0-9]+) ([0-9]+)$/.exec(data.toString('latin1', name + 1, line))
    if (!counts) return false
    at = line + 1
    if (Number(counts[1]) < 0) continue
    if (at + 20 > data.length) return false
    trees.push(data.toString('hex', at, at + 20)); at += 20
  }
  return true
}

/**
 * Whether a background record's marker in a shadow folder names a live process other than this one, within the budget it
 * gave (W2): a marker past it, or of a process gone, is a stopped one's, even where its pid is reused.
 */
function liveMarker(git: string): boolean {
  let marker: { pid?: unknown; until?: unknown }
  try { marker = JSON.parse(readFileSync(join(git, WARM_MARKER), 'utf8')) as typeof marker } catch { return false }
  const { pid, until } = marker
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || typeof until !== 'number' || Date.now() > until + STEP_TIMEOUT_MS) return false
  try { process.kill(pid, 0); return true } catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM' }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
/** A system error's code alone, as the owner's log may name it (D2). */
function systemCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? error.code : undefined
}
/** A file's identity on disk, so a swap can tell the index it copied from one written since. */
function fileIdentity(path: string): string | undefined {
  const stat = inspect(path)
  return stat?.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined
}

function isExit(error: unknown, code: number): boolean {
  return error instanceof Error && 'details' in error && typeof error.details === 'object' && error.details !== null && 'exitCode' in error.details && error.details.exitCode === code
}
/** A real folder's device and inode; undefined for a link, a file, or nothing. */
function folderIdentity(path: string): string | undefined {
  const stat = inspect(path)
  return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined
}
function inspect(path: string): Stats | undefined { try { return lstatSync(path, { throwIfNoEntry: false }) } catch { return undefined } }
function readText(path: string): string | undefined { try { return readFileSync(path, 'utf8') } catch { return undefined } }
function readdirNames(path: string): string[] { return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(path) : [] }
