import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { constants, ftruncateSync, readFileSync, writeSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, matchesGlob, relative } from 'node:path'
import type { JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { withFileBeneath } from '../../../adapters/beneath.js'
import type { PathView } from '../../../domain/path-view.js'
import { ToolInputError } from '../../../domain/tool.js'
import { isMissingPathError, resolveTarget } from '../../invocation/real-path.js'
import { isIgnoredDirectory } from './ignore.js'
import type * as schemas from './schemas.js'

const MAX_FILE_BYTES = 10 * 1_048_576
const MAX_TREE_ENTRIES = 5_000

export interface FsContext {
  paths: PathView
  authorizeRead?: (path: string) => Promise<boolean>
  authorizeWrite?: (target: string) => boolean
}

export async function readFileEntry(
  input: z.output<typeof schemas.readInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const info = await stat(path)
  if (!info.isFile()) throw new ToolInputError(`Not a file: ${input.path}`)
  if (info.size > MAX_FILE_BYTES) throw new ToolInputError(`File exceeds ${MAX_FILE_BYTES} bytes`)

  const buffer = await readFile(path)
  const hash = createHash('sha256').update(buffer).digest('hex')
  if (input.encoding === 'base64') {
    return { path: context.paths.display(path), encoding: 'base64', hash, content: buffer.toString('base64'), size: info.size }
  }

  const lines = buffer.toString('utf8').split('\n')
  const start = (input.offset ?? 1) - 1
  const end = input.limit === undefined ? lines.length : start + input.limit
  const slice = lines.slice(start, end)

  return {
    path: context.paths.display(path),
    encoding: 'utf8',
    validUtf8: isUtf8(buffer),
    hash,
    content: slice.join('\n'),
    size: info.size,
    firstLine: start + 1,
    lineCount: slice.length,
    totalLines: lines.length,
    truncated: end < lines.length || start > 0,
  }
}

export async function writeFileEntry(
  input: z.output<typeof schemas.writeInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const content = Buffer.from(input.content, input.encoding)
  if (content.byteLength > MAX_FILE_BYTES) throw new ToolInputError(`Content exceeds ${MAX_FILE_BYTES} bytes`)
  const target = writeTarget(path, context)
  const createParents = input.createParents === true
  if (input.expectedHash) {
    // Buckle's comparison and write share one descriptor and one event-loop turn; host editors remain independent.
    const expected = input.expectedHash
    try {
      withFileBeneath(target, { flags: constants.O_RDWR, createParents }, (descriptor) => {
        if (createHash('sha256').update(readFileSync(descriptor)).digest('hex') !== expected) throw new ToolInputError('File changed since it was opened. Reload before saving.')
        replaceContent(descriptor, content)
      })
    } catch (error) {
      if (isMissingPathError(error)) throw new ToolInputError('File changed or is unavailable. Reload before saving.')
      throw error
    }
  } else {
    withFileBeneath(target, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, createParents }, descriptor => writeAll(descriptor, content))
  }
  return { path: context.paths.display(path), size: content.byteLength, hash: createHash('sha256').update(content).digest('hex') }
}

export async function patchFile(
  input: z.output<typeof schemas.patchInput>,
  context: FsContext,
): Promise<JsonValue> {
  const path = context.paths.resolve(input.path)
  const target = writeTarget(path, context)
  return withFileBeneath(target, { flags: constants.O_RDWR }, (descriptor) => {
    let content = readFileSync(descriptor, 'utf8')
    const replacements: number[] = []

    for (const edit of input.edits) {
      const count = countOccurrences(content, edit.oldText)
      if (count === 0) throw new ToolInputError('Patch text was not found')
      if (!edit.replaceAll && count !== 1) {
        throw new ToolInputError(`Patch text matched ${count} times; set replaceAll or add surrounding context`)
      }
      content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, edit.newText)
      replacements.push(edit.replaceAll ? count : 1)
    }

    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ToolInputError(`Patched file exceeds ${MAX_FILE_BYTES} bytes`)
    replaceContent(descriptor, Buffer.from(content, 'utf8'))
    return { path: context.paths.display(path), replacements, size: Buffer.byteLength(content) }
  })
}

/**
 * Where a write lands: the named path with every link followed, dangling ones included, which is what
 * the permission rules judged (resolve-effects.ts). When the call carries its judged targets, a path
 * that resolves anywhere else now (a link swapped in while the call waited) is refused.
 */
function writeTarget(path: string, context: FsContext): string {
  const target = resolveTarget(path)
  if (context.authorizeWrite && !context.authorizeWrite(target)) {
    throw new ToolInputError(`${context.paths.display(path)} now resolves to a place its permission check did not see; send the call again`, { code: 'PERMISSION_DENIED' })
  }
  return target
}

function replaceContent(descriptor: number, content: Buffer): void {
  ftruncateSync(descriptor, 0)
  writeAll(descriptor, content)
}

function writeAll(descriptor: number, content: Buffer): void {
  let offset = 0
  while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset, offset)
}

export async function listTree(
  input: z.output<typeof schemas.listInput>,
  context: FsContext,
): Promise<JsonValue> {
  const root = context.paths.resolve(input.path)
  const entries: JsonValue[] = []
  await walkTree({ root, current: root, depth: input.depth, includeIgnored: input.includeIgnored, entries, authorizeRead: context.authorizeRead })
  return { path: context.paths.display(root), entries, truncated: entries.length >= MAX_TREE_ENTRIES }
}

export async function findNames(
  input: z.output<typeof schemas.findInput>,
  context: FsContext,
): Promise<JsonValue> {
  const root = context.paths.resolve(input.path)
  const matches: string[] = []
  await walkNames({ root, current: root, pattern: input.pattern, limit: input.limit, includeIgnored: input.includeIgnored, matches, authorizeRead: context.authorizeRead })
  return { path: context.paths.display(root), matches, truncated: matches.length >= input.limit }
}

async function walkTree(input: {
  root: string
  current: string
  depth: number
  includeIgnored: boolean
  entries: JsonValue[]
  authorizeRead?: (path: string) => Promise<boolean>
}): Promise<void> {
  if (input.entries.length >= MAX_TREE_ENTRIES) return
  const children = (await readdir(input.current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const child of children) {
    if (input.entries.length >= MAX_TREE_ENTRIES) return
    if (child.isDirectory() && isIgnoredDirectory(child.name, input.includeIgnored)) continue

    const childPath = join(input.current, child.name)
    if (input.authorizeRead && !await input.authorizeRead(childPath)) continue
    const info = await lstat(childPath)
    input.entries.push({
      path: relative(input.root, childPath),
      name: child.name,
      type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    })
    if (child.isDirectory() && !child.isSymbolicLink() && input.depth > 0) {
      await walkTree({ ...input, current: childPath, depth: input.depth - 1 })
    }
  }
}

async function walkNames(input: {
  root: string
  current: string
  pattern: string
  limit: number
  includeIgnored: boolean
  matches: string[]
  authorizeRead?: (path: string) => Promise<boolean>
}): Promise<void> {
  if (input.matches.length >= input.limit) return
  for (const child of await readdir(input.current, { withFileTypes: true })) {
    if (input.matches.length >= input.limit) return
    if (child.isDirectory() && isIgnoredDirectory(child.name, input.includeIgnored)) continue

    const childPath = join(input.current, child.name)
    if (input.authorizeRead && !await input.authorizeRead(childPath)) continue
    const relativePath = relative(input.root, childPath)
    if (matchesGlob(relativePath, input.pattern) || matchesGlob(basename(relativePath), input.pattern)) {
      input.matches.push(relativePath)
    }
    if (child.isDirectory() && !child.isSymbolicLink()) await walkNames({ ...input, current: childPath })
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let position = 0
  while ((position = content.indexOf(needle, position)) !== -1) {
    count += 1
    position += needle.length
  }
  return count
}

