import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { blobId, HistoryContentError, openObjectStore } from '../common/services/history/object-store.js'

const made: string[] = []
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function scratch(): string { const directory = mkdtempSync(join(tmpdir(), 'buckle-objects-')); made.push(directory); return directory }

// Slice F2, item 4: history keeps content as git loose blobs, written and read in-process, so neither a capture nor a
// restore needs the git binary, and no object is ever borrowed from the owner's repository (A5, D1, B9).
describe('the history object store', () => {
  it('keys content by its git blob id', () => {
    expect(blobId(Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    expect(blobId(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('writes a loose object git itself reads, and reads it back', async () => {
    const root = scratch()
    const store = openObjectStore(join(root, 'history'))
    const content = Buffer.from([0, 255, 13, 10, 1, 2, 3])
    const id = await store.put(content)
    expect(id).toBe(blobId(content))
    expect(await store.read(id)).toEqual(content)
    const file = join(root, 'history', 'blobs', id.slice(0, 2), id.slice(2))
    expect(inflateSync(readFileSync(file)).subarray(0, 7).toString()).toBe('blob 7\0')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '--quiet', repo], { env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'none') } })
    mkdirSync(join(repo, '.git', 'objects', id.slice(0, 2)), { recursive: true })
    cpSync(file, join(repo, '.git', 'objects', id.slice(0, 2), id.slice(2)))
    expect(execFileSync('git', ['cat-file', 'blob', id], { cwd: repo, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'none') } })).toEqual(content)
  })

  it('stores one copy of the same content, and counts its bytes', async () => {
    const store = openObjectStore(join(scratch(), 'history'))
    const first = await store.put(Buffer.from('same'))
    const bytes = store.bytes()
    expect(await store.put(Buffer.from('same'))).toBe(first)
    expect(store.bytes()).toBe(bytes)
    expect(store.list()).toEqual([first])
    const second = await store.put(Buffer.from('other'))
    expect(store.list().sort()).toEqual([first, second].sort())
    expect(store.bytes()).toBeGreaterThan(bytes)
    store.remove(first)
    expect(store.has(first)).toBe(false)
    expect(store.list()).toEqual([second])
  })

  it('refuses content that no longer matches its id, and forgets the damaged copy so a later capture writes it again', async () => {
    const root = scratch()
    const store = openObjectStore(join(root, 'history'))
    const id = await store.put(Buffer.from('original'))
    const file = join(root, 'history', 'blobs', id.slice(0, 2), id.slice(2))
    const other = openObjectStore(join(root, 'other'))
    const forged = await other.put(Buffer.from('forged'))
    writeFileSync(file, readFileSync(join(root, 'other', 'blobs', forged.slice(0, 2), forged.slice(2))))
    await expect(store.read(id)).rejects.toBeInstanceOf(HistoryContentError)
    expect(existsSync(file)).toBe(false)
    expect(await store.put(Buffer.from('original'))).toBe(id)
    expect((await store.read(id)).toString()).toBe('original')
    writeFileSync(file, 'not zlib')
    await expect(store.read(id)).rejects.toBeInstanceOf(HistoryContentError)
  })

  it('refuses a missing object and an id that is not one', async () => {
    const store = openObjectStore(join(scratch(), 'history'))
    await expect(store.read('0'.repeat(40))).rejects.toBeInstanceOf(HistoryContentError)
    await expect(store.read('../../etc/passwd')).rejects.toThrow('Invalid history object id')
    expect(() => store.remove('../x')).toThrow('Invalid history object id')
  })

  it('leaves no temporary file behind', async () => {
    const root = scratch()
    const store = openObjectStore(join(root, 'history'))
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.put(Buffer.from(`file ${index % 5}`))))
    const names = readdirSync(join(root, 'history', 'blobs'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)
    expect(names).toHaveLength(5)
    expect(names.every(name => /^[0-9a-f]{38}$/.test(name))).toBe(true)
  })
})
