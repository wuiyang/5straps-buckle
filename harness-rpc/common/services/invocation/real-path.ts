import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ToolInputError } from '../../domain/tool.js'

/** How many links one path may pass through, as Linux allows (SYMLOOP_MAX). */
const MAX_LINKS = 40

/**
 * Where a path really lands: the real path of an existing target, or, for one that does not exist
 * yet, where a write would create it. Each missing component is lstat'ed, so a dangling link is
 * followed to its target, recursively, instead of being judged by its own path while a write follows
 * it (review H1 and H2 of B23-B25). Link targets are resolved component by component, so a `..`
 * after a link climbs from where the link really points, as the kernel does. The existing part of a
 * planned path is named as the disk names it, so a case variant of an existing directory is judged
 * where it lands (review H2 of the second proof-of-possession re-review). A path that passes through
 * more than MAX_LINKS links, or climbs back out of a directory that does not exist or out of a file,
 * is refused.
 */
export function resolveTarget(absolutePath: string): string {
  try {
    // The C library's realpath, as the kernel resolves: Node's own folds a link target's `..` as text.
    return realpathSync.native(absolutePath)
  } catch (error) {
    if (isLinkLoop(error)) throw tooManyLinks(absolutePath)
    if (!isMissingPathError(error)) throw error
  }
  const landing = walk('/', absolutePath.split('/'), { links: 0 })
  return landing.kind === 'directory' ? diskCase(landing.path) : landing.path
}

/** The same resolution for callers that await; kept async so a later non-blocking lookup changes no caller. */
export async function realPathOrPlanned(absolutePath: string): Promise<string> {
  return resolveTarget(absolutePath)
}

/**
 * Where a walk ended: an existing directory, anything else that exists (a file), or a place that does
 * not exist yet. Only a directory has anything beneath it (review L2 of the second re-review).
 */
interface Landing { path: string; kind: 'directory' | 'other' | 'missing' }

function walk(start: string, parts: string[], budget: { links: number }): Landing {
  let current = start
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue
    if (part === '..') { current = dirname(current); continue }
    const next = join(current, part)
    const rest = parts.slice(index + 1)
    let info: Stats
    try {
      info = lstatSync(next)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      return { path: planned(join(diskCase(current), part), rest), kind: 'missing' }
    }
    if (info.isSymbolicLink()) {
      if (++budget.links > MAX_LINKS) throw tooManyLinks(next)
      const target = readlinkSync(next)
      const landing = walk(isAbsolute(target) ? '/' : current, target.split('/'), budget)
      if (landing.kind === 'directory') { current = landing.path; continue }
      return beyond(landing, rest)
    }
    if (!info.isDirectory()) return beyond({ path: diskCase(next), kind: 'other' }, rest)
    current = next
  }
  return { path: current, kind: 'directory' }
}

/**
 * The components after a landing that is not a directory: nothing exists beneath a missing directory
 * or a file, where the kernel answers ENOENT or ENOTDIR, so a `..` among them is refused rather than
 * folded as text (review L2 of the second re-review: `D -> nope` then `D/../x.txt`).
 */
function beyond(landing: Landing, rest: string[]): Landing {
  if (rest.every(part => part === '' || part === '.')) return landing
  return { path: planned(landing.path, rest), kind: 'missing' }
}

/**
 * Nothing exists beneath `missing`: the rest names where a write would create it. A `..` there climbs
 * out of a directory that does not exist, or out of a file, which the kernel answers ENOENT or ENOTDIR;
 * read as text it would name a path through links nobody followed (`a -> nope/../L/x`), so it is
 * refused (review item 0 of the proof-of-possession fixes). Only a link target can bring one here:
 * PathView already folded the agent's own.
 */
function planned(missing: string, rest: string[]): string {
  if (rest.includes('..')) throw new ToolInputError('A symbolic link in this path climbs back out of a directory that does not exist, or out of a file, so where it lands cannot be checked', { code: 'PERMISSION_DENIED' })
  return join(missing, ...rest)
}

/**
 * A link-free existing path as the disk names it (on macOS, in the case it stores); the text as it is
 * when the path went away meanwhile, which the pinned open then refuses or creates as judged.
 */
function diskCase(path: string): string {
  try { return realpathSync.native(path) } catch { return path }
}

function tooManyLinks(path: string): ToolInputError {
  return new ToolInputError(`${path} passes through more than ${MAX_LINKS} symbolic links, so where it lands cannot be checked`, { code: 'PERMISSION_DENIED' })
}

function isLinkLoop(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP'
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
