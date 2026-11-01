import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { blobId } from '../common/services/history/object-store.js'
import { applySnapshot } from '../common/services/history/snapshot.js'

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => 'collision-fixture',
}))

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('does not remove an existing file when reserving a restore temporary fails', () => {
  const root = mkdtempSync('/tmp/buckle-restore-collision-'); roots.push(root)
  const path = join(root, 'file')
  const temporary = `${path}.buckle-restore-collision-fixture`
  writeFileSync(path, 'current'); chmodSync(path, 0o600)
  writeFileSync(temporary, 'owner-file')
  expect(() => applySnapshot({ current: { [path]: { kind: 'file', mode: 0o600, hash: blobId(Buffer.from('current')) } }, target: { [path]: { kind: 'file', mode: 0o600, hash: 'before' } }, paths: [path], content: () => Buffer.from('before'), roots: [root] })).toThrow('EEXIST')
  expect(readFileSync(path, 'utf8')).toBe('current')
  expect(readFileSync(temporary, 'utf8')).toBe('owner-file')
})
