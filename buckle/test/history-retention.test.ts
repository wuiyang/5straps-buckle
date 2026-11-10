import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitStore } from '../common/services/history/git-store.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import type { Checkpoint } from '../common/services/history/records.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'

const gitFault = vi.hoisted(() => ({ refReads: 0 }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawnWithFault = (...args: Parameters<typeof actual.spawn>) => {
    if (gitFault.refReads > 0 && args[1]?.includes('for-each-ref')) { gitFault.refReads--; throw new Error('fixture ref read failed') }
    return actual.spawn(...args)
  }
  return { ...actual, spawn: vi.fn(spawnWithFault) }
})

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before-save' | 'after-save', id: '', commit: '', raised: false }))
vi.mock('../common/adapters/replace-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  const replaceFile: typeof actual.replaceFile = async (from, to, io) => {
    const state = to.endsWith('/checkpoints.json') ? JSON.parse(readFileSync(from, 'utf8')) as { checkpoints: Checkpoint[] } : null
    const record = state?.checkpoints.find(row => row.id === fault.id)
    const migrated = !fault.raised && fault.mode !== 'none' && record?.beforeTrees?.[0]?.commit !== fault.commit && record?.beforeTrees?.[0]?.commit !== undefined
    if (migrated && fault.mode === 'before-save') { fault.raised = true; throw new Error('fixture metadata save failed') }
    await actual.replaceFile(from, to, io)
    if (migrated && fault.mode === 'after-save') { fault.raised = true; throw new Error('fixture stopped after metadata save') }
  }
  return { ...actual, replaceFile }
})

interface SavedHistory { version: 2; checkpoints: Checkpoint[]; lastGcAt: number }
const roots: string[] = []
const histories: Awaited<ReturnType<typeof openChangeHistory>>[] = []
afterEach(async () => {
  fault.mode = 'none'; fault.raised = false; gitFault.refReads = 0
  vi.mocked(spawn).mockClear()
  for (const history of histories.splice(0)) await history.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture(keepTurns = 10) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-retention-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const options = { directory, excluded: [], maxBytes: 16 * 1_048_576, keepTurns }
  const history = await openChangeHistory(options)
  histories.push(history)
  const file = join(workspace, 'file'); writeFileSync(file, 'baseline\r\n')
  const captureRoots = [workspace]
  // Each write is a checkpoint of the shadow-git engine that stores written before Slice F2 hold (item 7), kept as the
  // history then kept it after each write, a failure of that upkeep left to the next one.
  const write = async (stageId: string, content: string) => {
    await shadowGitCheckpoint({ directory, roots: captureRoots, sessionId: 'session', stageId, execute: () => writeFileSync(file, content) })
    await history.prune().catch(() => undefined)
  }
  const state = () => JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8')) as SavedHistory
  const records = () => state().checkpoints
  const git = (...args: string[]) => execFileSync('git', ['--git-dir', join(directory, 'git'), ...args], { encoding: 'utf8' }).trim()
  const parents = (commit: string) => git('rev-list', '--parents', '--no-walk', commit).split(' ').slice(1)
  return { root, workspace, directory, history, file, write, records, state, git, parents, options, captureRoots }
}

it('keeps each checkpoint before parentless and its after linked only to that before', async () => {
  const test = await fixture()
  await test.write('first', 'first\r\n')
  await test.write('second', 'second\r\n')
  for (const record of test.records()) {
    const before = record.beforeTrees![0]!
    const after = record.afterTrees![0]!
    expect(test.parents(before.commit)).toEqual([])
    expect(test.parents(after.commit)).toEqual([before.commit])
  }
})

it('drops expired ancestry without rewriting retained commits and restores exact owner baseline bytes', async () => {
  const test = await fixture(2)
  await test.write('first', 'first\r\n')
  writeFileSync(test.file, 'owner baseline\r\n')
  await test.write('second', 'second\r\n')
  const [dropped, retained] = test.records()
  const commits = [...retained!.beforeTrees!, ...retained!.afterTrees!].map(tree => tree.commit)
  vi.mocked(spawn).mockClear()
  await test.write('third', 'third\r\n')
  expect(vi.mocked(spawn).mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('commit-tree'))).toHaveLength(2)
  const after = test.records()
  expect(after).toHaveLength(2)
  expect(after[0]!.id).toBe(retained!.id)
  expect([...after[0]!.beforeTrees!, ...after[0]!.afterTrees!].map(tree => tree.commit)).toEqual(commits)
  expect(test.git('rev-list', '--all').split('\n')).not.toContain(dropped!.afterTrees![0]!.commit)
  await test.history.rollback({ target: { id: retained!.id }, by: { sessionId: 'owner', stageId: 'restore', tool: 'test' } })
  expect(readFileSync(test.file, 'utf8')).toBe('owner baseline\r\n')
})


type Fixture = Awaited<ReturnType<typeof fixture>>
function gitAt(directory: string, args: string[], input?: string): string {
  return execFileSync('git', ['--git-dir', directory, '-c', 'commit.gpgSign=false', ...args], {
    encoding: 'utf8', ...(input === undefined ? {} : { input }),
    env: { ...process.env, GIT_AUTHOR_NAME: 'Retention fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Retention fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  }).trim()
}
function saveState(test: Fixture, state: SavedHistory): void {
  writeFileSync(join(test.directory, 'checkpoints.json'), JSON.stringify(state))
}
function legacyGraph(test: Fixture, independent = new Set<number>()): SavedHistory {
  const state = test.state()
  const previous = new Map<string, string>()
  for (const [index, record] of state.checkpoints.entries()) {
    for (const phase of ['before', 'after'] as const) for (const capture of phase === 'before' ? record.beforeTrees ?? [] : record.afterTrees ?? []) {
      const parent = independent.has(index)
        ? phase === 'after' ? record.beforeTrees?.find(before => before.git === capture.git && before.root === capture.root)?.commit : undefined
        : previous.get(capture.git)
      const tree = gitAt(capture.git, ['rev-parse', `${capture.commit}^{tree}`])
      capture.commit = gitAt(capture.git, ['commit-tree', tree, ...parent ? ['-p', parent] : []], `Legacy fixture ${record.id} ${phase}\n`)
      gitAt(capture.git, ['update-ref', `refs/buckle/checkpoints/${record.id}${phase === 'before' ? '-before' : ''}`, capture.commit])
      previous.set(capture.git, capture.commit)
    }
  }
  state.lastGcAt = Date.now(); saveState(test, state)
  return state
}
function assertPairs(state: SavedHistory): void {
  for (const record of state.checkpoints) {
    for (const capture of record.beforeTrees ?? []) expect(gitAt(capture.git, ['rev-list', '--parents', '--no-walk', capture.commit]).split(' ').slice(1)).toEqual([])
    for (const capture of record.afterTrees ?? []) {
      const before = record.beforeTrees?.find(tree => tree.git === capture.git && tree.root === capture.root)
      expect(gitAt(capture.git, ['rev-list', '--parents', '--no-walk', capture.commit]).split(' ').slice(1)).toEqual(before ? [before.commit] : [])
    }
  }
}
function assertCanonical(state: SavedHistory): void {
  for (const record of state.checkpoints) for (const phase of ['before', 'after'] as const) for (const capture of phase === 'before' ? record.beforeTrees ?? [] : record.afterTrees ?? []) {
    expect(gitAt(capture.git, ['rev-parse', `refs/buckle/checkpoints/${record.id}${phase === 'before' ? '-before' : ''}`])).toBe(capture.commit)
  }
}
function repositories(state: SavedHistory): string[] {
  return [...new Set(state.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]).map(tree => tree.git))]
}
function collect(state: SavedHistory): void { for (const directory of repositories(state)) gitAt(directory, ['gc', '--quiet', '--prune=now']) }
function staging(state: SavedHistory): string[] { return repositories(state).flatMap(directory => gitAt(directory, ['for-each-ref', '--format=%(refname)', 'refs/buckle/migrations/']).split('\n').filter(Boolean)) }
async function reopen(test: Fixture) {
  const history = await openChangeHistory(test.options); histories.push(history)
  return history
}
async function seedLegacy() {
  const test = await fixture()
  await test.write('first', 'first\r\n')
  writeFileSync(test.file, 'owner baseline\r\n')
  await test.write('second', 'second\r\n')
  await test.history.close()
  return { test, state: legacyGraph(test) }
}

it('migrates mixed linked and isolated records by actual parents across multiple roots', async () => {
  const test = await fixture()
  const mount = join(test.root, 'mount'); mkdirSync(mount); writeFileSync(join(mount, 'mounted'), 'mounted bytes')
  test.captureRoots.push(mount)
  for (const stage of ['one', 'two', 'three']) await test.write(stage, stage)
  await test.history.close()
  const before = legacyGraph(test, new Set([2]))
  const stable = structuredClone(before.checkpoints[2])
  const oldTrees = before.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]).map(tree => gitAt(tree.git, ['rev-parse', `${tree.commit}^{tree}`]))
  collect(before)
  const history = await reopen(test)
  await history.prune()
  const after = test.state()
  assertPairs(after); assertCanonical(after)
  expect(staging(after)).toEqual([])
  expect(after.checkpoints[2]).toEqual(stable)
  expect(after.checkpoints.flatMap(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []]).map(tree => gitAt(tree.git, ['rev-parse', `${tree.commit}^{tree}`]))).toEqual(oldTrees)
  const commits = after.checkpoints.map(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []].map(tree => tree.commit))
  await history.prune()
  expect(test.records().map(record => [...record.beforeTrees ?? [], ...record.afterTrees ?? []].map(tree => tree.commit))).toEqual(commits)
})

for (const published of [false, true]) it(`recovers staged legacy migration ${published ? 'after' : 'before'} JSON publication before another write`, async () => {
  const { test, state } = await seedLegacy()
  const original = structuredClone(state)
  const store = createGitStore({ directory: test.directory, allowed: () => true })
  expect(await store.isolate(state.checkpoints)).toBe(true)
  assertCanonical(original)
  expect(staging(state).length).toBeGreaterThan(0)
  if (published) saveState(test, state)
  collect(state)
  const history = await reopen(test)
  await history.prune()
  const repaired = test.state()
  assertPairs(repaired); assertCanonical(repaired)
  expect(staging(repaired)).toEqual([])
  collect(repaired)
  await history.restore(repaired.checkpoints[1]!.id)
  expect(readFileSync(test.file, 'utf8')).toBe('owner baseline\r\n')
})

it('keeps old canonical refs and saved pointers if migration metadata publication fails', async () => {
  const { test, state } = await seedLegacy()
  const target = state.checkpoints[1]!
  fault.mode = 'before-save'; fault.id = target.id; fault.commit = target.beforeTrees![0]!.commit
  const history = await reopen(test)
  await expect(history.prune()).rejects.toThrow('fixture metadata save failed')
  expect(fault.raised).toBe(true)
  expect(test.state()).toEqual(state)
  assertCanonical(state)
  expect(staging(state).length).toBeGreaterThan(0)
  await history.close(); collect(state)
  const recovered = await reopen(test)
  await recovered.prune()
  assertPairs(test.state()); assertCanonical(test.state())
  expect(staging(test.state())).toEqual([])
  await recovered.restore(target.id)
  expect(readFileSync(test.file, 'utf8')).toBe('owner baseline\r\n')
})

for (const failAfterSave of [false, true]) it(`preserves migrated pending recovery pointers ${failAfterSave ? 'when publication is interrupted' : 'after successful finish'}`, async () => {
  const { test, state } = await seedLegacy()
  const target = state.checkpoints[1]!
  const baseline = structuredClone(target.before)
  target.status = 'pending'; target.before = {}
  delete target.after; delete target.afterTrees
  saveState(test, state)
  if (failAfterSave) { fault.mode = 'after-save'; fault.id = target.id; fault.commit = target.beforeTrees![0]!.commit }
  const history = await reopen(test)
  // The lock settles the pending record as interrupted (Slice F2, item 6); its before tree stays, kept by the migration.
  await expect(history.recover(target.id)).resolves.toMatchObject({ id: target.id, status: 'interrupted', restorable: false })
  await history.prune().catch(() => undefined)
  expect(fault.raised).toBe(failAfterSave)
  const saved = test.state()
  const recovered = saved.checkpoints.find(record => record.id === target.id)!
  expect(recovered.beforeTrees![0]!.commit).not.toBe(target.beforeTrees![0]!.commit)
  collect(saved)
  await history.close()
  const restarted = await reopen(test)
  await restarted.prune()
  const durable = test.state()
  assertPairs(durable); assertCanonical(durable)
  expect(staging(durable)).toEqual([])
  collect(durable)
  const store = createGitStore({ directory: test.directory, allowed: () => true })
  const record = durable.checkpoints.find(row => row.id === target.id)!
  const content = await store.restoreContent({ trees: record.beforeTrees!, target: baseline, paths: [test.file] })
  expect([...content.values()].map(value => value.toString())).toContain('owner baseline\r\n')
  // Interrupted, it records no after state, so no restore runs through it.
  await expect(restarted.restore(target.id)).rejects.toMatchObject({ code: 'RESTORE_REFUSED' })
})

it('normalizes degraded after-only captures without inventing a before parent', async () => {
  const { test, state } = await seedLegacy()
  const target = state.checkpoints[1]!
  target.beforeTrees = []; target.baselineAvailable = false; target.restorable = false; target.before = {}
  saveState(test, state)
  const history = await reopen(test)
  await history.prune()
  assertPairs(test.state()); assertCanonical(test.state())
  expect(test.records()[1]!.restorable).toBe(false)
  expect(staging(test.state())).toEqual([])
})

it('retains recovered non-Git records whose legacy ID is not a Git reference name', async () => {
  const test = await fixture()
  await test.write('first', 'first')
  const state = test.state()
  const legacy = structuredClone(state.checkpoints[0]!)
  legacy.id = 'legacy-1'; legacy.turnId = 'legacy-turn'; legacy.status = 'interrupted'; legacy.restorable = false
  delete legacy.beforeTrees; delete legacy.afterTrees
  state.checkpoints.unshift(legacy); saveState(test, state)
  await expect(test.history.prune()).resolves.toEqual({ ok: true })
  await test.write('second', 'second')
  expect(test.records().find(record => record.id === 'legacy-1')).toMatchObject({ restorable: false, status: 'interrupted' })
  expect(test.records().at(-1)).toMatchObject({ status: 'complete', restorable: true })
})

it('rechecks new legacy commit IDs after this process already inspected an isolated graph', async () => {
  const test = await fixture()
  await test.write('first', 'first')
  await test.write('second', 'second')
  await test.history.prune()
  legacyGraph(test)
  await test.history.prune()
  assertPairs(test.state()); assertCanonical(test.state())
  expect(staging(test.state())).toEqual([])
})

it('retries failed ref cleanup immediately after expired records were durably dropped', async () => {
  const test = await fixture(2)
  await test.write('first', 'first')
  await test.write('second', 'second')
  const expired = test.records()[0]!
  const reference = `refs/buckle/checkpoints/${expired.id}`
  const state = test.state(); state.lastGcAt = Date.now(); saveState(test, state)
  gitFault.refReads = 1
  await test.write('third', 'third')
  expect(gitFault.refReads).toBe(0)
  expect(test.records().map(record => record.id)).not.toContain(expired.id)
  expect(test.git('for-each-ref', '--format=%(refname)', reference)).toBe(reference)
  await test.history.prune()
  expect(test.git('for-each-ref', '--format=%(refname)', reference)).toBe('')
  assertCanonical(test.state())
})
