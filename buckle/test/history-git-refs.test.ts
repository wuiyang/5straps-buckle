import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { readIndex } from '../common/services/history/command-capture.js'
import { blobId, openObjectStore } from '../common/services/history/object-store.js'
import { parseIndex, writeIndex } from '../common/services/history/workspace-repo.js'

// Slice F3 (owner question X6, "why we need copy? cant it refer from git?"): where a command's folder lies in a git
// repository with a commit, its shadow index is seeded from the repository's own index, so an unchanged committed file
// is never hashed or copied. A command that changes one copies the content it had into the history's own store before
// the checkpoint is saved; a restore reads that store alone.

/**
 * G3 of the Codex recheck of F3: what runs once, from `after`, as a sweep's plan has found which copies each repository
 * holds and before any slice of it removes one.
 */
const race = vi.hoisted(() => ({ after: undefined as (() => void) | undefined }))
vi.mock('../common/services/history/command-capture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/command-capture.js')>()
  const createCommandCapture: typeof actual.createCommandCapture = input => {
    const capture = actual.createCommandCapture(input)
    return { ...capture, released: async (...args: Parameters<typeof capture.released>) => { const found = await capture.released(...args); const step = race.after; race.after = undefined; step?.(); return found } }
  }
  return { ...actual, createCommandCapture }
})

const roots: string[] = []
afterEach(() => { race.after = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const DAY_AGO = new Date(Date.now() - 86_400_000)
/** Git for the test's own repositories, never the host's global or system config. */
function repoGit(root: string, cwd: string, args: string[], input?: string): string {
  const config = join(root, 'test-gitconfig'); if (!existsSync(config)) writeFileSync(config, '')
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }, ...input === undefined ? {} : { input } })
}

/**
 * A repository with `committed` files, each a day old as git added it so its index entry is not racy, then one committed
 * file changed and one new file: what is not committed. `subfolder` makes the workspace a folder below the repository's
 * top, with files of its own beside it.
 */
function repoFixture(options: { committed?: Record<string, string | Buffer>; subfolder?: boolean; maxFileBytes?: number; maxBytes?: number; excluded?: (workspace: string) => string[]; before?: (top: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-git-refs-')); roots.push(root)
  const top = join(root, 'repo')
  const workspace = options.subfolder ? join(top, 'app') : top
  const committed = options.committed ?? Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`src/f${index}.txt`, `committed ${index}\n`]))
  const files = { ...committed, 'src/changed.txt': 'committed changed\n' }
  for (const [name, content] of Object.entries(files)) { const path = join(workspace, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); utimesSync(path, DAY_AGO, DAY_AGO) }
  if (options.subfolder) for (const name of ['outside/one.txt', 'outside/two.txt']) { const path = join(top, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, `${name}\n`); utimesSync(path, DAY_AGO, DAY_AGO) }
  repoGit(root, top, ['init', '--quiet'])
  options.before?.(top)
  repoGit(root, top, ['add', '-A']); repoGit(root, top, ['commit', '--quiet', '-m', 'base'])
  writeFileSync(join(workspace, 'src', 'changed.txt'), 'changed since the commit\n')
  writeFileSync(join(workspace, 'src', 'new.txt'), 'never committed\n')
  const directory = join(root, 'history')
  const settings = { directory, excluded: options.excluded?.(workspace) ?? [], maxBytes: options.maxBytes ?? 64 * 1_048_576, sweepFreshMs: 0, ...options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {} }
  const shadow = join(directory, 'commands', createHash('sha256').update(workspace).digest('hex').slice(0, 24))
  return { root, top, workspace, directory, settings, shadow, committed, store: openObjectStore(directory), git: (args: string[], input?: string) => repoGit(root, top, args, input), details: { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] } }
}
function read(path: string): string | null { return existsSync(path) ? readFileSync(path, 'utf8') : null }
/** The repository's history rewritten to one commit without `names`, every branch but it deleted, and their content pruned; the files stay on disk. */
function rewriteWithout(made: ReturnType<typeof repoFixture>, names: string[]): void {
  made.git(['checkout', '--quiet', '--orphan', 'rewritten']); made.git(['rm', '--quiet', '--cached', ...names]); made.git(['commit', '--quiet', '-m', 'rewritten'])
  for (const branch of made.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(name => name && name !== 'rewritten')) made.git(['branch', '--quiet', '-D', branch])
  made.git(['reflog', 'expire', '--expire=now', '--all']); made.git(['gc', '--quiet', '--prune=now'])
}
/** Each committed file's blob id, as the repository's index names it. */
function committedIds(made: ReturnType<typeof repoFixture>): Map<string, string> {
  const listed = made.git(['ls-files', '-s', '-z']).split('\0').filter(Boolean)
  return new Map(listed.map(line => { const [meta, name] = line.split('\t'); return [name!, meta!.split(' ')[1]!] }))
}
/**
 * Every file below the repository's git folder, with its size, time, and content digest, and every folder with its time,
 * which a file made and removed there changes: what Buckle must never change.
 */
function gitFolderState(top: string): Record<string, string> {
  const state: Record<string, string> = {}
  const walk = (folder: string) => { for (const name of readdirSync(folder)) { const path = join(folder, name); const stat = statSync(path); if (stat.isDirectory()) { state[`${relative(top, path)}/`] = `${stat.mtimeMs}`; walk(path) } else state[relative(top, path)] = `${stat.size}:${stat.mtimeMs}:${createHash('sha1').update(readFileSync(path)).digest('hex')}` } }
  walk(join(top, '.git'))
  return state
}

describe('a command in a folder that is a git repository', () => {
  it('refers to the repository for each unchanged committed file, copying none of them, and stores what is not committed', async () => {
    const made = repoFixture({ excluded: workspace => [join(workspace, 'src', 'f7.txt')] })
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'changed by the command\n') })
      expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', restorable: true })
      const ids = committedIds(made)
      const unchanged = [...ids].filter(([name]) => name !== 'src/changed.txt').map(([, id]) => id)
      expect(unchanged.filter(id => made.store.has(id))).toEqual([])
      expect([blobId(Buffer.from('changed since the commit\n')), blobId(Buffer.from('changed by the command\n'))].map(id => made.store.has(id))).toEqual([true, true])
      // The shadow index names the repository's objects, never a protected path's.
      const named = new Set(readIndex(readFileSync(join(made.shadow, 'index')))!.entries.map(entry => entry.id))
      expect(unchanged.filter(id => id !== ids.get('src/f7.txt')).every(id => named.has(id))).toBe(true)
      expect(named.has(ids.get('src/f7.txt')!)).toBe(false)
    } finally { await history.close() }
  })

  it('seeds only the folder\'s own entries when it lies below the repository\'s top', async () => {
    const made = repoFixture({ subfolder: true })
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f3.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ restorable: true, changes: [{ path: join(made.workspace, 'src', 'f3.txt'), kind: 'modified' }] })
      const ids = committedIds(made)
      expect([...ids].filter(([name]) => name.startsWith('app/') && name !== 'app/src/changed.txt' && name !== 'app/src/f3.txt').filter(([, id]) => made.store.has(id))).toEqual([])
      const named = readIndex(readFileSync(join(made.shadow, 'index')))!.entries.map(entry => entry.id)
      expect(named).not.toContain(ids.get('outside/one.txt'))
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f3.txt'))).toBe('committed 3\n')
    } finally { await history.close() }
  })

  it('copies a committed file\'s content as a command changes it, and restores it with the repository gone and host git off', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    let id: string
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f1.txt'), 'rewritten\n'); rmSync(join(made.workspace, 'src', 'f2.txt')) })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [] })
      id = checkpoint.id
      expect([blobId(Buffer.from('committed 1\n')), blobId(Buffer.from('committed 2\n'))].map(blob => made.store.has(blob))).toEqual([true, true])
    } finally { await history.close() }
    // The alternate removed and every object of the repository gone: a restore reads the history's own store alone.
    rmSync(join(made.top, '.git'), { recursive: true, force: true })
    const later = await openChangeHistory({ ...made.settings, allowHostGit: false })
    try {
      await later.restore(id)
      expect([read(join(made.workspace, 'src', 'f1.txt')), read(join(made.workspace, 'src', 'f2.txt'))]).toEqual(['committed 1\n', 'committed 2\n'])
    } finally { await later.close() }
  })

  it('marks a file not restorable, reason source-gone, when its content left the repository before it was copied, and runs the call', async () => {
    const made = repoFixture()
    const gone = blobId(Buffer.from('committed 4\n'))
    const history = await openChangeHistory(made.settings)
    try {
      let ran = false
      await history.run(made.details, async () => {
        ran = true
        rmSync(join(made.workspace, 'src', 'f4.txt')); writeFileSync(join(made.workspace, 'src', 'f5.txt'), 'rewritten\n')
        rmSync(join(made.top, '.git', 'objects', gone.slice(0, 2), gone.slice(2)))
      })
      expect(ran).toBe(true)
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [join(made.workspace, 'src', 'f4.txt')], changes: [{ path: join(made.workspace, 'src', 'f5.txt'), kind: 'modified' }] })
      const saved = JSON.parse(readFileSync(join(made.directory, 'checkpoints.json'), 'utf8')) as { checkpoints: Array<{ before: Record<string, unknown> }> }
      expect(saved.checkpoints.at(-1)!.before[join(made.workspace, 'src', 'f4.txt')]).toMatchObject({ kind: 'unreadable', reason: 'source-gone' })
      await history.restore(checkpoint.id)
      expect([read(join(made.workspace, 'src', 'f4.txt')), read(join(made.workspace, 'src', 'f5.txt'))]).toEqual([null, 'committed 5\n'])
    } finally { await history.close() }
  })

  it('records a changed committed file over the cap as over the cap, and never copies one', async () => {
    const big = Buffer.alloc(200, 7)
    const made = repoFixture({ maxFileBytes: 64, committed: { 'src/f0.txt': 'committed 0\n', 'big.bin': big } })
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f0.txt'), 'rewritten\n') })
      expect(made.store.has(blobId(big))).toBe(false)
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'big.bin'), Buffer.alloc(300, 8)) })
      const saved = JSON.parse(readFileSync(join(made.directory, 'checkpoints.json'), 'utf8')) as { checkpoints: Array<{ before: Record<string, unknown> }> }
      expect(saved.checkpoints.at(-1)!.before[join(made.workspace, 'big.bin')]).toMatchObject({ kind: 'excluded', reason: 'size', size: 200 })
      expect(made.store.has(blobId(big))).toBe(false)
    } finally { await history.close() }
  })

  it('never stores a committed file as the repository converted it: a CRLF file under core.autocrlf restores as it stood', async () => {
    const crlf = 'one\r\ntwo\r\n'
    const made = repoFixture({ committed: { 'src/f0.txt': 'committed 0\n', 'src/crlf.txt': crlf }, before: top => repoGit(join(top, '..'), top, ['config', 'core.autocrlf', 'true']) })
    // The repository's blob holds LF line ends, the file CRLF.
    expect(committedIds(made).get('src/crlf.txt')).toBe(blobId(Buffer.from('one\ntwo\n')))
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'crlf.txt'), 'rewritten\n') })
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'crlf.txt'))).toBe(crlf)
    } finally { await history.close() }
  })

  // G2 of the Codex review of F3: a stat match and a blob of the file's length never prove the blob is the file's content.
  it.skipIf(process.platform === 'win32')('never takes a blob a clean filter wrote at the file\'s own length as the file: it restores the file as it stood', async () => {
    const plain = 'hello world\n'
    const made = repoFixture({ committed: { 'src/f0.txt': 'committed 0\n', 'src/rot.txt': plain }, before: top => {
      writeFileSync(join(top, '.gitattributes'), 'rot.txt filter=rot\n'); utimesSync(join(top, '.gitattributes'), DAY_AGO, DAY_AGO)
      repoGit(join(top, '..'), top, ['config', 'filter.rot.clean', 'tr a-z n-za-m'])
    } })
    // The repository's blob holds the filtered bytes, as long as the file.
    expect(committedIds(made).get('src/rot.txt')).toBe(blobId(Buffer.from('uryyb jbeyq\n')))
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'rot.txt'), 'rewritten\n') })
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'rot.txt'))).toBe(plain)
    } finally { await history.close() }
  })

  it('never takes a blob an index written by hand names for a file, with the file\'s own stat data, as the file: it restores the file as it stood', async () => {
    const made = repoFixture()
    // Another blob as long as the file, which the repository's index then names for it, every byte of its stat data kept.
    const forged = made.git(['hash-object', '-w', '--stdin'], 'COMMITTED 3\n').trim()
    const index = join(made.top, '.git', 'index')
    writeFileSync(index, writeIndex(parseIndex(readFileSync(index))!.entries.map(entry => entry.name.toString() === 'src/f3.txt' ? { ...entry, id: forged } : entry)))
    expect(committedIds(made).get('src/f3.txt')).toBe(forged)
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f3.txt'), 'rewritten\n') })
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'f3.txt'))).toBe('committed 3\n')
    } finally { await history.close() }
  })

  // G5 of the Codex review of F3: the repository's index checked again whenever it changes, as at the seed.
  it('takes the usual path once the repository\'s index turns split after the record referred to it', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') })
      expect(existsSync(join(made.shadow, 'source'))).toBe(true)
      made.git(['update-index', '--split-index'])
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f1.txt'), 'rewritten\n') })
      expect(existsSync(join(made.shadow, 'source'))).toBe(false)
      expect([...committedIds(made)].filter(([name]) => name !== 'src/changed.txt').every(([, id]) => made.store.has(id))).toBe(true)
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'f1.txt'))).toBe('committed 1\n')
    } finally { await history.close() }
  })

  it('seeds from a version 4 index, whose names git compresses', async () => {
    const made = repoFixture()
    made.git(['update-index', '--index-version', '4'])
    expect(readFileSync(join(made.top, '.git', 'index')).readUInt32BE(4)).toBe(4)
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f9.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ restorable: true, changes: [{ path: join(made.workspace, 'src', 'f9.txt'), kind: 'modified' }] })
      expect([...committedIds(made)].filter(([name]) => !['src/changed.txt', 'src/f9.txt'].includes(name)).filter(([, id]) => made.store.has(id))).toEqual([])
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f9.txt'))).toBe('committed 9\n')
    } finally { await history.close() }
  })

  it('keeps today\'s path for a sparse checkout: every file git tracks on disk is stored', async () => {
    const made = repoFixture()
    made.git(['update-index', '--skip-worktree', 'src/f0.txt'])
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f1.txt'), 'rewritten\n') })
      expect([...committedIds(made)].filter(([name]) => name !== 'src/changed.txt').every(([, id]) => made.store.has(id))).toBe(true)
      expect(existsSync(join(made.shadow, 'source'))).toBe(false)
    } finally { await history.close() }
  })

  it('keeps today\'s path for a split index: every file git tracks is stored', async () => {
    const made = repoFixture()
    made.git(['update-index', '--split-index'])
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'f1.txt'), 'rewritten\n') })
      expect([...committedIds(made)].filter(([name]) => name !== 'src/changed.txt').every(([, id]) => made.store.has(id))).toBe(true)
      expect(existsSync(join(made.shadow, 'source'))).toBe(false)
    } finally { await history.close() }
  })

  // Q3 (reversible default): a folder recorded before it referred to a repository, as by Buckle 0.1.9, is seeded at a
  // node's first capture of it, so the copies of its committed files go at the next sweep.
  it('seeds a folder recorded before it referred to its repository at a node\'s first capture, and sweeps the copies', async () => {
    const made = repoFixture()
    const gitFolder = join(made.root, 'git-folder')
    rmSync(gitFolder, { recursive: true, force: true }); execFileSync('mv', [join(made.top, '.git'), gitFolder])
    let history = await openChangeHistory(made.settings)
    try { await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') }) } finally { await history.close() }
    const unchanged = [...committedIds({ ...made, git: args => repoGit(made.root, made.top, ['--git-dir', gitFolder, '--work-tree', made.top, ...args]) })].filter(([name]) => name !== 'src/changed.txt').map(([, id]) => id)
    expect(unchanged.every(id => made.store.has(id))).toBe(true)
    execFileSync('mv', [gitFolder, join(made.top, '.git')])
    history = await openChangeHistory(made.settings)
    try {
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f8.txt'), 'rewritten\n') })
      expect(existsSync(join(made.shadow, 'source'))).toBe(true)
      await vi.waitFor(() => expect(unchanged.filter(id => id !== blobId(Buffer.from('committed 8\n')) && made.store.has(id))).toEqual([]))
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'f8.txt'))).toBe('committed 8\n')
    } finally { await history.close() }
  })

  it('keeps no copy of a committed file a command rewrote with the same content, as an install does, and still restores it later', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { for (let index = 0; index < 30; index++) writeFileSync(join(made.workspace, 'src', `f${index}.txt`), `committed ${index}\n`) })
      expect((await history.list()).at(-1)).toMatchObject({ restorable: true, changes: [] })
      const unchanged = [...committedIds(made)].filter(([name]) => name !== 'src/changed.txt').map(([, id]) => id)
      await vi.waitFor(() => expect(unchanged.filter(id => made.store.has(id))).toEqual([]))
      await history.run({ ...made.details, stageId: 'next' }, async () => { rmSync(join(made.workspace, 'src', 'f11.txt')) })
      await history.restore((await history.list()).at(-1)!.id)
      expect(read(join(made.workspace, 'src', 'f11.txt'))).toBe('committed 11\n')
    } finally { await history.close() }
  })

  it('never writes to the repository: its git folder stands as it was through commands, a copy, a restore, and a sweep', async () => {
    const made = repoFixture()
    const state = gitFolderState(made.top)
    const history = await openChangeHistory(made.settings)
    try {
      for (let index = 0; index < 3; index++) await history.run({ ...made.details, stageId: `t${index}` }, async () => { writeFileSync(join(made.workspace, 'src', `f${index}.txt`), `rewritten ${index}\n`) })
      await history.rollback({ target: { steps: 3 }, by: { sessionId: 's', tool: 'history_restore' } })
      await history.run({ ...made.details, stageId: 'after' }, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'again\n') })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(gitFolderState(made.top)).toEqual(state)
      expect([0, 1, 2].map(index => read(join(made.workspace, 'src', `f${index}.txt`)))).toEqual(['committed 0\n', 'committed 1\n', 'committed 2\n'])
    } finally { await history.close() }
  })
})

// Item 7: the repository the shadow index refers to moves, is deleted, or is rewritten and its objects pruned. The next
// capture finds that, rebuilds the index from the work tree with every tree written again, removes the alternate, and
// stays restorable; no call is refused.
describe('a command after its folder\'s repository is lost', () => {
  it('rebuilds its record from the work tree once the repository is deleted, and stays restorable', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') })
      rmSync(join(made.top, '.git'), { recursive: true, force: true })
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f6.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], changes: [{ path: join(made.workspace, 'src', 'f6.txt'), kind: 'modified' }] })
      expect(existsSync(join(made.shadow, 'source'))).toBe(false)
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f6.txt'))).toBe('committed 6\n')
    } finally { await history.close() }
  })

  // G4 of the Codex review of F3: one loose object gone, its fan-out folder left, changes neither folder a stamp watched.
  it('rebuilds its record when a loose object leaves the repository between commands, its folder staying, and stays restorable', async () => {
    const made = repoFixture()
    const gone = blobId(Buffer.from('committed 4\n'))
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') })
      rmSync(join(made.top, '.git', 'objects', gone.slice(0, 2), gone.slice(2)))
      expect(existsSync(join(made.top, '.git', 'objects', gone.slice(0, 2)))).toBe(true)
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f4.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], changes: [{ path: join(made.workspace, 'src', 'f4.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f4.txt'))).toBe('committed 4\n')
    } finally { await history.close() }
  })

  // G3 of the Codex review of F3: the history's own copy never stands for the repository holding an object.
  it('keeps a copy the repository no longer holds once the checkpoint that held it goes, so a later change to its file stays restorable', async () => {
    const same = 'the same content\n'
    const made = repoFixture({ committed: { 'src/f0.txt': 'committed 0\n', 'src/one.txt': same, 'src/two.txt': same } })
    const id = blobId(Buffer.from(same))
    const history = await openChangeHistory({ ...made.settings, keepTurns: 1 })
    try {
      // Deleting one of two files with the same content copies that content into the history; its checkpoint holds it.
      await history.run({ ...made.details, stageId: 't1' }, async () => { rmSync(join(made.workspace, 'src', 'two.txt')) })
      expect(made.store.has(id)).toBe(true)
      // The repository's history is rewritten without either file, and that content pruned; one.txt stays on disk.
      made.git(['checkout', '--quiet', '--orphan', 'rewritten']); made.git(['rm', '--quiet', '--cached', 'src/one.txt', 'src/two.txt']); made.git(['commit', '--quiet', '-m', 'rewritten'])
      for (const branch of made.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(name => name && name !== 'rewritten')) made.git(['branch', '--quiet', '-D', branch])
      made.git(['reflog', 'expire', '--expire=now', '--all']); made.git(['gc', '--quiet', '--prune=now'])
      expect(() => made.git(['cat-file', '-e', id])).toThrow()
      // The next command's turn drops the first one's, and its checkpoint with it.
      await history.run({ ...made.details, stageId: 't2' }, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'second\n') })
      await history.run({ ...made.details, stageId: 't3' }, async () => { writeFileSync(join(made.workspace, 'src', 'one.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], changes: [{ path: join(made.workspace, 'src', 'one.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'one.txt'))).toBe(same)
    } finally { await history.close() }
  })

  // G3 of the Codex recheck of F3: a sweep removes a copy the folder's index takes from its repository only once it has
  // found the repository holding it, then and there; else the copy stays.
  it('keeps a copy the folder\'s index names once its repository loses it, through the call\'s sweep and the one after, and removes one it still holds', async () => {
    const same = 'the same content\n'
    const made = repoFixture({ committed: { 'src/f0.txt': 'committed 0\n', 'src/one.txt': same, 'src/two.txt': same, 'src/held.txt': 'held\n' } })
    const [id, held] = [blobId(Buffer.from(same)), blobId(Buffer.from('held\n'))]
    const history = await openChangeHistory({ ...made.settings, keepTurns: 1 })
    try {
      await history.run({ ...made.details, stageId: 't1' }, async () => { rmSync(join(made.workspace, 'src', 'two.txt')) })
      expect(made.store.has(id)).toBe(true)
      // The next turn's command writes held.txt again as it was, which stores a copy nothing names, and the repository
      // loses one.txt's content, which stays on disk and in the folder's index. Its turn drops the first one's checkpoint.
      await history.run({ ...made.details, stageId: 't2' }, async () => {
        writeFileSync(join(made.workspace, 'src', 'held.txt'), 'held\n')
        rewriteWithout(made, ['src/one.txt', 'src/two.txt'])
      })
      expect(() => made.git(['cat-file', '-e', id])).toThrow()
      expect((await history.list()).map(checkpoint => checkpoint.stageId)).toEqual(['t2'])
      await vi.waitFor(() => expect(made.store.has(held)).toBe(false))
      expect(made.store.has(id)).toBe(true)
    } finally { await history.close() }
  })

  it('keeps a copy whose repository loses it after the sweep found it there and before a slice removes it', async () => {
    const [lost, kept] = ['lost later\n', 'held on\n']
    const made = repoFixture({ committed: { 'src/f0.txt': 'committed 0\n', 'src/lost.txt': lost, 'src/kept.txt': kept } })
    const [lostId, keptId] = [blobId(Buffer.from(lost)), blobId(Buffer.from(kept))]
    const history = await openChangeHistory(made.settings)
    try {
      let ran = false
      race.after = () => { ran = true; rmSync(join(made.top, '.git', 'objects', lostId.slice(0, 2), lostId.slice(2))) }
      // Both written again as they were: each a copy nothing names, which the repository holds as the sweep's plan reads it.
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'lost.txt'), lost); writeFileSync(join(made.workspace, 'src', 'kept.txt'), kept) })
      await vi.waitFor(() => expect(made.store.has(keptId)).toBe(false))
      expect(ran).toBe(true)
      expect(made.store.has(lostId)).toBe(true)
    } finally { await history.close() }
  })

  // H1 of the Codex recheck of F3: a commit at HEAD is checked again before each command, with the objects and the index.
  it('takes the usual path once the repository\'s HEAD names a branch with no commit', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') })
      expect(existsSync(join(made.shadow, 'source'))).toBe(true)
      made.git(['symbolic-ref', 'HEAD', 'refs/heads/unborn'])
      expect(() => made.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).toThrow()
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f1.txt'), 'rewritten\n') })
      expect(existsSync(join(made.shadow, 'source'))).toBe(false)
      expect([...committedIds(made)].filter(([name]) => name !== 'src/changed.txt').every(([, id]) => made.store.has(id))).toBe(true)
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], changes: [{ path: join(made.workspace, 'src', 'f1.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f1.txt'))).toBe('committed 1\n')
    } finally { await history.close() }
  })

  it('rebuilds its record once the repository is rewritten and its old objects pruned, and stays restorable', async () => {
    const made = repoFixture()
    const history = await openChangeHistory(made.settings)
    try {
      await history.run(made.details, async () => { writeFileSync(join(made.workspace, 'src', 'new.txt'), 'first\n') })
      // History rewritten to hold one file, every other object pruned; the files stay on disk.
      made.git(['checkout', '--quiet', '--orphan', 'rewritten']); made.git(['rm', '-r', '-f', '--quiet', '--cached', '.']); made.git(['add', 'src/f0.txt']); made.git(['commit', '--quiet', '-m', 'rewritten'])
      for (const branch of made.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(name => name && name !== 'rewritten')) made.git(['branch', '--quiet', '-D', branch])
      made.git(['reflog', 'expire', '--expire=now', '--all']); made.git(['gc', '--quiet', '--prune=now'])
      expect(() => made.git(['cat-file', '-e', blobId(Buffer.from('committed 6\n'))])).toThrow()
      await history.run({ ...made.details, stageId: 'next' }, async () => { writeFileSync(join(made.workspace, 'src', 'f6.txt'), 'rewritten\n') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], changes: [{ path: join(made.workspace, 'src', 'f6.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(made.workspace, 'src', 'f6.txt'))).toBe('committed 6\n')
    } finally { await history.close() }
  })
})
