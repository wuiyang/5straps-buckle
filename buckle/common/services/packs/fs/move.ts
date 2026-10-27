import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { basename } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openRealDirectory, type PinnedDirectory } from '../../../adapters/beneath.js'
import { copyBeneath } from '../../../adapters/copy-beneath.js'
import { countTree, removeBeneath, type RemoveIo } from '../../../adapters/remove-beneath.js'
import { PARTIAL_PREFIX } from '../../../adapters/replace-beneath.js'
import { isHeldOpen, replaceFile, type RenameIo } from '../../../adapters/replace-file.js'
import type { ToolEffect, TreeCount } from '../../../domain/effect.js'
import type { PathView } from '../../../domain/path-view.js'
import { isInside, isInsideAny } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { isMissingPathError, resolveTarget } from '../../invocation/real-path.js'
import { entryOf, kindOf, lstatOrNone, type Entry, type EntryKind } from './delete.js'
import { auditedPath, FILE_NOT_FOUND, PARENT_MISSING } from './transfer.js'
import type * as schemas from './schemas.js'

/** A `to` where something stands already, which a move does not replace unless asked to. */
export const TARGET_EXISTS = 'TARGET_EXISTS'
/** A folder too large for its checkpoint to cover whole (MAX_COUNTED_ENTRIES). */
export const FOLDER_TOO_LARGE = 'FOLDER_TOO_LARGE'

/** The renames, removals, and pause a move uses; a test hands in its own. */
export type MoveIo = RenameIo & RemoveIo

const SYSTEM_MOVE: MoveIo = { rename: renameSync, unlink: unlinkSync, rmdir: rmdirSync, pause: ms => delay(ms) }

/**
 * A move as it stood before any rule judged it: the source and what it is, where it lands (`to` itself, or `to/<name>`
 * where `to` is a folder or ends in a separator), what stands there, and whether the move replaces it.
 */
export interface SettledMove {
  from: Entry & { kind: EntryKind; tree?: TreeCount }
  /** The landing as the agent's path names it, which its effects name and its run opens. */
  landing: string
  target: Entry & { kind: EntryKind | 'same' }
  replaces: boolean
}

export interface MoveContext {
  paths: PathView
  authorizeDelete?: (target: string) => boolean
  authorizeWrite?: (target: string) => boolean
  /** The move done: the session's read set follows the entry (ToolContext.relocated). */
  relocated?: (from: string, to: string | null) => void
  io?: MoveIo
  platform?: NodeJS.Platform
}

/**
 * What fs_move settles before any rule judges it (ToolDefinition.judge): the landing, which a folder `to` or a trailing
 * separator makes `to/<the source's name>` (a backslash is a separator on Windows alone), what stands at each end, and
 * what a folder moved whole holds. Inside the roots the agent may name, a move that would not happen is refused at
 * once, so no person is asked about it: no source, a landing taken without `replace`, a landing that is a folder, a
 * missing folder to land in (a move makes none), a folder moved into itself, or one past the entries its checkpoint
 * covers. Elsewhere the same refusals come once a person allowed the call.
 */
export function settleMove(input: z.output<typeof schemas.moveInput>, context: { paths: PathView; platform?: NodeJS.Platform }): SettledMove {
  const platform = context.platform ?? process.platform
  const from = entryOf(input.from, context.paths)
  const fromKind = kindOf(lstatOrNone(from.path))
  const inside = (path: string) => isInsideAny(context.paths.reachableRoots, path)
  const refuseInside = (path: string, refusal: () => ToolInputError) => { if (inside(path)) throw refusal() }
  if (fromKind === 'missing') refuseInside(from.path, () => noSource(input.from))
  if (fromKind === 'other') refuseInside(from.path, () => notMovable(input.from))

  const named = intoFolder(input, context.paths, platform) ? `${withoutSeparator(input.to, platform)}/${from.name}` : input.to
  const target = entryOf(named, context.paths)
  const targetKind = standingAt(from.path, target.path)
  if (endsInSeparator(input.to, platform)) {
    const folder = statSync(resolveTarget(context.paths.resolve(withoutSeparator(input.to, platform)), { shares: context.paths.shares }), { throwIfNoEntry: false })
    if (folder?.isDirectory() !== true) refuseInside(target.directory, () => folder === undefined ? parentMissing(input.to) : new ToolInputError(`${input.to} is a file, not a folder: name it without the trailing separator to move onto it`))
  }
  if (target.path === from.path || targetKind === 'same') throw new ToolInputError(`${input.from} and ${named} name the same file, so nothing was moved`)
  if (fromKind === 'directory' && isInside(from.path, target.path)) throw new ToolInputError(`${input.to} lies inside ${input.from}, and a folder is not moved into itself`)
  if (!statSync(target.directory, { throwIfNoEntry: false })?.isDirectory()) refuseInside(target.directory, () => parentMissing(context.paths.display(target.directory)))
  if (targetKind !== 'missing') {
    if (!input.replace) refuseInside(target.path, () => taken(named))
    if (targetKind === 'directory') refuseInside(target.path, () => folderAtLanding(named))
  }
  const tree = fromKind === 'directory' ? (inside(from.path) ? counted(from, input.from) : { counted: false as const }) : undefined
  if (tree?.counted && tree.more) throw tooLarge(input.from)
  return { from: { ...from, kind: fromKind, ...(tree ? { tree } : {}) }, landing: named, target: { ...target, kind: targetKind }, replaces: input.replace && targetKind !== 'missing' }
}

/**
 * What stands at a landing beside its source: nothing, an entry of its own, or the source's own file under another name.
 * Where the volume ignores case, a landing that differs from the source in case alone is the same entry, which a rename
 * renames (`missing`); any other name of the same file is a hard link, which a rename would leave both of (`same`).
 */
function standingAt(source: string, landing: string): EntryKind | 'same' {
  const standing = lstatOrNone(landing)
  const kind = kindOf(standing)
  const own = lstatOrNone(source)
  if (standing === undefined || own === undefined || standing.ino !== own.ino || standing.dev !== own.dev || standing.ino === 0) return kind
  return basename(source).toLowerCase() === basename(landing).toLowerCase() && basename(source) !== basename(landing) ? 'missing' : 'same'
}

/**
 * fs_move's effects: the source read and removed from its place, and the landing written. The source's removal asks at
 * the destructive floor where the move takes a folder whole or may replace a file (the fs-verbs brief); a file moved
 * where nothing stands asks as a write to each folder does. A file replaced is removed at the floor as well.
 */
export function moveEffects(input: z.output<typeof schemas.moveInput>, judged: SettledMove): ToolEffect[] {
  const folder = judged.from.kind === 'directory'
  return [
    { kind: 'read_path', path: input.from },
    { kind: 'delete_path', path: input.from, floor: input.replace || folder, ...(folder && judged.from.tree ? { tree: judged.from.tree } : {}), ...(folder ? { moved: true as const } : {}) },
    { kind: 'write_path', path: judged.landing, entry: true, ...(folder ? { folder: true as const } : {}) },
    ...(judged.replaces ? [{ kind: 'delete_path' as const, path: judged.landing, floor: true }] : []),
  ]
}

/** What the description names beside the arguments: the landing where it is not `to` itself, and that the move replaces a file. */
export function moveFacts(input: z.output<typeof schemas.moveInput>, judged: SettledMove): JsonObject {
  return { ...(judged.landing === input.to ? {} : { landing: judged.landing }), replaces: judged.replaces }
}

/** fs_move's audit facts: both paths, credentials hidden. */
export function movedFacts(input: z.output<typeof schemas.moveInput>): JsonObject {
  return { from: auditedPath(input.from), to: auditedPath(input.to) }
}

/**
 * Moves the source to its landing where the permission check judged both, each folder reached without following a link:
 * a rename where both lie on one device, tried again where Windows holds the file (replaceFile); across devices or
 * mounts a copy beside the landing, then the rename onto it, then the source's removal, and a failure before that last
 * step leaves the source where it was and removes what the copy made. Nothing that stands at the landing is replaced
 * unless the call says `replace` and its check saw it.
 */
export async function moveEntry(input: z.output<typeof schemas.moveInput>, context: MoveContext, judged: SettledMove): Promise<JsonValue> {
  const io = context.io ?? SYSTEM_MOVE
  const from = entryOf(input.from, context.paths)
  const target = entryOf(judged.landing, context.paths)
  if ((context.authorizeDelete && !context.authorizeDelete(from.path)) || (context.authorizeWrite && !context.authorizeWrite(target.path))) {
    throw new ToolInputError(`${input.from} or ${judged.landing} now lands where its permission check did not see, so nothing was moved; send the call again`, { code: 'PERMISSION_DENIED' })
  }
  const source = openFolder(from.directory, input.from, () => noSource(input.from))
  try {
    const landing = openFolder(target.directory, judged.landing, () => parentMissing(context.paths.display(target.directory)))
    try {
      const kind = kindOf(lstatOrNone(source.child(from.name)))
      if (kind === 'missing') throw noSource(input.from)
      if (kind === 'other') throw notMovable(input.from)
      if (kind !== judged.from.kind) throw new ToolInputError(`${input.from} is a ${kind} now, not the ${judged.from.kind} its permission check saw, so nothing was moved; send the call again`, { code: 'PERMISSION_DENIED' })
      if (kind === 'directory' && !judged.from.tree?.counted && countTree(source, from.name, input.from).more) throw tooLarge(input.from)
      const standing = standingAt(source.child(from.name), landing.child(target.name))
      if (standing === 'same') throw new ToolInputError(`${input.from} and ${judged.landing} name the same file, so nothing was moved`)
      if (standing !== 'missing') {
        if (!input.replace) throw taken(judged.landing)
        if (standing === 'directory') throw folderAtLanding(judged.landing)
        if (!judged.replaces) throw new ToolInputError(`Something now stands at ${judged.landing} that its permission check did not see, so nothing was moved; send the call again`, { code: 'PERMISSION_DENIED' })
      }
      const ends: Ends = { source, name: from.name, landing, as: target.name, shown: input.from, replaces: standing !== 'missing', folder: kind === 'directory', io, platform: context.platform ?? process.platform }
      const moved = await renameOrCopy(ends)
      // A folder moved across devices whose removal stopped part way: the copy is whole, the rest is named.
      context.relocated?.(from.path, target.path)
      const rest: JsonObject = moved.rest === undefined ? {} : { leftOver: context.paths.display(`${from.directory}/${moved.rest}`) }
      return { from: context.paths.display(from.path), to: context.paths.display(target.path), replaced: ends.replaces, ...(moved.copied ? { copied: true } : {}), ...rest }
    } finally { landing.close() }
  } finally { source.close() }
}

interface Ends { source: PinnedDirectory; name: string; landing: PinnedDirectory; as: string; shown: string; replaces: boolean; folder: boolean; io: MoveIo; platform: NodeJS.Platform }

/**
 * A rename where one device holds both ends; a copy where it answers EXDEV. What the move did: whether it copied, and
 * where a folder copied across devices left part of itself behind (copyAcross).
 */
async function renameOrCopy(ends: Ends): Promise<{ copied: boolean; rest?: string }> {
  // A folder lands where a file stood only once that file is set aside: rename does not put one over the other.
  const aside = ends.replaces && ends.folder ? setAside(ends.landing, ends.as, ends.io) : null
  try {
    await renamed(ends, ends.source.child(ends.name), ends.landing.child(ends.as))
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      if (aside) ends.io.rename(ends.landing.child(aside), ends.landing.child(ends.as))
      throw error
    }
    return { copied: true, ...await copyAcross(ends, aside) }
  }
  if (aside) await removeAside(ends, aside)
  return { copied: false }
}

/**
 * The move across devices: the source copied beside the landing, the file standing there set aside, the copy renamed
 * onto the landing, then the source taken from its place. Where any step fails before the source is gone, what the copy
 * made is removed and the file set aside is put back, so the source stays where it was. A folder is renamed aside in its
 * own folder before it is removed, so a removal that fails part way leaves the whole copy at the landing, and the move
 * answers with where the rest of the source is left (`rest`).
 */
async function copyAcross(ends: Ends, setAsideAlready: string | null): Promise<{ rest?: string }> {
  const partial = `${PARTIAL_PREFIX}${randomUUID()}`
  let aside = setAsideAlready
  let made = partial
  let away: string | null = null
  try {
    copyBeneath({ from: ends.source, name: ends.name, to: ends.landing, as: partial, shown: ends.shown })
    if (ends.replaces && aside === null) aside = setAside(ends.landing, ends.as, ends.io)
    // Nothing is replaced that the check did not see: a landing taken while the copy ran stays as it is.
    if (!ends.replaces && lstatSync(ends.landing.child(ends.as), { throwIfNoEntry: false }) !== undefined) throw taken(ends.shown)
    await renamed(ends, ends.landing.child(partial), ends.landing.child(ends.as))
    made = ends.as
    if (ends.folder) away = setAside(ends.source, ends.name, ends.io)
    else await removeBeneath({ directory: ends.source, name: ends.name, shown: ends.shown, tree: false, io: ends.io, platform: ends.platform })
  } catch (error) {
    if (lstatSync(ends.landing.child(made), { throwIfNoEntry: false }) !== undefined) await removeBeneath({ directory: ends.landing, name: made, shown: ends.shown, tree: true, io: ends.io, platform: ends.platform })
    if (aside) ends.io.rename(ends.landing.child(aside), ends.landing.child(ends.as))
    throw error instanceof ToolInputError ? error : new ToolInputError(`${ends.shown} could not be moved to the other device (${String(errorCode(error) ?? 'an error')}), so what the copy made was removed and ${ends.shown} is where it was`)
  }
  if (aside) await removeAside(ends, aside)
  if (away === null) return {}
  try {
    await removeBeneath({ directory: ends.source, name: away, shown: ends.shown, tree: true, io: ends.io, platform: ends.platform })
    return {}
  } catch {
    return { rest: away }
  }
}

/** The file a replacing move set aside, removed once the move stands. */
function removeAside(ends: Ends, aside: string): Promise<void> {
  return removeBeneath({ directory: ends.landing, name: aside, shown: ends.shown, tree: false, io: ends.io, platform: ends.platform })
}

async function renamed(ends: Ends, from: string, to: string): Promise<void> {
  try {
    await replaceFile(from, to, ends.io)
  } catch (error) {
    if (isHeldOpen(error)) throw new ToolInputError(`${ends.shown} is held open by another program, so it was not moved; close it and send the call again`, { code: 'ENTRY_HELD' })
    throw error
  }
}

function setAside(directory: PinnedDirectory, name: string, io: MoveIo): string {
  const aside = `${PARTIAL_PREFIX}${randomUUID()}`
  io.rename(directory.child(name), directory.child(aside))
  return aside
}

function openFolder(directory: string, shown: string, missing: () => ToolInputError): PinnedDirectory {
  try {
    return openRealDirectory(directory, { refusal: { shown, outcome: 'nothing was moved' } })
  } catch (error) {
    if (isMissingPathError(error)) throw missing()
    throw error
  }
}

function intoFolder(input: z.output<typeof schemas.moveInput>, paths: PathView, platform: NodeJS.Platform): boolean {
  if (endsInSeparator(input.to, platform)) return true
  return statSync(resolveTarget(paths.resolve(input.to), { shares: paths.shares }), { throwIfNoEntry: false })?.isDirectory() === true
}

/** A backslash is a separator on Windows alone; elsewhere it is part of a name, as in the path layer (refuseLanding). */
function endsInSeparator(named: string, platform: NodeJS.Platform): boolean {
  return (platform === 'win32' ? /[/\\]$/ : /\/$/).test(named)
}

function withoutSeparator(named: string, platform: NodeJS.Platform): string {
  const trimmed = named.replace(platform === 'win32' ? /[/\\]+$/ : /\/+$/, '')
  return trimmed === '' ? named.slice(0, 1) : trimmed
}

function counted(entry: Entry, named: string): TreeCount {
  const parent = openRealDirectory(entry.directory, { refusal: { shown: named, outcome: 'nothing was moved' } })
  try { return countTree(parent, entry.name, named) } finally { parent.close() }
}

function noSource(named: string): ToolInputError {
  return new ToolInputError(`There is no file or folder at ${named}, so nothing was moved`, { code: FILE_NOT_FOUND })
}

function notMovable(named: string): ToolInputError {
  return new ToolInputError(`${named} is neither a file, a link, nor a folder (a socket, a device, or a pipe), so it is not moved`)
}

function taken(named: string): ToolInputError {
  return new ToolInputError(`Something already stands at ${named}: send replace: true to replace it, or move to a name that is free`, { code: TARGET_EXISTS })
}

function folderAtLanding(named: string): ToolInputError {
  return new ToolInputError(`${named} is a folder, and a move replaces a file, never a folder: delete it first, or move into it by name`, { code: TARGET_EXISTS })
}

function parentMissing(folder: string): ToolInputError {
  return new ToolInputError(`The folder ${folder} does not exist, and a move makes no folder: create it first, or move into one that exists`, { code: PARENT_MISSING })
}

function tooLarge(named: string): ToolInputError {
  return new ToolInputError(`${named} holds more than 10000 entries, more than one checkpoint covers: move the folder in parts`, { code: FOLDER_TOO_LARGE })
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
