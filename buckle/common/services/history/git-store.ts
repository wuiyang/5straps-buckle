import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'pathe'
import type { Program, UntrustedRoots } from '../../domain/executable.js'
import { isInside } from '../../domain/paths.js'
import type { Snapshot } from './snapshot-contract.js'
import type { TreeCapture } from './tree-capture.js'
import { gitOperation, historyGitProgram, isolatedGit, runProgram } from './git-process.js'

const HASH = /^[a-f0-9]{40,64}$/
const CHECKPOINT_ID = /^change-[a-zA-Z0-9-]+$/
interface CheckpointTrees { id: string; beforeTrees?: TreeCapture[]; afterTrees?: TreeCapture[] }
interface CommitShape { tree: string; parents: string[] }
const CHECKPOINT_REFS = 'refs/buckle/checkpoints/'
const STAGING_REFS = 'refs/buckle/migrations/'
const MAX_CACHED_COMMITS = 4096

export function createGitStore(input: { directory: string; allowed: () => boolean; untrusted?: () => UntrustedRoots }) {
  const owned = join(input.directory, 'git-private')
  // Made at the first git child, never at open: a history that holds no shadow-git checkpoint keeps none of its folders (Slice F2, item 7).
  let isolation: ReturnType<typeof isolatedGit> | undefined
  const isolated = () => isolation ??= isolatedGit(owned)
  const commitShapes = new Map<string, CommitShape>()

  function trustedProgram(roots: string[]): Program | null {
    return historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
  }
  async function git(state: Pick<TreeCapture, 'git' | 'workTree'>, args: string[], data?: string | Buffer, extra: Record<string, string> = {}, acceptedCodes: number[] = [0]): Promise<Buffer> {
    const program = trustedProgram(['root' in state && typeof state.root === 'string' ? state.root : state.workTree])
    if (!program) throw new Error('Content capture requires trusted host git')
    const { environment, safety } = isolated()
    return runProgram({ program, operation: gitOperation(args), args: [...safety, ...args], cwd: owned, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.workTree, GIT_INDEX_FILE: join(state.git, 'index'), ...extra }, data, acceptedCodes })
  }
  async function restoreContent(input: { trees: TreeCapture[]; target: Snapshot; paths: string[] }): Promise<Map<string, Buffer>> {
    const content = new Map<string, Buffer>()
    for (const tree of input.trees) {
      const paths = input.paths.filter(path => isInside(tree.root, path) && input.target[path]?.kind === 'file')
      if (!paths.length) continue
      isolated(); const temporary = join(owned, `restore-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 })
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
  /** Whether a shadow-git folder still borrows objects from the owner's repository through alternates (X12). */
  function borrowing(): boolean { return gitDirectories().some(directory => existsSync(alternatesOf(directory))) }
  /**
   * Copies into each shadow-git folder the owner's objects its refs reach, then drops its alternates, so the owner pruning
   * their repository never takes a retained checkpoint's content (X12). Run once reconcile has pinned every checkpoint.
   */
  async function materialize(): Promise<void> {
    for (const directory of gitDirectories()) {
      if (!existsSync(alternatesOf(directory))) continue
      // Without --local, pack-objects packs a borrowed object too, so the pack holds all a ref reaches.
      await git({ git: directory, workTree: owned }, ['repack', '-a', '-d', '-q'])
      rmSync(alternatesOf(directory), { force: true })
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
  return { restoreContent, removeRefs, reconcile, isolate, borrowing, materialize, collect, get available() { return trustedProgram([]) !== null } }
}

function shapeKey(directory: string, commit: string): string { return `${directory}\0${commit}` }
function alternatesOf(directory: string): string { return join(directory, 'objects', 'info', 'alternates') }
function assertHash(hash: string): void { if (!HASH.test(hash)) throw new Error('Invalid history object') }
