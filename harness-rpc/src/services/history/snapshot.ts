import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { isInsideAny } from '../../domain/paths.js'

export const entrySchema = z.object({ kind: z.enum(['file', 'directory', 'symlink']), mode: z.number(), hash: z.string().optional(), target: z.string().optional() })
export const snapshotSchema = z.record(z.string(), entrySchema)
export type Snapshot = z.infer<typeof snapshotSchema>
export type Entry = z.infer<typeof entrySchema>

export function snapshot(input: { roots: string[]; excluded: string[]; maxBytes: number; save: (hash: string, content: Buffer) => void }): Snapshot {
  const result: Snapshot = {}
  let bytes = 0
  let count = 0
  function visit(path: string): void {
    if (isInsideAny(input.excluded, path) || Object.hasOwn(result, path)) return
    if (++count > 100_000) throw new Error('History snapshot exceeds 100,000 entries; narrow the workspace')
    let stat
    try { stat = lstatSync(path) } catch (error) { if (isMissing(error)) return; throw error }
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) result[path] = { kind: 'symlink', mode, target: readlinkSync(path) }
    else if (stat.isDirectory()) {
      result[path] = { kind: 'directory', mode }
      for (const name of readdirSync(path)) visit(join(path, name))
    } else if (stat.isFile()) {
      if (stat.nlink > 1) throw new Error('History cannot safely restore hard-linked files')
      bytes += stat.size
      if (bytes > input.maxBytes) throw new Error('History snapshot exceeds its configured byte limit')
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let content: Buffer
      try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error('File changed during history capture')
        content = readFileSync(descriptor)
        const after = fstatSync(descriptor)
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('File changed during history capture; retry when the workspace is idle')
      } finally { closeSync(descriptor) }
      const hash = createHash('sha256').update(content).digest('hex')
      input.save(hash, content)
      result[path] = { kind: 'file', mode, hash }
    } else throw new Error('History cannot capture special filesystem entries')
  }
  for (const root of input.roots) visit(resolve(root))
  return result
}

export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => !sameEntry(before[path], after[path])).sort()
}

export function sameEntry(left: Entry | undefined, right: Entry | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function applySnapshot(input: { target: Snapshot; current: Snapshot; paths: string[]; content: (hash: string) => Buffer }): void {
  // Children leave before parents. Never recursively delete untracked contents.
  for (const path of [...input.paths].sort((a, b) => b.length - a.length)) {
    const current = input.current[path]
    const target = input.target[path]
    if (current && (!target || target.kind !== current.kind || current.kind === 'symlink')) {
      if (current.kind === 'directory') rmdirSync(path)
      else rmSync(path)
    }
  }
  for (const path of [...input.paths].sort((a, b) => a.length - b.length)) {
    const entry = input.target[path]
    if (!entry) continue
    if (entry.kind === 'directory') mkdirSync(path, { recursive: true, mode: 0o700 })
    else if (entry.kind === 'symlink') symlinkSync(entry.target!, path)
    else {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.buckle-restore-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`
      try { writeFileSync(temporary, input.content(entry.hash!), { flag: 'wx', mode: entry.mode }); renameSync(temporary, path) }
      finally { rmSync(temporary, { force: true }) }
    }
    if (entry.kind !== 'symlink') chmodSync(path, entry.mode)
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
