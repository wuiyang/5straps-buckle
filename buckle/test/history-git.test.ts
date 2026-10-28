import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createGitStore } from '../common/services/history/git-store.js'
import { openChangeHistory } from '../common/services/history/journal.js'

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
function treeDigest(directory: string): string {
  const hash = createHash('sha256')
  function visit(path: string): void { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const child = join(path, entry.name); hash.update(entry.name); if (entry.isDirectory()) visit(child); else hash.update(readFileSync(child)) } }
  visit(directory)
  return hash.digest('hex')
}
it('uses shadow refs and owner alternates without modifying owner git bytes', async () => {
  const { workspace, directory, history, details } = await fixture()
  execFileSync('git', ['init', '-q', workspace])
  writeFileSync(join(workspace, 'file'), 'original\r\n')
  execFileSync('git', ['-C', workspace, 'add', '.'])
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline'])
  const digest = treeDigest(join(workspace, '.git'))
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'changed') })
    const [checkpoint] = await history.list()
    expect(existsSync(join(directory, 'git', 'objects', 'info', 'alternates'))).toBe(true)
    expect(execFileSync('git', ['--git-dir', join(directory, 'git'), 'rev-parse', `refs/buckle/checkpoints/${checkpoint!.id}`], { encoding:'utf8' }).trim()).toMatch(/^[a-f0-9]{40}$/)
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
    expect(execFileSync('git', ['--git-dir', join(directory, 'git'), 'ls-tree', '-r', `refs/buckle/checkpoints/${checkpoint!.id}`], {encoding:'utf8'})).not.toMatch(/ignored|large/)
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
it('records changes without content when host git is disabled and refuses restore with a reason', async () => {
  const { workspace, directory, history, details } = await fixture({ allowHostGit: false })
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'a') })
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ restorable: false, paths: [join(workspace, 'file')] })
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
    let objectBytes = 0
    function visit(path: string): void { for (const entry of readdirSync(path, { withFileTypes: true })) { const at = join(path, entry.name); if (entry.isDirectory()) visit(at); else objectBytes += readFileSync(at).length } }
    visit(join(directory, 'git', 'objects'))
    expect(objectBytes).toBeLessThan(100_000)
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
  const { workspace, directory, history, details } = await fixture({ maxFileBytes: 32 })
  const file = join(workspace, 'size.txt'); writeFileSync(file, 'small')
  try {
    await history.run(details, async () => { writeFileSync(file, 'changed') })
    await history.run({ ...details, stageId: 'big' }, async () => { writeFileSync(file, Buffer.alloc(40, 3)) })
    const big = (await history.list()).at(-1)!
    expect(big.notRestorable).toContain(file)
    expect(execFileSync('git', ['--git-dir', join(directory, 'git'), 'ls-tree', '-r', `refs/buckle/checkpoints/${big.id}`], { encoding:'utf8' })).not.toContain('size.txt')
    await history.restore(big.id)
    expect(readFileSync(file).length).toBe(40)
    await history.run({ ...details, stageId: 'small-again' }, async () => { writeFileSync(file, 'small again') })
    await history.restore((await history.list()).at(-1)!.id)
    expect(readFileSync(file, 'utf8')).toBe('small again')
  } finally { await history.close() }
})

it('detaches dropped ancestry while preserving owner edits in the retained before commit', async () => {
  const { workspace, directory, history, details } = await fixture({ keepTurns: 1 })
  const file = join(workspace, 'file'); writeFileSync(file, 'original')
  try {
    await history.run(details, async () => { writeFileSync(file, 'first') })
    const old = (await history.list())[0]!
    const oldCommit = execFileSync('git', ['--git-dir', join(directory, 'git'), 'rev-parse', `refs/buckle/checkpoints/${old.id}`], { encoding:'utf8' }).trim()
    writeFileSync(file, 'owner edit between calls')
    await history.run({ ...details, stageId: 'new-turn' }, async () => { writeFileSync(file, 'second') })
    expect(execFileSync('git', ['--git-dir', join(directory, 'git'), 'rev-list', '--all'], { encoding:'utf8' })).not.toContain(oldCommit)
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

it.skipIf(process.platform === 'win32')('continues safe writes when an unrelated unsupported entry prevents capture', async () => {
  const { workspace, history, details } = await fixture()
  execFileSync('mkfifo', [join(workspace, 'unrelated-pipe')])
  try {
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'first'); return 'done' })).resolves.toBe('done')
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'second') })).resolves.toBeUndefined()
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('second')
    expect((await history.list()).at(-1)).toMatchObject({ status: 'interrupted', restorable: false, reason: expect.any(String) })
  } finally { await history.close() }
})

it('preserves hash and size warnings for oversized files across several restores', async () => {
  const { workspace, directory, history, details } = await fixture({ maxFileBytes: 32 })
  const file = join(workspace, 'large'); writeFileSync(file, Buffer.alloc(40, 1))
  try {
    for (const [index, size] of [41, 42].entries()) await history.run({ ...details, stageId: `cap-${index}` }, async () => { writeFileSync(file, Buffer.alloc(size, index + 2)); writeFileSync(join(workspace, 'note'), String(index)) })
    expect((await history.list()).map(item => item.notRestorable)).toEqual([[file], [file]])
    const state = JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8'))
    expect(state.checkpoints[0].afterTrees[0].extra[file]).toMatchObject({ reason: 'size', size: 41, hash: expect.any(String) })
    const restored = await history.rollback({ target: { turns: 2 }, by: { sessionId: 's', stageId: 'undo', tool: 'restore' } })
    expect(restored.notRestorable).toContain(file)
    expect(readFileSync(file).length).toBe(42)
  } finally { await history.close() }
})

it('persists one boundary marker for an ignored subtree instead of all ignored descendants', async () => {
  const { workspace, directory, history, details } = await fixture()
  writeFileSync(join(workspace, '.gitignore'), 'ignored/\n')
  mkdirSync(join(workspace, 'ignored'))
  for (let index = 0; index < 1000; index++) writeFileSync(join(workspace, 'ignored', `file-${index}`), 'private')
  try {
    for (let index = 0; index < 2; index++) await history.run(details, async () => { writeFileSync(join(workspace, 'note'), String(index)) })
    const state = JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8'))
    for (const checkpoint of state.checkpoints) for (const tree of [...checkpoint.beforeTrees, ...checkpoint.afterTrees]) {
      expect(tree.extra[join(workspace, 'ignored')]).toMatchObject({ kind: 'excluded', reason: 'ignored' })
      expect(Object.keys(tree.extra).length).toBeLessThan(5)
      expect(Object.keys(tree.extra).some(path => path.includes('file-'))).toBe(false)
    }
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
    await store.pruneLoose()
    await store.collect([])
    expect(readdirSync(join(directory, 'git', 'objects', 'pack')).filter(name => name.endsWith('.pack'))).toEqual([])
  } finally { await history.close() }
})
