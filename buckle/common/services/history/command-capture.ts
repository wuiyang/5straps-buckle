import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { join, relative } from 'pathe'
import type { Program, UntrustedRoots } from '../../domain/executable.js'
import { childPath, isInside, isPlainName } from '../../domain/paths.js'
import { escapeIgnore, gitOperation, historyGitProgram, isolatedGit, ownerGitDirectory, RAW_ATTRIBUTES, regularFile, runProgram } from './git-store.js'
import type { ObjectStore } from './object-store.js'
import { modeOf } from './scoped-capture.js'
import type { Entry, Snapshot } from './snapshot.js'

/** How long `git add -A` may run: a first capture hashes every file git tracks once, which can take minutes on a slow disk. */
const ADD_TIMEOUT_MS = 300_000
const SETUP_MARKER = 'buckle-setup-complete'
const ZERO = /^0+$/

/**
 * One root as git saw it at one phase of a command: the folder's identity on disk, the tree its shadow index wrote, and
 * the ignored entries beside it.
 */
export interface CommandBaseline { root: string; identity: string; git: string; tree: string; ignored: Map<string, string>; partial: boolean }

/** What a command changed, read from two baselines: each changed path's entries, and how many ignored entries changed. */
export interface CommandChanges { before: Snapshot; after: Snapshot; ignored: number; partial: boolean }

export class HostGitNeededError extends Error {}
/** A root that is no longer the folder it was, a link or another folder in its place: git would read where it lands. */
export class FolderReplacedError extends Error {}

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
  const { environment, safety, empty } = isolatedGit(join(folder, 'private'))

  function program(roots: string[]): Program | null {
    return historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
  }
  function gitDirectory(root: string): string { return join(folder, createHash('sha256').update(root).digest('hex').slice(0, 24)) }

  async function git(found: Program, state: { root: string; git: string }, args: string[], options: { timeoutMs?: number; extra?: string[]; data?: string } = {}): Promise<Buffer> {
    return runProgram({ program: found, operation: gitOperation(args), args: [...safety, ...options.extra ?? [], ...args], cwd: folder, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.root, GIT_INDEX_FILE: join(state.git, 'index'), GIT_OBJECT_DIRECTORY: input.objects.root }, ...(options.data === undefined ? {} : { data: options.data }), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) })
  }

  /** The shadow repository for `root`, made once; its excludes name Buckle's own state, which no capture records. */
  async function prepare(found: Program, root: string): Promise<{ root: string; git: string; extra: string[] }> {
    const state = { root, git: gitDirectory(root) }
    const attributes = join(state.git, 'info', 'attributes')
    if (!regularFile(join(state.git, SETUP_MARKER)) || !regularFile(join(state.git, 'HEAD')) || !regularFile(attributes, Buffer.byteLength(RAW_ATTRIBUTES))) {
      rmSync(join(state.git, SETUP_MARKER), { force: true })
      mkdirSync(state.git, { recursive: true, mode: 0o700 }); mkdirSync(input.objects.root, { recursive: true, mode: 0o700 })
      await git(found, state, ['init', '--quiet', `--template=${empty}`, state.git])
      mkdirSync(join(state.git, 'info'), { recursive: true, mode: 0o700 })
      writeFileSync(attributes, RAW_ATTRIBUTES, { mode: 0o600 })
      writeFileSync(join(state.git, SETUP_MARKER), '', { mode: 0o600 })
    }
    const excludes = input.excluded().filter(path => isInside(root, path) && path !== root).map(path => `/${escapeIgnore(relative(root, path))}`).join('\n') + '\n'
    const file = join(state.git, 'info', 'exclude')
    if (readText(file) !== excludes) writeFileSync(file, excludes, { mode: 0o600 })
    // A killed child leaves its lock; under the execution lock no other capture of this root runs (A4, B6).
    rmSync(join(state.git, 'index.lock'), { force: true })
    const owner = ownerGitDirectory(root)
    const own = owner === undefined ? undefined : join(owner, 'info', 'exclude')
    return { ...state, extra: own !== undefined && regularFile(own) ? ['-c', `core.excludesFile=${own}`] : [] }
  }

  /** Each directory root's state now: the index brought up to date, and its tree written. */
  async function baseline(roots: string[]): Promise<CommandBaseline[]> {
    const found = program(roots)
    if (!found) throw new HostGitNeededError('Host git is not permitted')
    const result: CommandBaseline[] = []
    for (const root of roots) {
      // Git follows a work tree that is a link, so a folder swapped for one is never read (folder-swap review).
      const identity = folderIdentity(root)
      if (identity === undefined) throw new FolderReplacedError('A folder history records is no longer a folder')
      const state = await prepare(found, root)
      // Started together: the listing reads the index add replaces whole, and either copy answers the same for what is
      // ignored, tracked (H) or not (?). A tracked file an ignore rule now covers leaves the index, so it is never stored.
      const [added, listed] = await Promise.all([
        // Exit 1: some files could not be read, and the index holds the rest (A7).
        git(found, state, ['add', '-A', '--ignore-errors', '--', '.'], { timeoutMs: ADD_TIMEOUT_MS, extra: state.extra }).then(() => 0, (error: unknown) => { if (isExit(error, 1)) return 1; throw error }),
        git(found, state, ['ls-files', '-z', '-t', '--cached', '--others', '--ignored', '--exclude-standard', '--directory'], { extra: state.extra }),
      ])
      const ignored = listed.toString().split('\0').filter(line => /^[H?] ./.test(line))
      const tracked = ignored.filter(line => line.startsWith('H ')).map(line => line.slice(2))
      if (tracked.length) await git(found, state, ['update-index', '--force-remove', '-z', '--stdin'], { data: tracked.join('\0') + '\0' })
      const tree = (await git(found, state, ['write-tree', '--missing-ok'])).toString().trim()
      if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('History git wrote no tree')
      // Swapped while git read it: the index may name what the link held, so it goes, and nothing keeps that content.
      if (folderIdentity(root) !== identity) { rmSync(join(state.git, 'index'), { force: true }); throw new FolderReplacedError('A folder history records was replaced while git read it') }
      result.push({ root, identity, git: state.git, tree, ignored: ignoredState(root, ignored.map(line => line.slice(2))), partial: added === 1 })
    }
    return result
  }

  /**
   * What changed between `before` and now, each changed path's entry on both sides. A side's mode is its file's own on
   * disk after the command, and before it the mode `prior` last recorded for the same content, else git's 644 or 755.
   */
  async function changes(before: CommandBaseline[], prior: (path: string) => Entry | undefined): Promise<CommandChanges> {
    if (before.some(item => folderIdentity(item.root) !== item.identity)) throw new FolderReplacedError('A folder history records was replaced during the command')
    const after = await baseline(before.map(item => item.root))
    const found = program(before.map(item => item.root))!
    const result: CommandChanges = { before: {}, after: {}, ignored: 0, partial: after.some(item => item.partial) }
    for (const [index, left] of before.entries()) {
      const right = after[index]!
      result.ignored += ignoredChanges(left.ignored, right.ignored)
      if (left.tree === right.tree) continue
      const raw = await git(found, left, ['diff-tree', '-r', '-t', '-z', '--raw', '--no-renames', '--no-abbrev', '--no-commit-id', left.tree, right.tree])
      for (const change of parseRaw(raw)) {
        if (change.status === 'M' && change.oldMode === '040000' && change.newMode === '040000') continue
        const parts = change.name.split('/')
        const path = childPath(left.root, change.name)
        if (!parts.every(part => isPlainName(part))) { result.before[path] = { kind: 'excluded', mode: 0 }; result.after[path] = { kind: 'excluded', mode: 0, reason: 'special' }; continue }
        // A path absent from one side's tree that an ignore rule covered there, or a folder holding what one covered,
        // was on disk all along: history never knew it, so no restore writes or removes it (A1).
        const was = ZERO.test(change.oldMode) && ignoredIn(left.ignored, change.name) ? ignoredEntry(path) : await sideBefore(change.oldMode, change.oldId, prior(path))
        const now = ZERO.test(change.newMode) ? untracked(path, ignoredIn(right.ignored, change.name)) : sideAfter(change.newMode, change.newId, path)
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
    if (size !== undefined && size > input.maxFileBytes()) return { kind: 'excluded', mode: own, size, reason: 'size' }
    return { kind: 'file', mode: own, hash: id }
  }

  /** The blob ids each shadow index names whose file is within the content cap: the content the next command's before state reuses. */
  function indexed(): Set<string> | undefined {
    const ids = new Set<string>()
    let folders: string[]
    try { folders = readdirNames(folder) } catch { return undefined }
    for (const name of folders) {
      if (!/^[0-9a-f]{24}$/.test(name)) continue
      let index: Buffer
      try { index = readFileSync(join(folder, name, 'index')) } catch { continue }
      const entries = indexEntries(index)
      if (!entries) return undefined
      for (const entry of entries) if (entry.size <= input.maxFileBytes()) ids.add(entry.id)
    }
    return ids
  }

  return { baseline, changes, indexed, available: (roots: string[]) => program(roots) !== null }
}

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
 * A git index's entries, read in-process: version 2 or 3, which an isolated config writes. Each entry's blob id and the
 * file size its stat gave. undefined for any other version, so nothing is swept on a guess.
 */
export function indexEntries(index: Buffer): Array<{ id: string; size: number }> | undefined {
  if (index.length < 12 || index.toString('latin1', 0, 4) !== 'DIRC') return undefined
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
  return entries
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
