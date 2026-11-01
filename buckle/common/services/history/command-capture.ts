import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { join, relative } from 'pathe'
import { replaceFile } from '../../adapters/replace-file.js'
import type { Program, UntrustedRoots } from '../../domain/executable.js'
import { childPath, isInside, isPlainName } from '../../domain/paths.js'
import { escapeIgnore, gitOperation, HistoryGitError, historyGitProgram, isolatedGit, ownerGitDirectory, RAW_ATTRIBUTES, regularFile, runProgram } from './git-store.js'
import { logger } from '../../runtime/log.js'
import { blobId, type ObjectStore } from './object-store.js'
import { modeOf } from './scoped-capture.js'
import type { Entry, Snapshot } from './snapshot.js'
import { entryKey, LOCATE_ARGS, namesBlob, objectFolders, parseBatch, parseBatchCheck, parseExistence, parseIndex, parseLocation, prefixWithin, readRepositoryIndex, readSource, readSourceIds, refreshedAs, removeSource, sameBlob, seedCandidates, unverified, writeIndex, writeSource, type IndexEntry, type SourceRecord } from './workspace-repo.js'

/**
 * When a phase's capture must end, and the cancellation of its call, which stops the before phase (X14): git's children
 * are stopped there and waited for, and the call runs without restorable content.
 */
export interface CaptureBudget { deadline: number; signal?: AbortSignal }
/** How long one git step other than git add may run, as every history git child before (runProgram's default). */
const STEP_TIMEOUT_MS = 10_000
const SETUP_MARKER = 'buckle-setup-complete'
const ZERO = /^0+$/
/** The modes of a file or a link, whose content a command's before side reads from its blob. */
const BLOB_MODE = /^(100644|100755|120000)$/
/** How many bytes of content one `git cat-file --batch` copies from a folder's repository at most, past one object: within runProgram's output limit. */
const COPY_BATCH_BYTES = 32 * 1_048_576

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
 * X10 of the Codex review of 670f1dc2..01d3b0c9). `source`, before a command, is the objects folder of the repository the
 * shadow index refers to for content it never copied (Slice F3).
 */
export interface CommandBaseline { root: string; identity: string; git: string; tree: string; ignored: Map<string, string>; partial: boolean; unstored: Set<string>; untrackedFolders: Set<string>; unknown: Set<string>; stale: Set<string>; source?: string }

/** What a command changed, read from two baselines: each changed path's entries, and how many ignored entries changed. */
export interface CommandChanges { before: Snapshot; after: Snapshot; ignored: number; partial: boolean }

/**
 * What settling a root's repository before a command found (Slice F3): the objects folder its shadow index refers to,
 * and, for a record that stood, the check that the repository alone still holds each blob the index takes from it.
 */
interface Settled { objects: string; holds?: Promise<boolean> }

/** A root's blobs its shadow index takes from its repository (Slice F3): its shadow git folder, that repository's objects folder, and the ids. */
export interface Lent { git: string; objects: string; ids: Set<string> }

export class HostGitNeededError extends Error {}
/** A root that is no longer the folder it was, a link or another folder in its place: git would read where it lands. */
export class FolderReplacedError extends Error {}
/** A command's root whose first record history is still taking in the background (W2): the command runs, never waiting on it. */
export class BaselineWarmingError extends Error {}

/**
 * The side index a first record taken in the background is built in, and the marker that names its history instance, its
 * process, and when that process started to every sweep.
 */
const WARM_INDEX = 'index.warm'
const WARM_MARKER = 'warming'
/** The side index a seed has git hash files in, to confirm each holds its repository's blob (Slice F3, G2). */
const VERIFY_INDEX = 'index.verify'

/**
 * Command capture (Slice F2, item 3, owner correction 2026-11-01): git itself, in a shadow repository per root with an
 * isolated config, reads the workspace's own ignore rules (every `.gitignore`, and the workspace repository's
 * `info/exclude`). Before and after a command, `git add -A` brings the shadow index up to date, re-hashing only the
 * files whose stat changed, and `write-tree` names that state; `diff-tree` lists what changed between the two. Buckle
 * never walks or reads the workspace itself. Git writes loose objects only (`gc.auto=0`, never a pack) into the history's
 * object store folder, which the in-process reader of item 4 reads, so a restore needs no git. An ignored path is never
 * stored, and only the count of ignored entries that changed is kept. Where the folder lies in a git repository with a
 * commit (Slice F3), the shadow index starts from that repository's index, so an unchanged committed file is never
 * copied: git hashes each such file once, storing nothing, to confirm it holds the committed blob. Its content is copied
 * into the store only as a command changes it, and a restore reads the store alone. Nothing is written to the
 * repository: only a step that reads objects (`cat-file`) sees its objects folder, as its only object store, so git add
 * and write-tree write every object they make into the store.
 */
export function createCommandCapture(input: { directory: string; objects: Pick<ObjectStore, 'root' | 'read' | 'size' | 'has' | 'put'>; excluded: () => string[]; allowed: () => boolean; untrusted?: () => UntrustedRoots; maxFileBytes: () => number }) {
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
  /** This history instance's name in each marker it makes, so two instances in one process tell their records apart (V2). */
  const instance = randomUUID()
  /** When this process started, as the system counts it, in each marker it makes, so a later process given its pid is told apart (V2). */
  const started = processStart(process.pid)
  /** Each root this process captured, by its shadow git folder: the root whose git a sweep checks its repository with (G3 of the Codex recheck of F3). */
  const captured = new Map<string, string>()

  function program(roots: string[]): Program | null {
    return historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
  }
  function gitDirectory(root: string): string { return join(folder, createHash('sha256').update(root).digest('hex').slice(0, 24)) }

  async function git(found: Program, state: { root: string; git: string }, args: string[], options: { budget?: CaptureBudget; whole?: boolean; extra?: string[]; data?: string; magic?: boolean; errors?: (chunk: Buffer) => void; index?: string; objects?: string } = {}): Promise<Buffer> {
    // `magic`: pathspec magic is read, for the literal excludes of the protected paths; every other call takes paths as given.
    // Each step takes STEP_TIMEOUT_MS at most, git add (`whole`) all that is left of the budget, which it bounds too.
    // `errors`: git's stderr, which it writes in the C locale, so its warnings read the same on every system.
    // `objects`: a folder's repository objects, git's only store for a step that only reads (`cat-file`), so the history's
    // own copy never stands for what the repository holds (Slice F3, G3 of the Codex review).
    const left = options.budget ? Math.max(1, options.budget.deadline - Date.now()) : undefined
    const timeoutMs = left === undefined ? undefined : options.whole ? left : Math.min(STEP_TIMEOUT_MS, left)
    return runProgram({ program: found, operation: gitOperation(args), args: [...safety, ...options.extra ?? [], ...args], cwd: folder, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.root, GIT_INDEX_FILE: options.index ?? join(state.git, 'index'), GIT_OBJECT_DIRECTORY: options.objects ?? input.objects.root, ...(options.magic ? { GIT_LITERAL_PATHSPECS: '0' } : {}), ...(options.errors ? { LC_ALL: 'C' } : {}) }, ...(options.data === undefined ? {} : { data: options.data }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(options.budget?.signal ? { signal: options.budget.signal } : {}), ...(options.errors ? { errors: options.errors } : {}) })
  }

  /**
   * The shadow repository for `root`, made once; its excludes name Buckle's own state and the protected paths, which no
   * capture records. `protect` names those inside the root, each excluded from every pathspec too, as a workspace
   * .gitignore outranks the shadow excludes and could re-include one (X3). A background record runs it too, outside the
   * execution lock, so it removes no index, no index lock, and no side index (T1).
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
   * The repository a root's shadow index refers to, settled before a command (Slice F3): the objects folder named, or
   * undefined where the index refers to none. A record that stands (standing) is kept, and `holds` checks that the
   * repository still has a commit at HEAD and holds each blob the index takes from it (G3, G4 of the Codex review, H1 of
   * its recheck). Any other record goes with the index, and the root is seeded again (item 7). A root with no index, or
   * with one this process has not written that refers to no repository, is seeded where it lies in one.
   */
  async function settleSource(found: Program, state: { root: string; git: string; protect: string[] }, budget: CaptureBudget): Promise<Settled | undefined> {
    const indexed = inspect(join(state.git, 'index')) !== undefined
    const record = readSource(state.git)
    if (record === 'invalid' || (record !== undefined && !indexed)) return rebuild(found, state, budget)
    if (record !== undefined) {
      const ids = standing(state, record)
      return ids ? { objects: record.objects, holds: holds(found, state, ids, record, budget).catch(unlessStopped(false)) } : rebuild(found, state, budget)
    }
    if (indexed && rewritten.has(state.root)) return undefined
    const seeded = await seed(found, state, budget).catch(unlessStopped(undefined))
    return seeded && { objects: seeded.objects }
  }

  /**
   * The blob ids the shadow index of a record that still stands takes from its repository, which `holds` then checks;
   * undefined where it no longer stands: the repository, found from the root with no git, is at another objects folder
   * or none; its index changed since and no longer reads plain (G5 of the Codex review); or the shadow index or its ids
   * do not read.
   */
  function standing(state: { root: string; git: string }, record: SourceRecord): string[] | undefined {
    const owner = ownerGitDirectory(state.root)
    if (owner === undefined || realPath(join(owner, 'objects')) !== record.objects) return undefined
    const identity = pathIdentity(record.index)
    if (identity !== record.indexIdentity) {
      const read = readRepositoryIndex(record.index)
      if (!(read && parseIndex(read))?.plain) return undefined
      writeSource(state.git, { ...record, indexIdentity: identity })
    }
    const held = readSourceIds(state.git)
    const entries = shadowIndex(state.git)
    if (!held || !entries) return undefined
    return [...new Set(entries.filter(entry => namesBlob(entry) && held.has(entry.id)).map(entry => entry.id))]
  }

  /**
   * Whether the repository `record` names still stands as a seed found it (item 1), checked by git from the root: the
   * same objects folder and index, with a commit at HEAD, which a switch to a branch with none takes away (H1 of the
   * Codex recheck); and whether its objects folder, read alone, holds each of `ids`: never the history's own copy, which
   * the sweep may remove once no checkpoint holds it (G3). One look at each object's file or a pack's index, before each
   * command, as no folder's time on disk proves an object is still there (G4). Both git steps run together, beside git
   * add; the look takes what is left of the budget, as git add does, as its work grows with the repository.
   */
  async function holds(found: Program, state: { root: string; git: string }, ids: string[], record: SourceRecord, budget: CaptureBudget): Promise<boolean> {
    const [location, present] = await both(
      locate(found, state.root, budget).then(output => parseLocation(output.toString())),
      ids.length ? git(found, state, ['cat-file', '--batch-check=%(objectname)'], { data: `${ids.join('\n')}\n`, objects: record.objects, budget, whole: true }).then(parseExistence) : Promise.resolve(new Set<string>()),
    )
    return location !== undefined && realPath(location.objects) === record.objects && location.index === record.index && ids.every(id => present.has(id))
  }

  /**
   * git add, before a command beside the check that the repository still holds what its record refers to (G4): both end
   * before either answer is used. Where it does not hold, the record is built again, and git add runs once more. After a
   * command, git add alone.
   */
  async function refreshSettled(found: Program, state: { root: string; git: string; extra: string[]; protect: string[] }, budget: CaptureBudget, settled: Settled | undefined): Promise<{ refreshed: Awaited<ReturnType<typeof refresh>>; source?: string }> {
    const [refreshed, held] = await both(refresh(found, state, budget), settled?.holds ?? Promise.resolve(true))
    if (held) return { refreshed, ...settled ? { source: settled.objects } : {} }
    const rebuilt = await rebuild(found, state, budget)
    return { refreshed: await refresh(found, state, budget), ...rebuilt ? { source: rebuilt.objects } : {} }
  }

  /**
   * Drops a root's record and index and seeds the root again, which W1's repair then completes from the work tree (item
   * 7): an entry git wrote for a file that still holds the same blob needs no second read.
   */
  async function rebuild(found: Program, state: { root: string; git: string; protect: string[] }, budget: CaptureBudget): Promise<Settled | undefined> {
    logger.info('History\'s record of a command folder\'s repository no longer holds; it builds the record again from the folder')
    const prior = shadowEntries(state.git)
    reset(state)
    const seeded = await seed(found, state, budget, prior).catch(unlessStopped(undefined))
    return seeded && { objects: seeded.objects }
  }

  /**
   * Seeds a root's shadow index from the index of the repository it lies in (Slice F3, items 1 and 2): where that
   * repository has a commit, SHA-1 objects, and an index git can read with nothing beyond its entries, each entry below
   * the root (seedCandidates) whose blob the repository holds and whose file holds that blob's very bytes (verified).
   * Git add then hashes only the files that differ. The record is written first, so an index that refers to a repository
   * is never left without it. Read with host git under the isolated config; nothing is written to the repository.
   * undefined where nothing is seeded: the root then takes today's path, as for any failure of these steps but its
   * budget's (settleSource). `prior`: the shadow index's entries as git last wrote them, read here unless given.
   */
  async function seed(found: Program, state: { root: string; git: string; protect: string[] }, budget: CaptureBudget, prior?: Map<string, IndexEntry>): Promise<SourceRecord | undefined> {
    if (ownerGitDirectory(state.root) === undefined) return undefined
    const located = parseLocation((await locate(found, state.root, budget)).toString())
    const objects = located && realPath(located.objects)
    const prefix = located && prefixWithin(located.top, state.root)
    if (!located || objects === undefined || prefix === undefined) return undefined
    // The index's identity before it is read, so a change while it is read is checked at the next capture (G5).
    const indexIdentity = pathIdentity(located.index)
    const read = readRepositoryIndex(located.index)
    const parsed = read && parseIndex(read)
    if (!parsed?.plain) return undefined
    const candidates = seedCandidates({ entries: parsed.entries, prefix, protect: state.protect })
    if (!candidates.length) return undefined
    const sizes = await sizesOf(found, state, [...new Set(candidates.map(entry => entry.id))], objects, budget)
    const entries = await verified(found, state, candidates.filter(entry => sizes.has(entry.id)), sizes, prior ?? shadowEntries(state.git), budget)
    if (!entries.length) return undefined
    const record = { objects, index: located.index, indexIdentity }
    writeSource(state.git, record, [...new Set(entries.map(entry => entry.id))])
    const temporary = join(state.git, `index.seed-${randomUUID()}`)
    try { writeFileSync(temporary, writeIndex(entries), { mode: 0o600, flag: 'wx' }); await replaceFile(temporary, join(state.git, 'index')) }
    catch (error) { removeSource(state.git); throw error }
    finally { rmSync(temporary, { force: true }) }
    rewritten.delete(state.root)
    logger.debug('History seeded a command folder\'s record from its repository\'s index', { entries: entries.length, left: candidates.length - entries.length })
    return record
  }

  /**
   * The entries of `held` whose file holds the very bytes of the repository's blob, as git hashes it raw (G2 of the
   * Codex review). Never the repository's stat data alone: a clean filter that keeps a file's length, or an index
   * written by hand, makes it stand for other content. An entry the shadow index holds for the same blob keeps the stat
   * data git wrote as it hashed that file. Each other goes into a side index with no stat data but its blob's size
   * (unverified), which `git update-index --refresh` brings up to date: git hashes each file of that size, writes no
   * object, and gives the file's own stat data to each whose hash is its blob's. The rest are left to git add.
   */
  async function verified(found: Program, state: { root: string; git: string }, held: IndexEntry[], sizes: Map<string, number>, prior: Map<string, IndexEntry>, budget: CaptureBudget): Promise<IndexEntry[]> {
    const unknown = held.filter(entry => !sameBlob(prior.get(entryKey(entry)), entry))
    const hashed = new Map<string, Buffer>()
    if (unknown.length) {
      const side = join(state.git, VERIFY_INDEX)
      try {
        rmSync(side, { force: true })
        writeFileSync(side, writeIndex(unknown.map(entry => unverified(entry, sizes.get(entry.id)!))), { mode: 0o600, flag: 'wx' })
        await git(found, state, ['update-index', '-q', '--refresh'], { index: side, budget, whole: true })
        for (const entry of parseIndex(readFileSync(side))?.entries ?? []) {
          const size = sizes.get(entry.id)
          if (size !== undefined && refreshedAs(entry, size)) hashed.set(entryKey(entry), entry.stat)
        }
      } finally { rmSync(side, { force: true }); rmSync(`${side}.lock`, { force: true }) }
    }
    return held.flatMap(entry => {
      const own = prior.get(entryKey(entry))
      const stat = sameBlob(own, entry) ? own.stat : hashed.get(entryKey(entry))
      return stat ? [{ ...entry, stat }] : []
    })
  }

  /** A root's shadow index's entries as git last wrote it; undefined where it does not read. */
  function shadowIndex(git: string): IndexEntry[] | undefined {
    try { return parseIndex(readFileSync(join(git, 'index')))?.entries } catch { return undefined }
  }
  /** Those entries by name; none where it does not read. */
  function shadowEntries(git: string): Map<string, IndexEntry> {
    return new Map((shadowIndex(git) ?? []).map(entry => [entryKey(entry), entry]))
  }

  /** Drops a root's shadow index and the record of the repository it refers to: its next capture builds it again (item 7). */
  function reset(state: { root: string; git: string }): void {
    rmSync(join(state.git, 'index'), { force: true }); removeSource(state.git); rewritten.delete(state.root)
  }

  /** The repository `root` lies in, found by git from the root, under the isolated config: one rev-parse. */
  function locate(found: Program, root: string, budget: CaptureBudget): Promise<Buffer> {
    const timeoutMs = Math.min(STEP_TIMEOUT_MS, Math.max(1, budget.deadline - Date.now()))
    return runProgram({ program: found, operation: 'rev-parse', args: [...safety, ...LOCATE_ARGS], cwd: root, environment, timeoutMs, ...(budget.signal ? { signal: budget.signal } : {}) })
  }

  /**
   * Each of `ids`'s size where it names a blob the repository's `objects` folder holds, read as git's only store, so the
   * history's own copy never stands for it (G3): one batch check, which takes what is left of the budget, as a seed's
   * grows with the repository.
   */
  async function sizesOf(found: Program, state: { root: string; git: string }, ids: string[], objects: string, budget: CaptureBudget): Promise<Map<string, number>> {
    if (!ids.length) return new Map()
    return parseBatchCheck(await git(found, state, ['cat-file', '--batch-check'], { data: `${ids.join('\n')}\n`, objects, budget, whole: true }))
  }

  /**
   * Copies into the history's store, before the checkpoint is saved, the content each changed file or link had before a
   * command where the shadow index referred to the repository for it (Slice F3, item 3): within the content cap only, as
   * a file over it is recorded over the cap, as before. Answers the size of each, and those gone: missing from the
   * repository, or not read at all, which never refuses or delays the call. One missing drops the record, so the next
   * capture builds it again from the work tree (item 7).
   */
  async function borrowed(found: Program, left: CommandBaseline, changes: RawChange[], budget: CaptureBudget): Promise<{ sizes: Map<string, number>; gone: Set<string> }> {
    const wanted = left.source === undefined ? [] : [...new Set(changes.filter(change => BLOB_MODE.test(change.oldMode) && !input.objects.has(change.oldId)).map(change => change.oldId))]
    if (!wanted.length || left.source === undefined) return { sizes: new Map(), gone: new Set() }
    try {
      const sizes = await sizesOf(found, left, wanted, left.source, budget)
      const gone = new Set(wanted.filter(id => !sizes.has(id)))
      for (const chunk of byBytes(wanted.filter(id => sizes.get(id)! <= input.maxFileBytes()), sizes)) {
        const contents = parseBatch(await git(found, left, ['cat-file', '--batch'], { data: `${chunk.join('\n')}\n`, objects: left.source, budget }))
        for (const id of chunk) {
          const content = contents?.get(id)
          if (content === undefined || blobId(content) !== id) gone.add(id)
          else await input.objects.put(content)
        }
      }
      if (gone.size) { reset(left); logger.warn('History found content its folder\'s repository no longer holds, so those paths are not restorable; the next command builds its record from the folder', { count: gone.size }) }
      return { sizes, gone }
    } catch (error) {
      logger.warn('History could not copy what a command changed from its folder\'s repository, so those paths are not restorable', { cause: gitCause(error) })
      return { sizes: new Map(), gone: new Set(wanted) }
    }
  }

  /**
   * Each directory root's state now: the index brought up to date (refresh), then, together, its tree, the tracked files
   * whose index state git could not refresh, and what git saw on disk but did not store: its folders, its files, and the
   * folders it warned it could not open (X5, X10, R1.3). A root whose first record is still being taken in the background
   * is never read: the command runs without restorable content, at once (W2). `progress` names the root git reads. Before
   * a command, the repository its shadow index refers to is settled first (Slice F3).
   */
  function baseline(roots: string[], budget: CaptureBudget, progress: { root?: string } = {}): Promise<CommandBaseline[]> { return capture(roots, budget, progress, 'before') }
  async function capture(roots: string[], budget: CaptureBudget, progress: { root?: string }, phase: 'before' | 'after'): Promise<CommandBaseline[]> {
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
      captured.set(state.git, root)
      // Under the call's execution lock alone (T1): a killed child leaves the index's lock, and no other capture of this
      // root runs, as a background record writes its side index's own (A4, B6); a side index no live record is building
      // is a stopped one's (W2).
      rmSync(join(state.git, 'index.lock'), { force: true }); tidy(root)
      const settled = phase === 'before' ? await settleSource(found, state, budget) : undefined
      const excludes = state.protect.map(name => `:(exclude,literal)${name}`)
      const { refreshed, source } = await refreshSettled(found, state, budget, settled)
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
      result.push({ root, identity, git: state.git, tree, ignored: ignoredState(root, refreshed.ignored), partial: refreshed.partial || seen.unknown.size > 0, ...seen, stale: new Set(stale.toString().split('\0').filter(Boolean)), ...source === undefined ? {} : { source } })
    }
    return result
  }

  /**
   * A root's first record, taken off every call path once a command's budget cut it short (W2): its index is built in a
   * side file, within `budget`, with no execution lock, while a command in that root runs without reading it
   * (BaselineWarmingError). Then `exclusive` runs the swap under the lock: the side index becomes the shadow index unless
   * that changed since it was copied. A marker names this instance and its process to every sweep, which removes nothing
   * while it stands, as git writes objects no index names yet. Called under the execution lock, as a command's call ends:
   * the marker is made there before anything is awaited, and it goes with the side index under the lock again as the record
   * ends (V1). Answers whether the record took its place.
   */
  async function warm(root: string, budget: CaptureBudget, exclusive: (step: () => Promise<void>, options: { signal?: AbortSignal; immediate?: boolean }) => Promise<void>): Promise<boolean> {
    if (warming.has(root) || !claim(root)) return false
    const stop = new AbortController()
    warming.set(root, stop)
    const signals = [stop.signal, ...budget.signal ? [budget.signal] : []]
    const background = { deadline: budget.deadline, signal: AbortSignal.any(signals) }
    try {
      const found = program([root])
      if (!found) throw new HostGitNeededError('Host git is not permitted')
      const identity = folderIdentity(root)
      if (identity === undefined) throw new FolderReplacedError('A folder history records is no longer a folder')
      const state = await prepare(found, root, background)
      // What a stopped record left went under the lock as this one's marker was made (claim): outside the lock, the record
      // writes its own side index alone (T1).
      const index = join(state.git, 'index'); const side = join(state.git, WARM_INDEX)
      const base = fileIdentity(index)
      if (base !== undefined) copyFileSync(index, side)
      await refresh(found, state, background, side)
      // Every tree written again, as a copied index may name one an earlier build removed (W1).
      await writeTree(found, state, background, side)
      if (folderIdentity(root) !== identity) throw new FolderReplacedError('A folder history records was replaced while git read it')
      let placed = false
      await exclusive(async () => { if (fileIdentity(index) === base && !stop.signal.aborted) { await replaceFile(side, index); placed = true } }, { signal: background.signal })
      if (placed) rewritten.add(root)
      return placed
    } finally {
      // The root is let go first, so a removal the system refuses never leaves it marked as taking a record (V1).
      warming.delete(root)
      // Under the lock (V1). As history closes it is tried once; a lock taken leaves it to the root's next capture or sweep.
      const closing = budget.signal?.aborted === true
      await exclusive(async () => { tidy(root) }, closing ? { immediate: true } : budget.signal ? { signal: budget.signal } : {}).catch(() => { leftovers.add(root) })
    }
  }

  /**
   * Makes `root`'s marker, exclusively, under the execution lock, as no other marker is made or removed but under it (V1):
   * what a record no longer running left goes first, and a live one's stays, so no second record of the root starts. One
   * made but not written whole, as on a full disk, names no record and goes at once, as nothing could prove it stale later
   * (V2). Answers whether this instance took it.
   */
  function claim(root: string): boolean {
    const git = gitDirectory(root)
    const marker = join(git, WARM_MARKER)
    tidy(root)
    mkdirSync(git, { recursive: true, mode: 0o700 })
    let made: number
    try { made = openSync(marker, 'wx', 0o600) } catch (error) { if (systemCode(error) === 'EEXIST') return false; throw error }
    try { writeFileSync(made, JSON.stringify({ pid: process.pid, ...started === undefined ? {} : { started }, instance })) }
    catch (error) { closeSync(made); rmSync(marker, { force: true }); throw error }
    closeSync(made)
    return true
  }

  /**
   * Removes what a background record of `root` made, each file on its own, the marker last, unless that record still runs
   * (liveMarker), so no live record's side index is ever removed. Only under the execution lock (V1). A removal the system
   * refuses, as Windows does while another handle holds the file, keeps the root among the leftovers, tried again at its
   * next capture and before each sweep: a marker of this instance counts only while its record runs, and the sweep keeps
   * what its side index names meanwhile.
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
  /**
   * What background records left that the system refused to remove, tried again where none runs (V1), one root at a time
   * until `until` passes (V3). Answers whether it tried any.
   */
  function tidyLeftovers(until = Infinity): boolean {
    let tried = false
    for (const root of leftovers) {
      if (performance.now() >= until) break
      if (!warming.has(root)) { tidy(root); tried = true }
    }
    return tried
  }

  /** Stops every first record this process takes in the background; each removes what it made as it ends. */
  function stopWarming(): void { for (const stop of warming.values()) stop.abort(new Error('History stopped its background record')) }

  /**
   * What changed between `before` and now, each changed path's entry on both sides. A side's mode is its file's own on
   * disk after the command, and before it the mode `prior` last recorded for the same content, else git's 644 or 755.
   * `progress` names the root git reads, as for a baseline.
   */
  async function changes(before: CommandBaseline[], prior: (path: string) => Entry | undefined, budget: CaptureBudget, progress: { root?: string } = {}): Promise<CommandChanges> {
    if (before.some(item => folderIdentity(item.root) !== item.identity)) throw new FolderReplacedError('A folder history records was replaced during the command')
    const after = await capture(before.map(item => item.root), budget, progress, 'after')
    const found = program(before.map(item => item.root))!
    const result: CommandChanges = { before: {}, after: {}, ignored: 0, partial: after.some(item => item.partial) }
    for (const [index, left] of before.entries()) {
      const right = after[index]!
      result.ignored += ignoredChanges(left.ignored, right.ignored)
      if (left.tree === right.tree) continue
      // A tree that cannot be read: the next capture of this root writes every tree again (W1).
      const raw = await git(found, left, ['diff-tree', '-r', '-t', '-z', '--raw', '--no-renames', '--no-abbrev', '--no-commit-id', left.tree, right.tree], { budget }).catch((error: unknown) => { rewritten.delete(left.root); throw error })
      const listed = parseRaw(raw)
      const copied = await borrowed(found, left, listed, budget)
      for (const change of listed) {
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
          : left.stale.has(change.name) ? { kind: 'unreadable' as const, mode: change.oldMode === '100755' ? 0o755 : 0o644 } : await sideBefore(change.oldMode, change.oldId, prior(path), copied)
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

  /** `copied`: what was copied from the repository the shadow index referred to, and what was gone from it (Slice F3). */
  async function sideBefore(mode: string, id: string, prior: Entry | undefined, copied: { sizes: Map<string, number>; gone: Set<string> }): Promise<Entry | undefined> {
    if (ZERO.test(mode)) return undefined
    if (mode === '160000') return { kind: 'excluded', mode: 0, reason: 'nested', hash: id }
    if (mode === '040000') return { kind: 'directory', mode: prior?.kind === 'directory' ? prior.mode : 0o755 }
    if (copied.gone.has(id)) return { kind: 'unreadable', mode: mode === '120000' ? 0o777 : mode === '100755' ? 0o755 : 0o644, reason: 'source-gone' }
    if (mode === '120000') {
      try { const target = (await input.objects.read(id)).toString(); return { kind: 'symlink', mode: prior?.kind === 'symlink' && prior.target === target ? prior.mode : 0o777, target } }
      catch { return { kind: 'unreadable', mode: 0o777 } }
    }
    const fallback = mode === '100755' ? 0o755 : 0o644
    const size = input.objects.size(id) ?? copied.sizes.get(id)
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
   * names, which git takes as written while it is there (W1). `kept`, those a sweep keeps. `lent`, by root, each blob the
   * root's repository was found holding as its index was seeded and that no index needs a copy of otherwise: a command
   * that changes its file copies it from there, and a capture that finds it gone builds the index again (Slice F3, items
   * 5 and 7), so a sweep removes its copy only once it finds the repository holding it then and there (released, G3 of
   * the Codex recheck). undefined where an index or those ids cannot be read, so nothing is swept on a guess.
   */
  function indexed(): { kept: Set<string>; lent: Lent[] } | undefined {
    const kept = new Set<string>()
    const lent: Lent[] = []
    let folders: string[]
    try { folders = readdirNames(folder) } catch { return undefined }
    for (const name of folders) {
      if (!/^[0-9a-f]{24}$/.test(name)) continue
      const git = join(folder, name)
      const held = readSourceIds(git)
      if (!held) return undefined
      // Ids that stand with no record that reads lend nothing: the sweep keeps each.
      const record = held.size ? readSource(git) : undefined
      const borrowed = new Set<string>()
      for (const file of ['index', WARM_INDEX]) {
        let index: Buffer
        try { index = readFileSync(join(git, file)) } catch (error) { if (isMissing(error)) continue; return undefined }
        const read = readIndex(index)
        if (!read) return undefined
        for (const entry of read.entries) (typeof record === 'object' && held.has(entry.id) ? borrowed : kept).add(entry.id)
        for (const tree of read.trees) kept.add(tree)
      }
      if (typeof record === 'object' && borrowed.size) lent.push({ git, objects: record.objects, ids: borrowed })
    }
    for (const lender of lent) for (const id of lender.ids) if (kept.has(id)) lender.ids.delete(id)
    return { kept, lent }
  }

  /**
   * Of `candidates`, the copies a sweep is to keep as `lent` takes them from repositories (G3 of the Codex recheck of
   * F3): each, unless every repository that lends it was found holding it, read outside the lock as `holds` reads it,
   * the repository's objects folder alone, in one existence check each. First a stat of each place git keeps each id
   * there is taken (holdingState); `still`, under the lock just before a copy is removed, takes it again, so a repository
   * that lost or moved an object since keeps the copy. A repository whose root this process has not captured, whose
   * alternates do not read, or whose check fails proves nothing. It never runs on a call's path.
   */
  async function released(lent: Lent[], candidates: Set<string>, signal?: AbortSignal): Promise<{ kept: Set<string>; still: (id: string) => boolean }> {
    const kept = new Set<string>()
    const proofs = new Map<string, Array<{ folders: string[]; state: string }>>()
    for (const lender of lent) {
      const ids = [...lender.ids].filter(id => candidates.has(id))
      if (!ids.length) continue
      const root = captured.get(lender.git)
      const found = root === undefined ? null : program([root])
      const folders = found ? objectFolders(lender.objects) : undefined
      if (!found || root === undefined || !folders) { for (const id of ids) kept.add(id); continue }
      const states = new Map(ids.map(id => [id, holdingState(folders, id)]))
      const budget = { deadline: Date.now() + STEP_TIMEOUT_MS, ...signal ? { signal } : {} }
      const present = await git(found, { root, git: lender.git }, ['cat-file', '--batch-check=%(objectname)'], { data: `${ids.join('\n')}\n`, objects: lender.objects, budget })
        .then(parseExistence, (error: unknown) => { logger.debug('History keeps the copies a command folder\'s repository lends: it could not check that repository', { cause: gitCause(error) }); return new Set<string>() })
      for (const id of ids) {
        if (present.has(id)) proofs.set(id, [...proofs.get(id) ?? [], { folders, state: states.get(id)! }])
        else kept.add(id)
      }
    }
    return { kept, still: id => (proofs.get(id) ?? []).every(proof => holdingState(proof.folders, id) === proof.state) }
  }

  /**
   * Whether `git`'s marker names a record that may still run (V1, V2): one of this instance while it runs here; one of
   * another instance, in this process or another, until it is proven stale: its process gone, or its pid taken by a
   * process that started after the marker was made, where the system says when each started (Linux). No marker expires
   * with time. One never proven stale, unread or where the system does not say, holds back every sweep, never a call.
   */
  function liveMarker(git: string): boolean {
    const path = join(git, WARM_MARKER)
    if (!inspect(path)) return false
    let marker: { pid?: unknown; started?: unknown; instance?: unknown } = {}
    try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); if (parsed && typeof parsed === 'object') marker = parsed } catch { /* unread: nothing proves it stale */ }
    if (marker.instance === instance) return [...warming.keys()].some(root => gitDirectory(root) === git)
    const { pid } = marker
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return true
    if (!processLives(pid)) return false
    // Another start than the one the marker names: the process that made it ended, and a later one took its pid.
    const now = typeof marker.started === 'string' ? processStart(pid) : undefined
    return now === undefined || now === marker.started
  }

  /**
   * The paths whose identity on disk changes as any shadow index, side index, or marker is written, made, or removed: the
   * folder that holds each root's, which a new root changes, and each root's three files. Listed without the lock (V3).
   */
  function indexPaths(): string[] {
    const names = readdirNames(folder).filter(name => /^[0-9a-f]{24}$/.test(name)).sort()
    return [folder, ...names.flatMap(name => ['index', WARM_INDEX, WARM_MARKER].map(file => join(folder, name, file)))]
  }
  /**
   * Those paths' identity on disk, from a stat of each and nothing else: the state a sweep in slices read what to keep
   * from, checked again under the lock before each slice, with no listing and no read there (V3).
   */
  function indexState(paths: string[]): string { return paths.map(pathIdentity).join('|') }

  /** Whether a first record is being taken in the background, by this instance or by a live other one (W2, V2). */
  function warmingAny(): boolean {
    if (warming.size) return true
    let names: string[]
    try { names = readdirNames(folder) } catch { return true }
    return names.some(name => /^[0-9a-f]{24}$/.test(name) && liveMarker(join(folder, name)))
  }

  return {
    baseline, changes, indexed, released, indexPaths, indexState, warm, stopWarming, tidyLeftovers, warming: warmingAny,
    /** Whether this instance takes a first record in the background now, from its own state alone, with no read (V3). */
    recording: () => warming.size > 0,
    available: (roots: string[]) => program(roots) !== null,
  }
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

function processLives(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return systemCode(error) === 'EPERM' }
}
/**
 * When the process `pid` started, in clock ticks since boot, which never changes while it runs: field 22 of Linux's
 * /proc/<pid>/stat, the 20th after the command name, which stands in parentheses and may hold any character. undefined
 * elsewhere, or where the system hides it.
 */
function processStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { return undefined }
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return start !== undefined && /^[0-9]+$/.test(start) ? start : undefined
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
/** Both promises' values once both have ended, so no git child of either still runs as the first failure is thrown. */
async function both<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [one, two] = await Promise.allSettled([first, second])
  if (one.status === 'rejected') throw one.reason
  if (two.status === 'rejected') throw two.reason
  return [one.value, two.value]
}
/** `ids` in runs of at most COPY_BATCH_BYTES of content by `sizes`, one object at least in each. */
function byBytes(ids: string[], sizes: Map<string, number>): string[][] {
  const runs: string[][] = []
  let bytes = Infinity
  for (const id of ids) {
    const size = sizes.get(id) ?? 0
    if (bytes + size > COPY_BATCH_BYTES) { runs.push([]); bytes = 0 }
    runs.at(-1)!.push(id); bytes += size
  }
  return runs
}
/** What the owner's log may say of a step that failed: for git which step and how, else a system code, never a message. */
function gitCause(error: unknown): Record<string, string | number> {
  if (error instanceof HistoryGitError) return { operation: error.details.operation, failure: error.details.failure, ...error.details.exitCode === undefined ? {} : { exitCode: error.details.exitCode } }
  return { error: error instanceof Error ? error.constructor.name : 'Unknown', ...systemCode(error) ? { code: systemCode(error)! } : {} }
}
/** A path as the system names it, links resolved and, on Windows, in its own case, so two spellings of one folder compare equal. */
function realPath(path: string): string | undefined { try { return realpathSync.native(path) } catch { return undefined } }
/**
 * A step of Slice F3 that failed answers `fallback`, so the root takes today's path, unless its budget or its call's
 * cancellation stopped it: that stops the phase, as for any git step, and W2 finishes the record in the background.
 */
function unlessStopped<T>(fallback: T): (error: unknown) => T {
  return error => {
    if (error instanceof HistoryGitError && (error.details.failure === 'timeout' || error.details.failure === 'aborted')) throw error
    logger.debug('History refers to no repository for a command folder: a step that reads it failed', { cause: gitCause(error) })
    return fallback
  }
}
/** A system error's code alone, as the owner's log may name it (D2). */
function systemCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? error.code : undefined
}
/** A file's identity on disk, so a swap can tell the index it copied from one written since. */
function fileIdentity(path: string): string | undefined {
  const stat = inspect(path)
  return stat?.isFile() ? statIdentity(stat) : undefined
}
/** A path's identity on disk, a folder's too, `-` for none: one stat (V3). */
function pathIdentity(path: string): string {
  const stat = inspect(path)
  return stat ? statIdentity(stat) : '-'
}
function statIdentity(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
/**
 * Where each place git keeps `id` in `folders` stands on disk, from a stat of each (G3 of the Codex recheck of F3): the
 * fan-out folder of its loose object, the packs' folder, and the alternates file. Git adds or removes no object there,
 * loose or packed, and names no other folder, without changing one of them, so an answer that reads the same later says
 * what git found in between still stands.
 */
function holdingState(folders: string[], id: string): string {
  return folders.map(folder => [join(folder, id.slice(0, 2)), join(folder, 'pack'), join(folder, 'info', 'alternates')].map(pathIdentity).join('|')).join('/')
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
