import { Worker } from 'node:worker_threads'
import type { Snapshot } from './snapshot.js'

export interface HashCaptureInput { roots: string[]; excluded: string[]; maxFileBytes: number; hashFiles: boolean; platform: NodeJS.Platform }

export class HistoryCaptureSafetyError extends Error {}

export function captureHashes(input: HashCaptureInput): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(`const __name = fn => fn; const historyCapturePath = ${historyCapturePath.toString()}; const { parentPort, workerData } = require('node:worker_threads'); (${scanWorkspace.toString()})(workerData).then(value => parentPort.postMessage({ value }), error => parentPort.postMessage({ error: error.message, code: error.code }));`, { eval: true, execArgv: [], workerData: input }) }
    catch (error) { reject(new HistoryCaptureSafetyError('History safety scan could not start', { cause: error })); return }
    let answered = false
    worker.once('message', (result: { value?: Snapshot; error?: string; code?: string }) => { answered = true; if (result.value) resolve(result.value); else reject(result.code === 'HISTORY_UNSAFE_CAPTURE' ? new HistoryCaptureSafetyError(result.error) : new Error(result.error ?? 'History hashing failed')) })
    worker.once('error', error => reject(new HistoryCaptureSafetyError('History safety scan did not finish', { cause: error })))
    worker.once('exit', code => { if (!answered) reject(new HistoryCaptureSafetyError(`History safety scan stopped with code ${code}`)) })
  })
}

// Self-contained: it runs in a worker so hashing never blocks the request's event loop.
async function scanWorkspace(input: HashCaptureInput): Promise<Snapshot> {
  const fs: typeof import('node:fs') = require('node:fs')
  const paths: typeof import('node:path') = require('node:path')
  const crypto: typeof import('node:crypto') = require('node:crypto')
  const result: Snapshot = {}
  let count = 0
  let limitation: Error | undefined
  const inside = (root: string, path: string) => { const below = paths.relative(root, path); return below === '' || below !== '..' && !below.startsWith(`..${paths.sep}`) && !paths.isAbsolute(below) }
  async function hash(path: string): Promise<string> {
    const value = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(path)) value.update(chunk)
    return value.digest('hex')
  }
  function unsafe(message: string): Error { return Object.assign(new Error(message), { code: 'HISTORY_UNSAFE_CAPTURE' }) }
  function inspect(path: string): import('node:fs').Stats | undefined {
    try { return fs.lstatSync(path, { throwIfNoEntry: false }) }
    catch { throw unsafe('History could not inspect every path safely; fix workspace access before writing') }
  }
  async function visit(path: string, root: string): Promise<void> {
    try { await captureEntry(path, root) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'HISTORY_UNSAFE_CAPTURE') throw error
      limitation ??= error instanceof Error ? error : new Error('History could not capture file content')
    }
  }
  async function captureEntry(path: string, root: string): Promise<void> {
    if (input.excluded.some(hidden => inside(hidden, path)) || Object.hasOwn(result, path)) return
    if (++count > 100_000) throw unsafe('History capture exceeds 100,000 entries; narrow the workspace')
    const stat = inspect(path)
    if (!stat) return
    const nativeMode = stat.mode & 0o777
    const mode = process.platform !== 'win32' || stat.isSymbolicLink() ? nativeMode : stat.isDirectory() ? nativeMode & 0o200 ? 0o755 : 0o555 : nativeMode & 0o200 ? 0o644 : 0o444
    if (stat.isSymbolicLink()) { result[path] = { kind: 'symlink', mode, target: fs.readlinkSync(path) }; return }
    if (stat.isDirectory()) {
      result[path] = { kind: 'directory', mode }
      let children: string[]
      try { children = fs.readdirSync(path) }
      catch { throw unsafe('History could not inspect every directory safely; fix workspace access before writing') }
      for (const name of children) {
        if (name === '.git') continue
        const child = paths.join(path, name)
        if (name.includes('\\') || input.platform === 'win32' && /[. ]$/.test(name)) { const omitted = inspect(child); if (omitted) result[child] = { kind: 'excluded', mode: omitted.mode & 0o777 }; continue }
        await visit(child, root)
      }
      return
    }
    if (!stat.isFile()) throw new Error('History cannot capture special filesystem entries')
    if (stat.nlink > 1) {
      if (paths.relative(root, path).split(paths.sep).includes('node_modules')) { result[path] = { kind: 'excluded', mode }; return }
      throw unsafe('History cannot safely restore hard-linked files')
    }
    const overCap = stat.size > input.maxFileBytes
    try {
      const contentHash = input.hashFiles || overCap || input.platform === 'win32' ? await hash(path) : undefined
      const after = fs.lstatSync(path)
      if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('File changed during history capture; retry when the workspace is idle')
      result[path] = { kind: overCap ? 'excluded' : 'file', mode, ...(overCap ? { size: stat.size, reason: 'size' as const } : {}), ...(contentHash ? { hash: contentHash } : {}) }
    } catch (error) {
      if (input.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EBUSY') result[path] = { kind: 'unreadable', mode }
      else throw error
    }
  }
  for (const root of input.roots) await visit(root, root)
  if (limitation) throw limitation
  return Object.fromEntries(Object.entries(result).map(([path, entry]) => [historyCapturePath({ path, platform: process.platform }), entry]))
}

export function historyCapturePath(input: { path: string; platform: NodeJS.Platform }): string { return input.platform === 'win32' ? input.path.replaceAll('\\', '/') : input.path }
