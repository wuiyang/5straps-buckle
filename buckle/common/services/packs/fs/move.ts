import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, type BigIntStats } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { basename } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import type { z } from 'zod'
import { openRealDirectory, type PinnedDirectory } from '../../../adapters/beneath.js'
import { copyBeneath, type SymlinkIo } from '../../../adapters/copy-beneath.js'
import { PARTIAL_PREFIX } from '../../../adapters/replace-beneath.js'
import { countTree, removeBeneath, type RemoveIo } from '../../../adapters/remove-beneath.js'
import { replaceFile, type RenameIo } from '../../../adapters/replace-file.js'
import { isHeldOpen } from '../../../domain/filesystem-errors.js'
import { inWorkspaceFolder } from '../../../domain/delete-policy.js'
import type { ToolEffect, TreeCount } from '../../../domain/effect.js'
import type { PathView } from '../../../domain/path-view.js'
import { isInside, isInsideAny } from '../../../domain/paths.js'
import { ToolInputError } from '../../../domain/tool.js'
import { isMissingPathError } from '../../../domain/filesystem-errors.js'
import { resolveTarget } from '../../invocation/real-path.js'
import { entryOf, kindOf, lstatOrNone, type Entry, type EntryKind } from './delete.js'
import { auditedPath, FILE_NOT_FOUND, PARENT_MISSING } from './transfer.js'
import type * as schemas from './schemas.js'

/** A landing where something stands already, which `replace: false` (the default) refuses. */
export const TARGET_EXISTS = 'TARGET_EXISTS'
/** `replace: true` where nothing stands at the landing: the flag says what the caller expects there, and nothing is there. */
export const NOTHING_TO_REPLACE = 'NOTHING_TO_REPLACE'
/** A folder too large for its checkpoint to cover whole (MAX_COUNTED_ENTRIES). */
export const FOLDER_TOO_LARGE = 'FOLDER_TOO_LARGE'

/** The renames, removals, links, and pause a move uses; a test hands in its own. */
export type MoveIo = RenameIo & RemoveIo & { symlink?: SymlinkIo }

/**
 * A file or folder set aside while a move across devices runs: hidden and new for each one, and not named as the partial
 * deliveries fs_receive sweeps by age (PARTIAL_PREFIX), so a set-aside original that could not be put back is never swept.
 */
const ASIDE_PREFIX = '.buckle-aside-'

const SYSTEM_MOVE: MoveIo = { rename: renameSync, unlink: unlinkSync, rmdir: rmdirSync, pause: ms => delay(ms) }

/**
 * A move as it stood before any rule judged it: the source and what it is, where it lands (`to` itself, or `to/<name>`
 * where `to` is a folder or ends in a separator), what stands there, and whether the move replaces it. `target.tree`:
 * what a folder at the landing holds, counted where the move replaces it and it lies inside the roots the agent may name.
 */
export interface SettledMove {
  from: Entry & { kind: EntryKind; tree?: TreeCount }
  /** The landing as the agent's path names it, which its effects name and its run opens. */
  landing: string
  target: Entry & { kind: EntryKind | 'same'; tree?: TreeCount }
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
 * what a folder moved whole holds. `replace` states what the caller expects at the landing, and a mismatch is a refusal
 * either way: anything standing there without it, nothing standing there with it. A folder standing there is replaced
 * whole, and counted as fs_delete counts one removed whole. Inside the roots the agent may name, a move that would not
 * happen is refused at once, so no person is asked about it: no source, a landing taken without `replace`, nothing at the
 * landing with it, a missing folder to land in (a move makes none), a folder moved into itself or a landing folder that
 * holds the source, or a folder moved or replaced past the entries its checkpoint covers. Elsewhere the same refusals
 * come once a person allowed the call.
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
  if (targetKind === 'missing') {
    if (input.replace) refuseInside(target.path, () => nothingToReplace(named))
  } else {
    if (!input.replace) refuseInside(target.path, () => taken(named))
    if (input.replace && targetKind === 'directory' && isInside(target.path, from.path)) throw holdsSource(named, input.from)
  }
  const tree = fromKind === 'directory' ? (inside(from.path) ? counted(from, input.from) : { counted: false as const }) : undefined
  if (tree?.counted && tree.more) throw tooLarge(input.from)
  // A folder replaced is removed whole, so it is counted as a recursive delete counts one, names an entry Buckle cannot remove by name, and has the same bound.
  const replacedTree = targetKind === 'directory' && input.replace ? (inside(target.path) ? counted(target, named, true) : { counted: false as const }) : undefined
  if (replacedTree?.counted && replacedTree.more) throw tooLarge(named, true)
  return { from: { ...from, kind: fromKind, ...(tree ? { tree } : {}) }, landing: named, target: { ...target, kind: targetKind, ...(replacedTree ? { tree: replacedTree } : {}) }, replaces: input.replace && targetKind !== 'missing' }
}

/**
 * What stands at a landing beside its source: nothing, an entry of its own, or the source's own file under another name.
 * Where the volume ignores case, a landing that differs from the source in case alone is the same entry, which a rename
 * renames (`missing`); any other name of the same file, and a case-only name on a volume that keeps case (two hard
 * links of one file), is a hard link, which a rename would leave both of (`same`). Files are told apart by the whole
 * of their volume and file numbers (bigint), as numbers past 2^53 would otherwise compare equal.
 */
export function standingAt(source: string, landing: string, stat: (path: string) => BigIntStats | undefined = lstatBigOrNone): EntryKind | 'same' {
  const standing = stat(landing)
  const kind = kindOf(standing)
  const own = stat(source)
  if (standing === undefined || own === undefined || standing.ino !== own.ino || standing.dev !== own.dev || standing.ino === 0n) return kind
  return basename(source).toLowerCase() === basename(landing).toLowerCase() && basename(source) !== basename(landing) && volumeIgnoresCase(source, own) ? 'missing' : 'same'
}

function lstatBigOrNone(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/** Whether the volume of `path` ignores case: its own name, spelled in the other case, is the same file. */
function volumeIgnoresCase(path: string, own: BigIntStats): boolean {
  const name = basename(path)
  const swapped = [...name].map(character => (character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase())).join('')
  if (swapped === name) return false
  const probe = lstatBigOrNone(`${path.slice(0, path.length - name.length)}${swapped}`)
  return probe !== undefined && probe.ino === own.ino && probe.dev === own.dev
}

/**
 * fs_move's effects: the source read and removed from its place, and the landing written. The source's removal asks at
 * the destructive floor where the move takes a folder whole or replaces what stands at the landing (the fs-verbs
 * brief); a file moved where nothing stands asks as a write to each folder does. What is replaced is removed at the
 * floor as well: a file or a link under its folder's delete subject, a folder removed whole under its own
 * `delete-tree` subject with the count of what it holds, as a recursive fs_delete asks.
 *
 * A file that leaves a folder outside the workspace's folder for the inside of it is a delete at the floor as well: a
 * delete inside the folder runs under its write grant, so a file moved in, then deleted, would otherwise be gone from
 * where it stood with no one asked (the delete policy review, R2). A rename that stays outside, and a move out of
 * the folder, stay writes to the folders they touch.
 */
export function moveEffects(input: z.output<typeof schemas.moveInput>, judged: SettledMove, paths: PathView): ToolEffect[] {
  const folder = judged.from.kind === 'directory'
  const replacedFolder = judged.replaces && judged.target.kind === 'directory'
  const entersFolder = !inWorkspaceFolder(judged.from.path, paths) && inWorkspaceFolder(judged.target.path, paths)
  return [
    { kind: 'read_path', path: input.from },
    { kind: 'delete_path', path: input.from, floor: input.replace || folder || entersFolder, ...(folder && judged.from.tree ? { tree: judged.from.tree } : {}), ...(folder ? { moved: true as const } : {}) },
    { kind: 'write_path', path: judged.landing, entry: true, ...(folder ? { folder: true as const } : {}) },
    ...(judged.replaces ? [{ kind: 'delete_path' as const, path: judged.landing, floor: true, ...(replacedFolder && judged.target.tree ? { tree: judged.target.tree } : {}) }] : []),
  ]
}

/**
 * What the description names beside the arguments: the landing where it is not `to` itself, that the move replaces what
 * stands there, and for a folder, how many entries it holds where they were counted (not outside the workspace's folders).
 */
export function moveFacts(input: z.output<typeof schemas.moveInput>, judged: SettledMove): JsonObject {
  const folder = judged.replaces && judged.target.kind === 'directory'
  const held = folder && judged.target.tree?.counted ? judged.target.tree.files + judged.target.tree.folders : undefined
  return { ...(judged.landing === input.to ? {} : { landing: judged.landing }), replaces: judged.replaces, ...(folder ? { replacesFolder: true } : {}), ...(held === undefined ? {} : { entries: held }) }
}

/** fs_move's audit facts: both paths, credentials hidden. */
export function movedFacts(input: z.output<typeof schemas.moveInput>): JsonObject {
  return { from: auditedPath(input.from), to: auditedPath(input.to) }
}

/**
 * Moves the source to its landing where the permission check judged both, each folder reached without following a link:
 * a rename where both lie on one device, tried again where Windows holds the file (replaceFile); across devices or
 * mounts a copy beside the landing, then the rename onto it, then the source's removal, and a failure before that last
 * step leaves the source where it was and removes what the copy made. What stands at the landing is replaced only where
 * the call says `replace` and its check saw it; it is set aside first and removed once the move stands (a folder whole),
 * and put back where the move fails. Nothing standing there with `replace` is refused (NOTHING_TO_REPLACE).
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
      if (standing === 'missing') {
        if (input.replace) throw nothingToReplace(judged.landing)
      } else {
        if (!input.replace) throw taken(judged.landing)
        if (!judged.replaces) throw new ToolInputError(`Something now stands at ${judged.landing} that its permission check did not see, so nothing was moved; send the call again`, { code: 'PERMISSION_DENIED' })
        // A folder where the check saw a file (or the reverse) is another removal than the one a person allowed.
        if ((standing === 'directory') !== (judged.target.kind === 'directory')) throw new ToolInputError(`${judged.landing} is a ${standing === 'directory' ? 'folder' : 'file'} now, not the ${judged.target.kind === 'directory' ? 'folder' : 'file'} its permission check saw, so nothing was moved; send the call again`, { code: 'PERMISSION_DENIED' })
        if (standing === 'directory') {
          if (isInside(target.path, from.path)) throw holdsSource(judged.landing, input.from)
          if (!judged.target.tree?.counted && countTree(landing, target.name, judged.landing, context.platform ? { platform: context.platform } : {}).more) throw tooLarge(judged.landing, true)
        }
      }
      const ends: Ends = { source, name: from.name, landing, as: target.name, shown: input.from, landingShown: judged.landing, replaces: standing !== 'missing', folder: kind === 'directory', landingFolder: standing === 'directory', io, platform: context.platform ?? process.platform }
      const moved = await renameOrCopy(ends)
      context.relocated?.(from.path, target.path)
      // A folder moved across devices whose removal stopped part way, or a replaced entry that could not be removed whole: what the move landed is whole, the rest is named.
      const rest: JsonObject = moved.rest.length === 0 ? {} : { leftOver: moved.rest.map(left => context.paths.display(`${left.in === 'source' ? from.directory : target.directory}/${left.name}`)).join(', ') }
      return { from: context.paths.display(from.path), to: context.paths.display(target.path), replaced: ends.replaces, ...(moved.copied ? { copied: true } : {}), ...rest }
    } finally { landing.close() }
  } finally { source.close() }
}

interface Ends { source: PinnedDirectory; name: string; landing: PinnedDirectory; as: string; shown: string; /** The landing as the agent's path names it, for what concerns it. */ landingShown: string; replaces: boolean; folder: boolean; /** What stands at the landing, and is replaced, is a folder. */ landingFolder: boolean; io: MoveIo; platform: NodeJS.Platform }

/** What a move left behind in one of its two folders: the source's, or the landing's. */
interface Left { in: 'source' | 'landing'; name: string }

/**
 * A rename where one device holds both ends; a copy where it answers EXDEV. What the move did: whether it copied, and
 * what it left behind: part of a folder copied across devices, or what a replacement could not remove (copyAcross).
 */
async function renameOrCopy(ends: Ends): Promise<{ copied: boolean; rest: Left[] }> {
  // A folder lands where a file stood, and a file or a folder where a folder stood, only once that entry is set aside: rename does not put one over the other.
  const aside = ends.replaces && (ends.folder || ends.landingFolder) ? setAside(ends.landing, ends.as, ends.io) : null
  try {
    await renamed(ends, ends.source.child(ends.name), ends.landing.child(ends.as))
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      if (aside) ends.io.rename(ends.landing.child(aside), ends.landing.child(ends.as))
      throw error
    }
    return { copied: true, rest: await copyAcross(ends, aside) }
  }
  return { copied: false, rest: await removeAside(ends, aside) }
}

/**
 * The move across devices: the source copied beside the landing, the file standing there set aside, the copy renamed
 * onto the landing, then the source taken from its place. Where any step fails before the source is gone, what the copy
 * made is removed and the entry set aside is put back, so the source stays where it was. A folder is renamed aside in its
 * own folder before it is removed, so a removal that fails part way leaves the whole copy at the landing, and the move
 * answers with where the rest of the source is left, and of what it replaced.
 */
async function copyAcross(ends: Ends, setAsideAlready: string | null): Promise<Left[]> {
  const partial = `${PARTIAL_PREFIX}${randomUUID()}`
  let aside = setAsideAlready
  let made = partial
  let away: string | null = null
  try {
    copyBeneath({ from: ends.source, name: ends.name, to: ends.landing, as: partial, shown: ends.shown, platform: ends.platform, ...(ends.io.symlink ? { symlink: ends.io.symlink } : {}) })
    if (ends.replaces && aside === null) aside = setAside(ends.landing, ends.as, ends.io)
    // Nothing is replaced that the check did not see: a landing taken while the copy ran stays as it is.
    if (!ends.replaces && lstatSync(ends.landing.child(ends.as), { throwIfNoEntry: false }) !== undefined) throw taken(ends.landingShown)
    await renamed(ends, ends.landing.child(partial), ends.landing.child(ends.as))
    made = ends.as
    if (ends.folder) away = setAside(ends.source, ends.name, ends.io)
    else await removeBeneath({ directory: ends.source, name: ends.name, shown: ends.shown, tree: false, io: ends.io, platform: ends.platform })
  } catch (error) {
    // Both clean-up steps run whatever the first does: the file set aside goes back even where the copy cannot be removed,
    // and a file renamed onto a copy that is a file replaces it.
    const trouble: string[] = []
    let copyTrouble: string | null = null
    try {
      if (lstatSync(ends.landing.child(made), { throwIfNoEntry: false }) !== undefined) await removeBeneath({ directory: ends.landing, name: made, shown: ends.landingShown, tree: true, io: ends.io, platform: ends.platform })
    } catch (cleanup) { copyTrouble = `the copy at ${ends.landingShown} could not be removed (${String(errorCode(cleanup) ?? 'an error')})` }
    let restored = false
    try {
      if (aside) { ends.io.rename(ends.landing.child(aside), ends.landing.child(ends.as)); restored = true }
    } catch (restore) { trouble.push(`the ${ends.landingFolder ? 'folder' : 'file'} it replaces could not be put back (${String(errorCode(restore) ?? 'an error')}) and is kept beside it as ${aside}`) }
    if (copyTrouble !== null && !(restored && !ends.folder && !ends.landingFolder)) trouble.unshift(copyTrouble)
    const reason = error instanceof ToolInputError ? error.message : `${ends.shown} could not be moved to the other device (${String(errorCode(error) ?? 'an error')}), so what the copy made was removed and ${ends.shown} is where it was`
    if (trouble.length === 0) throw error instanceof ToolInputError ? error : new ToolInputError(reason)
    throw new ToolInputError(`${reason.replace(/, so what the copy made was removed and .* is where it was$/, '')}; ${trouble.join(', and ')}; ${ends.shown} is where it was`, { code: error instanceof ToolInputError ? error.code : 'MOVE_FAILED' })
  }
  const rest = await removeAside(ends, aside)
  if (away === null) return rest
  try {
    await removeBeneath({ directory: ends.source, name: away, shown: ends.shown, tree: true, io: ends.io, platform: ends.platform })
    return rest
  } catch {
    return [{ in: 'source', name: away }, ...rest]
  }
}

/**
 * The entry a replacing move set aside, removed once the move stands, a folder with everything in it. The move has landed
 * by then, so a removal that fails (a read-only file inside, a lock) is not the move's failure: what is left is named.
 */
async function removeAside(ends: Ends, aside: string | null): Promise<Left[]> {
  if (aside === null) return []
  try {
    await removeBeneath({ directory: ends.landing, name: aside, shown: ends.landingShown, tree: ends.landingFolder, io: ends.io, platform: ends.platform })
    return []
  } catch {
    return [{ in: 'landing', name: aside }]
  }
}

async function renamed(ends: Ends, from: string, to: string): Promise<void> {
  try {
    await replaceFile(from, to, ends.io)
  } catch (error) {
    // A move across devices is told by this code alone; the copy takes it up (renameOrCopy).
    if (errorCode(error) === 'EXDEV' || error instanceof ToolInputError) throw error
    // Only Windows reads these as a program holding the file; elsewhere they are a sticky folder, an immutable file, or a mount point.
    if (ends.platform === 'win32' && isHeldOpen(error)) {
      const held = ends.replaces ? `${ends.shown} or ${ends.landingShown}, the file it replaces, is` : `${ends.shown} is`
      throw new ToolInputError(`${held} held open by another program, so it was not moved; close it and send the call again`, { code: 'ENTRY_HELD' })
    }
    const code = String(errorCode(error) ?? 'an error')
    throw new ToolInputError(`${ends.shown} could not be moved to ${ends.landingShown} (${code}), so it was not moved`, { code: ['EACCES', 'EPERM', 'EROFS'].includes(code) ? 'PERMISSION_DENIED' : 'MOVE_FAILED' })
  }
}

function setAside(directory: PinnedDirectory, name: string, io: MoveIo): string {
  const aside = `${ASIDE_PREFIX}${randomUUID()}`
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

/** What a folder holds; with `removal`, as a folder that is removed whole: an entry Buckle cannot remove by name is refused now, with nothing yet changed. */
function counted(entry: Entry, named: string, removal = false): TreeCount {
  const parent = openRealDirectory(entry.directory, { refusal: { shown: named, outcome: 'nothing was moved' } })
  try { return countTree(parent, entry.name, named, removal ? {} : undefined) } finally { parent.close() }
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

function nothingToReplace(named: string): ToolInputError {
  return new ToolInputError(`Nothing stands at ${named}, so replace: true has nothing to replace and nothing was moved: send replace: false to move there`, { code: NOTHING_TO_REPLACE })
}

function holdsSource(landing: string, source: string): ToolInputError {
  return new ToolInputError(`${landing} is a folder that holds ${source}, so replacing it would remove what is being moved`)
}

function parentMissing(folder: string): ToolInputError {
  return new ToolInputError(`The folder ${folder} does not exist, and a move makes no folder: create it first, or move into one that exists`, { code: PARENT_MISSING })
}

function tooLarge(named: string, replaced = false): ToolInputError {
  return new ToolInputError(`${named} holds more than 10000 entries, more than one checkpoint covers: ${replaced ? 'delete the folder in parts first, then move' : 'move the folder in parts'}`, { code: FOLDER_TOO_LARGE })
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
