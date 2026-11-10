import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { blobId, openObjectStore } from '../common/services/history/object-store.js'

// V3 of the Codex recheck of the W fixes, and of round 3: the sweep after a command runs in the background, and a call
// that comes while it runs waits for the lock at most one short slice of it, however many objects and temporaries the
// store holds: it reads what to keep and lists what to remove without the lock, and removes in slices that take the lock
// briefly, check with a few stats that nothing changed, and remove for 25 ms, so a hold runs past that by one removal at most.

interface SweepHold { startedAt: number; immediate: boolean }
interface Removal { start: number; end: number; path: string; hold: SweepHold | undefined }

const holds = vi.hoisted(() => ({ list: [] as SweepHold[], active: undefined as SweepHold | undefined }))
vi.mock('../common/services/history/execution-lock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/execution-lock.js')>()
  const withHistoryLock: typeof actual.withHistoryLock = (input, operation) => {
    const startedAt = performance.now()
    return actual.withHistoryLock(input, async () => {
      const hold: SweepHold = { startedAt, immediate: input.deadlineMs === 0 }
      const previous = holds.active
      holds.active = hold
      try { return await operation() } finally { holds.active = previous; holds.list.push(hold) }
    })
  }
  return { ...actual, withHistoryLock }
})
/** Each removal of a file: when it started and ended, so each hold is bounded by the one removal it may run past its slice. */
const removals = vi.hoisted(() => ({ list: [] as Removal[], clock: undefined as number | undefined, stepMs: 0, tracked: new Set<string>() }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const rmSync = ((...args: Parameters<typeof actual.rmSync>) => {
    const hold = holds.active
    const path = String(args[0]).replace(/\\/g, '/')
    const start = performance.now()
    try { actual.rmSync(...args) } finally {
      if (removals.clock !== undefined && hold?.immediate && removals.tracked.has(path)) removals.clock += removals.stepMs
      removals.list.push({ start, end: performance.now(), path, hold })
    }
  }) as typeof actual.rmSync
  return { ...actual, rmSync, default: { ...actual, rmSync } }
})

/**
 * U1 of the Codex recheck of round 4: what a sweep's plan runs as it reads what to keep. `root` runs once the plan has
 * named the command roots and before it reads their identity; `record` once it has read the markers and found none live,
 * before it lists the store. Each runs once, from `armed`.
 */
const race = vi.hoisted(() => ({ stage: 'off' as 'off' | 'armed' | 'root' | 'done', root: undefined as (() => void) | undefined, record: undefined as (() => void) | undefined }))
vi.mock('../common/services/history/command-capture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/command-capture.js')>()
  const createCommandCapture: typeof actual.createCommandCapture = input => {
    const capture = actual.createCommandCapture(input)
    return {
      ...capture,
      indexPaths: () => { const paths = capture.indexPaths(); if (race.stage === 'armed') { race.stage = 'root'; race.root?.() } return paths },
      warming: () => { const warming = capture.warming(); if (race.stage === 'root' && !warming) { race.stage = 'done'; race.record?.() } return warming },
    }
  }
  return { ...actual, createCommandCapture }
})

const SLICE_MS = 25

const roots: string[] = []
afterEach(() => { holds.list = []; holds.active = undefined; removals.list = []; removals.clock = undefined; removals.stepMs = 0; removals.tracked.clear(); race.stage = 'off'; race.root = undefined; race.record = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function plannedRemovals(hold: SweepHold, directory: string): Removal[] {
  return removals.list.filter(removal => removal.hold === hold && (removal.path.startsWith(directory + '/blobs/') || removal.path.startsWith(directory + '/checkpoints.json.') && removal.path.endsWith('.tmp')))
}

function expectSliceBudget(hold: SweepHold, inside: Removal[]): void {
  // A removal may finish past the budget; after that observation, only a new hold may start another.
  for (const removal of inside.slice(0, -1)) expect(removal.end - hold.startedAt, 'a further removal started after the slice budget was observed spent').toBeLessThan(SLICE_MS)
}

/**
 * `count` files nothing names in the store's fan-out folders, as a long-running node's store holds: loose objects, or the
 * temporaries stopped writes left. Each folder's are hard links to one file, which nothing reads, under NTFS's 1,024 links.
 */
function storeFiles(directory: string, count: number, kind: 'object' | 'temporary'): void {
  const store = join(directory, 'blobs')
  const seeds = new Map<string, string>()
  for (let at = 0; at < count; at++) {
    const id = createHash('sha1').update(`${kind} ${at}`).digest('hex')
    const folder = join(store, id.slice(0, 2))
    const path = join(folder, kind === 'object' ? id.slice(2) : `tmp_obj_${id.slice(2)}`)
    const seed = seeds.get(folder)
    if (seed) { linkSync(seed, path); continue }
    mkdirSync(folder, { recursive: true, mode: 0o700 }); writeFileSync(path, 'loose', { mode: 0o600 }); seeds.set(folder, path)
  }
}
/** `count` journal temporaries a stopped write left beside the journal, as hard links to one. */
function journalTemporaries(directory: string, count: number): void {
  const seed = join(directory, `checkpoints.json.${randomUUID()}.tmp`)
  writeFileSync(seed, '{}', { mode: 0o600 })
  for (let at = 1; at < count; at++) linkSync(seed, join(directory, `checkpoints.json.${randomUUID()}.tmp`))
}
function storedCount(directory: string): number {
  const store = join(directory, 'blobs')
  return readdirSync(store).filter(name => /^[0-9a-f]{2}$/.test(name) && lstatSync(join(store, name)).isDirectory()).reduce((sum, folder) => sum + readdirSync(join(store, folder)).length, 0)
}

it('never holds the execution lock past a short slice and one removal while it sweeps 20,000 stored objects and 5,000 temporaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-sweep-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'a.txt'), 'a1')
  const directory = join(root, 'history')
  const details = { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] }
  // The store's files are written just before the sweep that removes them: no margin (U1's test below has it).
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576, sweepFreshMs: 0 })
  try {
    await history.run(details, async () => 'first')
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10))
    storeFiles(directory, 20_000, 'object'); storeFiles(directory, 4_000, 'temporary'); journalTemporaries(directory, 900)
    holds.list = []; removals.list = []
    await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(join(workspace, 'a.txt'), 'a2') })
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10), { timeout: 120_000, interval: 200 })
    await vi.waitFor(() => expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]), { timeout: 10_000, interval: 100 })
    const sweep = holds.list.filter(hold => hold.immediate)
    expect(sweep.length).toBeGreaterThan(1)
    for (const hold of sweep) {
      const inside = plannedRemovals(hold, directory)
      // A slice removes for 25 ms from its start; the removal under way then may run on, however long a busy disk stalls it.
      expectSliceBudget(hold, inside)
    }
  } finally { await history.close() }
}, 180_000)

it.each<['objects' | 'temporaries' | 'mixed', number]>([
  ['objects', 25], ['objects', 40],
  ['temporaries', 25], ['temporaries', 40],
  ['mixed', 25], ['mixed', 40],
])('starts no further %s removal in a slice after a %i ms removal spends its budget', async (kind, stepMs) => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-sweep-budget-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'a.txt'), 'a1')
  const directory = join(root, 'history')
  const details = { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] }
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576, sweepFreshMs: 0 })
  const realNow = performance.now.bind(performance)
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => removals.clock ?? realNow())
  try {
    await history.run(details, async () => 'first')
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10))
    const targets: string[] = []
    const old = new Date(Date.now() - 3_600_000)
    for (let at = 0; at < 6; at++) {
      if (kind === 'objects' || kind === 'mixed' && at >= 3) {
        const path = objectPath(directory, looseObject(directory, Buffer.from('unused ' + kind + ' ' + at)))
        utimesSync(path, old, old)
        targets.push(path)
      } else {
        mkdirSync(join(directory, 'blobs', 'aa'), { recursive: true, mode: 0o700 })
        const path = at % 2 === 0 ? join(directory, 'checkpoints.json.' + randomUUID() + '.tmp') : join(directory, 'blobs', 'aa', 'tmp_obj_' + randomUUID())
        writeFileSync(path, '{}', { mode: 0o600 })
        targets.push(path)
      }
    }
    holds.list = []; removals.list = []
    removals.tracked = new Set(targets)
    removals.stepMs = stepMs
    removals.clock = Math.ceil(realNow())
    await history.run({ ...details, stageId: 'next' }, async () => { writeFileSync(join(workspace, 'a.txt'), 'a2') })
    await vi.waitFor(() => expect(targets.filter(path => existsSync(path))).toEqual([]), { timeout: 10_000 })
    const swept = removals.list.filter(removal => removals.tracked.has(removal.path))
    expect(swept).toHaveLength(targets.length)
    const slices = holds.list.filter(hold => hold.immediate && swept.some(removal => removal.hold === hold))
    for (const hold of slices) {
      const inside = plannedRemovals(hold, directory).filter(removal => removals.tracked.has(removal.path))
      expectSliceBudget(hold, inside)
      expect(inside).toHaveLength(1)
      expect(inside[0]!.end - inside[0]!.start).toBe(stepMs)
    }
    expect(slices).toHaveLength(targets.length)
  } finally {
    try { await history.close() } finally { clock.mockRestore(); removals.clock = undefined }
  }
})

function objectPath(directory: string, id: string): string { return join(directory, 'blobs', id.slice(0, 2), id.slice(2)) }
/** `content` as a loose blob, written as git writes one, at once: what a record's git add stores. */
function looseObject(directory: string, content: Buffer): string {
  const id = blobId(content)
  mkdirSync(join(directory, 'blobs', id.slice(0, 2)), { recursive: true, mode: 0o700 })
  writeFileSync(objectPath(directory, id), deflateSync(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])), { mode: 0o600 })
  return id
}

// U1 of the Codex recheck of round 4: a root made after the sweep's plan named the roots, but before it read the commands
// folder's identity, is missing from what each slice checks, and the folder reads unchanged. A record of another instance
// whose marker is made in it after the plan read the markers, and whose git writes objects before the plan lists the
// store, is invisible to every check: no sweep removes an object written, or freshened by git, since its plan began.
it('keeps the objects a background record wrote after the sweep began, its root and marker made while the sweep read what to keep (U1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-sweep-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'a.txt'), 'a1')
  const directory = join(root, 'history')
  const details = { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] }
  const store = openObjectStore(directory)
  // Objects nothing names, stored an hour ago: one the record's git writes again, and so freshens, one it does not. And
  // one stored 5 s before the sweep, within its margin, as a coarse time on disk or a clock step can leave one.
  const hour = new Date(Date.now() - 3_600_000)
  const stale = await store.put(Buffer.from('STALE')); const reused = await store.put(Buffer.from('REUSED')); const recent = await store.put(Buffer.from('RECENT'))
  for (const id of [stale, reused]) utimesSync(objectPath(directory, id), hour, hour)
  const before = new Date(Date.now() - 5_000); utimesSync(objectPath(directory, recent), before, before)
  const late = join(directory, 'commands', 'f'.repeat(24))
  let written: string[] = []
  race.root = () => { mkdirSync(late, { recursive: true, mode: 0o700 }) }
  race.record = () => {
    writeFileSync(join(late, 'warming'), JSON.stringify({ pid: process.pid, instance: 'other' }), { mode: 0o600 })
    written = ['RECORD one', 'RECORD two'].map(text => looseObject(directory, Buffer.from(text)))
    const now = new Date(); utimesSync(objectPath(directory, reused), now, now)
  }
  race.stage = 'armed'
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576 })
  try {
    await history.run(details, async () => { writeFileSync(join(workspace, 'a.txt'), 'a2') })
    // The sweep ran: what nothing names and no one wrote since goes.
    await vi.waitFor(() => expect(store.has(stale)).toBe(false), { timeout: 10_000, interval: 50 })
  } finally { await history.close() }
  expect(race.stage).toBe('done')
  expect([...written.map(id => store.has(id)), store.has(reused), store.has(recent)]).toEqual([true, true, true, true])
})
