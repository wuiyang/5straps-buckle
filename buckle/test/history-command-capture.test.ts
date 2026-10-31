import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_GIT_REASON, openChangeHistory } from '../common/services/history/journal.js'
import { indexEntries } from '../common/services/history/command-capture.js'
import { historyObjects } from './support/history-objects.js'

// Slice F2, item 3 (owner correction 2026-11-01): a command's checkpoint comes from git itself, in a shadow repository
// that reads the workspace's own ignore rules. git add -A brings its index up to date before and after the command, and
// diff-tree names what changed. Nothing ignored is stored or restored; only a count of ignored changes is kept. Git
// writes loose objects into history's own object folder, so a restore needs no git.

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) { execFileSync('chmod', ['-R', 'u+rwx', root]); rmSync(root, { recursive: true, force: true }) }
})

function fixture(options: { allowHostGit?: boolean; maxFileBytes?: number } = {}) {
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

it('reads a version 2 git index in-process', () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-index-')); roots.push(root)
  writeFileSync(join(root, 'one'), 'one'); mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder', 'a-much-longer-name.txt'), 'two!')
  execFileSync('git', ['init', '--quiet', root]); execFileSync('git', ['-C', root, 'add', '-A'])
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-s'], { encoding: 'utf8' }).trim().split('\n').map(line => line.split(' ')[1])
  expect(indexEntries(readFileSync(join(root, '.git', 'index')))).toEqual([{ id: listed[0], size: 4 }, { id: listed[1], size: 3 }])
})
