import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { historyGitProgram } from '../common/services/history/git-store.js'
import { openChangeHistory } from '../common/services/history/journal.js'

const fault = vi.hoisted(() => ({ enabled: false, writes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (fault.enabled && String(args[0]).includes('.buckle-restore-') && ++fault.writes === 2) { fault.enabled = false; throw new Error('injected restore failure') }
    return fs.renameSync(...args)
  } }
})

const roots: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  fault.enabled = false; fault.writes = 0
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
