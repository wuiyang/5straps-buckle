import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'

// V3 of the Codex recheck of the W fixes, and of round 3: the sweep after a command runs in the background, and a call
// that comes while it runs waits for the lock at most one short slice of it, however many objects and temporaries the
// store holds: it reads what to keep and lists what to remove without the lock, and removes in slices that take the lock
// briefly, check with a few stats that nothing changed, and remove for 25 ms, so a hold runs past that by one removal at most.

/** Each time the execution lock was held: when the operation under it started and ended. */
const holds = vi.hoisted(() => ({ list: [] as Array<{ start: number; end: number }> }))
vi.mock('../common/services/history/execution-lock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/execution-lock.js')>()
  const withHistoryLock: typeof actual.withHistoryLock = (input, operation) => actual.withHistoryLock(input, async () => {
    const start = performance.now()
    try { return await operation() } finally { holds.list.push({ start, end: performance.now() }) }
  })
  return { ...actual, withHistoryLock }
})
/** Each removal of a file: when it started and ended, so each hold is bounded by the one removal it may run past its slice. */
const removals = vi.hoisted(() => ({ list: [] as Array<{ start: number; end: number }> }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const rmSync = ((...args: Parameters<typeof actual.rmSync>) => {
    const start = performance.now()
    try { actual.rmSync(...args) } finally { removals.list.push({ start, end: performance.now() }) }
  }) as typeof actual.rmSync
  return { ...actual, rmSync, default: { ...actual, rmSync } }
})

/** How long a slice removes for (SWEEP_SLICE_MS), and what a hold may take besides: its checks, and the event loop's jitter. */
const SLICE_MS = 25
const SLACK_MS = 20

const roots: string[] = []
afterEach(() => { holds.list = []; removals.list = []; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576 })
  try {
    await history.run(details, async () => 'first')
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10))
    storeFiles(directory, 20_000, 'object'); storeFiles(directory, 4_000, 'temporary'); journalTemporaries(directory, 900)
    holds.list = []; removals.list = []
    const command = { start: 0, end: 0 }
    await history.run({ ...details, stageId: 'next' }, async () => { command.start = performance.now(); writeFileSync(join(workspace, 'a.txt'), 'a2'); command.end = performance.now() })
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10), { timeout: 120_000, interval: 200 })
    await vi.waitFor(() => expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]), { timeout: 10_000, interval: 100 })
    // Every hold but the command's own, which ran under the lock from its first capture to its last.
    const sweep = holds.list.filter(hold => !(hold.start <= command.start && command.end <= hold.end))
    expect(sweep.length).toBeGreaterThan(1)
    for (const hold of sweep) {
      const inside = removals.list.filter(removal => hold.start <= removal.start && removal.end <= hold.end).map(removal => removal.end - removal.start)
      // A slice removes for 25 ms from its start; the removal under way then may run on, however long a busy disk stalls it.
      expect(hold.end - hold.start).toBeLessThan(SLICE_MS + Math.max(0, ...inside) + SLACK_MS)
    }
  } finally { await history.close() }
}, 180_000)
