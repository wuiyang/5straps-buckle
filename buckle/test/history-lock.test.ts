import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('lists without the execution lock and names the live holder after a bounded owner wait', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'buckle-history-lock-')); roots.push(directory)
  mkdirSync(join(directory, 'workspace'))
  const first = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000, retentionDays: 30, label: 'test-writer', lockDeadlineMs: 30 })
  const second = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000, retentionDays: 30, lockDeadlineMs: 30 })
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const running = first.exclusive(() => new Promise<void>(resolve => { release = resolve; entered() }))
  await started
  try {
    expect(await second.list()).toEqual([])
    await expect(second.prune()).rejects.toThrow(`pid ${process.pid}`)
    await expect(second.prune()).rejects.toThrow('test-writer')
    await expect(second.prune()).rejects.toThrow('--force')
  } finally { release(); await running; await first.close(); await second.close() }
})
