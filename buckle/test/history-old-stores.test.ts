import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'

// The journal's publication can be made to fail, and the background deletion of the expired stores held (X8, M2).
const faults = vi.hoisted(() => ({ journal: false, hold: undefined as Promise<void> | undefined, held: [] as string[] }))
vi.mock('../common/adapters/replace-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return { ...actual, replaceFile: async (...args: Parameters<typeof actual.replaceFile>) => {
    if (faults.journal && args[1].endsWith('checkpoints.json')) throw Object.assign(new Error('fixture journal write failed'), { code: 'ENOSPC' })
    return actual.replaceFile(...args)
  } }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const rm: typeof actual.rm = async (path, options) => {
    if (faults.hold) { faults.held.push(String(path)); await faults.hold }
    return actual.rm(path, options)
  }
  return { ...actual, rm, default: { ...actual, rm } }
})

// Slice F2, item 7: the stores written before the object store (the shadow git of 670f1dc2, and the SQLite history
// before it) stay listable; a restore of a shadow-git checkpoint reads that store through permitted host git, and
// says why it cannot without it; and once ten turns of new checkpoints follow, the old stores are deleted.

const OLD_STORES = ['git', 'roots', 'git-private', 'history.sqlite']
const roots: string[] = []
const histories: Array<Awaited<ReturnType<typeof openChangeHistory>>> = []
afterEach(async () => {
  faults.journal = false; faults.hold = undefined; faults.held = []
  for (const history of histories.splice(0)) await history.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-old-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  return { workspace, directory: join(root, 'history'), file: join(workspace, 'file') }
}
async function open(directory: string, extra: { allowHostGit?: boolean; keepTurns?: number } = {}) {
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 16 * 1_048_576, ...extra })
  histories.push(history)
  return history
}
/** One SQLite checkpoint as the history before the shadow-git engine wrote it. */
async function legacyStore(directory: string, workspace: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'history.sqlite'))
  db.exec('CREATE TABLE objects (hash TEXT PRIMARY KEY, content BLOB NOT NULL); CREATE TABLE checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const record = { id: 'change-sqlite', sessionId: 'old-session', stageId: 'old-stage', tool: 'fs_write', createdAt: new Date(0).toISOString(), roots: [workspace], status: 'complete', before: {}, after: { [join(workspace, 'old.txt')]: { kind: 'file', mode: 0o644, hash: 'a'.repeat(64) } } }
  db.prepare('INSERT INTO checkpoints VALUES(?,?)').run(record.id, JSON.stringify(record)); db.close()
  return record.id
}
/** A file tool's write in a turn of its own, as the new engine records it. */
function write(history: Awaited<ReturnType<typeof open>>, file: string, turn: string, content: string) {
  return history.run({ sessionId: 's', stageId: turn, tool: 'fs_write', roots: [file], scope: [{ path: file }] }, async () => { writeFileSync(file, content) })
}

it('lists shadow-git and SQLite checkpoints beside new ones, and restores a shadow-git one through shadow git', async () => {
  const { workspace, directory, file } = fixture()
  writeFileSync(file, 'original')
  const old = await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'old engine') })
  const sqlite = await legacyStore(directory, workspace)
  const history = await open(directory)
  await write(history, file, 'new-1', 'new engine')
  const listed = await history.list()
  expect(listed.map(record => record.id)).toEqual(expect.arrayContaining([old.id, sqlite]))
  expect(listed.find(record => record.id === sqlite)).toMatchObject({ legacy: true, restorable: false, reason: expect.stringContaining('SQLite') })
  expect(listed.find(record => record.id === old.id)).toMatchObject({ restorable: true, paths: [file] })
  await expect(history.restore(sqlite)).rejects.toThrow('SQLite')
  await history.rollback({ target: { id: old.id }, by: { sessionId: 'owner', stageId: 'restore', tool: 'test' } })
  expect(readFileSync(file, 'utf8')).toBe('original')
})

it('refuses a shadow-git checkpoint\'s restore without permitted host git, naming why, before anything asks, even one that needs no content', async () => {
  const { workspace, directory, file } = fixture()
  const old = await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'made by the old engine') })
  const history = await open(directory, { allowHostGit: false })
  expect((await history.list()).find(record => record.id === old.id)).toMatchObject({ restorable: false, reason: expect.stringContaining('permitted trusted host git'), paths: [file] })
  await expect(history.plan({ id: old.id })).rejects.toThrow('permitted trusted host git')
  await expect(history.restore(old.id)).rejects.toThrow('permitted trusted host git')
  await expect(history.rollback({ target: { steps: 1 }, by: { sessionId: 'owner', stageId: 'restore', tool: 'test' } })).rejects.toThrow('permitted trusted host git')
  expect(readFileSync(file, 'utf8')).toBe('made by the old engine')
})

// M3 (coordinator): the old stores outlive as many new turns as history.keepTurns keeps, not a fixed ten.
for (const allowHostGit of [true, false]) it(`deletes the old stores once keepTurns new turns follow them, host git ${allowHostGit ? 'on' : 'off'}, and lists their checkpoints until then`, async () => {
  const { workspace, directory, file } = fixture()
  const old = await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'old engine') })
  const sqlite = await legacyStore(directory, workspace)
  const history = await open(directory, { allowHostGit, keepTurns: 12 })
  for (let turn = 1; turn <= 11; turn++) { await write(history, file, `new-${turn}`, `turn ${turn}`); await write(history, file, `new-${turn}`, `turn ${turn} again`) }
  for (const name of ['git', 'git-private', 'history.sqlite']) expect(existsSync(join(directory, name))).toBe(true)
  expect((await history.list()).map(record => record.id)).toEqual(expect.arrayContaining([old.id, sqlite]))
  await write(history, file, 'new-12', 'turn 12')
  for (const name of OLD_STORES) expect(existsSync(join(directory, name))).toBe(false)
  const listed = await history.list()
  expect(listed.map(record => record.id)).not.toContain(old.id)
  expect(listed.map(record => record.id)).not.toContain(sqlite)
  expect(listed).toHaveLength(23)
  expect(listed.every(record => record.restorable)).toBe(true)
  await history.restore(listed.at(-1)!.id)
  expect(readFileSync(file, 'utf8')).toBe('turn 11 again')
  // The count of new turns goes with the stores, and a later write recreates none of them.
  await write(history, file, 'new-13', 'turn 13')
  expect(JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8'))).not.toHaveProperty('oldStoreTurns')
  for (const name of OLD_STORES) expect(existsSync(join(directory, name))).toBe(false)
})

// X8 of the Codex review of 670f1dc2..01d3b0c9: the journal publishes the old checkpoints' removal before their stores go,
// so a journal that cannot save keeps both, and the next write expires them.
it('keeps the old stores while the journal cannot publish their checkpoints\' removal, and expires them on the next write', async () => {
  const { workspace, directory, file } = fixture()
  const old = await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'old engine') })
  const history = await open(directory, { allowHostGit: true, keepTurns: 2 })
  await write(history, file, 'new-1', 'turn 1')
  faults.journal = true
  await write(history, file, 'new-2', 'turn 2')
  faults.journal = false
  expect(JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8')).checkpoints.map((record: { id: string }) => record.id)).toContain(old.id)
  expect(existsSync(join(directory, 'git'))).toBe(true)
  await write(history, file, 'new-3', 'turn 3')
  expect(existsSync(join(directory, 'git'))).toBe(false)
  expect((await history.list()).map(record => record.id)).not.toContain(old.id)
})

// M2 (coordinator): the write that expires the old stores renames them aside under the lock; their deletion runs after,
// off the call path, so the call never waits on a recursive delete.
it('renames the old stores aside as their checkpoints expire and deletes them in the background', async () => {
  const { workspace, directory, file } = fixture()
  await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'old', execute: () => writeFileSync(file, 'old engine') })
  await legacyStore(directory, workspace)
  const history = await open(directory, { allowHostGit: false, keepTurns: 2 })
  await write(history, file, 'new-1', 'turn 1')
  let release!: () => void
  faults.hold = new Promise(resolve => { release = resolve })
  await write(history, file, 'new-2', 'turn 2')
  for (const name of OLD_STORES) expect(existsSync(join(directory, name))).toBe(false)
  const aside = readdirSync(directory).filter(name => name.startsWith('expired-'))
  expect(aside).toHaveLength(1)
  expect(readdirSync(join(directory, aside[0]!)).sort()).toEqual(['git', 'git-private', 'history.sqlite'])
  expect(faults.held).toEqual([join(directory, aside[0]!)])
  release()
  await vi.waitFor(() => expect(readdirSync(directory).filter(name => name.startsWith('expired-'))).toEqual([]))
})

it('makes none of the old stores\' folders in a new history, for a file tool or a command', async () => {
  const { workspace, directory, file } = fixture()
  const history = await open(directory)
  await write(history, file, 'new-1', 'file tool')
  await history.run({ sessionId: 's', stageId: 'new-2', tool: 'exec', roots: [workspace] }, async () => { writeFileSync(join(workspace, 'built'), 'command') })
  expect((await history.list()).every(record => record.restorable)).toBe(true)
  for (const name of OLD_STORES) expect(existsSync(join(directory, name))).toBe(false)
})
