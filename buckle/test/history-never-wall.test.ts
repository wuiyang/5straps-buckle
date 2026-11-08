import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { logger } from '../common/runtime/log.js'
import { openChangeHistory } from '../common/services/history/journal.js'

// Slice F2, item 6: no call is ever refused for a history reason. A checkpoint a stopped call left pending is marked
// interrupted, with its reason, by the next call to take the lock, and a capture that fails lets its call run and names
// its cause to the agent (the checkpoint's reason) and to the owner's log.

const journalFault = vi.hoisted(() => ({ enabled: false }))
vi.mock('../common/adapters/replace-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return { ...actual, replaceFile: async (...args: Parameters<typeof actual.replaceFile>) => {
    if (journalFault.enabled && args[1].endsWith('checkpoints.json')) throw Object.assign(new Error('fixture journal write failed'), { code: 'ENOSPC' })
    return actual.replaceFile(...args)
  } }
})

const moveFault = vi.hoisted(() => ({ enabled: false }))
/** `stat`: the journal, or the legacy SQLite history beside it, answers its stat with EIO (X7 of the Codex recheck). */
const statFault = vi.hoisted(() => ({ names: [] as string[] }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (moveFault.enabled && String(to).includes('checkpoints.json.damaged')) throw Object.assign(new Error('fixture move failed'), { code: 'EPERM' })
    return actual.renameSync(from, to)
  }
  const statSync = ((path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) => {
    if (statFault.names.some(name => String(path).endsWith(`/${name}`))) throw Object.assign(new Error('fixture stat failed'), { code: 'EIO' })
    return actual.statSync(path, options)
  }) as typeof actual.statSync
  return { ...actual, renameSync, statSync, default: { ...actual, renameSync, statSync } }
})

const roots: string[] = []
afterEach(() => {
  journalFault.enabled = false; moveFault.enabled = false; statFault.names = []
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

it('runs a call whose checkpoint history cannot save, and names the cause in its notice and the owner log', async () => {
  const { workspace, options } = fixture()
  const file = join(workspace, 'note.txt')
  const history = await openChangeHistory(options)
  const warn = vi.spyOn(logger, 'warn')
  try {
    await history.run({ sessionId: 's', stageId: 'stage', tool: 'test', requestId: 'r-1', roots: [workspace], scope: [{ path: file }] }, async () => { writeFileSync(file, 'one') })
    journalFault.enabled = true
    await expect(history.run({ sessionId: 's', stageId: 'stage', tool: 'test', requestId: 'r-2', roots: [workspace], scope: [{ path: file }] }, async () => { writeFileSync(file, 'two'); return 'ran' })).resolves.toBe('ran')
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(history.notice('s', 'r-2')).toMatchObject({ restorable: false, reason: expect.stringContaining('ENOSPC') })
    expect(warn.mock.calls.some(([message, fields]) => String(message).includes('could not save') && JSON.stringify(fields).includes('ENOSPC'))).toBe(true)
    journalFault.enabled = false
    await expect(history.run({ sessionId: 's', stageId: 'stage', tool: 'test', requestId: 'r-3', roots: [workspace], scope: [{ path: file }] }, async () => { writeFileSync(file, 'three') })).resolves.toBeUndefined()
    expect(history.notice('s', 'r-3')).toMatchObject({ restorable: true, status: 'complete' })
  } finally { await history.close() }
})

// M1 and X7 of the Codex review of 670f1dc2..01d3b0c9: a journal that does not read or validate never walls a call. It is
// moved aside to a dated file beside it, kept for the owner, history starts a fresh one and runs the call, the owner's log
// names the cause, and the call's notice tells the agent.
const damage = {
  'malformed JSON': (file: string) => writeFileSync(file, '{"version": 2, "checkpoints": ['),
  'an invalid schema': (file: string) => writeFileSync(file, JSON.stringify({ version: 3, checkpoints: 'none' })),
  'an unreadable file': (file: string) => chmodSync(file, 0o000),
}
for (const [kind, spoil] of Object.entries(damage)) it.skipIf(kind === 'an unreadable file' && (process.platform === 'win32' || process.getuid?.() === 0))(`runs a call over a journal with ${kind}, keeping it aside for the owner`, async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt')
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace], scope: [{ path: file }] }
  const first = await openChangeHistory(options)
  try { await first.run({ ...details, requestId: 'r-1' }, async () => { writeFileSync(file, 'one') }) } finally { await first.close() }
  const journal = join(directory, 'checkpoints.json')
  spoil(journal)
  const damaged = readdirSync(directory).includes('checkpoints.json') ? statSync(journal).size : -1
  const reopened = await openChangeHistory(options)
  const warn = vi.spyOn(logger, 'warn')
  try {
    await expect(reopened.run({ ...details, requestId: 'r-2' }, async () => { writeFileSync(file, 'two'); return 'ran' })).resolves.toBe('ran')
    expect(readFileSync(file, 'utf8')).toBe('two')
    const kept = readdirSync(directory).filter(name => /^checkpoints\.json\.damaged-\d{4}-\d{2}-\d{2}T/.test(name))
    expect(kept).toHaveLength(1)
    expect(statSync(join(directory, kept[0]!)).size).toBe(damaged)
    expect((await reopened.list()).map(record => record.requestId)).toEqual(['r-2'])
    expect(reopened.notice('s', 'r-2')).toMatchObject({ restorable: true, status: 'complete', reason: expect.stringMatching(/journal/) })
    expect(warn.mock.calls.some(([message, fields]) => /journal/.test(String(message)) && typeof fields === 'object' && fields !== null && 'cause' in fields)).toBe(true)
    await expect(reopened.run({ ...details, requestId: 'r-3' }, async () => { writeFileSync(file, 'three') })).resolves.toBeUndefined()
    expect(reopened.notice('s', 'r-3')).toMatchObject({ restorable: true, reason: undefined })
  } finally { await reopened.close() }
})

it('runs a call over a damaged journal it cannot move aside, and never writes over that journal', async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt')
  const journal = join(directory, 'checkpoints.json')
  const history = await openChangeHistory(options)
  try {
    writeFileSync(journal, '{"damaged":')
    moveFault.enabled = true
    await expect(history.run({ sessionId: 's', stageId: 'stage', tool: 'test', requestId: 'r-1', roots: [workspace], scope: [{ path: file }] }, async () => { writeFileSync(file, 'one'); return 'ran' })).resolves.toBe('ran')
    expect(readFileSync(file, 'utf8')).toBe('one')
    expect(readFileSync(journal, 'utf8')).toBe('{"damaged":')
    expect(history.notice('s', 'r-1')).toMatchObject({ restorable: false, reason: expect.stringContaining('EPERM') })
  } finally { await history.close() }
})

// X7 and M1 of the Codex recheck: a journal whose file cannot even be looked at, its stat failing, never walls a call
// either: the invoker's start of the call, the call, and its notice all run, and nothing writes over that journal.
for (const name of ['checkpoints.json', 'history.sqlite']) it(`starts, runs, and notes a call while ${name} answers its stat with EIO`, async () => {
  const { workspace, directory, options } = fixture()
  const file = join(workspace, 'note.txt')
  const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace], scope: [{ path: file }] }
  const history = await openChangeHistory(options)
  try {
    await history.run({ ...details, requestId: 'r-0' }, async () => { writeFileSync(file, 'zero') })
    const journal = join(directory, 'checkpoints.json')
    const saved = readFileSync(journal, 'utf8')
    statFault.names = [name]
    const turn = history.startCall({ sessionId: 's' }, 'stage')
    await expect(history.run({ ...details, requestId: 'r-1' }, async () => { writeFileSync(file, 'one'); return 'ran' })).resolves.toBe('ran')
    history.finishCall({ sessionId: 's' }, 'stage', turn)
    expect(readFileSync(file, 'utf8')).toBe('one')
    if (name === 'checkpoints.json') {
      expect(history.notice('s', 'r-1')).toMatchObject({ restorable: false, reason: expect.stringContaining('EIO') })
      await expect(history.list()).resolves.toEqual([])
    } else expect((await history.list()).map(record => record.requestId)).toEqual(['r-0', 'r-1'])
    statFault.names = []
    if (name === 'checkpoints.json') expect(readFileSync(journal, 'utf8')).toBe(saved)
  } finally { await history.close() }
})
