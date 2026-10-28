import { lstatSync, readdirSync, type BigIntStats, type Stats } from 'node:fs'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openRealDirectory, type PinnedDirectory } from '../../../adapters/beneath.js'
import { countTree, FOLDER_NOT_EMPTY, removeBeneath, type RemoveIo } from '../../../adapters/remove-beneath.js'
import type { DeleteEffect, TreeCount } from '../../../domain/effect.js'
import type { PathView } from '../../../domain/path-view.js'
import { rootHeldBy } from '../../../domain/permission/rules/write-scope-rule.js'
import { isInsideAny } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { isMissingPathError, resolveEntry } from '../../invocation/real-path.js'
import { auditedPath } from './transfer.js'
import type * as schemas from './schemas.js'

/** What an entry is, as lstat sees it: a link is a link, whatever it points to. */
export type EntryKind = 'file' | 'link' | 'directory' | 'other' | 'missing'

/** Where a named entry really is: its folder resolved as any path is, its own name kept, never followed. */
export interface Entry { path: string; directory: string; name: string }

/** fs_delete's entries as they stood before any rule judged the call: what each is, and what a folder removed whole holds. */
export interface SettledDelete { entries: Array<{ kind: EntryKind; tree?: TreeCount }> }

export interface DeleteContext {
  paths: PathView
  /** Whether a real entry path is one the call's permission check judged as a delete (ToolContext.authorizeDelete). */
  authorizeDelete?: (target: string) => boolean
  /** An entry removed: the session's read set forgets it (ToolContext.relocated). */
  relocated?: (from: string, to: null) => void
  /** The removals, for a test to hand in its own; the host's `platform` unless a test imitates another. */
  io?: RemoveIo
  platform?: NodeJS.Platform
}

/** The named path's entry, the entry itself (resolveEntry): a root names none, and a name Buckle would read as another path is refused. */
export function entryOf(named: string, paths: PathView): Entry {
  const entry = resolveEntry(paths.resolve(named), { shares: paths.shares })
  if (entry === null) throw new ToolInputError(`${named} names no entry in a folder, so it is not removed or moved`)
  return entry
}

/** lstat, or undefined where nothing stands: a missing name, or one beneath a file (ENOTDIR). */
export function lstatOrNone(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

export function kindOf(info: Stats | BigIntStats | undefined): EntryKind {
  if (info === undefined) return 'missing'
  if (info.isSymbolicLink()) return 'link'
  if (info.isDirectory()) return 'directory'
  return info.isFile() ? 'file' : 'other'
}

/**
 * What fs_delete settles before any rule judges it (ToolDefinition.judge): what each entry is, and what a folder removed
 * whole holds, counted where it lies inside the roots the agent may name, so the ask can say so. There too, a folder
 * that holds entries named without `recursive`, or an entry that is neither a file, a link, nor a folder, is refused at
 * once, so no person is asked about a delete that would not happen; elsewhere nothing is looked into before a person
 * allows the call, and the same refusals come as it runs. A folder the workspace shows is neither counted nor told to
 * send `recursive`: the write rule refuses it whatever it holds, with its reason (rootHeldBy).
 */
export function settleDelete(input: z.output<typeof schemas.deleteInput>, context: { paths: PathView }): SettledDelete {
  return {
    entries: input.paths.map((named) => {
      const entry = entryOf(named, context.paths)
      const kind = kindOf(lstatOrNone(entry.path))
      const inside = isInsideAny(context.paths.reachableRoots, entry.path)
      if (kind !== 'directory') {
        if (kind === 'other' && inside) throw notRemovable(named)
        return { kind }
      }
      if (rootHeldBy(entry.path, context.paths) !== undefined) return { kind }
      if (!input.recursive) {
        if (inside && readdirSync(entry.path).length > 0) throw new ToolInputError(`${named} is a folder that holds entries: send recursive: true to delete it and everything in it`, { code: FOLDER_NOT_EMPTY })
        return { kind }
      }
      return { kind, tree: inside ? counted(entry, named, true) : { counted: false } }
    }),
  }
}

/** One delete_path per entry, at the floor; an entry missing inside the roots the agent may name is no effect, and is reported as missing. */
export function deleteEffects(input: z.output<typeof schemas.deleteInput>, judged: SettledDelete, paths: PathView): DeleteEffect[] {
  return input.paths.flatMap((path, index) => {
    const settled = judged.entries[index]!
    if (settled.kind === 'missing' && isInsideAny(paths.reachableRoots, entryOf(path, paths).path)) return []
    return [{ kind: 'delete_path' as const, path, floor: true, ...(settled.tree ? { tree: settled.tree } : {}) }]
  })
}

/** fs_delete's audit facts: every path it was asked to remove, credentials hidden. */
export function deletedFacts(input: z.output<typeof schemas.deleteInput>): JsonObject {
  return { paths: input.paths.map(auditedPath) }
}

/**
 * Removes each entry in order, where its permission check judged it, from a folder reached without following a link
 * (removeBeneath). The result lists every path: removed, missing (reported, never fatal), or the refusal that stopped the
 * batch, and after it each path not attempted, so nothing is hidden. An entry that changed kind since it was judged, or
 * now lands where its check did not see, is refused rather than removed.
 */
export async function deletePaths(input: z.output<typeof schemas.deleteInput>, context: DeleteContext, judged: SettledDelete): Promise<JsonValue> {
  const results: JsonObject[] = []
  let refused = false
  for (const [index, named] of input.paths.entries()) {
    const shown = shownPath(named, context.paths)
    if (refused) { results.push({ path: shown, removed: false, notAttempted: true }); continue }
    try {
      results.push({ ...await deleteOne({ named, judged: judged.entries[index]!, recursive: input.recursive, context }), path: shown })
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error
      refused = true
      results.push({ path: shown, removed: false, refused: error.message, code: error.code })
    }
  }
  return { removed: results.filter(result => result.removed === true).length, results }
}

/** A path as the other tools answer it: relative to the workspace's folder inside it; as it was sent where the view cannot place it. */
function shownPath(named: string, paths: PathView): string {
  try {
    return paths.display(paths.resolve(named))
  } catch (error) {
    if (error instanceof ToolInputError) return named
    throw error
  }
}

async function deleteOne(input: { named: string; judged: SettledDelete['entries'][number]; recursive: boolean; context: DeleteContext }): Promise<JsonObject> {
  const { named, context } = input
  const missing = { path: named, removed: false, missing: true }
  const entry = entryOf(named, context.paths)
  if (context.authorizeDelete && !context.authorizeDelete(entry.path)) {
    // Judged missing where nothing is looked into, and missing still: reported. Anything else lands where no check saw.
    if (input.judged.kind === 'missing' && lstatOrNone(entry.path) === undefined) return missing
    throw new ToolInputError(`${named} now lands where its permission check did not see, so nothing was removed there; send the call again`, { code: 'PERMISSION_DENIED' })
  }
  let directory: PinnedDirectory
  try {
    directory = openRealDirectory(entry.directory, { refusal: { shown: named, outcome: 'nothing was removed' } })
  } catch (error) {
    if (isMissingPathError(error)) return missing
    if (error instanceof ToolInputError) throw error
    throw notRemoved(named, error, false)
  }
  try {
    const kind = kindOf(lstatOrNone(directory.child(entry.name)))
    if (kind === 'missing') return missing
    if (kind === 'other') throw notRemovable(named)
    if (kind !== input.judged.kind) throw new ToolInputError(`${named} is a ${kind} now, not the ${input.judged.kind} its permission check saw, so nothing was removed; send the call again`, { code: 'PERMISSION_DENIED' })
    const tree = input.recursive && kind === 'directory'
    try {
      await removeBeneath({ directory, name: entry.name, shown: named, tree, ...(context.io ? { io: context.io } : {}), ...(context.platform ? { platform: context.platform } : {}) })
    } catch (error) {
      // What the system refuses (a read-only folder, a lock) is this path's refusal, not the batch's failure: the paths removed before it are reported.
      if (error instanceof ToolInputError || (error instanceof Error && error.name === 'AbortError')) throw error
      // A folder removed whole that stopped part way is gone in part: what it held is no longer known to the session.
      if (tree) context.relocated?.(entry.path, null)
      throw notRemoved(named, error, tree)
    }
    context.relocated?.(entry.path, null)
    return { path: named, removed: true }
  } finally { directory.close() }
}

function counted(entry: Entry, named: string, removal = false): TreeCount {
  const parent = openRealDirectory(entry.directory, { refusal: { shown: named, outcome: 'nothing was removed' } })
  try { return countTree(parent, entry.name, named, removal ? {} : undefined) } finally { parent.close() }
}

/** A removal the system refused (EACCES, EPERM, EROFS) or failed, as the path's own refusal; a folder removed whole may be gone in part. */
function notRemoved(named: string, error: unknown, tree: boolean): ToolInputError {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'an error'
  const refused = ['EACCES', 'EPERM', 'EROFS'].includes(code)
  return new ToolInputError(`${named} could not be removed (${code})${tree ? ', so what it holds may be removed only in part' : ''}`, { code: refused ? 'PERMISSION_DENIED' : 'REMOVAL_FAILED' })
}

function notRemovable(named: string): ToolInputError {
  return new ToolInputError(`${named} is neither a file, a link, nor a folder (a socket, a device, or a pipe), so it is not removed`)
}
