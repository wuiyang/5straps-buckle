import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { changedPaths, notRestorablePaths, snapshot } from '../common/services/history/snapshot.js'

// On Windows a file another program holds open without read sharing answers the open, or a read of a locked range,
// with EBUSY. Linux has no such lock, so these tests make the open of a file named `held-open`, and the read of one named
// `locked-range`, answer EBUSY, and imitate Windows through the platform each capture takes.
const held = vi.hoisted(() => ({ descriptors: new Set<number>() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const busy = (path: unknown) => Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(path)}'`), { code: 'EBUSY' })
  const openSync = ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('held-open')) throw busy(path)
    const descriptor = (actual.openSync as (...args: unknown[]) => number)(path, ...rest)
    if (String(path).endsWith('locked-range')) held.descriptors.add(descriptor)
    return descriptor
  }) as typeof actual.openSync
  const readFileSync = ((source: unknown, ...rest: unknown[]) => {
    if (typeof source === 'number' && held.descriptors.has(source)) throw busy(source)
    return (actual.readFileSync as (...args: unknown[]) => unknown)(source, ...rest)
  }) as typeof actual.readFileSync
  const closeSync = ((descriptor: number) => { held.descriptors.delete(descriptor); actual.closeSync(descriptor) }) as typeof actual.closeSync
  const replaced = { openSync, readFileSync, closeSync }
  return { ...actual, ...replaced, default: { ...actual, ...replaced } }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'buckle-held-files-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace'))
  return { root, workspace: join(root, 'workspace') }
}

describe('a capture on Windows, imitated, beside a file another program holds open', () => {
  it('records the file as unreadable, with its mode and no content, whether the open or the read was refused', () => {
    const { workspace: ws } = workspace()
    for (const name of ['held-open', 'locked-range', 'plain']) writeFileSync(join(ws, name), name, { mode: 0o640 })
    const saved: string[] = []
    const captured = snapshot({ roots: [ws], excluded: [], maxBytes: 1_000_000, save: hash => { saved.push(hash) }, platform: 'win32' })
    expect(captured[join(ws, 'held-open')]).toEqual({ kind: 'unreadable', mode: 0o640 })
    expect(captured[join(ws, 'locked-range')]).toEqual({ kind: 'unreadable', mode: 0o640 })
    expect(captured[join(ws, 'plain')]).toMatchObject({ kind: 'file', hash: expect.any(String) })
    expect(saved).toHaveLength(1)
  })

  it('still fails the capture on Linux, where EBUSY means something else', () => {
    const { workspace: ws } = workspace()
    writeFileSync(join(ws, 'held-open'), 'x')
    expect(() => snapshot({ roots: [ws], excluded: [], maxBytes: 1_000_000, save: () => {}, platform: 'linux' })).toThrow(/EBUSY/)
  })

  it('leaves an unreadable file out of the changed paths and lists a change to it as not restorable', () => {
    const before = { '/ws': { kind: 'directory' as const, mode: 0o755 }, '/ws/a': { kind: 'file' as const, mode: 0o644, hash: 'h1' } }
    const after = { '/ws': { kind: 'directory' as const, mode: 0o755 }, '/ws/a': { kind: 'unreadable' as const, mode: 0o644 }, '/ws/b': { kind: 'unreadable' as const, mode: 0o644 } }
    expect(changedPaths(before, after)).toEqual([])
    expect(notRestorablePaths(before, after)).toEqual(['/ws/a', '/ws/b'])
  })

  it('records a write beside the held file, and refuses a restore that would remove the directory holding it', async () => {
    const { root, workspace: ws } = workspace()
    writeFileSync(join(ws, 'held-open'), 'held')
    const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30, platform: 'win32' })
    try {
      const details = { sessionId: 'held', stageId: 'stage', tool: 'fs_write', roots: [ws] }
      await history.run(details, async () => { writeFileSync(join(ws, 'notes.md'), 'notes') })
      await history.run(details, async () => { mkdirSync(join(ws, 'out')); writeFileSync(join(ws, 'out', 'held-open'), 'log') })
      const [first, second] = await history.list()
      expect(first!.paths).toEqual([join(ws, 'notes.md')])
      expect(second!.paths).toEqual([join(ws, 'out')])
      expect(second!.notRestorable).toEqual([join(ws, 'out', 'held-open')])
      await expect(history.restore(second!.id)).rejects.toThrow('Restore conflict: a directory holds a file another program held open, which history could not read')
      expect(readFileSync(join(ws, 'out', 'held-open'), 'utf8')).toBe('log')
    } finally { await history.close() }
  })
})
