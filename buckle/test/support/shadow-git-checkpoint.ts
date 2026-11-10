import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'pathe'
import { modeOf } from '../../common/services/history/file-mode.js'
import { ownerGitDirectory, RAW_ATTRIBUTES } from '../../common/services/history/git-files.js'
import { gitOperation, historyGitProgram, isolatedGit, runProgram } from '../../common/services/history/git-process.js'
import type { Checkpoint } from '../../common/services/history/records.js'
import type { Snapshot } from '../../common/services/history/snapshot-contract.js'
import { changedPaths, notRestorablePaths } from '../../common/services/history/snapshot.js'
import type { TreeCapture } from '../../common/services/history/tree-capture.js'

type Repository = Pick<TreeCapture, 'root' | 'workTree' | 'selector' | 'git'>
type Git = (repository: Repository, args: string[], data?: string) => Promise<Buffer>

/**
 * Writes one checkpoint as the shadow-git engine of 670f1dc2 did: the whole of `roots` captured in shadow git before and
 * after `execute`, the trees in `beforeTrees` and `afterTrees`. Since Slice F2 no call makes one, but stores written
 * before it hold them, and history still lists, keeps, migrates, and restores them (item 7).
 */
export async function shadowGitCheckpoint<T>(input: { directory: string; roots: string[]; sessionId: string; stageId: string; tool?: string; turnId?: string; execute: () => T | Promise<T> }): Promise<Checkpoint> {
  const { repositories, git } = await prepareRepositories(input)
  const id = `change-${randomUUID()}`
  const before = await capture({ repositories, git, id, phase: 'before' })
  await input.execute()
  const after = await capture({ repositories, git, id, phase: 'after', parents: before.trees })
  const changed = new Set<string>()
  for (const right of after.trees) {
    const left = before.trees.find(tree => tree.root === right.root)!
    const names = await git(right, ['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--name-only', '-r', '-z', left.commit, right.commit])
    for (const name of names.toString().split('\0').filter(Boolean)) changed.add(join(right.workTree, name))
  }
  const record: Checkpoint = {
    id, sessionId: input.sessionId, stageId: input.stageId, tool: input.tool ?? 'test', turnId: input.turnId ?? `turn-${input.stageId}`, turnStageId: input.stageId,
    createdAt: new Date().toISOString(), status: 'complete', baselineAvailable: true, roots: input.roots, before: before.snapshot, beforeTrees: before.trees,
    after: after.snapshot, afterTrees: after.trees, restorable: true, changed: [...changed].sort(),
  }
  const kept = new Set([...changedPaths(record.before, record.after!), ...notRestorablePaths(record.before, record.after!)])
  record.before = Object.fromEntries(Object.entries(record.before).filter(([path]) => kept.has(path)))
  record.after = Object.fromEntries(Object.entries(record.after!).filter(([path]) => kept.has(path)))
  const file = join(input.directory, 'checkpoints.json')
  const state: { version: 2; checkpoints: Checkpoint[]; lastGcAt: number } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 2, checkpoints: [], lastGcAt: 0 }
  state.checkpoints.push(record)
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  return record
}

async function prepareRepositories(input: { directory: string; roots: string[] }): Promise<{ repositories: Repository[]; git: Git }> {
  const roots = [...new Set(input.roots.map(root => resolve(root)))]
  const program = historyGitProgram({ allowed: true, roots })
  if (!program) throw new Error('The legacy history fixture requires trusted host git')
  const owned = join(input.directory, 'git-private')
  const { environment, safety, empty } = isolatedGit(owned)
  const git: Git = (repository, args, data) => runProgram({ program, operation: gitOperation(args), args: [...safety, ...args], cwd: owned, environment: { ...environment, GIT_DIR: repository.git, GIT_WORK_TREE: repository.workTree, GIT_INDEX_FILE: join(repository.git, 'index') }, ...(data === undefined ? {} : { data }) })
  const primaryFile = join(owned, 'primary-root')
  const primary = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : roots[0]
  if (primary === undefined) throw new Error('The legacy history fixture requires a root')
  if (!existsSync(primaryFile)) writeFileSync(primaryFile, primary, { mode: 0o600 })
  const repositories: Repository[] = []
  for (const root of roots) {
    const repository: Repository = { root, workTree: root, selector: '.', git: root === primary ? join(input.directory, 'git') : join(input.directory, 'roots', createHash('sha256').update(root).digest('hex').slice(0, 24), 'git') }
    if (!existsSync(join(repository.git, 'HEAD'))) {
      // The store makes its folders at its first git child, never at open (Slice F2, item 7): the crashed setup makes its own.
      mkdirSync(repository.git, { recursive: true, mode: 0o700 })
      await git(repository, ['init', '--quiet', `--template=${empty}`, repository.git])
    }
    mkdirSync(join(repository.git, 'info'), { recursive: true, mode: 0o700 })
    writeFileSync(join(repository.git, 'info', 'attributes'), RAW_ATTRIBUTES, { mode: 0o600 })
    const owner = ownerGitDirectory(root)
    const alternates = join(repository.git, 'objects', 'info', 'alternates')
    if (owner && !existsSync(alternates)) {
      mkdirSync(join(repository.git, 'objects', 'info'), { recursive: true, mode: 0o700 })
      writeFileSync(alternates, `${join(owner, 'objects')}\n`, { mode: 0o600 })
    }
    writeFileSync(join(repository.git, 'buckle-setup-complete'), '', { mode: 0o600 })
    repositories.push(repository)
  }
  return { repositories, git }
}

async function capture(input: { repositories: Repository[]; git: Git; id: string; phase: 'before' | 'after'; parents?: TreeCapture[] }): Promise<{ snapshot: Snapshot; trees: TreeCapture[] }> {
  const snapshot: Snapshot = {}
  const trees: TreeCapture[] = []
  for (const repository of input.repositories) {
    await input.git(repository, ['add', '-A', '--', '.'])
    const tree = (await input.git(repository, ['write-tree'])).toString().trim()
    const parent = input.parents?.find(before => before.root === repository.root)?.commit
    const commit = (await input.git(repository, ['commit-tree', tree, ...parent ? ['-p', parent] : []], `Legacy fixture ${input.id} ${input.phase}\n`)).toString().trim()
    const entries: Snapshot = { [repository.root]: { kind: 'directory', mode: modeOf(lstatSync(repository.root)) } }
    const listed = await input.git(repository, ['ls-tree', '-r', '-t', '-z', tree])
    for (const row of listed.toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t')
      const [mode, type, hash] = row.slice(0, tab).split(' ')
      const path = join(repository.root, row.slice(tab + 1))
      const permissions = modeOf(lstatSync(path))
      if (type === 'tree') entries[path] = { kind: 'directory', mode: permissions }
      else if (mode === '120000') entries[path] = { kind: 'symlink', mode: permissions, target: readlinkSync(path) }
      else if (type === 'blob' && hash) entries[path] = { kind: 'file', mode: permissions, hash }
      else throw new Error('Unexpected entry in the controlled legacy history fixture')
    }
    const extra = Object.fromEntries(Object.entries(entries).map(([path, { hash: _hash, ...entry }]) => [path, entry]))
    trees.push({ ...repository, commit, extra })
    Object.assign(snapshot, entries)
    await input.git(repository, ['update-ref', `refs/buckle/checkpoints/${input.id}${input.phase === 'before' ? '-before' : ''}`, commit])
  }
  return { snapshot, trees }
}
