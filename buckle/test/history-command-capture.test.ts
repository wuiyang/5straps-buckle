import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_GIT_REASON, openChangeHistory } from '../common/services/history/journal.js'
import { readIndex, unstoredState } from '../common/services/history/command-capture.js'
import { blobId, openObjectStore } from '../common/services/history/object-store.js'
import { historyObjects } from './support/history-objects.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { fixedInteraction } from './support/interaction.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

// Slice F2, item 3 (owner correction 2026-11-01): a command's checkpoint comes from git itself, in a shadow repository
// that reads the workspace's own ignore rules. git add -A brings its index up to date before and after the command, and
// diff-tree names what changed. Nothing ignored is stored or restored; only a count of ignored changes is kept. Git
// writes loose objects into history's own object folder, so a restore needs no git.

// A hook run once as git add starts, before the child reads the folder: a folder swapped while git reads it (X9).
// `slow`: git add first sleeps that many seconds, in a shell that ends at once when stopped (X14).
// `cold`: every git add into an index not made yet first sleeps that many seconds, as a first hash of a cold folder does (W2).
// `held`: such a git add into a background record's side index ignores the stop, and its sleep keeps git's output open, so
// it ends only once the sleep does, as a child slow to stop (V2). `indexes`: the index each git add writes.
const gitAdd = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined, slow: 0, cold: 0, held: false, indexes: [] as string[], started: undefined as (() => void) | undefined }))
vi.mock('../common/services/history/git-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/git-store.js')>()
  const { existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, runProgram: (input: Parameters<typeof actual.runProgram>[0]) => {
    const index = String(input.environment.GIT_INDEX_FILE)
    if (input.operation === 'add') gitAdd.indexes.push(index)
    if (input.operation === 'add' && gitAdd.hook) { const hook = gitAdd.hook; gitAdd.hook = undefined; hook() }
    const cold = input.operation === 'add' && gitAdd.cold && !existsSync(index) ? gitAdd.cold : 0
    if (input.operation !== 'add' || !gitAdd.slow && !cold) return actual.runProgram(input)
    const script = gitAdd.held && cold && index.endsWith('index.warm') ? `trap '' TERM; sleep ${cold}; exec "$0" "$@"` : `trap 'exit 143' TERM; sleep ${gitAdd.slow || cold} >/dev/null 2>&1 </dev/null & wait $!; exec "$0" "$@"`
    const program = { path: '/bin/sh', argv0: 'sh', args: ['-c', script, input.program.path, ...input.program.args] }
    if (gitAdd.slow) { gitAdd.slow = 0; queueMicrotask(() => gitAdd.started?.()) }
    return actual.runProgram({ ...input, program })
  } }
})

// Each folder read while `on`: a command's capture reads none of the workspace's, as git's own listings name what it saw (R1.3).
// `first`: the stored object a listing of history's objects names first. `refuse`: answers whether the system refuses the
// removal of a stored object, as Windows does with EBUSY while another handle holds a file just written (W1).
// `files`: the same for any other file that stands, each refused one named in `refused` (V1).
const folderReads = vi.hoisted(() => ({ on: false, paths: [] as string[] }))
const objectFaults = vi.hoisted(() => ({ first: undefined as string | undefined, refuse: undefined as ((id: string) => boolean) | undefined, removed: [] as string[], files: undefined as ((path: string) => boolean) | undefined, refused: [] as string[] }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const objectId = (path: string) => /[\\/]blobs[\\/]([0-9a-f]{2})[\\/]([0-9a-f]{38})$/.exec(path)?.slice(1).join('')
  const readdirSync = ((path: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) => {
    if (folderReads.on) folderReads.paths.push(String(path))
    const names = actual.readdirSync(path, options as never)
    const first = objectFaults.first
    if (!first || options !== undefined) return names
    const wanted = /[\\/]blobs$/.test(String(path)) ? first.slice(0, 2) : String(path).endsWith(`blobs/${first.slice(0, 2)}`) ? first.slice(2) : undefined
    return wanted === undefined ? names : [...(names as string[]).filter(name => name === wanted), ...(names as string[]).filter(name => name !== wanted)]
  }) as typeof actual.readdirSync
  const rmSync = ((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
    const id = objectId(String(path))
    if (id && objectFaults.refuse?.(id)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
    if (!id && objectFaults.files?.(String(path)) && actual.existsSync(path)) { objectFaults.refused.push(String(path)); throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) }
    actual.rmSync(path, options)
    if (id) objectFaults.removed.push(id)
  }) as typeof actual.rmSync
  return { ...actual, readdirSync, rmSync, default: { ...actual, readdirSync, rmSync } }
})

const roots: string[] = []
afterEach(() => {
  folderReads.on = false; folderReads.paths = []
  objectFaults.first = undefined; objectFaults.refuse = undefined; objectFaults.removed = []; objectFaults.files = undefined; objectFaults.refused = []
  gitAdd.hook = undefined; gitAdd.slow = 0; gitAdd.cold = 0; gitAdd.held = false; gitAdd.indexes = []; gitAdd.started = undefined
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) { ownerWritable(root); rmSync(root, { recursive: true, force: true }) }
})
/** Gives the owner back each folder a test locked, with Node alone, so cleanup needs no Unix chmod (X15). */
function ownerWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink()) return
  try { chmodSync(path, stat.isDirectory() ? 0o700 : 0o600) } catch { /* removed below all the same */ }
  if (stat.isDirectory()) for (const name of readdirSync(path)) ownerWritable(join(path, name))
}

function fixture(options: { allowHostGit?: boolean; maxFileBytes?: number; excluded?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-command-capture-')); roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.txt'), 'a1')
  writeFileSync(join(workspace, 'src', 'b.txt'), 'b1')
  const directory = join(root, 'history')
  const settings = { directory, excluded: [], maxBytes: 64 * 1_048_576, ...options }
  return { root, workspace, directory, settings, details: { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] } }
}
function read(path: string): string | null { return existsSync(path) ? readFileSync(path, 'utf8') : null }

describe('a command\'s checkpoint', () => {
  it('records what the command changed through the workspace\'s .gitignore, never the ignored files, and restores it', async () => {
    const { workspace, directory, settings, details } = fixture()
    writeFileSync(join(workspace, '.gitignore'), 'dist/\nnode_modules/\n')
    mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    for (let index = 0; index < 20; index++) writeFileSync(join(workspace, 'node_modules', 'pkg', `f${index}.js`), `${index}`)
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => {
        writeFileSync(join(workspace, 'src', 'a.txt'), 'a2')
        rmSync(join(workspace, 'src', 'b.txt'))
        writeFileSync(join(workspace, 'src', 'c.txt'), 'c1')
        mkdirSync(join(workspace, 'dist')); writeFileSync(join(workspace, 'dist', 'out.js'), 'built')
        writeFileSync(join(workspace, 'node_modules', 'pkg', 'f0.js'), 'installed')
        mkdirSync(join(workspace, 'node_modules', 'added'))
      })
      const checkpoint = (await history.list()).at(-1)!
      // Counted by the ignored entries git lists, by their own state: dist/ is new, node_modules/ gained a folder.
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, notRestorable: [], ignored: { count: 2, reason: 'ignored' } })
      expect(checkpoint.changes).toEqual([
        { path: join(workspace, 'src', 'a.txt'), kind: 'modified' },
        { path: join(workspace, 'src', 'b.txt'), kind: 'deleted' },
        { path: join(workspace, 'src', 'c.txt'), kind: 'created' },
      ])
      // One object folder, loose objects only: no shadow-git store and no pack.
      expect(existsSync(join(directory, 'git'))).toBe(false)
      expect(readdirSync(join(directory, 'blobs', 'pack'))).toEqual([])
      await history.restore(checkpoint.id)
      expect([read(join(workspace, 'src', 'a.txt')), read(join(workspace, 'src', 'b.txt')), read(join(workspace, 'src', 'c.txt'))]).toEqual(['a1', 'b1', null])
      expect([read(join(workspace, 'dist', 'out.js')), read(join(workspace, 'node_modules', 'pkg', 'f0.js'))]).toEqual(['built', 'installed'])
    } finally { await history.close() }
  })

  it('tracks everything in a folder with no .gitignore, dependencies included', async () => {
    const { workspace, settings, details } = fixture()
    mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'v1')
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'v2') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ restorable: true, changes: [{ path: join(workspace, 'node_modules', 'pkg', 'index.js'), kind: 'modified' }] })
      expect(checkpoint).not.toHaveProperty('ignored')
      await history.restore(checkpoint.id)
      expect(read(join(workspace, 'node_modules', 'pkg', 'index.js'))).toBe('v1')
    } finally { await history.close() }
  })

  it.skipIf(process.platform === 'win32')('never refuses for a hard link, a FIFO, an unreadable folder, or a nested repository with no commit', async () => {
    const { root, workspace, settings, details } = fixture()
    writeFileSync(join(root, 'outside'), 'shared'); linkSync(join(root, 'outside'), join(workspace, 'linked.js'))
    execFileSync('mkfifo', [join(workspace, 'pipe')])
    mkdirSync(join(workspace, 'locked')); writeFileSync(join(workspace, 'locked', 'secret'), 'x'); chmodSync(join(workspace, 'locked'), 0o000)
    execFileSync('git', ['init', '--quiet', join(workspace, 'nested')])
    const history = await openChangeHistory(settings)
    try {
      await expect(history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2'); writeFileSync(join(workspace, 'linked.js'), 'rewritten') })).resolves.toBeUndefined()
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true })
      expect(checkpoint.changes).toEqual(expect.arrayContaining([{ path: join(workspace, 'src', 'a.txt'), kind: 'modified' }, { path: join(workspace, 'linked.js'), kind: 'modified' }]))
      await history.restore(checkpoint.id)
      expect([read(join(workspace, 'src', 'a.txt')), read(join(workspace, 'linked.js'))]).toEqual(['a1', 'shared'])
    } finally { await history.close() }
  })

  it('restores a command\'s changes with host git turned off since', async () => {
    const { workspace, settings, details } = fixture()
    const first = await openChangeHistory(settings)
    let id: string
    try {
      await first.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      id = (await first.list()).at(-1)!.id
    } finally { await first.close() }
    const later = await openChangeHistory({ ...settings, allowHostGit: false })
    try {
      await later.restore(id)
      expect(read(join(workspace, 'src', 'a.txt'))).toBe('a1')
    } finally { await later.close() }
  })

  it('runs a command without host git and records it as not restorable: host git needed', async () => {
    const { workspace, settings, details } = fixture({ allowHostGit: false })
    const history = await openChangeHistory(settings)
    try {
      let ran = false
      await history.run(details, async () => { ran = true; writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      expect(ran).toBe(true)
      expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', restorable: false, reason: HOST_GIT_REASON, changes: [] })
    } finally { await history.close() }
  })

  it('lists a file over the content cap as not restorable and restores the rest', async () => {
    const { workspace, settings, details } = fixture({ maxFileBytes: 64 })
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(200, 7)); writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ restorable: true, notRestorable: [join(workspace, 'big.bin')], changes: [{ path: join(workspace, 'src', 'a.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(workspace, 'src', 'a.txt'))).toBe('a1')
      expect(existsSync(join(workspace, 'big.bin'))).toBe(true)
    } finally { await history.close() }
  })

  it.skipIf(process.platform === 'win32')('never reads where a link lands when a command swaps its folder for one', async () => {
    const { root, workspace, directory, settings, details } = fixture()
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'key'), 'PRIVATE KEY')
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { renameSync(workspace, join(root, 'moved')); symlinkSync(elsewhere, workspace) })
      expect((await history.list()).at(-1)).toMatchObject({ status: 'interrupted', restorable: false, reason: expect.stringContaining('replaced by a link') })
      expect(historyObjects(directory).some(content => content.includes('PRIVATE'))).toBe(false)
    } finally { await history.close() }
  })

  it('keeps a file\'s own mode across a file tool\'s checkpoint and a command\'s, so a restore of both runs', async () => {
    const { workspace, settings, details } = fixture()
    const file = join(workspace, 'src', 'a.txt'); chmodSync(file, 0o664)
    const history = await openChangeHistory(settings)
    try {
      await history.run({ ...details, tool: 'fs_write', scope: [{ path: file }] }, async () => { writeFileSync(file, 'a2') })
      await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(file, 'a3') })
      await history.rollback({ target: { steps: 2 }, by: { sessionId: 's', tool: 'history_restore' } })
      expect(read(file)).toBe('a1')
    } finally { await history.close() }
  })
})

it('reads a version 2 git index in-process, the trees its cache-tree names included (W1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-index-')); roots.push(root)
  writeFileSync(join(root, 'one'), 'one'); mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder', 'a-much-longer-name.txt'), 'two!')
  execFileSync('git', ['init', '--quiet', root]); execFileSync('git', ['-C', root, 'add', '-A'])
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-s'], { encoding: 'utf8' }).trim().split('\n').map(line => line.split(' ')[1])
  expect(readIndex(readFileSync(join(root, '.git', 'index')))).toEqual({ entries: [{ id: listed[0], size: 4 }, { id: listed[1], size: 3 }], trees: [] })
  const tree = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim()
  const folder = execFileSync('git', ['-C', root, 'rev-parse', `${tree}:folder`], { encoding: 'utf8' }).trim()
  expect(readIndex(readFileSync(join(root, '.git', 'index')))?.trees).toEqual([tree, folder])
  // A file tool's later change leaves the root and its folder invalid in the cache-tree: neither is named any more.
  writeFileSync(join(root, 'folder', 'a-much-longer-name.txt'), 'three'); execFileSync('git', ['-C', root, 'add', '-A'])
  expect(readIndex(readFileSync(join(root, '.git', 'index')))?.trees).toEqual([])
})

describe('an exec call through the invoker', () => {
  it.skipIf(process.platform === 'win32').each([true, false])('is recorded through git with host git %s, and its notice says when it cannot be', async hostGit => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-command-exec-')); roots.push(root)
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    writeFileSync(join(workspace, '.gitignore'), 'build/\n')
    mkdirSync(join(workspace, 'seed', 'build'), { recursive: true }); writeFileSync(join(workspace, 'seed', 'out.txt'), 'made'); writeFileSync(join(workspace, 'seed', 'build', 'app.js'), 'built')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_ALLOW_HOST_GIT: String(hostGit), BUCKLE_PACKS: 'fs,shell,history', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const runtime = await createRuntime({ config, interaction: fixedInteraction() })
    try {
      await runtime.policy.setDangerouslyAllow(true)
      const result = await runtime.invoke({ sessionId: 'agent', approvalWait: { mode: 'none' }, request: { requestId: 'exec-1', tool: 'shell_exec', args: { command: 'cp', args: ['-R', 'seed/.', '.'] }, approvalTokens: [] } })
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'ok' })
      const checkpoint = (await runtime.history.list()).at(-1)!
      if (hostGit) {
        expect(checkpoint).toMatchObject({ tool: 'shell_exec', restorable: true, changes: [{ path: join(workspace, 'out.txt'), kind: 'created' }], ignored: { count: 1, reason: 'ignored' } })
        expect(result).toMatchObject({ meta: expect.not.objectContaining({ history: expect.anything() }) })
      } else expect(result).toMatchObject({ meta: { history: { checkpoint: checkpoint.id, restorable: false, reason: HOST_GIT_REASON } } })
    } finally { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  })
})

// The Codex review of 670f1dc2..01d3b0c9: what git never read or never represented is never recorded as known.
describe('a command\'s checkpoint, at the edges of what git reads', () => {
  const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0

  // X3: a protected folder stays out of the shadow index whatever the workspace's own rules re-include.
  it('never stores a protected folder that the workspace .gitignore re-includes, and drops one tracked before', async () => {
    const { root, workspace, directory, details } = fixture()
    const secret = join(workspace, 'private')
    mkdirSync(secret); writeFileSync(join(secret, 'old'), 'OLD PRIVATE')
    writeFileSync(join(workspace, '.gitignore'), '!private/\n!private/**\n')
    const unprotected = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576 })
    try { await unprotected.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') }) } finally { await unprotected.close() }
    const history = await openChangeHistory({ directory, excluded: [secret], maxBytes: 64 * 1_048_576 })
    try {
      await history.run(details, async () => { writeFileSync(join(secret, 'key'), 'NEW PRIVATE KEY'); writeFileSync(join(workspace, 'src', 'b.txt'), 'b2') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.changes).toEqual([{ path: join(workspace, 'src', 'b.txt'), kind: 'modified' }])
      expect(historyObjects(directory).some(content => content.includes('NEW PRIVATE'))).toBe(false)
      const shadow = join(directory, 'commands', readdirSync(join(directory, 'commands')).find(name => /^[0-9a-f]{24}$/.test(name))!)
      const listed = execFileSync('git', ['--git-dir', shadow, 'ls-files'], { env: { ...process.env, GIT_INDEX_FILE: join(shadow, 'index'), GIT_OBJECT_DIRECTORY: join(directory, 'blobs') }, cwd: root, encoding: 'utf8' })
      expect(listed).not.toContain('private/')
    } finally { await history.close() }
  })

  // X4: a tracked file an ignore rule now covers leaves the index before git add reads it.
  it('never stores the new content of a tracked file a command both ignores and changes', async () => {
    const { workspace, directory, settings, details } = fixture()
    const env = join(workspace, '.env')
    writeFileSync(env, 'TOKEN=old')
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      await history.run(details, async () => { writeFileSync(join(workspace, '.gitignore'), '.env\n'); writeFileSync(env, 'TOKEN=NEWSECRET') })
      expect(historyObjects(directory).some(content => content.includes('NEWSECRET'))).toBe(false)
    } finally { await history.close() }
  })

  // X10: a folder that stood empty before the command is no folder the command made.
  it('keeps a folder that stood empty before the command when restoring the file it made there', async () => {
    const { workspace, settings, details } = fixture()
    mkdirSync(join(workspace, 'empty', 'nested'), { recursive: true })
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'empty', 'nested', 'first.txt'), 'made'); mkdirSync(join(workspace, 'made', 'deep'), { recursive: true }); writeFileSync(join(workspace, 'made', 'deep', 'f'), 'x') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.changes).toEqual(expect.arrayContaining([{ path: join(workspace, 'empty', 'nested', 'first.txt'), kind: 'created' }, { path: join(workspace, 'made'), kind: 'created' }]))
      expect(checkpoint.changes.map(change => change.path)).not.toContain(join(workspace, 'empty'))
      await history.restore(checkpoint.id)
      expect(existsSync(join(workspace, 'empty', 'nested', 'first.txt'))).toBe(false)
      expect(existsSync(join(workspace, 'empty', 'nested'))).toBe(true)
      expect(existsSync(join(workspace, 'made'))).toBe(false)
    } finally { await history.close() }
  })

  // R1.3 of the Codex recheck: what git saw on disk but stored nothing of comes from git's own listings, never a walk.
  it('reads no folder of the workspace itself, nested empty folders included', async () => {
    const { workspace, settings, details } = fixture()
    mkdirSync(join(workspace, 'empty', 'a', 'b'), { recursive: true })
    const history = await openChangeHistory(settings)
    try {
      folderReads.on = true
      await history.run(details, async () => { writeFileSync(join(workspace, 'empty', 'a', 'b', 'f.txt'), 'made') })
      folderReads.on = false
      expect(folderReads.paths.filter(path => path.startsWith(workspace))).toEqual([])
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.changes).toEqual([{ path: join(workspace, 'empty', 'a', 'b', 'f.txt'), kind: 'created' }])
      await history.restore(checkpoint.id)
      expect(readdirSync(join(workspace, 'empty', 'a', 'b'))).toEqual([])
    } finally { await history.close() }
  })

  // R2.2 of the Codex recheck: git's listings cannot say whether a folder below one holding nothing git stored stood there
  // before the command, so one the after side holds there is not restorable, never taken as there before; the file made in
  // it was absent before, so a restore removes it.
  it('lists a folder made inside one holding nothing git stores as not restorable, and restores the file made in it', async () => {
    const { workspace, settings, details } = fixture()
    const made = join(workspace, 'out', 'made')
    mkdirSync(join(workspace, 'out'))
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { mkdirSync(made); writeFileSync(join(made, 'f.txt'), 'made') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.notRestorable).toEqual([made])
      expect(checkpoint.changes).toEqual([{ path: join(made, 'f.txt'), kind: 'created' }])
      expect((await history.restore(checkpoint.id)).notRestorable).toEqual([made])
      expect(existsSync(join(made, 'f.txt'))).toBe(false)
    } finally { await history.close() }
  })

  // Across a turn, an earlier checkpoint that left the folder absent or a folder is its state: the file tool that made it
  // knows it, so the turn's restore removes it.
  it('restores a turn whose file tool made the folder a command later wrote in', async () => {
    const { workspace, settings, details } = fixture()
    const [out, made] = [join(workspace, 'out'), join(workspace, 'out', 'made')]
    const scope = [{ path: out }, { path: made }, { path: join(made, 'f.txt') }]
    const history = await openChangeHistory(settings)
    try {
      await history.run({ ...details, tool: 'fs_write', scope }, async () => { mkdirSync(made, { recursive: true }); writeFileSync(join(made, 'f.txt'), 'f') })
      await history.run({ ...details, tool: 'fs_delete', scope: [{ path: join(made, 'f.txt') }] }, async () => { rmSync(join(made, 'f.txt')) })
      await history.run(details, async () => { writeFileSync(join(made, 'g.txt'), 'g') })
      expect((await history.list()).at(-1)!.notRestorable).toEqual([made])
      await history.restoreStage('stage', 's')
      expect(existsSync(out)).toBe(false)
    } finally { await history.close() }
  })

  // The same folder that held a file git listed before was there: nothing about it is unknown.
  it.skipIf(!posixUser)('takes a folder below one holding nothing git stores as there before when git listed a file in it', async () => {
    const { workspace, settings, details } = fixture()
    const held = join(workspace, 'out', 'held')
    mkdirSync(held, { recursive: true }); writeFileSync(join(held, 'locked.txt'), 'L'); chmodSync(join(held, 'locked.txt'), 0o000)
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(held, 'f.txt'), 'made') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.notRestorable).toEqual([])
      expect(checkpoint.changes).toEqual([{ path: join(held, 'f.txt'), kind: 'created' }])
      await history.restore(checkpoint.id)
      expect(readdirSync(held)).toEqual(['locked.txt'])
    } finally { await history.close() }
  })

  // What stood in a folder git could not open before the command is unknown, a file it tracked there included.
  for (const where of ['tracked', 'nested', 'new'] as const) it.skipIf(!posixUser)(`lists a file in a folder git could not open before the command as not restorable (${where})`, async () => {
    const { workspace, settings, details } = fixture()
    const folder = where === 'nested' ? join(workspace, 'outer', 'held') : join(workspace, 'held')
    const file = join(folder, 'q.txt')
    const history = await openChangeHistory(settings)
    try {
      if (where === 'tracked') await history.run(details, async () => { mkdirSync(folder); writeFileSync(file, 'A') })
      else { mkdirSync(folder, { recursive: true }); writeFileSync(file, 'A') }
      writeFileSync(file, 'B'); chmodSync(folder, 0o000)
      await history.run(details, async () => { chmodSync(folder, 0o755); writeFileSync(file, 'C') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint.notRestorable).toContain(file)
      expect(checkpoint.changes.map(change => change.path)).not.toContain(file)
      await history.restore(checkpoint.id).catch(() => undefined)
      chmodSync(folder, 0o755)
      expect(read(file)).toBe('C')
    } finally { await history.close() }
  })

  // X5: a file git could not read before the command has no known before state, tracked or not.
  for (const tracked of [true, false]) it.skipIf(!posixUser)(`lists a ${tracked ? 'tracked' : 'new'} file git could not read before the command as not restorable`, async () => {
    const { workspace, settings, details } = fixture()
    const file = join(workspace, 'held.txt')
    const history = await openChangeHistory(settings)
    try {
      if (tracked) await history.run(details, async () => { writeFileSync(file, 'A') })
      else writeFileSync(file, 'A')
      writeFileSync(file, 'B'); chmodSync(file, 0o000)
      await history.run(details, async () => { chmodSync(file, 0o644); writeFileSync(file, 'C') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ notRestorable: [file] })
      expect(checkpoint.changes.map(change => change.path)).not.toContain(file)
      await history.restore(checkpoint.id).catch(() => undefined)
      expect(read(file)).toBe('C')
    } finally { await history.close() }
  })
})

// X9 and X6 of the Codex review of 670f1dc2..01d3b0c9: what a command's capture wrote that no checkpoint and no shadow
// index names is reclaimed under the lock: a rejected capture's objects at once, a file over the cap and an abandoned
// temporary by the sweep that follows each command.
describe('what a command\'s capture wrote that nothing names', () => {
  it.skipIf(process.platform === 'win32')('keeps nothing git read through a link swapped in while it read the folder', async () => {
    const { root, workspace, directory, settings, details } = fixture()
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'key'), 'PRIVATE KEY')
    const history = await openChangeHistory(settings)
    try {
      gitAdd.hook = () => { renameSync(workspace, join(root, 'moved')); symlinkSync(elsewhere, workspace) }
      await expect(history.run(details, async () => 'ran')).resolves.toBe('ran')
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('replaced by a link') })
      expect(historyObjects(directory).some(content => content.includes('PRIVATE'))).toBe(false)
    } finally { await history.close() }
  })

  it('reclaims a file over the content cap and an abandoned temporary after the command', async () => {
    const { workspace, directory, settings, details } = fixture({ maxFileBytes: 64 })
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      const folder = join(directory, 'blobs', 'ab'); mkdirSync(folder, { recursive: true })
      for (const name of ['tmp-0123', 'tmp_obj_4567']) writeFileSync(join(folder, name), 'abandoned')
      await history.run(details, async () => { writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(200, 7)) })
      expect((await history.list()).at(-1)).toMatchObject({ notRestorable: [join(workspace, 'big.bin')] })
      await vi.waitFor(() => {
        expect(historyObjects(directory).some(content => content.length > 200)).toBe(false)
        expect(readdirSync(folder).filter(name => name.startsWith('tmp'))).toEqual([])
      })
    } finally { await history.close() }
  })
})

// W1 of the Windows test of d26bf5ba: git takes a tree its index's cache-tree names as written while that tree is there,
// and never looks below it. The sweep after a command removed every tree; one that stopped part way, Windows refusing a
// removal while another handle held a file just written, left a named tree whose subtree was gone, so the next command's
// before tree named a missing one and diff-tree exited with 128. The sweep keeps what a shadow index names, goes on past a
// refused removal, and a node's first capture of a folder writes every tree again, whatever an earlier build left.
describe('the trees a command\'s capture keeps', () => {
  /** The id git gives a tree of these entries, each mode, name, and object id. */
  function treeId(entries: Array<[string, string, string]>): string {
    const body = Buffer.concat(entries.map(([mode, name, id]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, 'hex')])))
    return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex')
  }
  /** A folder lib/inner the first command leaves alone, its file old enough that git never hashes it again unchanged. */
  function deepFixture() {
    const made = fixture()
    const file = join(made.workspace, 'lib', 'inner', 'd.txt')
    mkdirSync(join(made.workspace, 'lib', 'inner'), { recursive: true }); writeFileSync(file, 'd1'); utimesSync(file, 1_600_000_000, 1_600_000_000)
    return { ...made, file, inner: treeId([['100644', 'd.txt', blobId(Buffer.from('d1'))]]) }
  }

  it('keeps the trees a shadow index names, so a sweep that stops part way leaves the next command restorable', async () => {
    const { workspace, settings, details, file, inner } = deepFixture()
    // The sweep reaches the tree of lib/inner first; once it is gone, every other removal is refused.
    objectFaults.first = inner
    objectFaults.refuse = id => id !== inner && objectFaults.removed.includes(inner)
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      await vi.waitFor(() => expect(objectFaults.removed.length).toBeGreaterThan(0))
      objectFaults.refuse = undefined
      await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(file, 'd2') })
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, changes: [{ path: file, kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(file)).toBe('d1')
    } finally { await history.close() }
  })

  it('goes on past a stored object the system refuses to remove', async () => {
    const { workspace, directory, settings, details } = fixture({ maxFileBytes: 64 })
    const big = (fill: number) => Buffer.alloc(200, fill)
    const held = blobId(big(1))
    objectFaults.first = held
    objectFaults.refuse = id => id === held
    const history = await openChangeHistory(settings)
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'one.bin'), big(1)); writeFileSync(join(workspace, 'two.bin'), big(2)) })
      await vi.waitFor(() => expect(historyObjects(directory).filter(content => content.length > 200).map(content => content.at(-1))).toEqual([1]))
    } finally { await history.close() }
  })

  it('writes every tree again at a node\'s first capture of a folder, so a tree an earlier sweep removed is never named', async () => {
    const { root, workspace, directory, settings, details, file, inner } = deepFixture()
    let history = await openChangeHistory(settings)
    try { await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') }) } finally { await history.close() }
    // As an earlier build's sweep that stopped part way left it: the trees the shadow index names, but not lib/inner's.
    const shadow = join(directory, 'commands', createHash('sha256').update(workspace).digest('hex').slice(0, 24))
    const config = join(root, 'empty-config'); writeFileSync(config, '')
    execFileSync('git', ['write-tree', '--missing-ok'], { env: { ...process.env, GIT_DIR: shadow, GIT_INDEX_FILE: join(shadow, 'index'), GIT_WORK_TREE: workspace, GIT_OBJECT_DIRECTORY: join(directory, 'blobs'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config } })
    rmSync(join(directory, 'blobs', inner.slice(0, 2), inner.slice(2)))
    history = await openChangeHistory(settings)
    try {
      await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(file, 'd2') })
      expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', restorable: true, changes: [{ path: file, kind: 'modified' }] })
    } finally { await history.close() }
  })
})

// X14 of the Codex review of 670f1dc2..01d3b0c9: a command's capture runs within a short budget, and its before phase stops
// with its call's cancellation, so history never holds the lock for minutes before a command; the command runs all the same.
describe('a command\'s capture that takes too long', () => {
  it.skipIf(process.platform === 'win32')('stops at its budget and runs the command without restorable content', async () => {
    const { workspace, settings, details } = fixture()
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500 })
    try {
      gitAdd.slow = 20
      const started = Date.now()
      await expect(history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2'); return 'ran' })).resolves.toBe('ran')
      expect(Date.now() - started).toBeLessThan(10_000)
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('git add timed out') })
      expect(read(join(workspace, 'src', 'a.txt'))).toBe('a2')
    } finally { await history.close() }
  })

  // X6 of the Codex recheck: what a git add cut short wrote before it stopped is swept after the command, as after any other.
  it.skipIf(process.platform === 'win32')('reclaims what git add wrote before its budget stopped it', async () => {
    const { workspace, directory, settings, details } = fixture()
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500 })
    try {
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      let orphan = ''
      gitAdd.hook = () => { void openObjectStore(directory).put(Buffer.from('CUT SHORT')).then(id => { orphan = id }) }
      gitAdd.slow = 20
      await expect(history.run(details, async () => 'ran')).resolves.toBe('ran')
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('git add timed out') })
      expect(orphan).not.toBe('')
      await vi.waitFor(() => expect(historyObjects(directory).some(content => content.includes('CUT SHORT'))).toBe(false))
    } finally { await history.close() }
  })

  it.skipIf(process.platform === 'win32')('stops its before phase as its call is cancelled', async () => {
    const { settings, details } = fixture()
    const history = await openChangeHistory(settings)
    try {
      const cancel = new AbortController()
      gitAdd.slow = 20; gitAdd.started = () => setTimeout(() => cancel.abort(new Error('cancelled')), 200)
      const started = Date.now()
      await history.run(details, async () => 'ran', cancel.signal)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('cancelled') })
    } finally { await history.close() }
  })
})

// W2 of the Windows test of d26bf5ba: a first record of a folder that a command's budget cut short is finished in the
// background, off every call path, so later commands are restorable without paying the budget again; one that starts while
// it runs neither waits on it nor starts its own.
describe('a first record of a folder that a command\'s budget cut short', () => {
  function shadowIndex(directory: string, workspace: string): string {
    return join(directory, 'commands', createHash('sha256').update(workspace).digest('hex').slice(0, 24), 'index')
  }

  it.skipIf(process.platform === 'win32')('is finished in the background, so a later command is restorable without paying the budget again', async () => {
    const { workspace, directory, settings, details } = fixture()
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500, baselineBudgetMs: 30_000 })
    try {
      gitAdd.cold = 2
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('git add timed out') })
      await vi.waitFor(() => expect(existsSync(shadowIndex(directory, workspace))).toBe(true), { timeout: 20_000, interval: 100 })
      const started = Date.now()
      await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a3') })
      expect(Date.now() - started).toBeLessThan(2_000)
      const checkpoint = (await history.list()).at(-1)!
      expect(checkpoint).toMatchObject({ status: 'complete', restorable: true, changes: [{ path: join(workspace, 'src', 'a.txt'), kind: 'modified' }] })
      await history.restore(checkpoint.id)
      expect(read(join(workspace, 'src', 'a.txt'))).toBe('a2')
    } finally { await history.close() }
  })

  it.skipIf(process.platform === 'win32')('runs a command that starts while it is taken at once, saying why it is not restorable', async () => {
    const { workspace, settings, details } = fixture()
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500, baselineBudgetMs: 30_000 })
    try {
      gitAdd.cold = 5
      await history.run(details, async () => 'first')
      const started = Date.now()
      await expect(history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2'); return 'ran' })).resolves.toBe('ran')
      expect(Date.now() - started).toBeLessThan(400)
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('in the background') })
    } finally { await history.close() }
  })

  // V1 of the Codex review of the W fixes: Windows refusing the removal of what the record made, its marker here, never
  // leaves the folder marked as taking one, which would leave every later command unrestorable and stop every sweep.
  it.skipIf(process.platform === 'win32')('lets its folder go once it ends, even where the system refuses to remove what it made, and removes that later', async () => {
    const { root, workspace, directory, settings, details } = fixture({ maxFileBytes: 64 })
    const other = join(root, 'other'); mkdirSync(other)
    const marker = shadowIndex(directory, workspace).replace(/index$/, 'warming')
    objectFaults.files = path => path === marker
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500, baselineBudgetMs: 30_000 })
    try {
      gitAdd.cold = 2
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      await vi.waitFor(() => expect(objectFaults.refused).toContain(marker), { timeout: 20_000, interval: 100 })
      objectFaults.files = undefined; gitAdd.cold = 0
      // The sweep after a command in another folder tries the removal again.
      await history.run({ ...details, stageId: 'other', roots: [other] }, async () => { writeFileSync(join(other, 'c.txt'), 'c1') })
      await vi.waitFor(() => expect(existsSync(marker)).toBe(false))
      await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a3'); writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(200, 7)) })
      expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', restorable: true, notRestorable: [join(workspace, 'big.bin')] })
      await vi.waitFor(() => expect(historyObjects(directory).some(content => content.length > 200)).toBe(false))
    } finally { await history.close() }
  })

  // V2 of the Codex review of the W fixes: a folder swapped for a link while git reads it stops every background record, as
  // the sweep that removes what git read through the link waits for them; its command never waits for one to end.
  it.skipIf(process.platform === 'win32')('is stopped by a command whose own folder is replaced as git reads it, which runs without waiting for it to end', async () => {
    const { root, workspace, directory, settings, details } = fixture()
    const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'c.txt'), 'c1')
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'key'), 'PRIVATE KEY')
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500, baselineBudgetMs: 30_000 })
    try {
      await history.run({ ...details, roots: [other] }, async () => 'first there')
      gitAdd.cold = 5; gitAdd.held = true
      await history.run(details, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2') })
      await vi.waitFor(() => expect(gitAdd.indexes.some(index => index.endsWith('index.warm'))).toBe(true), { timeout: 10_000, interval: 50 })
      gitAdd.hook = () => { renameSync(other, join(root, 'moved')); symlinkSync(elsewhere, other) }
      const started = Date.now()
      await expect(history.run({ ...details, stageId: 'next', roots: [other] }, async () => 'ran')).resolves.toBe('ran')
      expect(Date.now() - started).toBeLessThan(2_000)
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('replaced by a link') })
      await vi.waitFor(() => expect(historyObjects(directory).some(content => content.includes('PRIVATE'))).toBe(false), { timeout: 10_000, interval: 100 })
    } finally { await history.close() }
  })

  it.skipIf(process.platform === 'win32')('is taken in the background too once an after phase runs out of time', async () => {
    const { workspace, settings, details } = fixture()
    const history = await openChangeHistory({ ...settings, captureBudgetMs: 500, baselineBudgetMs: 30_000 })
    try {
      await history.run(details, async () => 'first')
      // The after phase's git add, then the next one, take longer than a phase may.
      await history.run({ ...details, stageId: 'second' }, async () => { writeFileSync(join(workspace, 'src', 'a.txt'), 'a2'); gitAdd.slow = 20; gitAdd.started = () => { gitAdd.slow = 5 } })
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('git add timed out') })
      const started = Date.now()
      await history.run({ ...details, stageId: 'third' }, async () => 'ran')
      expect(Date.now() - started).toBeLessThan(400)
      expect((await history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('in the background') })
    } finally { await history.close() }
  })
})

// R1.3 of the Codex recheck: what git saw on disk but did not store comes from its listings and its warnings, never a
// walk; a warning history cannot read leaves every folder git listed unknown, so nothing below one reads as absent.
it('reads what git did not store from its listings and the folders it warned it could not open', () => {
  const listings = [Buffer.from('empty/\0nested/\0tracked/unread\0'), Buffer.from('empty/held.txt\0tracked/unread\0nested/\0')]
  const seen = unstoredState(listings, { text: "warning: could not open directory 'tracked/locked/': Permission denied\nwarning: could not open directory 'empty/inner/': Permission denied\n", complete: true })
  expect(seen).toEqual({ unstored: new Set(['tracked/unread', 'empty/held.txt']), untrackedFolders: new Set(['empty', 'nested']), unknown: new Set(['tracked/locked', 'empty/inner']) })
  expect(unstoredState(listings, { text: "warning: unable to access 'x/.gitignore': Permission denied\n", complete: true }).unknown).toEqual(new Set(['empty', 'nested']))
  expect(unstoredState(listings, { text: '', complete: false }).unknown).toEqual(new Set(['empty', 'nested']))
})
