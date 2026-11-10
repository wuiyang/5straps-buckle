import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { afterEach, expect, it } from 'vitest'
import { createCommandCapture } from '../common/services/history/command-capture.js'
import { RAW_ATTRIBUTES } from '../common/services/history/git-files.js'
import { openObjectStore } from '../common/services/history/object-store.js'

const roots: string[] = []
const largeNames = Array.from({ length: 600 }, (_, index) => `protected/entry-${String(index).padStart(4, '0')}`)
const largeExcludes = largeNames.map(name => `/${name}\n`).join('')

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(protectedNames: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-command-metadata-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'file.txt'), 'tracked content\r\n')
  const directory = join(root, 'history')
  const git = join(directory, 'commands', createHash('sha256').update(workspace).digest('hex').slice(0, 24))
  const info = join(git, 'info')
  const capture = createCommandCapture({ directory, objects: openObjectStore(directory), excluded: () => protectedNames.map(name => join(workspace, name)), allowed: () => true, maxFileBytes: () => 1_048_576 })
  return { root, workspace, directory, git, info, exclude: join(info, 'exclude'), baseline: () => capture.baseline([workspace], { deadline: Date.now() + 30_000 }) }
}

function startCapture(made: ReturnType<typeof fixture>, protectedNames: string[]) {
  const script = fileURLToPath(new URL('./support/command-metadata-process.ts', import.meta.url))
  const excluded = protectedNames.map(name => join(made.workspace, name))
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, made.directory, made.workspace, made.git, JSON.stringify(excluded)], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' })
  const output = createInterface({ input: child.stdout })
  const queued: string[] = []
  const pending: { resolve: (line: string) => void; reject: (error: Error) => void }[] = []
  let ended = false
  output.on('line', line => { const waiting = pending.shift(); if (waiting) waiting.resolve(line); else queued.push(line) })
  child.stderr.resume()
  const rejectPending = (message: string) => { ended = true; for (const waiting of pending.splice(0)) waiting.reject(new Error(message)) }
  child.once('error', () => rejectPending('Capture worker could not start'))
  const closed = new Promise<void>(resolve => child.once('close', () => { rejectPending('Capture worker exited before its next checkpoint'); resolve() }))
  return {
    next(): Promise<string> {
      const line = queued.shift()
      if (line !== undefined) return Promise.resolve(line)
      if (ended) return Promise.reject(new Error('Capture worker has no further checkpoints'))
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    release(): void { child.stdin.write('x') },
    async stop(): Promise<void> { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; output.close() },
  }
}

it('keeps unchanged generated command excludes above 8192 bytes at the same inode across captures', async () => {
  const made = fixture(largeNames)
  const [first] = await made.baseline()
  expect(Buffer.byteLength(largeExcludes)).toBeGreaterThan(8192)
  expect(readFileSync(made.exclude, 'utf8')).toBe(largeExcludes)
  // An open handle prevents an unlinked inode from being reused for its replacement.
  const original = openSync(made.exclude, 'r')
  try {
    const held = fstatSync(original)
    const [second] = await made.baseline()
    const current = lstatSync(made.exclude)
    expect({ dev: current.dev, ino: current.ino, nlink: current.nlink }).toEqual({ dev: held.dev, ino: held.ino, nlink: 1 })
    expect(readFileSync(made.exclude, 'utf8')).toBe(largeExcludes)
    expect(second?.tree).toBe(first?.tree)
  } finally { closeSync(original) }
})

it('publishes changed command excludes without exposing a missing destination', async () => {
  const made = fixture()
  const [baseline] = await made.baseline()
  const previous = readFileSync(made.exclude, 'utf8')
  const worker = startCapture(made, largeNames)
  try {
    expect(await worker.next()).toBe('metadata-write')
    expect(readFileSync(made.exclude, 'utf8')).toBe(previous)
    worker.release()
    expect(await worker.next()).toBe('prepared')
    worker.release()
    expect(await worker.next()).toBe(`complete:${baseline?.tree}`)
    expect(readFileSync(made.exclude, 'utf8')).toBe(largeExcludes)
  } finally { await worker.stop() }
}, 40_000)

it('lets concurrent command prepares publish the same large excludes and both complete real captures', async () => {
  const made = fixture()
  const [baseline] = await made.baseline()
  const first = startCapture(made, largeNames)
  const second = startCapture(made, largeNames)
  try {
    expect(await Promise.all([first.next(), second.next()])).toEqual(['metadata-write', 'metadata-write'])
    // Both prepares have reached their real write before either can publish.
    first.release()
    expect(await first.next()).toBe('prepared')
    second.release()
    expect(await second.next()).toBe('prepared')
    // Only index work is serialized; metadata preparation has already overlapped.
    first.release()
    expect(await first.next()).toBe(`complete:${baseline?.tree}`)
    second.release()
    expect(await second.next()).toBe(`complete:${baseline?.tree}`)
    expect(readFileSync(made.exclude, 'utf8')).toBe(largeExcludes)
  } finally { await Promise.all([first.stop(), second.stop()]) }
}, 40_000)

for (const matching of [false, true]) it.skipIf(process.platform === 'win32')(`replaces a linked command info directory with ${matching ? 'matching' : 'different'} metadata without changing its target`, async () => {
  const made = fixture(['protected'])
  writeFileSync(join(made.workspace, 'protected'), 'protected content')
  const [baseline] = await made.baseline()
  const target = join(made.root, 'owner-info'); mkdirSync(target)
  const attributes = matching ? RAW_ATTRIBUTES : 'owner attributes must stay unchanged\n'
  const excludes = matching ? '/protected\n' : 'owner excludes must stay unchanged\n'
  writeFileSync(join(target, 'attributes'), attributes)
  writeFileSync(join(target, 'exclude'), excludes)
  writeFileSync(join(target, 'kept'), 'owner metadata')
  const original = lstatSync(target)
  rmSync(made.info, { recursive: true, force: true }); symlinkSync(target, made.info, 'dir')

  const [captured] = await made.baseline()
  expect(readFileSync(join(target, 'attributes'), 'utf8')).toBe(attributes)
  expect(readFileSync(join(target, 'exclude'), 'utf8')).toBe(excludes)
  expect(readFileSync(join(target, 'kept'), 'utf8')).toBe('owner metadata')
  expect({ dev: lstatSync(target).dev, ino: lstatSync(target).ino }).toEqual({ dev: original.dev, ino: original.ino })
  expect(lstatSync(made.info).isDirectory()).toBe(true)
  expect(lstatSync(made.info).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(made.info, 'attributes'), 'utf8')).toBe(RAW_ATTRIBUTES)
  expect(readFileSync(made.exclude, 'utf8')).toBe('/protected\n')
  expect(captured?.tree).toBe(baseline?.tree)
})
