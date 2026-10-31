import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it } from 'vitest'
import { openChangeHistory, STOPPED_REASON } from '../common/services/history/journal.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('marks a failed finish interrupted and permits the next write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-recovery-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const file = join(workspace, 'file'); writeFileSync(file, 'before')
  const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30 })
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace] }
  try {
    // A shadow index git cannot lock stops the after capture; the call has run all the same.
    const shadows = () => readdirSync(join(root, 'history', 'commands')).filter(name => /^[0-9a-f]{24}$/.test(name)).map(name => join(root, 'history', 'commands', name))
    await expect(history.run(details, async () => { writeFileSync(file, 'during'); for (const shadow of shadows()) chmodSync(shadow, 0o500); return 'written' })).resolves.toBe('written')
    for (const shadow of shadows()) chmodSync(shadow, 0o700)
    expect((await history.list())[0]).toMatchObject({ status: 'interrupted', restorable: false, reason: expect.stringContaining('git add') })
    await expect(history.run(details, async () => { writeFileSync(file, 'next') })).resolves.toBeUndefined()
  } finally { await history.close() }
})

it('marks a crashed checkpoint interrupted at the next write, without waiting on the owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-recovery-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000, retentionDays: 30 })
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace] }
  try {
    await history.run(details, async () => undefined)
    const id = (await history.list())[0]!.id
    const file = join(directory, 'checkpoints.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    state.checkpoints[0].status = 'pending'
    writeFileSync(file, JSON.stringify(state))
    const start = performance.now()
    await expect(history.run(details, async () => undefined)).resolves.toBeUndefined()
    expect(performance.now() - start).toBeLessThan(1000)
    expect((await history.list()).find(record => record.id === id)).toMatchObject({ status: 'interrupted', restorable: false, reason: STOPPED_REASON })
  } finally { await history.close() }
})


it('settles a pending shadow-git checkpoint a restart left as interrupted, and the next write runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-git-recovery-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const file = join(workspace, 'file'); writeFileSync(file, 'original\r\n')
  const directory = join(root, 'history')
  const options = { directory, excluded: [], maxBytes: 1_000_000 }
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace] }
  const record = await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 's', stageId: 'stage', execute: () => writeFileSync(file, 'changed before crash') })
  const id = record.id
  const journal = join(directory, 'checkpoints.json')
  const state = JSON.parse(readFileSync(journal, 'utf8'))
  expect(state.checkpoints[0].beforeTrees.length).toBeGreaterThan(0)
  state.checkpoints[0].status = 'pending'; state.checkpoints[0].before = {}
  delete state.checkpoints[0].after; delete state.checkpoints[0].afterTrees; delete state.checkpoints[0].changed
  writeFileSync(journal, JSON.stringify(state))
  const reopened = await openChangeHistory(options)
  try {
    await expect(reopened.recover(id)).resolves.toMatchObject({ id, status: 'interrupted', restorable: false, reason: STOPPED_REASON })
    await expect(reopened.run(details, async () => { writeFileSync(file, 'next write') })).resolves.toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('next write')
  } finally { await reopened.close() }
})

