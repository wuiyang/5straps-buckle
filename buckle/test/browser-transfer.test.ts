import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import { MAX_TRANSFER_BYTES, prepareTransfer } from '../common/services/packs/browser/file-transfer.js'
import { writeFileEntry } from '../common/services/packs/fs/operations.js'
import { writeInput } from '../common/services/packs/fs/schemas.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'

// Review L4 of the second proof-of-possession re-review: browser transfer copies were synchronous and
// unbounded (512 MiB staged in full blocked the node), the call's timeout could not stop one, and a node
// killed mid-call left its transfer directory in Buckle's state.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-transfer-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const session = join(root, 'session')
  mkdirSync(workspace)
  mkdirSync(session, { mode: 0o700 })
  return { root, workspace, session, paths: createPathView({ root: workspace, mount: null }) }
}

const transfers = (session: string) => readdirSync(session).filter(name => name.startsWith('transfer-'))

async function browser(input: { workspace: string; session: string; args: JsonObject; run?: (request: ProcessRequest) => void; options?: Partial<BrowserPackOptions> }) {
  const pack = createBrowserPack({
    cwd: input.workspace, paths: createPathView({ root: input.workspace, mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: input.session,
    headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser', args: [] }, approvedLists: [],
    runProcess: async (request): Promise<ProcessResult> => {
      input.run?.(request)
      return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false }
    },
    ...input.options,
  })
  return pack.tools[0]!.prepare(input.args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1_000, signal: new AbortController().signal })
}

describe('a browser file transfer', () => {
  it('refuses an upload larger than the cap, naming it, and stages nothing', async () => {
    const { workspace, session } = fixture()
    writeFileSync(join(workspace, 'big.bin'), '')
    truncateSync(join(workspace, 'big.bin'), MAX_TRANSFER_BYTES + 1)
    let ran = false
    await expect(browser({ workspace, session, args: { command: 'upload', args: ['#file', 'big.bin'] }, run: () => { ran = true } })).rejects.toThrow('big.bin is larger than the 100 MiB a browser command transfers')
    expect(ran).toBe(false)
    expect(transfers(session)).toEqual([])
  })

  it('refuses to deliver a screenshot larger than the cap, and writes nothing to its target', async () => {
    const { workspace, session } = fixture()
    const run = (request: ProcessRequest) => {
      const staged = request.args[1]!
      writeFileSync(staged, '')
      truncateSync(staged, MAX_TRANSFER_BYTES + 1)
    }
    await expect(browser({ workspace, session, args: { command: 'screenshot', args: ['shot.png'] }, run })).rejects.toThrow('shot.png is larger than the 100 MiB')
    expect(existsSync(join(workspace, 'shot.png'))).toBe(false)
    expect(transfers(session)).toEqual([])
  })

  it('stops a copy when the call\'s signal fires, and leaves no transfer directory', async () => {
    const { workspace, session, paths } = fixture()
    writeFileSync(join(workspace, 'large.bin'), '')
    truncateSync(join(workspace, 'large.bin'), 64 * 1_048_576)
    const stop = new AbortController()
    setImmediate(() => stop.abort(new Error('the call timed out')))
    await expect(prepareTransfer({ directory: session, paths, reads: ['large.bin'], writes: [], context: { signal: stop.signal }, protectedRoots: [], staleAfterMs: 600_000 })).rejects.toThrow('the call timed out')
    expect(transfers(session)).toEqual([])
  })

  // On the owner's live node an HTTP client gave up while the call waited for an approval: the target was created and
  // truncated before the abort was seen, and an empty screenshot was left in the workspace.
  it('creates nothing when the call\'s signal fired before the delivery', async () => {
    const { workspace, session } = fixture()
    const stop = new AbortController()
    const run = (request: ProcessRequest) => { writeFileSync(request.args[1]!, 'png bytes'); stop.abort(new Error('the caller went away')) }
    const pack = createBrowserPack({
      cwd: workspace, paths: createPathView({ root: workspace, mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: session, headed: false,
      agentBrowser: { path: 'agent-browser', argv0: 'agent-browser', args: [] }, approvedLists: [],
      runProcess: async (request): Promise<ProcessResult> => { run(request); return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false } },
    })
    await expect(pack.tools[0]!.prepare({ command: 'screenshot', args: ['shots/probe.png'] }).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1_000, signal: stop.signal })).rejects.toThrow('the caller went away')
    expect(readdirSync(workspace)).toEqual([])
    expect(transfers(session)).toEqual([])
  })

  it('leaves no partial file and the earlier target untouched when the signal fires mid-copy', async () => {
    const { workspace, session, paths } = fixture()
    writeFileSync(join(workspace, 'shot.png'), 'earlier')
    chmodSync(join(workspace, 'shot.png'), 0o640)
    const stop = new AbortController()
    const transfer = await prepareTransfer({ directory: session, paths, reads: [], writes: ['shot.png'], context: { signal: stop.signal }, protectedRoots: [], staleAfterMs: 600_000 })
    const staged = transfer.argument('shot.png')!
    writeFileSync(staged, '')
    truncateSync(staged, 96 * 1_048_576)
    const partials = () => readdirSync(workspace).filter(name => name.startsWith('.buckle-delivery-'))
    let partialMode: number | null = null
    const watch = setInterval(() => {
      const [partial] = partials()
      if (partial === undefined || partialMode !== null) return
      partialMode = statSync(join(workspace, partial)).mode & 0o777
      stop.abort(new Error('the caller went away'))
    }, 0)
    try {
      await expect(transfer.deliver()).rejects.toThrow('the caller went away')
    } finally { clearInterval(watch); transfer.close() }
    // While it is copied it has the mode of the file it replaces, as fs_write writes into that file in place.
    expect(partialMode).toBe(0o640)
    expect(partials()).toEqual([])
    expect(readFileSync(join(workspace, 'shot.png'), 'utf8')).toBe('earlier')
  })

  // Re-check of 2026-10-14: a new file's mode worked out from the umask missed a folder's default ACL; it is now the
  // mode the kernel gives, compared with what fs_write itself makes in the same folder.
  it('replaces the target only once the copy is whole, keeping the target\'s mode, and gives a new one fs_write\'s', async () => {
    const { workspace, session, paths } = fixture()
    writeFileSync(join(workspace, 'shot.png'), 'earlier')
    chmodSync(join(workspace, 'shot.png'), 0o640)
    const transfer = await prepareTransfer({ directory: session, paths, reads: [], writes: ['shot.png', 'new.png'], context: { signal: new AbortController().signal }, protectedRoots: [], staleAfterMs: 600_000 })
    writeFileSync(transfer.argument('shot.png')!, 'later')
    writeFileSync(transfer.argument('new.png')!, 'fresh')
    try { await transfer.deliver() } finally { transfer.close() }
    expect(readFileSync(join(workspace, 'shot.png'), 'utf8')).toBe('later')
    expect(statSync(join(workspace, 'shot.png')).mode & 0o777).toBe(0o640)
    await writeFileEntry(writeInput.parse({ path: 'reference.txt', content: 'fs_write' }), { paths })
    expect(statSync(join(workspace, 'new.png')).mode & 0o777).toBe(statSync(join(workspace, 'reference.txt')).mode & 0o777)
    expect(readdirSync(workspace).sort()).toEqual(['new.png', 'reference.txt', 'shot.png'])
  })

  // The re-check's case: a folder whose default ACL decides a new file's mode, which a mode worked out from the umask
  // missed. The ACL gives the group rwx and others nothing, so a new file is 0660, which no common umask gives (022
  // gives 0644, 002 gives 0664): the kernel applied the ACL. Set through python3, where the disk takes a POSIX ACL;
  // skipped where it cannot be set.
  it('gives a new file the mode fs_write gets in a folder with a default ACL', async (context) => {
    const { workspace, session, paths } = fixture()
    const acl = 'import os, struct, sys; os.setxattr(sys.argv[1], "system.posix_acl_default", struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, perm, 0xFFFFFFFF) for tag, perm in ((1, 6), (4, 7), (32, 0))))'
    if (spawnSync('python3', ['-I', '-c', acl, workspace]).status !== 0) context.skip()
    const transfer = await prepareTransfer({ directory: session, paths, reads: [], writes: ['shot.png'], context: { signal: new AbortController().signal }, protectedRoots: [], staleAfterMs: 600_000 })
    writeFileSync(transfer.argument('shot.png')!, 'png bytes')
    try { await transfer.deliver() } finally { transfer.close() }
    await writeFileEntry(writeInput.parse({ path: 'reference.txt', content: 'fs_write' }), { paths })
    expect(statSync(join(workspace, 'reference.txt')).mode & 0o777).toBe(0o660)
    expect(statSync(join(workspace, 'shot.png')).mode & 0o777).toBe(0o660)
  })

  // Review of 2026-10-14: nothing showed delivery refusing a link or a folder swapped in at the target after the check.
  it('refuses a link or a folder put at the target after the check, makes nothing, and follows nothing', async () => {
    const { root, workspace, session, paths } = fixture()
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'owner data')
    for (const swap of ['link', 'folder'] as const) {
      rmSync(join(workspace, 'shot.png'), { recursive: true, force: true })
      const transfer = await prepareTransfer({ directory: session, paths, reads: [], writes: ['shot.png'], context: { signal: new AbortController().signal }, protectedRoots: [], staleAfterMs: 600_000 })
      writeFileSync(transfer.argument('shot.png')!, 'png bytes')
      if (swap === 'link') symlinkSync(outside, join(workspace, 'shot.png'))
      else mkdirSync(join(workspace, 'shot.png'))
      try {
        await expect(transfer.deliver()).rejects.toThrow(swap === 'link' ? expect.objectContaining({ code: 'PERMISSION_DENIED' }) : 'Not a regular file: shot.png')
      } finally { transfer.close() }
      expect(lstatSync(join(workspace, 'shot.png'))[swap === 'link' ? 'isSymbolicLink' : 'isDirectory']()).toBe(true)
      expect(readFileSync(outside, 'utf8')).toBe('owner data')
      expect(readdirSync(workspace).filter(name => name.startsWith('.buckle-delivery-'))).toEqual([])
    }
  })

  it('sweeps only regular files: a stale folder or link named like a partial delivery stays', async () => {
    const { root, workspace, session, paths } = fixture()
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'owner data')
    const stale = (Date.now() - 10 * 60_000) / 1_000
    // The link leads to a stale regular file, so a sweep that followed links would take the link for one and remove it.
    utimesSync(outside, stale, stale)
    writeFileSync(join(workspace, '.buckle-delivery-file'), 'half')
    utimesSync(join(workspace, '.buckle-delivery-file'), stale, stale)
    mkdirSync(join(workspace, '.buckle-delivery-folder'))
    writeFileSync(join(workspace, '.buckle-delivery-folder', 'keep'), 'kept')
    utimesSync(join(workspace, '.buckle-delivery-folder'), stale, stale)
    symlinkSync(outside, join(workspace, '.buckle-delivery-link'))
    lutimesSync(join(workspace, '.buckle-delivery-link'), stale, stale)
    const transfer = await prepareTransfer({ directory: session, paths, reads: [], writes: ['shot.png'], context: { signal: new AbortController().signal }, protectedRoots: [], staleAfterMs: 60_000 })
    writeFileSync(transfer.argument('shot.png')!, 'png bytes')
    try { await transfer.deliver() } finally { transfer.close() }
    expect(readdirSync(workspace).sort()).toEqual(['.buckle-delivery-folder', '.buckle-delivery-link', 'shot.png'])
    expect(readFileSync(join(workspace, '.buckle-delivery-folder', 'keep'), 'utf8')).toBe('kept')
    expect(readFileSync(outside, 'utf8')).toBe('owner data')
  })

  it('removes a partial delivery a stopped node left beside the target, once older than twice the longest call', async () => {
    const { workspace, session } = fixture()
    mkdirSync(join(workspace, 'shots'))
    mkdirSync(join(workspace, 'other'))
    const partial = (directory: string, name: string, ageMs: number) => {
      const path = join(workspace, directory, `.buckle-delivery-${name}`)
      writeFileSync(path, 'half a png')
      utimesSync(path, (Date.now() - ageMs) / 1_000, (Date.now() - ageMs) / 1_000)
    }
    partial('shots', 'stale', 2 * 60_000 + 10_000)
    partial('shots', 'recent', 60_000)
    partial('other', 'stale', 10 * 60_000)
    const run = (request: ProcessRequest) => { writeFileSync(request.args[1]!, 'png bytes') }
    await browser({ workspace, session, args: { command: 'screenshot', args: ['shots/probe.png'] }, run, options: { maxTimeoutMs: 60_000 } })
    expect(readdirSync(join(workspace, 'shots')).sort()).toEqual(['.buckle-delivery-recent', 'probe.png'])
    expect(readFileSync(join(workspace, 'shots', 'probe.png'), 'utf8')).toBe('png bytes')
    expect(readdirSync(join(workspace, 'other'))).toEqual(['.buckle-delivery-stale'])
  })

  it('sweeps transfer directories a stopped node left at pack start, and keeps one a call may still use', async () => {
    const { workspace, session } = fixture()
    for (const name of ['transfer-stale', 'transfer-live']) mkdirSync(join(session, name, '0'), { recursive: true })
    writeFileSync(join(session, 'transfer-stale', '0', 'upload.png'), 'left behind')
    const old = (Date.now() - 2 * 60_000 - 1_000) / 1_000
    utimesSync(join(session, 'transfer-stale'), old, old)
    await browser({ workspace, session, args: { command: 'snapshot' }, options: { maxTimeoutMs: 60_000 } })
    expect(transfers(session)).toEqual(['transfer-live'])
  })
})
