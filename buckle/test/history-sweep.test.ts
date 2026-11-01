import { createHash } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'

// V3 of the Codex recheck of the W fixes: the sweep after a command runs in the background, and a call that comes while it
// runs waits for the lock at most one short slice of it, however many objects the store holds: it reads what to keep
// without the lock, lists the store without it, and removes in slices that take the lock briefly and check nothing changed.

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

const roots: string[] = []
afterEach(() => { holds.list = []; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** `count` loose objects nothing names, as a long-running node's store holds: hard links to one file per folder, which nothing reads. */
function looseObjects(directory: string, count: number): void {
  const store = join(directory, 'blobs')
  const seeds = new Map<string, string>()
  for (let at = 0; at < count; at++) {
    const id = createHash('sha1').update(`loose ${at}`).digest('hex')
    const folder = join(store, id.slice(0, 2))
    const path = join(folder, id.slice(2))
    const seed = seeds.get(folder)
    if (seed) { linkSync(seed, path); continue }
    mkdirSync(folder, { recursive: true, mode: 0o700 }); writeFileSync(path, 'loose', { mode: 0o600 }); seeds.set(folder, path)
  }
}
function storedCount(directory: string): number {
  const store = join(directory, 'blobs')
  return readdirSync(store).filter(name => /^[0-9a-f]{2}$/.test(name) && lstatSync(join(store, name)).isDirectory()).reduce((sum, folder) => sum + readdirSync(join(store, folder)).length, 0)
}

it('never holds the execution lock past a short slice while it sweeps 20,000 stored objects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-sweep-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'a.txt'), 'a1')
  const directory = join(root, 'history')
  const details = { sessionId: 's', stageId: 'stage', tool: 'shell_exec', roots: [workspace] }
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 64 * 1_048_576 })
  try {
    await history.run(details, async () => 'first')
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10))
    looseObjects(directory, 20_000)
    holds.list = []
    const command = { start: 0, end: 0 }
    await history.run({ ...details, stageId: 'next' }, async () => { command.start = performance.now(); writeFileSync(join(workspace, 'a.txt'), 'a2'); command.end = performance.now() })
    await vi.waitFor(() => expect(storedCount(directory)).toBeLessThan(10), { timeout: 120_000, interval: 200 })
    // Every hold but the command's own, which ran under the lock from its first capture to its last.
    const sweep = holds.list.filter(hold => !(hold.start <= command.start && command.end <= hold.end)).map(hold => hold.end - hold.start).toSorted((a, b) => a - b)
    // A slice removes for 25 ms, then lets the lock go; one removal a busy disk stalls can stretch the slice it is in.
    expect(sweep.length).toBeGreaterThan(1)
    expect(sweep[Math.floor(sweep.length / 2)]).toBeLessThan(50)
  } finally { await history.close() }
}, 180_000)
