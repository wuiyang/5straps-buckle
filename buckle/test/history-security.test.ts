import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { historyGitProgram } from '../common/services/history/git-store.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { blobId } from '../common/services/history/object-store.js'
import { applySnapshot, SnapshotConflictError } from '../common/services/history/snapshot.js'

// `appear`: where the volume makes no hard link, an outside writer makes that file just as the restore puts its own there (R1.1).
// `failWrite`: the write into the file a restore creates exclusively at that path fails; with `other`, another writer then
// puts its own file at that name the moment the cleanup next reaches it, to look at it or to take it (`replace`, R2.1).
const fault = vi.hoisted(() => ({ enabled: false, writes: 0, noLink: false, appear: undefined as string | undefined, failWrite: undefined as { path: string; other: boolean } | undefined, failing: undefined as number | undefined, replace: undefined as string | undefined }))
// A restored file is put in place by a hard link, or a rename where the volume makes none: either fails on the second.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const placed = (from: unknown) => { if (fault.enabled && String(from).includes('.buckle-restore-') && ++fault.writes === 2) { fault.enabled = false; throw new Error('injected restore failure') } }
  const outside = (to: unknown) => {
    const path = fault.appear
    if (path === undefined || String(to).includes('.buckle-') || !String(to).endsWith(`/${path.split('/').at(-1)}`)) return
    fault.appear = undefined; fs.writeFileSync(path, 'outside')
  }
  const named = (path: unknown, at: string) => !String(path).includes('.buckle-') && String(path).endsWith(`/${at.split('/').at(-1)}`)
  const replaced = (path: unknown) => {
    const at = fault.replace
    if (at === undefined || !named(path, at)) return
    fault.replace = undefined; fs.writeFileSync(`${at}.other`, 'outside'); fs.renameSync(`${at}.other`, at)
  }
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { placed(args[0]); replaced(args[0]); if (String(args[0]).includes('.buckle-')) outside(args[1]); return fs.renameSync(...args) },
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => { const found = fs.lstatSync(...args); replaced(args[0]); return found }) as typeof fs.lstatSync,
    symlinkSync: (...args: Parameters<typeof fs.symlinkSync>) => { outside(args[1]); return fs.symlinkSync(...args) },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[1] === 'number' && (args[1] & fs.constants.O_EXCL)) outside(args[0])
      const descriptor = fs.openSync(...args)
      if (fault.failWrite && typeof args[1] === 'number' && (args[1] & fs.constants.O_EXCL) && named(args[0], fault.failWrite.path)) fault.failing = descriptor
      return descriptor
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.failing === undefined || args[0] !== fault.failing) return fs.writeFileSync(...args)
      if (fault.failWrite?.other) fault.replace = fault.failWrite.path
      fault.failing = undefined; fault.failWrite = undefined
      throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' })
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      placed(args[0])
      if (String(args[0]).includes('.buckle-displaced-')) outside(args[1])
      if (fault.noLink && String(args[0]).includes('.buckle-')) throw Object.assign(new Error('fixture volume makes no hard link'), { code: 'EPERM' })
      return fs.linkSync(...args)
    },
  }
})

const roots: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  fault.enabled = false; fault.writes = 0; fault.noLink = false; fault.appear = undefined; fault.failWrite = undefined; fault.failing = undefined; fault.replace = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture(extra: Parameters<typeof openChangeHistory>[0] extends infer T ? Partial<T> : never = {}) {
  const root = mkdtempSync(join(tmpdir(), 'history-security-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 256 * 1048576, ...extra })
  return { root, workspace, directory, history, details: { sessionId: 's', tool: 'test', roots: [workspace] } }
}

it('refuses git in another workspace and records hashes without executing it', async () => {
  const node = await fixture()
  const other = join(node.root, 'other-workspace'); mkdirSync(other)
  const marker = join(node.root, 'executed')
  const fakeGit = join(other, 'git'); writeFileSync(fakeGit, `#!/bin/sh\necho ran > "${marker}"\n`); chmodSync(fakeGit, 0o755)
  process.env.PATH = other
  const untrusted = { untrustedRoots: [{ kind: 'workspace' as const, path: other }] }
  try {
    expect(historyGitProgram({ allowed: true, roots: [node.workspace], untrusted })).toBeNull()
    const separate = await openChangeHistory({ directory: join(node.root, 'separate-history'), excluded: [], maxBytes: 256 * 1048576, untrusted: () => untrusted })
    try {
      await separate.run(node.details, async () => { writeFileSync(join(node.workspace, 'file'), 'changed') })
      expect((await separate.list())[0]).toMatchObject({ restorable: false, reason: expect.stringContaining('trusted host git') })
      expect(existsSync(marker)).toBe(false)
    } finally { await separate.close() }
  } finally { await node.history.close() }
})

// Slice F2, item 4: a restore reads history's own object store, so it needs no git; a command needs git to be recorded.
it('stops using git when host git is disabled on an open history, and still restores', async () => {
  const node = await fixture()
  const file = join(node.workspace, 'file'); writeFileSync(file, 'before')
  try {
    await node.history.run(node.details, async () => { writeFileSync(file, 'first') })
    const first = (await node.history.list())[0]!
    node.history.configure({ allowHostGit: false })
    process.env.PATH = join(node.root, 'no-programs')
    await node.history.restore(first.id)
    expect(readFileSync(file, 'utf8')).toBe('before')
    await node.history.run(node.details, async () => { writeFileSync(file, 'second') })
    expect((await node.history.list()).at(-1)).toMatchObject({ restorable: false, reason: expect.stringContaining('host git') })
    expect(readFileSync(file, 'utf8')).toBe('second')
  } finally { await node.history.close() }
})

it.skipIf(process.platform === 'win32')('does not block on FIFO .git or commondir metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'history-fifo-')); roots.push(root)
  for (const marker of ['.git', 'commondir']) {
    const workspace = join(root, `workspace-${marker.replace('.', '')}`); mkdirSync(workspace)
    if (marker === 'commondir') mkdirSync(join(workspace, '.git'))
    execFileSync('mkfifo', [marker === '.git' ? join(workspace, '.git') : join(workspace, '.git', 'commondir')])
    const directory = join(root, `history-${marker.replace('.', '')}`)
    const moduleUrl = new URL('../common/services/history/journal.ts', import.meta.url).href
    const metadataUrl = new URL('../common/services/history/git-store.ts', import.meta.url).href
    const metadata = marker === '.git' ? join(workspace, '.git') : join(workspace, '.git', 'commondir')
    const source = `const { readGitMetadata } = await import(${JSON.stringify(metadataUrl)}); if (readGitMetadata(${JSON.stringify(metadata)}) !== undefined) throw new Error('Special metadata was read'); const { openChangeHistory } = await import(${JSON.stringify(moduleUrl)}); const history = await openChangeHistory({ directory: process.argv[1], excluded: [], maxBytes: 268435456 }); try { await history.run({sessionId:'s',tool:'test',roots:[process.argv[2]]}, async () => { (await import('node:fs')).writeFileSync(process.argv[2] + '/file', 'done') }); } finally { await history.close() }`
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source, directory, workspace], { detached: true, stdio: 'ignore' })
      const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(new Error('FIFO history capture timed out')) }, 10_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`FIFO child exited ${code}`)) })
    })
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('done')
  }
})

it('retains an interrupted checkpoint after a restore fails following its first write', async () => {
  const node = await fixture()
  const a = join(node.workspace, 'a'); const b = join(node.workspace, 'b')
  writeFileSync(a, 'before-a'); writeFileSync(b, 'before-b')
  try {
    await node.history.run(node.details, async () => { writeFileSync(a, 'after-a'); writeFileSync(b, 'after-b') })
    const original = (await node.history.list())[0]!
    fault.enabled = true
    await expect(node.history.restore(original.id)).rejects.toThrow('Restore stopped')
    expect(fault.writes).toBe(2)
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['before-a', 'after-b'])
    expect((await node.history.list()).at(-1)).toMatchObject({ status: 'interrupted', restores: original.id, reason: expect.stringContaining('some paths may have changed') })
  } finally { await node.history.close() }
})

// X2: a restored file is put in place by a hard link, which never replaces an entry; a volume that makes none renames.
it('restores on a volume that makes no hard link', async () => {
  const node = await fixture()
  const a = join(node.workspace, 'a'); writeFileSync(a, 'before-a')
  try {
    await node.history.run({ ...node.details, scope: [{ path: a }] }, async () => { writeFileSync(a, 'after-a') })
    fault.noLink = true
    await node.history.restore((await node.history.list())[0]!.id)
    expect(readFileSync(a, 'utf8')).toBe('before-a')
  } finally { await node.history.close() }
})

// R1.1 of the Codex recheck: where the volume makes no hard link, a file is put in place by creating its name, which fails
// where another writer made one since, never by a rename, which would write over it.
it('never writes over a file another writer makes as the restore puts one back on a volume that makes no hard link', async () => {
  const node = await fixture()
  const a = join(node.workspace, 'a')
  try {
    await node.history.run({ ...node.details, scope: [{ path: a }] }, async () => { writeFileSync(a, 'before-a') })
    await node.history.run({ ...node.details, scope: [{ path: a }] }, async () => { rmSync(a) })
    fault.noLink = true; fault.appear = a
    await expect(node.history.restore((await node.history.list()).at(-1)!.id)).rejects.toThrow()
    expect(fault.appear).toBeUndefined()
    expect(readFileSync(a, 'utf8')).toBe('outside')
  } finally { await node.history.close() }
})

// The same for an entry a refused restore had moved aside: it goes back only where its name is still free as it is made.
it('keeps an entry moved aside, never writing it over a file another writer makes as a refused restore puts it back', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-put-back-')); roots.push(root)
  const [first, second] = [join(root, 'first.txt'), join(root, 'second.txt')]
  writeFileSync(first, 'checked'); writeFileSync(second, 'edited outside')
  const entry = { kind: 'file' as const, mode: 0o644, hash: blobId(Buffer.from('checked')) }
  fault.appear = first
  expect(() => applySnapshot({ current: { [first]: entry, [second]: entry }, target: {}, paths: [first, second], content: () => Buffer.alloc(0), roots: [root] })).toThrow(SnapshotConflictError)
  expect(fault.appear).toBeUndefined()
  expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['outside', 'edited outside'])
  const aside = readdirSync(root).filter(name => name.includes('.buckle-displaced-'))
  expect(aside.map(name => readFileSync(join(root, name), 'utf8'))).toEqual(['checked'])
})

// R2.1 of the Codex recheck: where the volume makes no hard link and a restored file's write fails, the cleanup removes the
// file it made and nothing else, never one another writer put at that name as the cleanup reached it.
for (const other of [true, false]) it(`removes only the file it made as a failed restore write is cleaned up${other ? ', never one another writer puts there' : ''}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'history-cleanup-')); roots.push(root)
  const a = join(root, 'a')
  fault.noLink = true; fault.failWrite = { path: a, other }
  const target = { [a]: { kind: 'file' as const, mode: 0o644, hash: blobId(Buffer.from('restored')) } }
  expect(() => applySnapshot({ current: {}, target, paths: [a], content: () => Buffer.from('restored'), roots: [root] })).toThrow('injected write failure')
  expect([fault.failWrite, fault.replace]).toEqual([undefined, undefined])
  expect(existsSync(a) ? readFileSync(a, 'utf8') : null).toBe(other ? 'outside' : null)
  expect(readdirSync(root).filter(name => name.includes('.buckle-') || name.endsWith('.other'))).toEqual([])
})

// Slice F2, items 3 and 6: the hard link and the FIFO never refuse the call; git records the write.
it.skipIf(process.platform === 'win32')('records a write beside a hard link and a FIFO', async () => {
  const node = await fixture()
  writeFileSync(join(node.root, 'outside'), 'shared')
  execFileSync('mkfifo', [join(node.workspace, 'a-pipe')])
  linkSync(join(node.root, 'outside'), join(node.workspace, 'z-linked.js'))
  try {
    await expect(node.history.run(node.details, async () => { writeFileSync(join(node.workspace, 'note'), 'runs') })).resolves.toBeUndefined()
    expect(existsSync(join(node.workspace, 'note'))).toBe(true)
    expect((await node.history.list()).at(-1)).toMatchObject({ restorable: true, paths: [join(node.workspace, 'note')] })
  } finally { await node.history.close() }
})
