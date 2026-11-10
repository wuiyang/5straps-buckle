import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readGitMetadata } from '../common/services/history/git-files.js'

const growth = vi.hoisted(() => ({ path: '', swap: '', replacement: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (growth.swap === args[0]) {
      const path = growth.swap; growth.swap = ''; fs.rmSync(path)
      if (growth.replacement === 'fifo') execFileSync('mkfifo', [path])
      else fs.symlinkSync(growth.replacement, path)
    }
    return fs.openSync(...args)
  }, fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
    const result = fs.fstatSync(...args)
    if (growth.path) { const path = growth.path; growth.path = ''; fs.writeFileSync(path, 'x'.repeat(100_000)) }
    return result
  } }
})
const roots: string[] = []
afterEach(() => { growth.path = ''; growth.swap = ''; growth.replacement = ''; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('hard-bounds a metadata read when the opened regular file grows after its size check', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-metadata-')); roots.push(root)
  const file = join(root, 'pointer'); writeFileSync(file, 'gitdir: other\n')
  growth.path = file
  expect(readGitMetadata(file)).toBeUndefined()
})
it('reads a small regular Git metadata file and rejects a directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-metadata-')); roots.push(root)
  const file = join(root, 'pointer'); writeFileSync(file, 'gitdir: other\n')
  expect(readGitMetadata(file)).toBe('gitdir: other\n')
  const directory = join(root, 'directory'); mkdirSync(directory)
  expect(readGitMetadata(directory)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('rejects a regular metadata file swapped to a FIFO before open', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-metadata-')); roots.push(root)
  const file = join(root, 'pointer'); writeFileSync(file, 'gitdir: other\n')
  growth.swap = file; growth.replacement = 'fifo'
  expect(readGitMetadata(file)).toBeUndefined()
})
it('rejects a regular metadata file swapped to a symlink before open', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-metadata-')); roots.push(root)
  const file = join(root, 'pointer'); writeFileSync(file, 'gitdir: other\n')
  const target = join(root, 'target'); writeFileSync(target, 'gitdir: private\n')
  growth.swap = file; growth.replacement = target
  expect(readGitMetadata(file)).toBeUndefined()
})
