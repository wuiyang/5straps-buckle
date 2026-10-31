import { spawn, type ChildProcess } from 'node:child_process'
import { constants as systemConstants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, mkdirSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename as nativeBasename, isAbsolute as nativeIsAbsolute, relative as nativeRelative, sep as nativeSeparator } from 'node:path'
import { dirname, join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { requireOwnerOnly, setMode } from '../../adapters/file-modes.js'
import { resolveProgram, rootsOf, type Program, type UntrustedRoots } from '../../domain/executable.js'
import { isInside, isPlainName } from '../../domain/paths.js'
import { logger } from '../../runtime/log.js'
import { captureHashes, historyCapturePath } from './capture-hashes.js'
import { snapshotSchema, type Snapshot } from './snapshot.js'

export const DEFAULT_HISTORY_FILE_BYTES = 32 * 1_048_576
export const treeCaptureSchema = z.object({ root: z.string(), workTree: z.string(), selector: z.string(), git: z.string(), commit: z.string(), extra: snapshotSchema })
export type TreeCapture = z.infer<typeof treeCaptureSchema>
export interface CapturedState { snapshot: Snapshot; trees: TreeCapture[]; restorable: boolean; reason?: string }
const HASH = /^[a-f0-9]{40,64}$/
const CHECKPOINT_ID = /^change-[a-zA-Z0-9-]+$/
/** Git reads every file as raw bytes: no line ending, filter, ident, or encoding change, so a blob id is the file's own. */
export const RAW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n**/* -text -filter -ident -working-tree-encoding\n'

const SETUP_MARKER = 'buckle-setup-complete'
const GIT_OPERATIONS = ['init', 'ls-files', 'update-index', 'add', 'read-tree', 'write-tree', 'commit-tree', 'ls-tree', 'check-ignore', 'cat-file', 'update-ref', 'diff-tree', 'checkout-index', 'for-each-ref', 'rev-parse', 'verify-pack', 'rev-list', 'gc'] as const
export type GitOperation = typeof GIT_OPERATIONS[number] | 'unknown'
type GitFailure = 'start' | 'timeout' | 'output-limit' | 'exit'
interface GitFailureDetails { operation: GitOperation; failure: GitFailure; elapsedMs: number; exitCode?: number; errno?: string }
interface CaptureTiming { captureHashesMs: number; resolveMs: number; gitSubprocessMs: number; commandCount: number }
interface CheckpointTrees { id: string; beforeTrees?: TreeCapture[]; afterTrees?: TreeCapture[] }
interface CommitShape { tree: string; parents: string[] }
const CHECKPOINT_REFS = 'refs/buckle/checkpoints/'
const STAGING_REFS = 'refs/buckle/migrations/'
const MAX_CACHED_COMMITS = 4096
type GitCommand = (state: Pick<TreeCapture, 'git' | 'workTree'>, args: string[], data?: string | Buffer, extra?: Record<string, string>, acceptedCodes?: number[]) => Promise<Buffer>

export class HistoryGitError extends Error {
  override readonly name = 'HistoryGitError'
  constructor(readonly details: GitFailureDetails) { super(`History git ${details.operation} failed (${details.failure}); inspect the checkpoint and retry`) }
}

export function historyGitProgram(input: { allowed: boolean; roots: string[]; untrusted?: UntrustedRoots }): Program | null {
  if (!input.allowed) return null
  const found = resolveProgram('git', { ...input.untrusted, untrustedRoots: [...input.untrusted?.untrustedRoots ?? [], ...rootsOf('workspace', input.roots)] })
  return found.path === null ? null : found
}

/**
 * How every history git child runs, from `owned`, a folder only Buckle writes: no system or global config, no hooks,
 * fsmonitor, filters, prompts, or lazy fetch, no automatic gc or maintenance, and the workspace's own config never read.
 * `empty` is the empty template and hooks folder, `config` the empty file git reads as its global config.
 */
export function isolatedGit(owned: string): { environment: Record<string, string>; safety: string[]; empty: string } {
  mkdirSync(owned, { recursive: true, mode: 0o700 })
  const empty = join(owned, 'empty'); mkdirSync(empty, { recursive: true, mode: 0o700 })
  const config = join(owned, 'config'); writeFileSync(config, '', { mode: 0o600 })
  const safeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const environment = { ...safeEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_AUTHOR_NAME: 'Buckle history', GIT_AUTHOR_EMAIL: 'history@buckle.invalid', GIT_COMMITTER_NAME: 'Buckle history', GIT_COMMITTER_EMAIL: 'history@buckle.invalid' }
  const safety = ['-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'gc.writeCommitGraph=false', '-c', 'core.commitGraph=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', `core.attributesFile=${config}`, '-c', 'core.fileMode=true', '-c', 'core.symlinks=true']
  return { environment, safety, empty }
}

export function createGitStore(input: { directory: string; excluded: string[]; maxFileBytes: () => number; allowed: () => boolean; untrusted?: () => UntrustedRoots; platform?: NodeJS.Platform }) {
  const owned = join(input.directory, 'git-private')
  const { environment, safety, empty } = isolatedGit(owned)
  const primaryFile = join(owned, 'primary-root')
  let primary: string | undefined = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : undefined
  const exclusions = [...input.excluded, input.directory]
  const warnedNames = new Set<string>()
  const commitShapes = new Map<string, CommitShape>()

  const git = gitCommand()
  function trustedProgram(roots: string[], timing?: CaptureTiming): Program | null {
    const started = performance.now()
    try { return historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) }) }
    finally { if (timing) timing.resolveMs += performance.now() - started }
  }
  function gitCommand(timing?: CaptureTiming): GitCommand {
    return async (state, args, data, extra = {}, acceptedCodes = [0]) => {
      const program = trustedProgram(['root' in state && typeof state.root === 'string' ? state.root : state.workTree], timing)
      if (!program) throw new Error('Content capture requires trusted host git')
      const started = performance.now()
      if (timing) timing.commandCount++
      try { return await runProgram({ program, operation: gitOperation(args), args: [...safety, ...args], cwd: owned, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.workTree, GIT_INDEX_FILE: join(state.git, 'index'), ...extra }, data, acceptedCodes }) }
      finally { if (timing) timing.gitSubprocessMs += performance.now() - started }
    }
  }
  function gitDirectory(root: string): string {
    primary = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : root
    if (!existsSync(primaryFile)) writeFileSync(primaryFile, primary, { mode: 0o600 })
    return root === primary ? join(input.directory, 'git') : join(input.directory, 'roots', createHash('sha256').update(root).digest('hex').slice(0, 24), 'git')
  }
  async function prepare(root: string, command: GitCommand): Promise<Pick<TreeCapture, 'root' | 'workTree' | 'selector' | 'git'>> {
    const stat = lstatSync(root, { throwIfNoEntry: false })
    let workTree = stat?.isDirectory() ? root : dirname(root)
    while (!lstatSync(workTree, { throwIfNoEntry: false })?.isDirectory() && dirname(workTree) !== workTree) workTree = dirname(workTree)
    const state = { root, workTree, selector: root === workTree ? '.' : relative(workTree, root), git: gitDirectory(root) }
    const marker = join(state.git, SETUP_MARKER)
    const attributes = join(state.git, 'info', 'attributes')
    if (!regularFile(marker) || !regularFile(join(state.git, 'HEAD')) || !regularFile(attributes, Buffer.byteLength(RAW_ATTRIBUTES)) || readGitMetadata(attributes) !== RAW_ATTRIBUTES) {
      rmSync(marker, { force: true })
      mkdirSync(state.git, { recursive: true, mode: 0o700 }); setMode(state.git, 0o700); requireOwnerOnly(state.git, 'directory')
      await command(state, ['init', '--quiet', `--template=${empty}`, state.git])
      mkdirSync(join(state.git, 'info'), { recursive: true, mode: 0o700 }); mkdirSync(join(state.git, 'objects', 'info'), { recursive: true, mode: 0o700 })
      rmSync(attributes, { force: true })
      writeFileSync(attributes, RAW_ATTRIBUTES, { mode: 0o600, flag: 'wx' })
      const objects = ownerObjects(workTree)
      const alternates = join(state.git, 'objects', 'info', 'alternates')
      if (objects && !existsSync(alternates)) writeFileSync(alternates, `${objects}\n`, { mode: 0o600, flag: 'wx' })
      writeFileSync(marker, '', { mode: 0o600, flag: 'wx' })
    }
    return state
  }
  async function capture(details: { roots: string[]; excluded?: string[]; id: string; phase: 'before' | 'after'; parents?: TreeCapture[] }): Promise<CapturedState> {
    const started = performance.now()
    const timing: CaptureTiming = { captureHashesMs: 0, resolveMs: 0, gitSubprocessMs: 0, commandCount: 0 }
    let outcome: 'ok' | 'error' = 'error'
    try { const captured = await captureState(details, timing); outcome = 'ok'; return captured }
    finally { logger.debug('History capture finished', { phase: details.phase, outcome, captureHashesMs: Math.round(timing.captureHashesMs), resolveMs: Math.round(timing.resolveMs), gitSubprocessMs: Math.round(timing.gitSubprocessMs), commandCount: timing.commandCount, captureMs: Math.round(performance.now() - started) }) }
  }
  async function captureState(details: Parameters<typeof capture>[0], timing: CaptureTiming): Promise<CapturedState> {
    const roots = normalizedRoots(details.roots)
    const program = trustedProgram(roots, timing)
    const command = gitCommand(timing)
    const hashStarted = performance.now()
    let scanned: Snapshot
    try { scanned = await captureHashes({ roots, excluded: [...exclusions, ...details.excluded ?? []], maxFileBytes: input.maxFileBytes(), hashFiles: !program, platform: input.platform ?? process.platform }) }
    finally { timing.captureHashesMs += performance.now() - hashStarted }
    for (const [path, entry] of Object.entries(scanned)) if (entry.kind === 'excluded' && !isPlainName(nativeBasename(path), input.platform ?? process.platform) && !warnedNames.has(path)) {
      const root = roots.find(root => nativeInside(root, path))
      if (root) { warnedNames.add(path); logger.warn('History leaves out a name Buckle would read as another path', { root, name: gitName(root, path) }) }
    }
    if (!program) return { snapshot: scanned, trees: [], restorable: false, reason: 'History records hashes only because content capture requires permitted trusted host git' }
    const combined: Snapshot = {}
    const trees: TreeCapture[] = []
    for (const root of roots) {
      const state = await prepare(root, command)
      const selected = Object.fromEntries(Object.entries(scanned).filter(([path]) => nativeInside(root, path)))
      const omitted = Object.entries(selected).filter(([, entry]) => entry.kind === 'excluded' || entry.kind === 'unreadable').map(([path]) => path)
      const excluded = [...exclusions, ...details.excluded ?? [], ...omitted]
      writeFileSync(join(state.git, 'info', 'exclude'), excluded.filter(path => nativeInside(state.workTree, path)).map(path => `/${escapeIgnore(gitName(state.workTree, path))}`).join('\n') + '\n', { mode: 0o600 })
      const ignoredTracked = await command(state, ['ls-files', '-ci', '--exclude-standard', '-z'])
      if (ignoredTracked.length) await command(state, ['update-index', '--force-remove', '-z', '--stdin'], ignoredTracked)
      if (existsSync(root)) await command(state, ['add', '-A', '--', state.selector])
      else await command(state, ['read-tree', '--empty'])
      const tree = (await command(state, ['write-tree'])).toString().trim()
      const parent = details.phase === 'after' ? details.parents?.find(value => value.root === root && value.git === state.git)?.commit : undefined
      const commit = (await command(state, ['commit-tree', tree, ...parent ? ['-p', parent] : []], `Buckle ${details.id} ${details.phase}\n`)).toString().trim()
      rememberShape(state.git, commit, { tree, parents: parent ? [parent] : [] })
      const listed = await loadTree({ ...state, commit, extra: {} }, command)
      const names = Object.keys(selected).filter(path => path !== state.workTree && isPlainName(nativeBasename(path), input.platform ?? process.platform)).map(path => gitName(state.workTree, path))
      const checked = names.length ? (await command(state, ['check-ignore', '--no-index', '--stdin', '-z', '-v', '--non-matching'], Buffer.from(names.join('\0') + '\0'), { GIT_LITERAL_PATHSPECS: '0' }, [0, 1])).toString().split('\0') : []
      const ignored = new Set<string>()
      for (let index = 0; index + 3 < checked.length; index += 4) {
        const source = checked[index]; const pattern = checked[index + 2]; const name = checked[index + 3]
        if (source && pattern && name && !pattern.startsWith('!') && resolve(state.workTree, source) !== join(state.git, 'info', 'exclude')) ignored.add(join(state.workTree, name))
      }
      const extra: Snapshot = {}
      for (const [path, entry] of Object.entries(selected)) {
        if (entry.kind === 'excluded' && !isPlainName(nativeBasename(path), input.platform ?? process.platform)) { extra[path] = entry; continue }
        const inheritedIgnore = ignoredAncestor(path, state.workTree, ignored)
        if ((path !== root || entry.kind !== 'directory') && (ignored.has(path) || inheritedIgnore)) {
          if (!inheritedIgnore) extra[path] = { kind: 'excluded', mode: entry.mode, reason: 'ignored' }
          continue
        }
        if (entry.kind === 'directory' ? entry.mode !== 0o755 || !listed[path] : entry.kind === 'excluded' || entry.kind === 'unreadable') extra[path] = entry
        else if (listed[path] && entry.mode !== listed[path]!.mode) extra[path] = { ...entry, hash: undefined }
        if (listed[path]) listed[path] = { ...listed[path]!, mode: entry.mode, ...(entry.kind === 'symlink' ? { target: entry.target } : {}) }
      }
      Object.assign(listed, Object.fromEntries(Object.entries(extra).filter(([, entry]) => entry.kind !== 'file' && entry.kind !== 'symlink')))
      Object.assign(combined, listed)
      const captured: TreeCapture = { ...state, commit, extra }
      trees.push(captured)
      await reference({ capture: captured, id: details.id, phase: details.phase }, command)
    }
    return { snapshot: combined, trees, restorable: true }
  }
  async function loadTree(captured: TreeCapture, command: GitCommand = git): Promise<Snapshot> {
    assertHash(captured.commit)
    const result: Snapshot = {}
    const raw = await command(captured, ['ls-tree', '-r', '-t', '-z', captured.commit])
    for (const row of raw.toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'); const [mode, type, hash] = row.slice(0, tab).split(' '); const name = row.slice(tab + 1)
      if (!hash || !mode || !type || !name || name.startsWith('/') || name.split('/').some(part => !isPlainName(part, input.platform ?? process.platform) || part === '.git')) throw new Error('Invalid path in history tree')
      const path = join(captured.workTree, name)
      if (!isInside(captured.root, path)) continue
      if (type === 'tree') result[path] = { kind: 'directory', mode: 0o755 }
      else if (mode === '120000') result[path] = { kind: 'symlink', mode: 0o777, target: (await command(captured, ['cat-file', 'blob', hash])).toString() }
      else if (type === 'blob') result[path] = { kind: 'file', mode: mode === '100755' ? 0o755 : 0o644, hash }
      else result[path] = { kind: 'excluded', mode: 0 }
    }
    if (captured.selector === '.') result[captured.root] ??= { kind: 'directory', mode: 0o755 }
    for (const [path, entry] of Object.entries(captured.extra)) result[path] = { ...result[path], ...entry, ...(result[path]?.hash ? { hash: result[path]!.hash } : {}) }
    return result
  }
  async function reference(input: { capture: TreeCapture; id: string; phase: 'before' | 'after' }, command: GitCommand = git): Promise<void> {
    if (!CHECKPOINT_ID.test(input.id)) throw new Error('Invalid checkpoint reference')
    await command(input.capture, ['update-ref', `refs/buckle/checkpoints/${input.id}${input.phase === 'before' ? '-before' : ''}`, input.capture.commit])
  }
  async function changed(before: TreeCapture[], after: TreeCapture[]): Promise<string[]> {
    const result: string[] = []
    for (const right of after) {
      const left = before.find(value => value.root === right.root)
      if (!left) continue
      const names = await git(right, ['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--name-only', '-r', '-z', left.commit, right.commit])
      for (const name of names.toString().split('\0').filter(Boolean)) result.push(join(right.workTree, name))
    }
    return [...new Set(result)].sort()
  }
  async function restoreContent(input: { trees: TreeCapture[]; target: Snapshot; paths: string[] }): Promise<Map<string, Buffer>> {
    const content = new Map<string, Buffer>()
    for (const tree of input.trees) {
      const paths = input.paths.filter(path => isInside(tree.root, path) && input.target[path]?.kind === 'file')
      if (!paths.length) continue
      const temporary = join(owned, `restore-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 })
      const index = join(temporary, 'index')
      try {
        await git(tree, ['read-tree', tree.commit], undefined, { GIT_INDEX_FILE: index })
        for (const path of paths) {
          const entry = input.target[path]!
          await git(tree, ['update-index', '--add', '--cacheinfo', `${entry.mode & 0o111 ? '100755' : '100644'},${entry.hash!},${relative(tree.workTree, path)}`], undefined, { GIT_INDEX_FILE: index })
        }
        await git(tree, ['checkout-index', '--force', '--prefix', `${temporary}/files/`, '-z', '--stdin'], Buffer.from(paths.map(path => relative(tree.workTree, path)).join('\0') + '\0'), { GIT_INDEX_FILE: index })
        for (const path of paths) content.set(input.target[path]!.hash!, readFileSync(join(temporary, 'files', relative(tree.workTree, path))))
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    return content
  }
  async function removeRefs(id: string, trees: TreeCapture[]): Promise<void> {
    if (!CHECKPOINT_ID.test(id)) return
    for (const tree of trees) for (const suffix of ['', '-before']) await git(tree, ['update-ref', '-d', `refs/buckle/checkpoints/${id}${suffix}`])
  }
  function rememberShape(directory: string, commit: string, shape: CommitShape): void {
    assertHash(commit); assertHash(shape.tree)
    commitShapes.set(shapeKey(directory, commit), shape)
    while (commitShapes.size > MAX_CACHED_COMMITS) commitShapes.delete(commitShapes.keys().next().value!)
  }
  async function inspectShapes(trees: TreeCapture[]): Promise<Map<string, CommitShape>> {
    const shapes = new Map<string, CommitShape>()
    const missing = new Map<string, Map<string, TreeCapture>>()
    for (const tree of trees) {
      assertHash(tree.commit)
      const key = shapeKey(tree.git, tree.commit)
      const cached = commitShapes.get(key)
      if (cached) shapes.set(key, cached)
      else {
        const group = missing.get(tree.git) ?? new Map<string, TreeCapture>()
        group.set(tree.commit, tree); missing.set(tree.git, group)
      }
    }
    for (const group of missing.values()) {
      const values = [...group.values()]
      const first = values[0]!
      const output = await git(first, ['cat-file', '--batch'], values.map(tree => tree.commit).join('\n') + '\n')
      let offset = 0
      for (const value of values) {
        const end = output.indexOf(10, offset)
        const header = output.subarray(offset, end).toString().match(/^([a-f0-9]{40,64}) commit ([0-9]+)$/)
        if (end < 0 || !header || header[1] !== value.commit) throw new Error('History commit metadata is incomplete')
        const size = Number(header[2])
        const next = end + 1 + size
        if (!Number.isSafeInteger(size) || next >= output.length || output[next] !== 10) throw new Error('History commit metadata is incomplete')
        const lines = output.subarray(end + 1, next).toString().split('\n\n', 1)[0]!.split('\n')
        const tree = lines[0]?.match(/^tree ([a-f0-9]{40,64})$/)?.[1]
        const parents = lines.filter(line => line.startsWith('parent ')).map(line => line.slice(7))
        if (!tree || parents.some(parent => !HASH.test(parent))) throw new Error('Invalid history commit metadata')
        const shape = { tree, parents }
        shapes.set(shapeKey(value.git, value.commit), shape); rememberShape(value.git, value.commit, shape)
        offset = next + 1
      }
      if (offset !== output.length) throw new Error('Unexpected history commit metadata')
    }
    return shapes
  }
  async function isolate(records: CheckpointTrees[]): Promise<boolean> {
    const shapes = await inspectShapes(records.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]))
    let changed = false
    for (const record of records) {
      if (!record.beforeTrees?.length && !record.afterTrees?.length) continue
      if (!CHECKPOINT_ID.test(record.id)) throw new Error('Invalid checkpoint reference')
      for (const phase of ['before', 'after'] as const) for (const capture of phase === 'before' ? record.beforeTrees ?? [] : record.afterTrees ?? []) {
        const shape = shapes.get(shapeKey(capture.git, capture.commit))!
        const parent = phase === 'after' ? record.beforeTrees?.find(before => before.git === capture.git && before.root === capture.root)?.commit : undefined
        if (shape.parents.length === (parent ? 1 : 0) && (!parent || shape.parents[0] === parent)) continue
        const commit = (await git(capture, ['commit-tree', shape.tree, ...parent ? ['-p', parent] : []], `Buckle ${record.id} ${phase}\n`)).toString().trim()
        assertHash(commit)
        // Keep the saved journal's canonical refs intact until its replacements are durably pinned and saved.
        await git(capture, ['update-ref', STAGING_REFS + commit, commit])
        const replacement = { tree: shape.tree, parents: parent ? [parent] : [] }
        rememberShape(capture.git, commit, replacement); shapes.set(shapeKey(capture.git, commit), replacement)
        capture.commit = commit; changed = true
      }
    }
    const retained = new Set(records.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]).map(tree => shapeKey(tree.git, tree.commit)))
    for (const key of commitShapes.keys()) if (!retained.has(key)) commitShapes.delete(key)
    return changed
  }
  async function readRefs(state: Pick<TreeCapture, 'git' | 'workTree'>): Promise<Map<string, string>> {
    const output = await git(state, ['for-each-ref', '--format=%(refname) %(objectname)', CHECKPOINT_REFS, STAGING_REFS])
    const refs = new Map<string, string>()
    for (const line of output.toString().trim().split('\n').filter(Boolean)) {
      const [ref, commit, extra] = line.split(' ')
      if (!ref || !commit || extra || !(ref.startsWith(CHECKPOINT_REFS) || ref.startsWith(STAGING_REFS))) throw new Error('Invalid history reference')
      assertHash(commit); refs.set(ref, commit)
    }
    return refs
  }
  async function writeRefs(state: Pick<TreeCapture, 'git' | 'workTree'>, commands: string[]): Promise<void> {
    if (commands.length) await git(state, ['update-ref', '--stdin'], commands.join('\n') + '\n')
  }
  async function reconcile(records: CheckpointTrees[]): Promise<void> {
    const groups = new Map<string, { state: Pick<TreeCapture, 'git' | 'workTree'>; expected: Map<string, string>; actual?: Map<string, string> }>()
    for (const record of records) {
      if (!record.beforeTrees?.length && !record.afterTrees?.length) continue
      if (!CHECKPOINT_ID.test(record.id)) throw new Error('Invalid checkpoint reference')
      for (const phase of ['before', 'after'] as const) for (const capture of phase === 'before' ? record.beforeTrees ?? [] : record.afterTrees ?? []) {
        assertHash(capture.commit)
        const group = groups.get(capture.git) ?? { state: capture, expected: new Map<string, string>() }
        const ref = CHECKPOINT_REFS + record.id + (phase === 'before' ? '-before' : '')
        if (group.expected.has(ref) && group.expected.get(ref) !== capture.commit) throw new Error('Conflicting history references')
        group.expected.set(ref, capture.commit); groups.set(capture.git, group)
      }
    }
    for (const directory of gitDirectories()) if (!groups.has(directory)) groups.set(directory, { state: { git: directory, workTree: owned }, expected: new Map() })
    for (const group of groups.values()) {
      const actual = await readRefs(group.state)
      await writeRefs(group.state, [...group.expected].filter(([ref, commit]) => actual.get(ref) !== commit).map(([ref, commit]) => `update ${ref} ${commit}`))
      group.actual = await readRefs(group.state)
      for (const [ref, commit] of group.expected) if (group.actual.get(ref) !== commit) throw new Error('History references do not match the saved checkpoints')
    }
    // Every saved commit must have its canonical ref before any staged or expired ref is removed.
    for (const group of groups.values()) await writeRefs(group.state, [...group.actual!].filter(([ref]) => !group.expected.has(ref)).map(([ref, commit]) => `delete ${ref} ${commit}`))
  }
  function gitDirectories(): string[] {
    const roots = join(input.directory, 'roots')
    const directories = [join(input.directory, 'git'), ...existsSync(roots) ? readdirSync(roots, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(roots, entry.name, 'git')) : []]
    return directories.filter(directory => lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() && existsSync(join(directory, 'HEAD')))
  }
  function objectFiles(): string[] {
    const found: string[] = []
    function visit(directory: string): void {
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && /\/objects\/[a-f0-9]{2}\/[a-f0-9]{38,62}$/.test(path)) found.push(path)
      }
    }
    visit(input.directory)
    return found
  }
  async function reachableBytes(trees: TreeCapture[]): Promise<number> {
    let bytes = 0
    const groups = new Map<string, TreeCapture[]>()
    for (const tree of trees) groups.set(tree.git, [...groups.get(tree.git) ?? [], tree])
    for (const group of groups.values()) {
      const first = group[0]!
      const packed = new Map<string, number>()
      const packDirectory = join(first.git, 'objects', 'pack')
      if (existsSync(packDirectory)) for (const name of readdirSync(packDirectory).filter(name => name.endsWith('.idx'))) {
        const output = await git(first, ['verify-pack', '-v', join(packDirectory, name)])
        for (const line of output.toString().split('\n')) { const fields = line.split(/ +/); if (fields[0] && HASH.test(fields[0]) && fields[3]) packed.set(fields[0], Number(fields[3])) }
      }
      const output = await git(first, ['rev-list', '--objects', '--no-object-names', '--no-walk', ...new Set(group.map(tree => tree.commit))])
      for (const oid of output.toString().trim().split('\n').filter(Boolean)) { assertHash(oid); const loose = lstatSync(join(first.git, 'objects', oid.slice(0, 2), oid.slice(2)), { throwIfNoEntry: false }); bytes += loose?.size ?? packed.get(oid) ?? 0 }
    }
    return bytes
  }
  async function pruneLoose(): Promise<void> {
    const files = objectFiles()
    if (files.length > 20_000) return
    const groups = new Map<string, string[]>()
    for (const file of files) { const directory = file.slice(0, file.lastIndexOf('/objects/')); groups.set(directory, [...groups.get(directory) ?? [], file]) }
    for (const [directory, objects] of groups) {
      const output = await git({ git: directory, workTree: owned }, ['rev-list', '--all', '--objects', '--no-object-names'])
      const reachable = new Set(output.toString().trim().split('\n'))
      for (const file of objects) { const parts = file.split('/'); const oid = parts.at(-2)! + parts.at(-1)!; if (!reachable.has(oid)) rmSync(file, { force: true }) }
      rmSync(join(directory, 'index'), { force: true })
    }
  }
  async function collect(trees: TreeCapture[]): Promise<void> {
    const directories = new Map(trees.map(tree => [tree.git, tree]))
    for (const directory of gitDirectories()) if (!directories.has(directory)) directories.set(directory, { git: directory, workTree: owned, root: owned, selector: '.', commit: '', extra: {} })
    for (const tree of directories.values()) {
      rmSync(join(tree.git, 'index'), { force: true })
      rmSync(join(tree.git, 'objects', 'info', 'commit-graph'), { force: true })
      await git(tree, ['-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--quiet', '--prune=now'])
    }
  }
  return { capture, loadTree: (captured: TreeCapture) => loadTree(captured), changed, restoreContent, removeRefs, reconcile, isolate, collect, pruneLoose, reachableBytes, get available() { return trustedProgram([]) !== null }, bytes: () => storeBytes(input.directory) }
}

function shapeKey(directory: string, commit: string): string { return `${directory}\0${commit}` }
function nativeInside(root: string, path: string): boolean { const below = nativeRelative(root, path); return below === '' || below !== '..' && !below.startsWith(`..${nativeSeparator}`) && !nativeIsAbsolute(below) }
function gitName(root: string, path: string): string { return historyCapturePath({ path: nativeRelative(root, path), platform: process.platform }) }
function normalizedRoots(roots: string[]): string[] { return [...new Set(roots.map(root => resolve(root)))].filter(root => !roots.some(parent => parent !== root && lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() && isInside(parent, root))) }
function ignoredAncestor(path: string, root: string, ignored: Set<string>): boolean {
  if (ignored.size === 0) return false
  let parent = dirname(path)
  while (isInside(root, parent)) {
    if (ignored.has(parent)) return true
    if (parent === root) break
    parent = dirname(parent)
  }
  return false
}
export function escapeIgnore(path: string): string { return path.replace(/[\\*?\[\] !#]/g, '\\$&') }
function assertHash(hash: string): void { if (!HASH.test(hash)) throw new Error('Invalid history object') }
function ownerObjects(workTree: string): string | undefined {
  const directory = ownerGitDirectory(workTree)
  const objects = directory === undefined ? undefined : join(directory, 'objects')
  return objects !== undefined && lstatSync(objects, { throwIfNoEntry: false })?.isDirectory() ? objects : undefined
}
/** The git folder of the repository `workTree` lies in, its common one for a linked worktree; undefined outside one. */
export function ownerGitDirectory(workTree: string): string | undefined {
  let root = workTree
  while (true) {
    const marker = join(root, '.git'); const stat = lstatSync(marker, { throwIfNoEntry: false })
    if (stat) {
      let directory: string
      if (stat.isDirectory() || stat.isSymbolicLink()) { try { directory = realpathSync(marker) } catch { return undefined } }
      else {
        const pointer = readGitMetadata(marker)
        if (!pointer || !/^gitdir: [^\0\r\n]+\n?$/.test(pointer)) return undefined
        directory = resolve(root, pointer.slice(8).trim())
      }
      const common = join(directory, 'commondir')
      if (existsSync(common)) { const pointer = readGitMetadata(common); if (!pointer || /[\0\r\n]./.test(pointer.trim())) return undefined; directory = resolve(directory, pointer.trim()) }
      return directory
    }
    if (dirname(root) === root) return undefined
    root = dirname(root)
  }
}
export function readGitMetadata(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > 8192) return undefined
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > 8192 || opened.ino !== stat.ino || opened.dev !== stat.dev) return undefined
    const content = Buffer.alloc(8193)
    let bytes = 0
    while (bytes < content.length) {
      const read = readSync(descriptor, content, bytes, content.length - bytes, null)
      if (!read) break
      bytes += read
    }
    const final = fstatSync(descriptor)
    if (bytes > 8192 || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return undefined
    return content.toString('utf8', 0, bytes)
  } catch { return undefined }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
export function storeBytes(directory: string): number {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'history.sqlite' || entry.name.startsWith('execution.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += storeBytes(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}
export function regularFile(path: string, size?: number): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat?.isFile() === true && stat.nlink === 1 && (size === undefined || stat.size === size)
}
export function gitOperation(args: string[]): GitOperation {
  let index = 0
  while (args[index] === '-c') index += 2
  return GIT_OPERATIONS.find(operation => operation === args[index]) ?? 'unknown'
}
function safeErrno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && Object.hasOwn(systemConstants.errno, error.code) ? error.code : undefined
}
/**
 * Runs one git child and answers its stdout. `timeoutMs` (10 s unless given) stops it; a timer never releases the
 * caller while the child can still write.
 */
export function runProgram(input: { program: Program; operation: GitOperation; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; data?: string | Buffer; acceptedCodes?: number[]; timeoutMs?: number }): Promise<Buffer> {
  const started = performance.now()
  const details = (failure: GitFailure, code?: number | null, errno?: string): GitFailureDetails => ({ operation: input.operation, failure, elapsedMs: Math.round(performance.now() - started), ...(code !== null && code !== undefined && Number.isSafeInteger(code) && code >= 0 ? { exitCode: code } : {}), ...(errno ? { errno } : {}) })
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(input.program.path, [...input.program.args, ...input.args], { argv0: input.program.argv0, cwd: input.cwd, env: input.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch (error) { reject(new HistoryGitError(details('start', undefined, safeErrno(error)))); return }
    const output: Buffer[] = []; let bytes = 0
    let failure: GitFailure | undefined; let errno: string | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const signal = (value: NodeJS.Signals): void => { try { child.kill(value) } catch (error) { errno ??= safeErrno(error) } }
    const stop = (reason: 'timeout' | 'output-limit'): void => {
      if (failure) return
      failure = reason
      signal('SIGTERM')
      force = setTimeout(() => { logger.warn('History waits for Git exit before continuing', { ...details(reason, undefined, errno) }); signal('SIGKILL') }, 1_000)
    }
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs ?? 10_000)
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1_048_576) stop('output-limit'); else output.push(chunk) })
    child.stderr!.resume()
    child.on('error', error => { failure ??= 'start'; errno ??= safeErrno(error) })
    // A timer must never release the mutation lock while Git can still write.
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(force)
      if (!failure && code !== null && (input.acceptedCodes ?? [0]).includes(code)) resolve(Buffer.concat(output))
      else reject(new HistoryGitError(details(failure ?? 'exit', code, errno)))
    })
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(input.data)
  })
}
