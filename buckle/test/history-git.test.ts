import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitStore } from '../common/services/history/git-store.js'
import { HOST_GIT_REASON, openChangeHistory } from '../common/services/history/journal.js'
import { logger } from '../common/runtime/log.js'
import { historyObjects } from './support/history-objects.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-git-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 256 * 1048576, retentionDays: 30, ...extra })
  const details = { sessionId: 's', stageId: 'one', tool: 'test', roots: [workspace] }
  return { root, workspace, directory, history, details }
}
/** Each path below `directory` with this name, walked with Node alone, so the test needs no Unix find (X15). */
function named(directory: string, name: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(path => path.split(/[\\/]/).at(-1) === name)
}
function storedObjects(directory: string): string[] { return historyObjects(directory).map(content => content.toString('latin1')) }
function treeDigest(directory: string): string {
  const hash = createHash('sha256')
  function visit(path: string): void { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const child = join(path, entry.name); hash.update(entry.name); if (entry.isDirectory()) visit(child); else hash.update(readFileSync(child)) } }
  visit(directory)
  return hash.digest('hex')
}
// Slice F2, items 3 and 4: a command's checkpoint borrows nothing from the owner's repository (A5) and changes none of it.
it('records a command in an owner repository without borrowing its objects or modifying its git bytes', async () => {
  const { workspace, directory, history, details } = await fixture()
  execFileSync('git', ['init', '-q', workspace])
  writeFileSync(join(workspace, 'file'), 'original\r\n')
  execFileSync('git', ['-C', workspace, 'add', '.'])
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline'])
  const digest = treeDigest(join(workspace, '.git'))
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'changed') })
    const [checkpoint] = await history.list()
    expect(named(directory, 'alternates')).toEqual([])
    expect(checkpoint).toMatchObject({ restorable: true, paths: [join(workspace, 'file')] })
    await history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('original\r\n')
    expect(treeDigest(join(workspace, '.git'))).toBe(digest)
  } finally { await history.close() }
})
it('honours ignore rules and excludes state while recording over-cap hashes without blocking a write', async () => {
  const { workspace, directory, history, details } = await fixture({ maxFileBytes: 32 })
  writeFileSync(join(workspace, '.gitignore'), 'ignored\n')
  writeFileSync(join(workspace, 'ignored'), 'private')
  writeFileSync(join(workspace, 'large'), Buffer.alloc(64, 1))
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'large'), Buffer.alloc(65, 2)); writeFileSync(join(workspace, 'file'), 'okay') })
    const [checkpoint] = await history.list()
    expect(checkpoint!.notRestorable).toContain(join(workspace, 'large'))
    expect(checkpoint!.paths).toEqual([join(workspace, 'file')])
    expect(storedObjects(directory).some(content => content.includes('private'))).toBe(false)
    await history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'large')).length).toBe(65)
  } finally { await history.close() }
})
it('groups explicit stages by session and implicit calls by idle gap, and drops the oldest of eleven turns', async () => {
  let now = 1_000_000
  const { workspace, history, details } = await fixture({ now: () => now, keepTurns: 10, turnIdleMs: 60_000 })
  try {
    await history.run({ ...details, stageId: undefined }, async () => { writeFileSync(join(workspace, 'file'), 'a') })
    now += 1000
    await history.run({ ...details, stageId: undefined }, async () => { writeFileSync(join(workspace, 'file'), 'b') })
    const first = await history.list()
    expect(first[0]!.turnId).toBeDefined()
    expect(first[1]!.turnId).toBe(first[0]!.turnId)
    for(let i=0;i<10;i++){ now += 61_000; await history.run({ ...details, stageId: `turn-${i}` }, async () => { writeFileSync(join(workspace, 'file'), String(i)) }) }
    const listed = await history.list()
    expect(new Set(listed.map(item => item.turnId)).size).toBe(10)
    expect(listed.some(item => item.id === first[0]!.id)).toBe(false)
  } finally { await history.close() }
})
it('runs a command when host git is disabled, records it as not restorable, and refuses restore with that reason', async () => {
  const { workspace, directory, history, details } = await fixture({ allowHostGit: false })
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'a') })
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ restorable: false, reason: HOST_GIT_REASON, paths: [] })
    expect(existsSync(join(directory, 'git'))).toBe(false)
    await expect(history.restore(checkpoint!.id)).rejects.toThrow('host git')
  } finally { await history.close() }
})

it('drops content rather than blocking when a single checkpoint cannot fit the rolling cap', async () => {
  const { randomBytes } = await import('node:crypto')
  const { workspace, directory, history, details } = await fixture({ maxBytes: 100_000 })
  try {
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'random.bin'), randomBytes(300_000)); return 'done' })).resolves.toBe('done')
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ restorable: false, reason: expect.stringContaining('rolling size cap') })
    expect(existsSync(join(directory, 'git'))).toBe(false)
  } finally { await history.close() }
})

it('reads and recovers a legacy SQLite store without modifying its bytes, then prunes it explicitly', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { directory, workspace, history } = await fixture()
  const file = join(directory, 'history.sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const record = { id: 'change-legacy', sessionId: 'old-session', stageId: 'old-stage', tool: 'old', createdAt: new Date().toISOString(), roots: [workspace], status: 'pending', before: {} }
  db.prepare('INSERT INTO checkpoints VALUES(?,?)').run(record.id, JSON.stringify(record)); db.close()
  const bytes = readFileSync(file)
  try {
    expect((await history.list())[0]).toMatchObject({ id: record.id, legacy: true })
    await history.recover(record.id)
    expect(readFileSync(file)).toEqual(bytes)
    await history.prune({ legacy: true })
    expect(existsSync(file)).toBe(false)
  } finally { await history.close() }
})

it('removes stale index entries when a tracked file becomes over-cap and never restores either transition', async () => {
  const { workspace, history, details } = await fixture({ maxFileBytes: 32 })
  const file = join(workspace, 'size.txt'); writeFileSync(file, 'small')
  try {
    await history.run(details, async () => { writeFileSync(file, 'changed') })
    await history.run({ ...details, stageId: 'big' }, async () => { writeFileSync(file, Buffer.alloc(40, 3)) })
    const big = (await history.list()).at(-1)!
    expect(big.notRestorable).toContain(file)
    await history.restore(big.id)
    expect(readFileSync(file).length).toBe(40)
    await history.run({ ...details, stageId: 'small-again' }, async () => { writeFileSync(file, 'small again') })
    await history.restore((await history.list()).at(-1)!.id)
    expect(readFileSync(file, 'utf8')).toBe('small again')
  } finally { await history.close() }
})

it('drops the oldest turn while keeping the owner edit the next command\'s before state holds', async () => {
  const { workspace, history, details } = await fixture({ keepTurns: 1 })
  const file = join(workspace, 'file'); writeFileSync(file, 'original')
  try {
    await history.run(details, async () => { writeFileSync(file, 'first') })
    const old = (await history.list())[0]!
    writeFileSync(file, 'owner edit between calls')
    await history.run({ ...details, stageId: 'new-turn' }, async () => { writeFileSync(file, 'second') })
    expect((await history.list()).map(item => item.id)).not.toContain(old.id)
    await history.restore((await history.list())[0]!.id)
    expect(readFileSync(file, 'utf8')).toBe('owner edit between calls')
  } finally { await history.close() }
})

it('keeps ignored directories out of the restore plan and retains not-restorable warnings across rollback', async () => {
  const { workspace, history, details } = await fixture({ maxFileBytes: 32 })
  writeFileSync(join(workspace, '.gitignore'), 'ignored/\n')
  writeFileSync(join(workspace, 'large'), Buffer.alloc(40, 1))
  try {
    await history.run(details, async () => { mkdirSync(join(workspace, 'ignored')); writeFileSync(join(workspace, 'ignored', 'kept'), 'private'); writeFileSync(join(workspace, 'large'), Buffer.alloc(41, 2)); writeFileSync(join(workspace, 'note'), 'change') })
    const checkpoint = (await history.list())[0]!
    expect(checkpoint.paths).toEqual([join(workspace, 'note')])
    const result = await history.rollback({ target: { steps: 1 }, by: { sessionId: 's', stageId: 'undo', tool: 'restore' } })
    expect(result.notRestorable).toContain(join(workspace, 'large'))
    expect(readFileSync(join(workspace, 'ignored', 'kept'), 'utf8')).toBe('private')
  } finally { await history.close() }
})

it('never overwrites a file entering ignore rules or deletes one leaving them', async () => {
  const { workspace, history, details } = await fixture()
  const file = join(workspace, 'file'); writeFileSync(file, 'before')
  try {
    await history.run(details, async () => { writeFileSync(file, 'ignored private content'); writeFileSync(join(workspace, '.gitignore'), 'file\n') })
    const first = (await history.list()).at(-1)!
    expect(first.notRestorable).toContain(file)
    await history.restore(first.id)
    expect(readFileSync(file, 'utf8')).toBe('ignored private content')
    writeFileSync(join(workspace, '.gitignore'), 'file\n')
    await history.run(details, async () => { rmSync(join(workspace, '.gitignore')); writeFileSync(join(workspace, 'note'), 'x') })
    await history.restore((await history.list()).at(-1)!.id)
    expect(readFileSync(file, 'utf8')).toBe('ignored private content')
  } finally { await history.close() }
})
it('refuses an ignored child before deleting any sibling of its new directory', async () => {
  const { workspace, history, details } = await fixture()
  writeFileSync(join(workspace, '.gitignore'), 'new/ignored\n')
  try {
    await history.run(details, async () => { mkdirSync(join(workspace, 'new')); writeFileSync(join(workspace, 'new', 'ignored'), 'private'); writeFileSync(join(workspace, 'new', 'note'), 'normal') })
    await expect(history.restore((await history.list())[0]!.id)).rejects.toThrow('ignored files')
    expect(readFileSync(join(workspace, 'new', 'note'), 'utf8')).toBe('normal')
  } finally { await history.close() }
})

it('keeps an idle turn alive across read calls and separates equal stage ids from different sessions', async () => {
  let now = 1_000_000
  const { workspace, history, details } = await fixture({ now: () => now })
  const file = join(workspace, 'file')
  try {
    await history.run({ ...details, stageId: undefined }, async () => { writeFileSync(file, 'first') })
    const first = (await history.list())[0]!
    now += 50_000; history.observeCall('s')
    now += 50_000; history.observeCall('s')
    now += 50_000
    await history.run({ ...details, stageId: undefined }, async () => { writeFileSync(file, 'second') })
    expect((await history.list()).at(-1)!.turnId).toBe(first.turnId)
    now += 60_001
    await history.run({ ...details, stageId: undefined }, async () => { writeFileSync(file, 'third') })
    expect((await history.list()).at(-1)!.turnId).not.toBe(first.turnId)
    await history.run({ ...details, stageId: 'same-stage', sessionId: 'one' }, async () => undefined)
    await history.run({ ...details, stageId: 'same-stage', sessionId: 'two' }, async () => undefined)
    const latest = (await history.list()).slice(-2)
    expect(latest[0]!.turnId).not.toBe(latest[1]!.turnId)
  } finally { await history.close() }
})

it('plans every checkpoint in a retained turn even when the turn has more than one hundred calls', async () => {
  const { workspace, directory, history, details } = await fixture()
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'same') })
    const file = join(directory, 'checkpoints.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    const source = state.checkpoints[0]
    state.checkpoints = Array.from({ length: 101 }, (_, index) => ({ ...source, id: `change-planned-${index}`, before: {}, after: {} }))
    writeFileSync(file, JSON.stringify(state))
    expect((await history.plan({ turns: 1 })).undoes).toBe(101)
    expect((await history.plan({ steps: 100 })).undoes).toBe(100)
  } finally { await history.close() }
})

// Slice F2, item 3: git leaves a FIFO out, so it never stops a capture (A7).
it.skipIf(process.platform === 'win32')('records and restores writes beside an unrelated FIFO', async () => {
  const { workspace, history, details } = await fixture()
  execFileSync('mkfifo', [join(workspace, 'unrelated-pipe')])
  try {
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'first'); return 'done' })).resolves.toBe('done')
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'second') })).resolves.toBeUndefined()
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('second')
    expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', restorable: true, paths: [join(workspace, 'file')] })
  } finally { await history.close() }
})

it('preserves hash and size warnings for oversized files across several restores', async () => {
  const { workspace, directory, history, details } = await fixture({ maxFileBytes: 32 })
  const file = join(workspace, 'large'); writeFileSync(file, Buffer.alloc(40, 1))
  try {
    for (const [index, size] of [41, 42].entries()) await history.run({ ...details, stageId: `cap-${index}` }, async () => { writeFileSync(file, Buffer.alloc(size, index + 2)); writeFileSync(join(workspace, 'note'), String(index)) })
    expect((await history.list()).map(item => item.notRestorable)).toEqual([[file], [file]])
    const state = JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8'))
    expect(state.checkpoints[0].after[file]).toMatchObject({ kind: 'excluded', reason: 'size', size: 41 })
    const restored = await history.rollback({ target: { turns: 2 }, by: { sessionId: 's', stageId: 'undo', tool: 'restore' } })
    expect(restored.notRestorable).toContain(file)
    expect(readFileSync(file).length).toBe(42)
  } finally { await history.close() }
})

it('records and stores nothing of an ignored subtree', async () => {
  const { workspace, directory, history, details } = await fixture()
  writeFileSync(join(workspace, '.gitignore'), 'ignored/\n')
  mkdirSync(join(workspace, 'ignored'))
  for (let index = 0; index < 1000; index++) writeFileSync(join(workspace, 'ignored', `file-${index}`), 'private')
  try {
    for (let index = 0; index < 2; index++) await history.run(details, async () => { writeFileSync(join(workspace, 'note'), String(index)) })
    expect(readFileSync(join(directory, 'checkpoints.json'), 'utf8')).not.toContain('file-')
    expect(storedObjects(directory).some(content => content.includes('private'))).toBe(false)
  } finally { await history.close() }
})

it('collects a packed-only shadow repository after every content reference has been dropped', async () => {
  const { workspace, directory, history } = await fixture()
  try {
    const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 32 * 1048576, allowed: () => true })
    writeFileSync(join(workspace, 'file'), 'packed checkpoint content')
    const captured = await store.capture({ roots: [workspace], id: 'change-packed', phase: 'before' })
    const git = (...args: string[]) => execFileSync('git', ['--git-dir', join(directory, 'git'), ...args], { encoding: 'utf8' })
    git('gc', '--quiet', '--prune=now')
    expect(readdirSync(join(directory, 'git', 'objects', 'pack')).some(name => name.endsWith('.pack'))).toBe(true)
    await store.removeRefs('change-packed', captured.trees)
    await store.collect([])
    expect(readdirSync(join(directory, 'git', 'objects', 'pack')).filter(name => name.endsWith('.pack'))).toEqual([])
  } finally { await history.close() }
})


it('retries interrupted private initialization after HEAD exists without safety setup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-init-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  execFileSync('git', ['init', '-q', workspace])
  writeFileSync(join(workspace, 'file'), 'original\r\n')
  const ownerDigest = treeDigest(join(workspace, '.git'))
  const privateGit = join(directory, 'git')
  // The store makes its folders at its first git child, never at open (Slice F2, item 7): the crashed setup makes its own.
  mkdirSync(privateGit, { recursive: true }); mkdirSync(join(directory, 'git-private', 'empty'), { recursive: true })
  execFileSync('git', ['init', '--quiet', `--template=${join(directory, 'git-private', 'empty')}`, privateGit], { env: { ...process.env, GIT_DIR: privateGit, GIT_WORK_TREE: workspace } })
  expect(existsSync(join(privateGit, 'HEAD'))).toBe(true)
  expect(existsSync(join(privateGit, 'info', 'attributes'))).toBe(false)
  const captured = await store.capture({ roots: [workspace], id: 'change-init-retry', phase: 'before' })
  expect(captured.restorable).toBe(true)
  expect(readFileSync(join(privateGit, 'info', 'attributes'), 'utf8')).toContain('-text -filter -ident -working-tree-encoding')
  expect(existsSync(join(privateGit, 'objects', 'info', 'alternates'))).toBe(true)
  expect([...(await store.restoreContent({ trees: captured.trees, target: captured.snapshot, paths: [join(workspace, 'file')] })).values()].map(value => value.toString())).toContain('original\r\n')
  expect(treeDigest(join(workspace, '.git'))).toBe(ownerDigest)
})

it('captures an empty baseline when the root and its parents do not exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-missing-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const missing = join(workspace, 'missing', 'child')
  const store = createGitStore({ directory: join(root, 'history'), excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  const before = await store.capture({ roots: [missing], id: 'change-missing-root', phase: 'before' })
  expect(before).toMatchObject({ snapshot: {}, restorable: true })
  mkdirSync(missing, { recursive: true }); writeFileSync(join(missing, 'file'), 'created')
  const after = await store.capture({ roots: [missing], id: 'change-missing-root', phase: 'after', parents: before.trees })
  expect(after.restorable).toBe(true)
  expect(await store.changed(before.trees, after.trees)).toEqual([join(missing, 'file')])
})

it('keeps concurrent capture timing summaries isolated and omits private metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-timing-')); roots.push(root)
  const populated = join(root, 'populated'); mkdirSync(populated); writeFileSync(join(populated, 'private-file'), 'private-content')
  const empty = join(root, 'empty'); mkdirSync(empty)
  const first = createGitStore({ directory: join(root, 'first'), excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  const second = createGitStore({ directory: join(root, 'second'), excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
  try {
    await Promise.all([first.capture({ roots: [populated], id: 'change-private-first', phase: 'before' }), second.capture({ roots: [empty], id: 'change-private-second', phase: 'after' })])
    const summaries = debug.mock.calls.filter(([message]) => message === 'History capture finished').map(([, fields]) => fields)
    expect(summaries).toHaveLength(2)
    expect(summaries).toContainEqual({ phase: 'before', outcome: 'ok', captureHashesMs: expect.any(Number), resolveMs: expect.any(Number), gitSubprocessMs: expect.any(Number), commandCount: 8, captureMs: expect.any(Number) })
    expect(summaries).toContainEqual({ phase: 'after', outcome: 'ok', captureHashesMs: expect.any(Number), resolveMs: expect.any(Number), gitSubprocessMs: expect.any(Number), commandCount: 7, captureMs: expect.any(Number) })
    expect(JSON.stringify(summaries)).not.toMatch(/private-file|private-content|change-private/)
    expect(JSON.stringify(summaries)).not.toContain(root)
  } finally { debug.mockRestore() }
})


for (const missing of ['HEAD', 'info/attributes']) it(`repairs stale setup markers when ${missing} is missing and preserves existing refs`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-stale-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'file'), 'original')
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  const first = await store.capture({ roots: [workspace], id: 'change-original', phase: 'before' })
  const privateGit = join(directory, 'git')
  expect(existsSync(join(privateGit, 'buckle-setup-complete'))).toBe(true)
  rmSync(join(privateGit, missing))
  const next = await store.capture({ roots: [workspace], id: 'change-repaired', phase: 'before' })
  expect(next.restorable).toBe(true)
  expect(execFileSync('git', ['--git-dir', privateGit, 'rev-parse', 'refs/buckle/checkpoints/change-original-before'], { encoding: 'utf8' }).trim()).toBe(first.trees[0]!.commit)
  expect(readFileSync(join(privateGit, 'info', 'attributes'), 'utf8')).toContain('-text -filter -ident -working-tree-encoding')
})

it('preserves borrowed objects when migrating a pre-marker store after owner git changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-alternates-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const originalGit = join(root, 'original-owner-git')
  execFileSync('git', ['init', '-q', `--separate-git-dir=${originalGit}`, workspace])
  writeFileSync(join(workspace, 'file'), 'borrowed original')
  execFileSync('git', ['-C', workspace, 'add', 'file'])
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  const first = await store.capture({ roots: [workspace], id: 'change-borrowed', phase: 'before' })
  const privateGit = join(directory, 'git')
  const alternates = readFileSync(join(privateGit, 'objects', 'info', 'alternates'), 'utf8')
  const fileHash = first.snapshot[join(workspace, 'file')]!.hash!
  expect(existsSync(join(privateGit, 'objects', fileHash.slice(0, 2), fileHash.slice(2)))).toBe(false)
  rmSync(join(privateGit, 'buckle-setup-complete'), { force: true })
  const nextGit = join(root, 'next-owner-git')
  execFileSync('git', ['init', '--bare', '-q', nextGit])
  writeFileSync(join(workspace, '.git'), `gitdir: ${nextGit}\n`)
  writeFileSync(join(workspace, 'file'), 'new content')
  const originalDigest = treeDigest(originalGit)
  const nextDigest = treeDigest(nextGit)
  await store.capture({ roots: [workspace], id: 'change-migrated', phase: 'after', parents: first.trees })
  expect(readFileSync(join(privateGit, 'objects', 'info', 'alternates'), 'utf8')).toBe(alternates)
  expect([...(await store.restoreContent({ trees: first.trees, target: first.snapshot, paths: [join(workspace, 'file')] })).values()].map(value => value.toString())).toContain('borrowed original')
  expect(treeDigest(originalGit)).toBe(originalDigest)
  expect(treeDigest(nextGit)).toBe(nextDigest)
})


it.skipIf(process.platform === 'win32')('replaces linked setup metadata without writing through to its target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-setup-link-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  await store.capture({ roots: [workspace], id: 'change-initial', phase: 'before' })
  const attributes = join(directory, 'git', 'info', 'attributes')
  const marker = join(directory, 'git', 'buckle-setup-complete')
  const target = join(root, 'metadata-target'); writeFileSync(target, 'owner file must stay unchanged')
  rmSync(attributes); symlinkSync(target, attributes)
  rmSync(marker); symlinkSync(target, marker)
  const captured = await store.capture({ roots: [workspace], id: 'change-repair-link', phase: 'before' })
  expect(captured.restorable).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe('owner file must stay unchanged')
  expect(readFileSync(attributes, 'utf8')).toContain('-text -filter -ident -working-tree-encoding')
})


it('repairs same-size corrupted safety attributes and captures exact CRLF bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-corrupt-attributes-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, '.gitattributes'), 'file text eol=lf\n')
  writeFileSync(join(workspace, 'file'), 'original\r\n')
  const directory = join(root, 'history')
  const store = createGitStore({ directory, excluded: [], maxFileBytes: () => 1_048_576, allowed: () => true })
  await store.capture({ roots: [workspace], id: 'change-before-corruption', phase: 'before' })
  const attributes = join(directory, 'git', 'info', 'attributes')
  const guarded = readFileSync(attributes, 'utf8')
  writeFileSync(attributes, ' '.repeat(Buffer.byteLength(guarded)))
  const captured = await store.capture({ roots: [workspace], id: 'change-after-corruption', phase: 'after' })
  expect([...(await store.restoreContent({ trees: captured.trees, target: captured.snapshot, paths: [join(workspace, 'file')] })).values()].map(value => value.toString())).toContain('original\r\n')
  expect(readFileSync(attributes, 'utf8')).toBe(guarded)
})
