import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogEvent } from '../../src/index.js'
import { acquireFileLock, openDatabase, readPragma } from '../../src/sqlite/index.js'

// chmod fails with EPERM on a file another user owns or on a filesystem without modes; not reproducible unprivileged.
const refusals = vi.hoisted(() => new Map<string, string>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: (path: import('node:fs').PathLike, mode: import('node:fs').Mode) => {
      const code = refusals.get(String(path))
      if (code) throw Object.assign(new Error(`${code}: chmod '${String(path)}'`), { code })
      return actual.chmodSync(path, mode)
    },
  }
})

function capture() {
  const events: LogEvent[] = []
  const root = createLogger({ component: 'sqlite', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
  return { events, root }
}

describe('chmod failures while opening a database (ruling 7)', () => {
  it('warns and continues when the database file mode cannot be set (EPERM)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eperm-')), 'app.sqlite')
    refusals.set(path, 'EPERM')
    const { events, root } = capture()
    const db = await openDatabase({ path, logger: root.logger })
    expect(await readPragma(db, 'foreign_keys')).toBe(1)
    await root.flush()
    expect(events).toEqual([expect.objectContaining({ level: 'warn', fields: { path, mode: '600', code: 'EPERM' } })])
    await db.dispose()
  })

  it('warns and continues when a directory it created cannot be restricted (EPERM)', async () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'eperm-')), 'state')
    refusals.set(directory, 'EPERM')
    const { events, root } = capture()
    const db = await openDatabase({ path: join(directory, 'app.sqlite'), logger: root.logger })
    await root.flush()
    expect(events).toContainEqual(expect.objectContaining({ level: 'warn', fields: { path: directory, mode: '700', code: 'EPERM' } }))
    expect(statSync(directory).isDirectory()).toBe(true)
    await db.dispose()
  })

  it('still fails on any other chmod error', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eio-')), 'app.sqlite')
    refusals.set(path, 'EIO')
    await expect(openDatabase({ path })).rejects.toMatchObject({ code: 'EIO' })
  })
})

describe('a sidecar another process removes while this one opens the file', () => {
  it('opens a lock whose -journal vanished between the look and the chmod (ENOENT)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vanished-')), 'state.json.lock.sqlite')
    // The holder's -journal is seen, then its ROLLBACK deletes it before the chmod.
    writeFileSync(`${path}-journal`, '')
    refusals.set(`${path}-journal`, 'ENOENT')
    const lock = await acquireFileLock({ path, wait: 'none' })
    await lock.release()
  })
})
