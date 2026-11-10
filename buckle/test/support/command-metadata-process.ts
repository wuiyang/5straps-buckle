import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'pathe'

const [directory, workspace, git, serialized] = process.argv.slice(2)
if (!directory || !workspace || !git || !serialized) throw new Error('Capture worker arguments are missing')
const parsed: unknown = JSON.parse(serialized)
if (!Array.isArray(parsed)) throw new Error('Capture worker excludes must be an array')
const excluded = parsed.map((value: unknown) => { if (typeof value !== 'string') throw new Error('Capture worker excludes must be strings'); return value })
const info = join(git, 'info')
const indexLock = join(git, 'index.lock')
const writeFile = fs.writeFileSync
const remove = fs.rmSync
const open = fs.openSync
const close = fs.closeSync
const metadataDescriptors = new Set<number>()
let writePaused = false
let preparePaused = false

function checkpoint(name: string): void {
  fs.writeSync(1, `${name}\n`)
  const release = Buffer.alloc(1)
  if (fs.readSync(0, release, 0, 1, null) !== 1) throw new Error('Capture worker checkpoint was closed')
}

// The real filesystem write still runs; the parent only controls its interleaving.
fs.writeFileSync = (file, data, options) => {
  if (!writePaused && (dirname(String(file)) === info || (typeof file === 'number' && metadataDescriptors.has(file)))) { writePaused = true; checkpoint('metadata-write') }
  writeFile(file, data, options)
}
fs.openSync = (file, flags, mode) => {
  const descriptor = open(file, flags, mode)
  if (dirname(String(file)) === info) metadataDescriptors.add(descriptor)
  return descriptor
}
fs.closeSync = descriptor => { metadataDescriptors.delete(descriptor); close(descriptor) }
// This is the first capture step after prepare, before any shared index work.
fs.rmSync = (file, options) => {
  if (!preparePaused && String(file) === indexLock) { preparePaused = true; checkpoint('prepared') }
  remove(file, options)
}
syncBuiltinESMExports()

try {
  const { createCommandCapture } = await import('../../common/services/history/command-capture.js')
  const { openObjectStore } = await import('../../common/services/history/object-store.js')
  const capture = createCommandCapture({ directory, objects: openObjectStore(directory), excluded: () => excluded, allowed: () => true, maxFileBytes: () => 1_048_576 })
  const [baseline] = await capture.baseline([workspace], { deadline: Date.now() + 30_000 })
  if (!baseline || !/^[0-9a-f]{40}$/.test(baseline.tree)) throw new Error('Capture worker received no real baseline tree')
  fs.writeSync(1, `complete:${baseline.tree}\n`)
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'UnknownError'
  fs.writeSync(1, `failure:${code}\n`)
  process.exitCode = 1
} finally {
  fs.writeFileSync = writeFile
  fs.rmSync = remove
  fs.openSync = open
  fs.closeSync = close
  syncBuiltinESMExports()
}
