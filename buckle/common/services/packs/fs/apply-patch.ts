import { constants, fstatSync, readFileSync, statSync, writeSync } from 'node:fs'
import { basename, dirname } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openRealDirectory, withFileBeneath } from '../../../adapters/beneath.js'
import { removeBeneath } from '../../../adapters/remove-beneath.js'
import { replaceBeneath } from '../../../adapters/replace-beneath.js'
import type { ToolEffect } from '../../../domain/effect.js'
import type { PathView } from '../../../domain/path-view.js'
import { ToolInputError, type WrittenFile } from '../../../domain/tool.js'
import { isMissingPathError } from '../../../domain/filesystem-errors.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { judgedPath } from '../judged-path.js'
import { entryOf, kindOf, lstatOrNone } from './delete.js'
import { applyHunks, parseUnifiedDiff, placementBudget, type FileChange, type PlacementBudget } from './unified-diff.js'
import { auditedPath } from './transfer.js'
import type * as schemas from './schemas.js'

/** The largest file a patch leaves, as fs_write writes one. */
const MAX_FILE_BYTES = 10 * 1_048_576
/** The most files one patch touches, as a batch holds. */
const MAX_PATCH_FILES = 100

/** A patch as read before any rule judges it: each file it touches, in order. */
export interface SettledPatch { files: FileChange[] }

export interface PatchContext {
  paths: PathView
  authorizeReadTarget?: (target: string) => boolean
  authorizeWrite?: (target: string) => boolean
  authorizeDelete?: (target: string) => boolean
  known?: (target: string) => void
  /** A file the patch deleted: the session's read set forgets it (ToolContext.relocated). */
  relocated?: (from: string, to: null) => void
  /** Buckle's protected roots: a hard-linked file on their device is not read (isLinkedOnStateDevice), as fs_read refuses it. */
  protectedRoots?: readonly string[]
  signal: AbortSignal
}

/**
 * What fs_apply_patch settles before any rule judges it (ToolDefinition.judge): the diff read whole, so a patch Buckle
 * cannot read, one past MAX_PATCH_FILES, or one that names a file twice, is refused before anyone is asked. No file is
 * read here: whether each hunk matches is known once the call is judged.
 */
export function settleApplyPatch(input: z.output<typeof schemas.applyPatchInput>, context: { paths: PathView }): SettledPatch {
  const files = parseUnifiedDiff(input.patch)
  if (files.length > MAX_PATCH_FILES) throw new ToolInputError(`The patch touches ${files.length} files, more than the ${MAX_PATCH_FILES} one call patches: split it`)
  const seen = new Set<string>()
  for (const file of files) {
    const target = resolveTarget(context.paths.resolve(file.path), { shares: context.paths.shares })
    if (seen.has(target)) throw new ToolInputError(`The patch names ${file.path} more than once: give each file one --- and +++ pair`)
    seen.add(target)
  }
  return { files }
}

/**
 * fs_apply_patch's effects: a write per file it changes or creates, a read of each file it reads to change or delete, and
 * a delete, at the destructive floor, of each file it deletes.
 */
export function patchEffects(judged: SettledPatch): ToolEffect[] {
  return judged.files.flatMap((file): ToolEffect[] => {
    if (file.kind === 'create') return [{ kind: 'write_path', path: file.path }]
    if (file.kind === 'delete') return [{ kind: 'read_path', path: file.path }, { kind: 'delete_path', path: file.path, floor: true }]
    return [{ kind: 'read_path', path: file.path }, { kind: 'write_path', path: file.path }]
  })
}

/** What each changed file holds afterwards, for the destructive-write check, where the file may be read; a deleted one is at the floor already. */
export function patchedSizes(judged: SettledPatch, current: (path: string) => Buffer | null): WrittenFile[] {
  // One budget for the patch: a hunk that cannot be placed within it is refused when the patch runs, and writes nothing.
  const budget = placementBudget()
  return judged.files.flatMap((file) => {
    if (file.kind !== 'modify') return []
    const before = current(file.path)
    if (before === null) return []
    try { return [{ path: file.path, size: applyHunks(file, before, budget).byteLength }] } catch { return [] }
  })
}

/** The description's files and the audit's: every path the patch touches, as it names them. */
export function patchFacts(judged: SettledPatch): JsonObject {
  return { files: judged.files.map(file => file.path) }
}

export function patchedFacts(input: z.output<typeof schemas.applyPatchInput>): JsonObject {
  try { return { files: parseUnifiedDiff(input.patch).map(file => auditedPath(file.path)) } } catch { return {} }
}

/**
 * Applies the patch all or nothing: every hunk of every file is applied in memory to the file where its permission check
 * judged it, read beneath its folder without following a link, before any byte is written, and the first that does not
 * match is refused by file and hunk with nothing changed. Then each file is written as a copy lands (replaceBeneath:
 * a new file beside it, renamed over it, its mode kept), a created file's missing folders made as fs_write's
 * createParents makes them, and each deleted file is removed. MAX_FILE_BYTES holds for each file a patch leaves.
 */
export async function applyPatch(context: PatchContext, judged: SettledPatch): Promise<JsonValue> {
  const budget = placementBudget()
  const planned = judged.files.map(file => plan(file, context, budget))
  const results: JsonObject[] = []
  for (const step of planned) {
    try {
      results.push(await writeStep(step, context))
    } catch (error) {
      throw interrupted({ error, step, written: results, context })
    }
  }
  return { files: results }
}

async function writeStep(step: Step, context: PatchContext): Promise<JsonObject> {
  if (step.file.kind === 'delete') {
    const directory = openRealDirectory(step.directory, { refusal: { shown: step.file.path, outcome: 'nothing more was changed' } })
    try { await removeBeneath({ directory, name: basename(step.target), shown: step.file.path, tree: false }) } finally { directory.close() }
    context.relocated?.(step.target, null)
    return { path: context.paths.display(step.target), change: 'deleted' }
  }
  const directory = openRealDirectory(step.directory, { create: step.file.kind === 'create', refusal: { shown: step.file.path, outcome: 'nothing more was changed' } })
  try {
    await replaceBeneath({ directory, name: basename(step.target), named: step.file.path, signal: context.signal, fill: async descriptor => writeAll(descriptor, step.content) })
  } finally { directory.close() }
  context.known?.(step.target)
  return { path: context.paths.display(step.target), change: step.file.kind === 'create' ? 'created' : 'modified', size: step.content.byteLength }
}

/**
 * A write that failed after the plan held: the refusal says which file stopped it and, where earlier files were already
 * written, lists them and says to read them again before anything more is sent, since the patch no longer matches them.
 * A call that was cut off (an abort) stays an abort. With nothing written yet a refusal keeps its own words and code, and
 * an error the disk gave is worded with its code, so nothing was written.
 */
function interrupted(input: { error: unknown; step: Step; written: JsonObject[]; context: PatchContext }): unknown {
  const { error, step, written, context } = input
  if (context.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return error
  if (written.length === 0 && error instanceof ToolInputError) return error
  const reason = error instanceof ToolInputError
    ? error.message.split(';')[0]!.replace(/, so nothing (was|more was) (written|changed)$/, '')
    : `${step.file.path} could not be written (${String(error instanceof Error && 'code' in error ? error.code : 'an error')})`
  const options = error instanceof ToolInputError ? { code: error.code } : {}
  if (written.length === 0) return new ToolInputError(`${reason}, so nothing was written`, options)
  const done = written.map(item => `${String(item.change)} ${String(item.path)}`).join(', ')
  return new ToolInputError(`${reason}. Already written: ${done}. The patch no longer matches those files: read them again and send only what is left; the change history can restore them`, options)
}

interface Step { file: FileChange; target: string; directory: string; content: Buffer }

/** One file's new content, worked out where its check judged it, before anything is written. */
function plan(file: FileChange, context: PatchContext, budget: PlacementBudget): Step {
  if (file.kind === 'delete') {
    const entry = entryOf(file.path, context.paths)
    if (context.authorizeDelete && !context.authorizeDelete(entry.path)) throw new ToolInputError(`${file.path} now lands where its permission check did not see, so nothing was written; send the call again`, { code: 'PERMISSION_DENIED' })
    const kind = kindOf(lstatOrNone(entry.path))
    if (kind !== 'file') throw new ToolInputError(kind === 'missing' ? `The patch deletes ${file.path}, which does not exist, so nothing was written` : `The patch deletes ${file.path}, which is a ${kind}, not a file, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
    return { file, target: entry.path, directory: entry.directory, content: applyHunks(file, readJudged(entry.path, file.path, context), budget) }
  }
  const target = judgedPath({ named: file.path, kind: 'write', paths: context.paths, context })
  if (file.kind === 'create') {
    if (lstatOrNone(target) !== undefined) throw new ToolInputError(`The patch creates ${file.path}, which exists already, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
    const blocking = firstNonFolder(dirname(target))
    if (blocking !== null) throw new ToolInputError(`The patch creates ${file.path}, but ${context.paths.display(blocking)} is a file, not a folder, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
    return { file, target, directory: dirname(target), content: sized(applyHunks(file, null, budget), file.path) }
  }
  if (context.authorizeReadTarget && !context.authorizeReadTarget(target)) throw new ToolInputError(`${file.path} now resolves to a place its permission check did not see; send the call again`, { code: 'PERMISSION_DENIED' })
  return { file, target, directory: dirname(target), content: sized(applyHunks(file, readJudged(target, file.path, context), budget), file.path) }
}

/** The nearest existing entry at or above a folder a created file lands in, if it is not a folder (or a link to one): a file there stops the folders from being made. */
function firstNonFolder(folder: string): string | null {
  for (let path = folder; ; path = dirname(path)) {
    const info = lstatOrNone(path)
    if (info !== undefined) return kindOf(info) === 'directory' || (info.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) ? null : path
    if (dirname(path) === path) return null
  }
}

function readJudged(target: string, named: string, context: PatchContext): Buffer {
  try {
    return withFileBeneath(target, { flags: constants.O_RDONLY, shown: named, ...(context.protectedRoots ? { protectedRoots: context.protectedRoots, roots: context.paths.reachableRoots } : {}) }, (descriptor) => {
      if (fstatSync(descriptor).size > MAX_FILE_BYTES) throw new ToolInputError(`${named} exceeds ${MAX_FILE_BYTES} bytes, so nothing was written`)
      return readFileSync(descriptor)
    })
  } catch (error) {
    if (isMissingPathError(error)) throw new ToolInputError(`The patch changes ${named}, which does not exist, so nothing was written`, { code: 'PATCH_DOES_NOT_APPLY' })
    throw error
  }
}

function sized(content: Buffer, named: string): Buffer {
  if (content.byteLength > MAX_FILE_BYTES) throw new ToolInputError(`The patch leaves ${named} at ${content.byteLength} bytes, more than the ${MAX_FILE_BYTES} a file may hold, so nothing was written`)
  return content
}

async function writeAll(descriptor: number, content: Buffer): Promise<void> {
  let written = 0
  while (written < content.byteLength) written += writeSync(descriptor, content, written, content.byteLength - written)
}
