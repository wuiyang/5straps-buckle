import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { SqliteErrorCode, withReadOnlyDatabase } from '../../src/sqlite/index.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-read-only-')); roots.push(root)
  const file = join(root, 'legacy.sqlite'); const db = new DatabaseSync(file)
  db.exec('CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'retained\')'); db.close()
  chmodSync(file, 0o640)
  return { root, file }
}
it('reads existing data without changing file bytes, permissions, or allowing writes', () => {
  const { file } = fixture(); const bytes = readFileSync(file); const mode = statSync(file).mode
  const row = withReadOnlyDatabase({ path: file, read: db => {
    expect(() => db.exec("INSERT INTO records VALUES ('forbidden')")).toThrow(/readonly|read-only/i)
    return db.prepare('SELECT value FROM records').get()
  } })
  expect(row).toEqual({ value: 'retained' })
  expect(readFileSync(file)).toEqual(bytes)
  expect(statSync(file).mode).toBe(mode)
})
it('refuses a missing database without creating its file or parent directories', () => {
  const { root } = fixture(); const parent = join(root, 'missing')
  expect(() => withReadOnlyDatabase({ path: join(parent, 'legacy.sqlite'), read: () => undefined })).toThrow(expect.objectContaining({ code: SqliteErrorCode.notRegularFile }))
  expect(existsSync(parent)).toBe(false)
})
it.skipIf(process.platform === 'win32')('refuses a symlink instead of opening its target', async () => {
  const { file, root } = fixture(); const { symlinkSync } = await import('node:fs')
  const link = join(root, 'linked.sqlite'); symlinkSync(file, link)
  expect(() => withReadOnlyDatabase({ path: link, read: () => undefined })).toThrow(expect.objectContaining({ code: SqliteErrorCode.notRegularFile }))
})
it('closes its connection while preserving a callback failure', () => {
  const { file } = fixture(); const failure = new Error('reader failed'); let captured: DatabaseSync | undefined
  expect(() => withReadOnlyDatabase({ path: file, read: db => { captured = db; throw failure } })).toThrow(failure)
  expect(captured).toBeDefined()
  expect(() => captured!.prepare('SELECT 1')).toThrow(/closed|not open/i)
})
