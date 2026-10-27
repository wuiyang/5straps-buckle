import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findExecutable } from '../common/domain/executable.js'
import { createPathView } from '../common/domain/path-view.js'
import { searchBuiltin } from '../common/services/packs/fs/builtin-search.js'
import { searchInput } from '../common/services/packs/fs/schemas.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The built-in search never fails whole for one file (the live failure: a search of a folder that a 95 MiB file was being
// received into failed with the invoker's generic "Tool invocation failed"). Linux has no sharing locks and the disk
// stays still while a test reads it, so the faults a node meets are made here: a name that vanishes between the listing
// and its stat or open, an open or a read that answers EBUSY, EPERM, EACCES, or EIO, a file that grows or shrinks between
// its stat and its read, and a worker that dies or cannot start.

const faults = vi.hoisted(() => ({
  names: new Map<number, string>(),
  open: new Map<string, string>(),
  read: new Map<string, unknown>(),
  readdir: new Map<string, string>(),
  beforeLstat: new Map<string, () => void>(),
  beforeOpen: new Map<string, () => void>(),
  afterFstat: new Map<string, () => void>(),
  workers: { die: 0, refuse: 0 },
}))

const errno = (code: string) => Object.assign(new Error(`${code}: injected by the test`), { code })

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const nameOf = (path: unknown): string => {
    const text = String(path)
    const pinned = /^\/proc\/self\/fd\/(\d+)$/.exec(text)
    return pinned ? faults.names.get(Number(pinned[1])) ?? '' : text.slice(text.lastIndexOf('/') + 1)
  }
  const once = (hooks: Map<string, () => void>, name: string) => { const hook = hooks.get(name); if (hook) { hooks.delete(name); hook() } }
  const failing = (descriptor: unknown): void => {
    const fault = faults.read.get(faults.names.get(Number(descriptor)) ?? '')
    if (fault !== undefined) throw typeof fault === 'string' ? errno(fault) : fault
  }
  const openSync = ((path: string, ...rest: unknown[]) => {
    const name = nameOf(path)
    once(faults.beforeOpen, name)
    const code = faults.open.get(name)
    if (code) throw errno(code)
    const descriptor = (actual.openSync as (...args: unknown[]) => number)(path, ...rest)
    faults.names.set(descriptor, name)
    return descriptor
  }) as typeof actual.openSync
  const closeSync = ((descriptor: number) => { faults.names.delete(descriptor); actual.closeSync(descriptor) }) as typeof actual.closeSync
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    once(faults.beforeLstat, nameOf(path))
    return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.lstatSync
  const readdirSync = ((path: string, ...rest: unknown[]) => {
    const code = faults.readdir.get(nameOf(path))
    if (code) throw errno(code)
    return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readdirSync
  const fstatSync = ((descriptor: number, ...rest: unknown[]) => {
    const info = (actual.fstatSync as (...args: unknown[]) => unknown)(descriptor, ...rest)
    once(faults.afterFstat, faults.names.get(descriptor) ?? '')
    return info
  }) as typeof actual.fstatSync
  const readFileSync = ((source: unknown, ...rest: unknown[]) => {
    if (typeof source === 'number') failing(source)
    return (actual.readFileSync as (...args: unknown[]) => unknown)(source, ...rest)
  }) as typeof actual.readFileSync
  const readSync = ((descriptor: number, ...rest: unknown[]) => {
    failing(descriptor)
    return (actual.readSync as (...args: unknown[]) => unknown)(descriptor, ...rest)
  }) as typeof actual.readSync
  const replaced = { openSync, closeSync, lstatSync, readdirSync, fstatSync, readFileSync, readSync }
  return { ...actual, ...replaced, default: { ...actual, ...replaced } }
})

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  class FaultyWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (faults.workers.refuse > 0) { faults.workers.refuse--; throw errno('ERR_WORKER_INIT_FAILED') }
      super(...args)
      if (faults.workers.die > 0) { faults.workers.die--; void this.terminate() }
    }
  }
  return { ...actual, Worker: FaultyWorker, default: { ...actual, Worker: FaultyWorker } }
})

const roots: string[] = []
afterEach(() => {
  faults.names.clear()
  for (const hooks of [faults.open, faults.read, faults.readdir, faults.beforeLstat, faults.beforeOpen, faults.afterFstat]) (hooks as Map<string, unknown>).clear()
  faults.workers.die = 0
  faults.workers.refuse = 0
})
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface Output { matches: JsonObject[]; truncated: boolean; excludedFiles: number; skipped?: Array<{ path: string; reason: string }>; skippedMore?: number }

/** A folder of three small files that all hold `hello`. */
function folder(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-search-faults-'))
  roots.push(root)
  for (const [path, content] of Object.entries({ 'a.txt': 'hello a\n', 'b.txt': 'hello b\n', 'z.txt': 'hello z\n', ...files })) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function builtin(root: string, args: Record<string, unknown>, extra: Partial<Parameters<typeof searchBuiltin>[0]> = {}): Promise<JsonValue> {
  return searchBuiltin({ args: searchInput.parse(args), paths: createPathView({ root, mount: null }), signal: new AbortController().signal, authorizeRead: async () => true, protectedRoots: [], ...extra })
}

const search = async (root: string, args: Record<string, unknown> = { pattern: 'hello' }, extra: Partial<Parameters<typeof searchBuiltin>[0]> = {}) => await builtin(root, args, extra) as unknown as Output
const found = (output: Output) => output.matches.map(match => match.path)

describe('a file that cannot be searched is skipped and counted, and the search goes on', () => {
  it('says nothing was skipped when nothing was', async () => {
    expect(await search(folder())).toMatchObject({ truncated: false, excludedFiles: 0, skipped: [], skippedMore: 0 })
  })

  it('skips an entry that vanished between the listing and its stat', async () => {
    const root = folder()
    faults.beforeLstat.set('b.txt', () => rmSync(join(root, 'b.txt')))
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output).toMatchObject({ truncated: false, excludedFiles: 1, skipped: [{ path: './b.txt', reason: 'vanished' }] })
  })

  it('skips a file that vanished between its stat and its open', async () => {
    const root = folder()
    faults.beforeOpen.set('b.txt', () => rmSync(join(root, 'b.txt')))
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [{ path: './b.txt', reason: 'vanished' }] })
  })

  it('skips a file that was swapped for a link after it was listed, as one that changed', async () => {
    const root = folder()
    faults.beforeOpen.set('b.txt', () => { rmSync(join(root, 'b.txt')); symlinkSync('a.txt', join(root, 'b.txt')) })
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output).toMatchObject({ skipped: [{ path: './b.txt', reason: 'changed' }] })
  })

  it.each([
    ['EBUSY', 'win32', 'held'],
    ['EPERM', 'win32', 'held'],
    ['EACCES', 'win32', 'unreadable'],
    ['EBUSY', 'linux', 'unreadable'],
    ['EPERM', 'linux', 'unreadable'],
    ['EIO', 'linux', 'unreadable'],
  ] as const)('skips a file whose open answers %s on %s as %s', async (code, platform, reason) => {
    const root = folder()
    faults.open.set('b.txt', code)
    const output = await search(root, { pattern: 'hello' }, { platform })
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [{ path: './b.txt', reason }] })
  })

  it.each([
    ['EBUSY', 'win32', 'held'],
    ['EIO', 'linux', 'unreadable'],
  ] as const)('skips a file whose read answers %s on %s as %s', async (code, platform, reason) => {
    const root = folder()
    faults.read.set('b.txt', code)
    const output = await search(root, { pattern: 'hello' }, { platform })
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [{ path: './b.txt', reason }] })
  })

  it('skips a file that grew past the 10 MiB cap between its stat and its read, instead of reading what it grew to', async () => {
    const root = folder({ 'big.txt': Buffer.alloc(9 * 1_048_576, 'x') })
    faults.afterFstat.set('big.txt', () => appendFileSync(join(root, 'big.txt'), Buffer.alloc(3 * 1_048_576, 'y')))
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [{ path: './big.txt', reason: 'changed' }] })
  })

  it('skips a file that shrank between its stat and its read', async () => {
    const root = folder({ 'big.txt': Buffer.alloc(2 * 1_048_576, 'x') })
    faults.afterFstat.set('big.txt', () => truncateSync(join(root, 'big.txt'), 1_024))
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [{ path: './big.txt', reason: 'changed' }] })
  })

  it('lists a file over the cap and a binary file with their reasons', async () => {
    const root = folder({ 'huge.txt': Buffer.alloc(10 * 1_048_576 + 1, 'x'), 'image.png': Buffer.from([0x89, 0x50, 0, 0x0d]) })
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './huge.txt', reason: 'too-large' }, { path: './image.png', reason: 'binary' }])
    expect(output.excludedFiles).toBe(1)
  })

  it('lists at most 100 skipped files and counts the rest', async () => {
    const binary = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`bin${String(index).padStart(3, '0')}.dat`, Buffer.from([0, 1, 2])]))
    const output = await search(folder(binary))
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output.skipped).toHaveLength(100)
    expect(output.skipped![0]).toEqual({ path: './bin000.dat', reason: 'binary' })
    expect(output.skippedMore).toBe(20)
  })

  it('skips a folder it cannot list and goes on with its neighbours', async () => {
    const root = folder({ 'sub/c.txt': 'hello c\n', 'sub/deeper/d.txt': 'hello d\n' })
    faults.readdir.set('sub', 'EACCES')
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './sub/', reason: 'unreadable' }])
  })

  it('skips a folder that vanished before it was opened', async () => {
    const root = folder({ 'sub/c.txt': 'hello c\n' })
    faults.beforeOpen.set('sub', () => rmSync(join(root, 'sub'), { recursive: true }))
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './sub/', reason: 'vanished' }])
  })

  it('searches on without an ignore file it cannot read, and says it was not read', async () => {
    const root = folder({ '.git/HEAD': 'ref\n', '.gitignore': 'b.txt\n' })
    faults.read.set('.gitignore', 'EIO')
    const output = await search(root)
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './.gitignore', reason: 'unreadable' }])
  })

  it('leaves the files the rules do not allow in the count of files left out, without a reason', async () => {
    const root = folder()
    const output = await search(root, { pattern: 'hello' }, { authorizeRead: async path => !path.endsWith('b.txt') })
    expect(output).toMatchObject({ excludedFiles: 1, skipped: [] })
  })

  it('skips a file whose permission check could not reach it, and still fails on any other error of the check', async () => {
    const root = folder()
    const output = await search(root, { pattern: 'hello' }, { authorizeRead: async path => { if (path.endsWith('b.txt')) throw errno('EACCES'); return true } })
    expect(found(output)).toEqual(['./a.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './b.txt', reason: 'unreadable' }])
    await expect(search(root, { pattern: 'hello' }, { authorizeRead: async () => { throw new Error('the audit could not be written') } })).rejects.toThrow('the audit could not be written')
  })
})

describe('a pattern that is slow on one file, or a worker that fails, skips that file', () => {
  const slow = `${'a'.repeat(60)}b\n`

  it('skips a file the pattern runs past its bound on, as timeout, and searches the others', async () => {
    const root = folder({ 'bad.txt': slow })
    const output = await search(root, { pattern: '(a+)+$|hello' }, { matchTimeoutMs: 500 })
    expect(found(output)).toEqual(['./a.txt', './b.txt', './z.txt'])
    expect(output).toMatchObject({ truncated: false, excludedFiles: 1, skipped: [{ path: './bad.txt', reason: 'timeout' }] })
  })

  it('stops after three files time out, and says it was cut short', async () => {
    const root = folder(Object.fromEntries(['bad1.txt', 'bad2.txt', 'bad3.txt', 'bad4.txt'].map(name => [name, slow])))
    const output = await search(root, { pattern: '(a+)+$|hello' }, { matchTimeoutMs: 500 })
    expect(output.truncated).toBe(true)
    expect(output.skipped).toEqual([{ path: './bad1.txt', reason: 'timeout' }, { path: './bad2.txt', reason: 'timeout' }, { path: './bad3.txt', reason: 'timeout' }])
  })

  it('skips the file a worker died on, and the next file gets a new worker', async () => {
    const root = folder()
    faults.workers.die = 1
    const output = await search(root)
    expect(found(output)).toEqual(['./b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './a.txt', reason: 'timeout' }])
  })

  it('skips the file a worker could not be started for', async () => {
    const root = folder()
    faults.workers.refuse = 1
    const output = await search(root)
    expect(found(output)).toEqual(['./b.txt', './z.txt'])
    expect(output.skipped).toEqual([{ path: './a.txt', reason: 'timeout' }])
  })
})

describe('a search that cannot go on says why, with a code', () => {
  it('names a pattern no regular expression reads', async () => {
    await expect(search(folder(), { pattern: '(unclosed' })).rejects.toMatchObject({ code: 'INVALID_PATTERN', message: expect.stringContaining('is not a regular expression') })
  })

  it('names a folder that is not there', async () => {
    await expect(search(folder(), { pattern: 'hello', path: 'missing' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', message: 'There is no folder at missing, so nothing was searched' })
  })

  it('names a file given as the folder', async () => {
    await expect(search(folder(), { pattern: 'hello', path: 'a.txt' })).rejects.toMatchObject({ code: 'SEARCH_ROOT_UNREADABLE', message: 'a.txt is not a folder, so nothing was searched; to search one file, name its folder and give the file as the glob' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names a folder this node may not open', async () => {
    const root = folder({ 'closed/c.txt': 'hello\n' })
    chmodSync(join(root, 'closed'), 0o000)
    try {
      await expect(search(root, { pattern: 'hello', path: 'closed' })).rejects.toMatchObject({ code: 'SEARCH_ROOT_UNREADABLE', message: expect.stringContaining('closed') })
    } finally { chmodSync(join(root, 'closed'), 0o755) }
  })

  it('names a folder whose listing fails', async () => {
    const root = folder()
    faults.readdir.set(basename(root), 'EIO')
    await expect(search(root)).rejects.toMatchObject({ code: 'SEARCH_ROOT_UNREADABLE', message: expect.stringContaining('EIO') })
  })

  it('names the call\'s time limit when it runs out, where the invoker would say only that the tool failed', async () => {
    const root = folder()
    for (let index = 0; index < 600; index++) mkdirSync(join(root, `dir${String(index).padStart(3, '0')}`))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1)
    await expect(search(root, { pattern: 'x', glob: '*.none' }, { signal: controller.signal, timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'SEARCH_TIMED_OUT', message: expect.stringContaining('30 seconds') })
  })

  it('still ends with the reason a cancel gave', async () => {
    const root = folder()
    for (let index = 0; index < 600; index++) mkdirSync(join(root, `dir${String(index).padStart(3, '0')}`))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 1)
    await expect(search(root, { pattern: 'x', glob: '*.none' }, { signal: controller.signal })).rejects.toThrow('cancelled')
  })
})

describe.skipIf(findExecutable('rg') !== null)('fs_search_content on a node, without ripgrep', () => {
  let root = ''
  let runtime: BuckleRuntime
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'buckle-search-node-'))
    roots.push(root)
    const state = mkdtempSync(join(tmpdir(), 'buckle-search-node-state-'))
    roots.push(state)
    runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' }) })
  })
  afterAll(async () => { await runtime.approvalService.close(); await runtime.history.close() })

  let calls = 0
  const invoke = (args: Record<string, JsonValue>, timeoutMs?: number) => runtime.invoke({ request: { requestId: `search-faults-${++calls}`, tool: 'fs_search_content', args, approvalTokens: [], ...(timeoutMs ? { timeoutMs } : {}) }, sessionId: 'agent' })
  const fixture = (name: string, files: Record<string, string | Buffer> = {}) => {
    for (const [path, content] of Object.entries({ 'a.txt': 'hello a\n', 'b.txt': 'hello b\n', 'z.txt': 'hello z\n', ...files })) {
      mkdirSync(join(root, name, path, '..'), { recursive: true })
      writeFileSync(join(root, name, path), content)
    }
  }

  it('answers a result, not a failure, where a listed file vanished before it was read', async () => {
    fixture('vanished')
    faults.beforeLstat.set('b.txt', () => rmSync(join(root, 'vanished', 'b.txt')))
    const response = await invoke({ path: 'vanished', pattern: 'hello' })
    expect(response).toMatchObject({ outcome: 'ok', output: { excludedFiles: 1, skipped: [{ path: './b.txt', reason: 'vanished' }] } })
  })

  it('answers a result where a file could not be read', async () => {
    fixture('unreadable')
    faults.read.set('b.txt', 'EIO')
    const response = await invoke({ path: 'unreadable', pattern: 'hello' })
    expect(response).toMatchObject({ outcome: 'ok', output: { skipped: [{ path: './b.txt', reason: 'unreadable' }] } })
  })

  it('answers the code and the cause where the folder is not there', async () => {
    const response = await invoke({ path: 'nowhere', pattern: 'hello' })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'FILE_NOT_FOUND', message: 'There is no folder at nowhere, so nothing was searched' } })
  })

  it('answers the code and the cause where the pattern is no regular expression', async () => {
    fixture('pattern')
    const response = await invoke({ path: 'pattern', pattern: '(unclosed' })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'INVALID_PATTERN' } })
  })

  it('answers the code and the cause where the call\'s time ran out', async () => {
    fixture('slow')
    for (let index = 0; index < 600; index++) mkdirSync(join(root, 'slow', `dir${String(index).padStart(3, '0')}`))
    const response = await invoke({ path: 'slow', pattern: 'x', glob: '*.none' }, 1)
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'SEARCH_TIMED_OUT' } })
  })
})
