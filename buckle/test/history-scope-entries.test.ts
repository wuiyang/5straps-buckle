import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blobId, openObjectStore } from '../common/services/history/object-store.js'
import { captureScope, missingParents } from '../common/services/history/scoped-capture.js'

// Slice F2, item 1: what a file tool's checkpoint records of each path it names, read from the disk alone. No entry
// refuses the capture: what history cannot keep is recorded without content, with its reason.

const made: string[] = []
afterEach(() => { for (const directory of made.splice(0)) { try { chmodSync(directory, 0o700) } catch { /* gone */ } rmSync(directory, { recursive: true, force: true }) } })
function scratch(): string { const directory = mkdtempSync(join(tmpdir(), 'buckle-scope-')); made.push(directory); return directory }
const limits = { maxFileBytes: 1_000, maxTreeBytes: 10_000, excluded: [] as string[] }
const posix = process.platform !== 'win32'

describe('a scoped capture', () => {
  it('records a file, a link as a link, a folder by itself, and nothing for an absent path', async () => {
    const root = scratch()
    writeFileSync(join(root, 'file.txt'), 'content')
    symlinkSync(join(root, 'elsewhere'), join(root, 'link'))
    mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder', 'inside.txt'), 'inside')
    const store = openObjectStore(join(scratch(), 'history'))
    const captured = await captureScope({ ...limits, store, scope: [{ path: join(root, 'file.txt') }, { path: join(root, 'link') }, { path: join(root, 'folder') }, { path: join(root, 'absent') }] })
    expect(captured).toEqual({
      [join(root, 'file.txt')]: { kind: 'file', mode: expect.any(Number), hash: blobId(Buffer.from('content')) },
      [join(root, 'link')]: { kind: 'symlink', mode: expect.any(Number), target: join(root, 'elsewhere') },
      [join(root, 'folder')]: { kind: 'directory', mode: expect.any(Number) },
    })
    expect((await store.read(blobId(Buffer.from('content')))).toString()).toBe('content')
  })

  it('hashes without storing where no store is given, as a restore reads the current state', async () => {
    const root = scratch()
    writeFileSync(join(root, 'file.txt'), 'content')
    expect(await captureScope({ ...limits, scope: [{ path: join(root, 'file.txt') }] })).toEqual({ [join(root, 'file.txt')]: { kind: 'file', mode: expect.any(Number), hash: blobId(Buffer.from('content')) } })
  })

  it('records a folder tree past its entry or byte bound as that folder alone, reason limit', async () => {
    const root = scratch()
    mkdirSync(join(root, 'many'))
    for (let index = 0; index < 6; index++) writeFileSync(join(root, 'many', `${index}.txt`), 'x'.repeat(500))
    const many = join(root, 'many')
    expect(await captureScope({ ...limits, maxTreeEntries: 5, scope: [{ path: many, tree: true }] })).toEqual({ [many]: { kind: 'excluded', mode: expect.any(Number), reason: 'limit' } })
    expect(await captureScope({ ...limits, maxTreeBytes: 2_000, scope: [{ path: many, tree: true }] })).toEqual({ [many]: { kind: 'excluded', mode: expect.any(Number), reason: 'limit' } })
    expect(Object.keys(await captureScope({ ...limits, scope: [{ path: many, tree: true }] }))).toHaveLength(7)
  })

  it('records an oversized file by its size and mtime, never its content', async () => {
    const root = scratch()
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(1_001))
    expect(await captureScope({ ...limits, scope: [{ path: join(root, 'big.bin') }] })).toEqual({ [join(root, 'big.bin')]: { kind: 'excluded', mode: expect.any(Number), size: 1_001, mtime: statSync(join(root, 'big.bin')).mtimeMs, reason: 'size' } })
  })

  it.runIf(posix)('records a FIFO, an unreadable file, and a folder it cannot list without refusing the capture', async () => {
    const root = scratch()
    mkdirSync(join(root, 'tree'))
    execFileSync('mkfifo', [join(root, 'tree', 'pipe')])
    writeFileSync(join(root, 'tree', 'locked.txt'), 'secret-free'); chmodSync(join(root, 'tree', 'locked.txt'), 0o000)
    mkdirSync(join(root, 'tree', 'closed')); writeFileSync(join(root, 'tree', 'closed', 'hidden.txt'), 'hidden'); chmodSync(join(root, 'tree', 'closed'), 0o000)
    writeFileSync(join(root, 'tree', 'back\\slash'), 'misnamed')
    const captured = await captureScope({ ...limits, scope: [{ path: join(root, 'tree'), tree: true }] })
    chmodSync(join(root, 'tree', 'closed'), 0o700)
    expect(captured[join(root, 'tree', 'pipe')]).toMatchObject({ kind: 'excluded', reason: 'special' })
    if (process.getuid?.() !== 0) {
      expect(captured[join(root, 'tree', 'locked.txt')]).toMatchObject({ kind: 'unreadable' })
      expect(captured[join(root, 'tree', 'closed')]).toMatchObject({ kind: 'unreadable' })
      expect(captured[join(root, 'tree', 'closed', 'hidden.txt')]).toBeUndefined()
    }
    expect(captured[`${join(root, 'tree')}/back\\slash`]).toMatchObject({ kind: 'excluded' })
  })

  it('names the folders a write would make, nearest first, and none where its folder stands', () => {
    const root = scratch()
    expect(missingParents(join(root, 'a', 'b', 'c.txt'))).toEqual([join(root, 'a', 'b'), join(root, 'a')])
    expect(missingParents(join(root, 'c.txt'))).toEqual([])
  })

  it('records nothing inside Buckle\'s own state', async () => {
    const root = scratch()
    mkdirSync(join(root, 'tree', 'state'), { recursive: true })
    writeFileSync(join(root, 'tree', 'state', 'token'), 'node state')
    writeFileSync(join(root, 'tree', 'kept.txt'), 'kept')
    const captured = await captureScope({ ...limits, excluded: [join(root, 'tree', 'state')], scope: [{ path: join(root, 'tree'), tree: true }, { path: join(root, 'tree', 'state', 'token') }] })
    expect(Object.keys(captured).sort()).toEqual([join(root, 'tree'), join(root, 'tree', 'kept.txt')])
  })
})
