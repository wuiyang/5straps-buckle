import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { captureHashes, HistoryCaptureSafetyError } from '../common/services/history/capture-hashes.js'

type Fault = 'none' | 'open-busy' | 'read-busy' | 'late-busy' | 'short-read' | 'opened-kind' | 'opened-identity' | 'opened-links' | 'after-identity' | 'after-size' | 'after-time' | 'after-links' | 'path-identity' | 'link-swap' | 'same-inode-link-swap' | 'entry-cap'
const controls = vi.hoisted(() => ({
  fault: 'none' as Fault, noFollow: true, target: '', outside: '', root: '', opened: [] as string[], bytes: 0, reads: 0, digests: 0, outsideBytes: 0, pathChecks: 0, checkedWhileOpen: false,
  descriptors: new Map<number, { path: string; checks: number }>(),
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  const { createRequire } = await import('node:module')
  const { Readable } = await import('node:stream')
  const fs = await import('node:fs')
  const crypto = await import('node:crypto')
  const require = createRequire(import.meta.url)
  const busy = () => Object.assign(new Error('fixture read is busy'), { code: 'EBUSY' })
  const pathKey = (path: import('node:fs').PathLike): string => process.platform === 'win32' ? String(path).replaceAll('\\', '/') : String(path)
  const beforeOpen = (path: string) => {
    controls.opened.push(pathKey(path))
    if (pathKey(path) !== controls.target) return
    if (controls.fault === 'link-swap') { fs.rmSync(path); fs.symlinkSync(controls.outside, path) }
    if (controls.fault === 'same-inode-link-swap') { fs.renameSync(path, controls.outside); fs.symlinkSync(controls.outside, path) }
  }
  const checked = {
    ...fs,
    constants: { ...fs.constants, get O_NOFOLLOW() { return controls.noFollow ? fs.constants.O_NOFOLLOW : undefined } },
    readdirSync: (path: import('node:fs').PathLike) => controls.fault === 'entry-cap' && pathKey(path) === controls.root ? Array.from({ length: 100_000 }, (_, index) => `missing-${index}`) : fs.readdirSync(path),
    lstatSync: (path: import('node:fs').PathLike, options?: { throwIfNoEntry?: boolean }) => {
      if (controls.fault === 'entry-cap' && pathKey(path) !== controls.root) return undefined
      const stat = fs.lstatSync(path, { throwIfNoEntry: options?.throwIfNoEntry ?? true })
      if (pathKey(path) === controls.target && ++controls.pathChecks > 1) {
        controls.checkedWhileOpen = [...controls.descriptors.values()].some(value => value.path === pathKey(path))
        if (stat && controls.fault === 'path-identity' && controls.bytes > 0) stat.ino++
      }
      return stat
    },
    openSync: (path: import('node:fs').PathLike, flags: string | number, mode?: import('node:fs').Mode) => {
      beforeOpen(String(path))
      if (pathKey(path) === controls.target && controls.fault === 'open-busy') throw busy()
      const descriptor = fs.openSync(path, flags, mode)
      controls.descriptors.set(descriptor, { path: pathKey(path), checks: 0 })
      return descriptor
    },
    fstatSync: (descriptor: number) => {
      const stat = fs.fstatSync(descriptor)
      const opened = controls.descriptors.get(descriptor)
      if (opened?.path === controls.target) {
        opened.checks++
        if (opened.checks === 1) {
          if (controls.fault === 'opened-kind') stat.isFile = () => false
          if (controls.fault === 'opened-identity') stat.ino++
          if (controls.fault === 'opened-links') stat.nlink = 2
        } else {
          if (controls.fault === 'after-identity') stat.ino++
          if (controls.fault === 'after-size') stat.size++
          if (controls.fault === 'after-time') stat.mtimeMs++
          if (controls.fault === 'after-links') stat.nlink = 2
        }
      }
      return stat
    },
    readSync: (descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (controls.descriptors.get(descriptor)?.path === controls.target) {
        controls.reads++
        if (controls.fault === 'read-busy' || controls.fault === 'late-busy' && controls.reads > 1) throw busy()
        if (controls.fault === 'short-read') return 0
      }
      const read = fs.readSync(descriptor, buffer, offset, length, position)
      controls.bytes += read
      if (controls.fault === 'same-inode-link-swap') controls.outsideBytes += read
      return read
    },
    closeSync: (descriptor: number) => { controls.descriptors.delete(descriptor); fs.closeSync(descriptor) },
    createReadStream: (path: import('node:fs').PathLike) => {
      beforeOpen(String(path))
      let stream: import('node:stream').Readable
      if (pathKey(path) === controls.target && ['open-busy', 'read-busy', 'late-busy', 'short-read'].includes(controls.fault)) {
        stream = Readable.from((async function* () {
          if (controls.fault === 'short-read') return
          if (controls.fault === 'late-busy') yield fs.readFileSync(path).subarray(0, 65_536)
          if (controls.fault !== 'open-busy') controls.reads++
          throw busy()
        })())
      } else stream = fs.createReadStream(path)
      stream.on('data', (chunk: Buffer) => { controls.reads++; controls.bytes += chunk.length; if (pathKey(path) === controls.target && controls.fault === 'link-swap') controls.outsideBytes += chunk.length })
      return stream
    },
  }
  return { Worker: class extends EventEmitter {
    constructor(source: string, options: { workerData: unknown }) {
      super()
      queueMicrotask(() => {
        try {
          new Function('require', 'Buffer', 'process', source)((name: string) => name === 'node:fs' ? checked : name === 'node:crypto' ? { ...crypto, createHash: (...args: Parameters<typeof crypto.createHash>) => { controls.digests++; return crypto.createHash(...args) } } : name === 'node:worker_threads' ? { workerData: options.workerData, parentPort: { postMessage: (value: unknown) => this.emit('message', value) } } : require(name), Buffer, process)
        } catch (error) { this.emit('error', error) }
      })
    }
  } }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  Object.assign(controls, { fault: 'none', noFollow: true, target: '', outside: '', root: '', opened: [], bytes: 0, reads: 0, digests: 0, outsideBytes: 0, pathChecks: 0, checkedWhileOpen: false })
  controls.descriptors.clear()
})
function fixture(content = Buffer.alloc(130_001, 7)) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-scan-file-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const file = join(workspace, 'file'); writeFileSync(file, content)
  controls.root = workspace; controls.target = file
  const input = { roots: [workspace], excluded: [], maxFileBytes: 1_048_576, hashFiles: false, platform: 'win32' as const }
  return { root, workspace, file, content, input }
}

it('reads every Windows Git file byte without computing an unused digest and checks its path while open', async () => {
  const { file, content, input } = fixture()
  expect((await captureHashes(input))[file]).toMatchObject({ kind: 'file' })
  expect(controls.bytes).toBe(content.length)
  expect(controls.digests).toBe(0)
  expect(controls.checkedWhileOpen).toBe(true)
  expect(controls.descriptors.size).toBe(0)
})
for (const fault of ['open-busy', 'read-busy', 'late-busy'] as const) it(`keeps ${fault} Windows files unreadable`, async () => {
  const { file, input } = fixture(); controls.fault = fault
  expect((await captureHashes(input))[file]).toMatchObject({ kind: 'unreadable' })
  if (fault === 'late-busy') expect(controls.bytes).toBeGreaterThan(0)
  expect(controls.descriptors.size).toBe(0)
})
it('attempts a read of an empty Windows file and retains read-time EBUSY', async () => {
  const { file, input } = fixture(Buffer.alloc(0)); controls.fault = 'read-busy'
  expect((await captureHashes(input))[file]).toMatchObject({ kind: 'unreadable' })
  expect(controls.reads).toBeGreaterThan(0)
  expect(controls.descriptors.size).toBe(0)
})
it('keeps SHA256 for hashes-only capture and over-cap entries', async () => {
  const { file, content, input } = fixture()
  const hash = createHash('sha256').update(content).digest('hex')
  expect((await captureHashes({ ...input, hashFiles: true }))[file]).toMatchObject({ kind: 'file', hash })
  expect((await captureHashes({ ...input, maxFileBytes: 16 }))[file]).toMatchObject({ kind: 'excluded', reason: 'size', size: content.length, hash })
})
for (const fault of ['opened-kind', 'opened-identity', 'opened-links', 'after-identity', 'after-size', 'after-time', 'after-links', 'path-identity', 'short-read'] as const) it(`refuses ${fault} races rather than accepting a partial file`, async () => {
  const { input } = fixture(); controls.fault = fault
  await expect(captureHashes(input)).rejects.toThrow(/File changed|hard-linked/)
  if (fault.startsWith('opened-')) expect(controls.bytes).toBe(0)
  expect(controls.descriptors.size).toBe(0)
})
it.skipIf(process.platform === 'win32')('does not follow a file replaced by a symbolic link before opening it', async () => {
  const { root, input } = fixture()
  controls.outside = join(root, 'outside'); writeFileSync(controls.outside, 'outside bytes')
  controls.fault = 'link-swap'
  await expect(captureHashes(input)).rejects.toThrow()
  expect(controls.outsideBytes).toBe(0)
})
it.skipIf(process.platform === 'win32')('records symbolic links without reading their targets', async () => {
  const { root, file, input } = fixture()
  const outside = join(root, 'outside'); writeFileSync(outside, 'outside bytes')
  rmSync(file); symlinkSync(outside, file)
  expect((await captureHashes(input))[file]).toMatchObject({ kind: 'symlink', target: outside })
  expect(controls.opened).toEqual([])
  expect(controls.bytes).toBe(0)
})
it('retains the hard-link refusal and dependency exclusion before any content read', async () => {
  const { root, workspace, file, input } = fixture()
  linkSync(file, join(workspace, 'second'))
  await expect(captureHashes(input)).rejects.toBeInstanceOf(HistoryCaptureSafetyError)
  expect(controls.bytes).toBe(0)
  rmSync(file); rmSync(join(workspace, 'second'))
  const modules = join(workspace, 'node_modules'); mkdirSync(modules)
  const outside = join(root, 'outside-root'); writeFileSync(outside, 'outside')
  linkSync(outside, join(modules, 'linked'))
  expect((await captureHashes(input))[join(modules, 'linked')]).toMatchObject({ kind: 'excluded' })
  expect(controls.bytes).toBe(0)
  expect(readFileSync(outside, 'utf8')).toBe('outside')
})
it('keeps the entry cap even when enumerated names disappear before inspection', async () => {
  const { input } = fixture(); controls.fault = 'entry-cap'
  await expect(captureHashes(input)).rejects.toBeInstanceOf(HistoryCaptureSafetyError)
  expect(controls.bytes).toBe(0)
})


it.skipIf(process.platform === 'win32')('checks the path before reading a same-inode symbolic link when no-follow is unavailable', async () => {
  const { root, input } = fixture()
  controls.noFollow = false; controls.fault = 'same-inode-link-swap'; controls.outside = join(root, 'moved-file')
  await expect(captureHashes(input)).rejects.toThrow('File changed')
  expect(controls.outsideBytes).toBe(0)
  expect(controls.descriptors.size).toBe(0)
})
