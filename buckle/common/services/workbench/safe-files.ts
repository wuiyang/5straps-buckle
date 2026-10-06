import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { dirname, join, relative } from 'pathe'
// node:path's matchesGlob, not pathe's, which matches otherwise: here a `*` leaves dot names out and a leading `!` is
// literal, as the staged editor always matched. Case is folded where the volume ignores it (globMatches).
import { matchesGlob } from 'node:path'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { createPathView } from '../../domain/path-view.js'
import { isIgnoredDirectory } from '../packs/fs/ignore.js'
import { readInput, writeInput, listInput, findInput, searchInput } from '../packs/fs/schemas.js'
import { WorkbenchError, workbenchHash } from './storage.js'
import { comparablePath, ignoresCase, isPlainName } from '../../domain/paths.js'

const MAX_BYTES = 10 * 1_048_576
/** `platform`: the host's unless a test imitates another; on Windows and macOS a glob ignores case (globMatches). */
interface SafeFilesInput { root: string; tool: string; args: JsonObject; permitted(path: string, operation: 'read' | 'write'): boolean; platform?: NodeJS.Platform }
export function invokePinnedWorkbenchFile(input: SafeFilesInput): JsonValue {
  const view = createPathView({ root: input.root, mount: '/workspace' })
  const relativeName = (named: string) => relative(input.root, view.resolve(named)) || '.'
  function allow(path: string, operation: 'read' | 'write') {
    if (!input.permitted(path, operation)) throw new WorkbenchError('Workspace permission does not allow this operation', 403)
  }
  function directory<T>(path: string, operation: (descriptor: number) => T): T {
    const descriptors: number[] = []
    try {
      let current = openSync(input.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      descriptors.push(current)
      for (const part of path === '.' ? [] : path.split('/')) {
        current = openSync('/proc/self/fd/' + current + '/' + part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        descriptors.push(current)
      }
      return operation(current)
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['ELOOP', 'ENOTDIR'].includes(String(error.code))) throw new WorkbenchError('Symbolic links are not accessible in the staged editor', 403)
      throw error
    } finally { for (const descriptor of descriptors.reverse()) closeSync(descriptor) }
  }
  function file<T>(path: string, write: boolean, operation: (descriptor: number) => T): T {
    allow(path, 'read'); if (write) allow(path, 'write')
    return directory(dirname(path), parent => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const descriptor = openSync('/proc/self/fd/' + parent + '/' + name, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = fstatSync(descriptor)
        if (!stat.isFile() || stat.nlink > 1) throw new WorkbenchError('Only ordinary files without hard links can be edited', 403)
        return operation(descriptor)
      } finally { closeSync(descriptor) }
    })
  }
  function content(descriptor: number): Buffer {
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, MAX_BYTES + 1 - size))
      const count = readSync(descriptor, chunk, 0, chunk.length, size)
      if (!count) return Buffer.concat(chunks)
      size += count
      if (size > MAX_BYTES) throw new WorkbenchError('File exceeds the editor size limit', 413)
      chunks.push(chunk.subarray(0, count))
    }
  }
  function walk(root: string, depth: number, includeIgnored: boolean): Array<{ path: string; name: string; type: string; size: number; modifiedAt: string }> {
    const entries: Array<{ path: string; name: string; type: string; size: number; modifiedAt: string }> = []
    function visit(path: string, remaining: number): void {
      directory(path, descriptor => {
        for (const child of readdirSync('/proc/self/fd/' + descriptor, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= 5000) return
          // A name pathe would read as another path (a backslash on Linux) would be judged there: left out.
          if (!isPlainName(child.name)) continue
          const named = path === '.' ? child.name : path + '/' + child.name
          if (!input.permitted(named, 'read') || child.isSymbolicLink() || child.isDirectory() && isIgnoredDirectory(child.name, includeIgnored)) continue
          const info = lstatSync('/proc/self/fd/' + descriptor + '/' + child.name)
          if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) continue
          entries.push({ path: relative(root, named), name: child.name, type: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() })
          if (info.isDirectory() && remaining > 0) visit(named, remaining - 1)
        }
      })
    }
    allow(root, 'read'); visit(root, depth)
    return entries
  }
  if (input.tool === 'fs_read') {
    const args = readInput.parse(input.args), path = relativeName(args.path)
    return file(path, false, (descriptor): JsonValue => {
      const buffer = content(descriptor), hash = workbenchHash(buffer)
      if (args.encoding === 'base64') return { path, hash, encoding: 'base64', content: buffer.toString('base64'), size: buffer.length }
      const lines = buffer.toString('utf8').split('\n'), start = (args.offset ?? 1) - 1, end = args.limit === undefined ? lines.length : start + args.limit
      return { path, hash, encoding: 'utf8', validUtf8: isUtf8(buffer), content: lines.slice(start, end).join('\n'), size: buffer.length, firstLine: start + 1, lineCount: lines.slice(start, end).length, totalLines: lines.length, truncated: start > 0 || end < lines.length }
    })
  }
  if (input.tool === 'fs_write') {
    const args = writeInput.parse(input.args), path = relativeName(args.path)
    if (!args.expectedHash) throw new WorkbenchError('Saving requires the file revision returned by fs_read', 400)
    const buffer = Buffer.from(args.content, args.encoding)
    if (buffer.length > MAX_BYTES) throw new WorkbenchError('File exceeds the editor size limit', 413)
    return file(path, true, descriptor => {
      if (workbenchHash(content(descriptor)) !== args.expectedHash) throw new WorkbenchError('File changed since it was opened. Reload before saving.')
      ftruncateSync(descriptor, 0); writeFileSync(descriptor, buffer)
      return { path, hash: workbenchHash(buffer), size: buffer.length }
    })
  }
  if (input.tool === 'fs_list') {
    const args = listInput.parse(input.args), path = relativeName(args.path)
    const entries = walk(path, args.depth, args.includeIgnored)
    return { path, entries, truncated: entries.length >= 5000 }
  }
  if (input.tool === 'fs_find_names') {
    const args = findInput.parse(input.args), path = relativeName(args.path)
    const all = walk(path, 10, args.includeIgnored)
    const matches = all.filter(entry => globMatches(entry.path, args.pattern, input.platform)).slice(0, args.limit).map(entry => entry.path)
    return { path, matches, truncated: matches.length >= args.limit || all.length >= 5000 }
  }
  if (input.tool === 'fs_search_content') {
    const args = searchInput.parse(input.args), path = relativeName(args.path)
    const entries = walk(path, 10, false)
    const matches: Array<{ path: string; line: number; text: string }> = []
    const pattern = args.caseSensitive ? args.pattern : args.pattern.toLowerCase()
    let scannedBytes = 0, budgetExhausted = false
    for (const entry of entries) {
      if (entry.type !== 'file' || args.glob && !globMatches(entry.path, args.glob, input.platform) || entry.size > MAX_BYTES) continue
      if ((scannedBytes += entry.size) > 64 * 1_048_576) { budgetExhausted = true; break }
      const buffer = file(join(path, entry.path), false, content)
      if (!isUtf8(buffer) || buffer.includes(0)) continue
      for (const [index, line] of buffer.toString('utf8').split('\n').entries()) {
        if ((args.caseSensitive ? line : line.toLowerCase()).includes(pattern)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 2000) })
        if (matches.length >= args.limit) break
      }
      if (matches.length >= args.limit) break
    }
    return { path, matches, truncated: budgetExhausted || matches.length >= args.limit || entries.length >= 5000, literal: true }
  }
  throw new WorkbenchError('Tool is unavailable in the staged workbench', 400)
}

/** A glob match as the volume compares names: case folded on Windows and macOS (comparablePath), exact elsewhere. */
function globMatches(path: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  return matchesGlob(comparablePath(path, ignoresCase(platform)), comparablePath(pattern, ignoresCase(platform)))
}
