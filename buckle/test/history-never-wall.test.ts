import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { logger } from '../common/runtime/log.js'
import { openChangeHistory } from '../common/services/history/journal.js'

// Slice F2, item 6: no call is ever refused for a history reason. A checkpoint a stopped call left pending is marked
// interrupted, with its reason, by the next call to take the lock, and a capture that fails lets its call run and names
// its cause to the agent (the checkpoint's reason) and to the owner's log.

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-never-wall-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  return { root, workspace, directory, options: { directory, excluded: [], maxBytes: 1_000_000, allowHostGit: false } }
}

/** Puts the newest checkpoint back as pending, as a node stopped in the middle of its call leaves it. */
function leavePending(directory: string): string {
  const file = join(directory, 'checkpoints.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const newest = state.checkpoints.at(-1)
  newest.status = 'pending'; delete newest.after; delete newest.changed
  writeFileSync(file, JSON.stringify(state))
  return newest.id
}

for (const kind of ['file tool', 'command'] as const) it(`marks a ${kind} checkpoint left pending interrupted and runs the next write`, async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt')
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace], ...(kind === 'file tool' ? { scope: [{ path: file }] } : {}) }
  const first = await openChangeHistory(options)
  try { await first.run(details, async () => { writeFileSync(file, 'one') }) } finally { await first.close() }
  const stopped = leavePending(directory)
  const reopened = await openChangeHistory(options)
  try {
    await expect(reopened.run(details, async () => { writeFileSync(file, 'two') })).resolves.toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('two')
    const listed = await reopened.list()
    expect(listed.find(record => record.id === stopped)).toMatchObject({ status: 'interrupted', restorable: false, reason: expect.stringMatching(/stopped before this call finished/) })
    expect(listed.at(-1)).toMatchObject({ status: 'complete' })
  } finally { await reopened.close() }
})

it('plans a restore past a checkpoint left pending without asking the owner to recover it', async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt')
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace], scope: [{ path: file }] }
  const first = await openChangeHistory(options)
  try { await first.run(details, async () => { writeFileSync(file, 'one') }) } finally { await first.close() }
  leavePending(directory)
  const reopened = await openChangeHistory(options)
  try {
    const refusal: unknown = await reopened.plan({ steps: 1 }).catch(error => error)
    expect(refusal).toMatchObject({ code: 'RESTORE_REFUSED' })
    expect(String((refusal as Error).message)).not.toMatch(/recover/)
    expect((await reopened.list()).at(-1)).toMatchObject({ status: 'interrupted' })
  } finally { await reopened.close() }
})

it('runs a write whose files history cannot store, naming the cause to the agent and the owner log', async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt'); writeFileSync(file, 'before')
  const history = await openChangeHistory(options)
  const warn = vi.spyOn(logger, 'warn')
  try {
    mkdirSync(join(directory, 'blobs'), { recursive: true }); chmodSync(join(directory, 'blobs'), 0o500)
    await expect(history.run({ sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace], scope: [{ path: file }] }, async () => { writeFileSync(file, 'after') })).resolves.toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('after')
    const checkpoint = (await history.list()).at(-1)!
    expect(checkpoint).toMatchObject({ restorable: false, reason: expect.stringContaining('EACCES') })
    expect(checkpoint.reason).not.toContain(workspace)
    const logged = warn.mock.calls.find(([message]) => typeof message === 'string' && message.includes(checkpoint.id))
    expect(logged?.[1]).toMatchObject({ cause: { code: 'EACCES' } })
  } finally { chmodSync(join(directory, 'blobs'), 0o700); await history.close() }
})
