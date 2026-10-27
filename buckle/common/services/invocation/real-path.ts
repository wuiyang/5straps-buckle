import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { basename } from 'pathe'
import { childPath, isPlainName, nativePath, parentDirectory, pathRoot, refuseDrive, withForwardSlashes } from '../../domain/paths.js'
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
 * is refused. `absolutePath` is in pathe's form; the walk starts from its own root (`/`, or a drive
 * such as `C:/`), and every path the system answers with is read back into that form (nativePath).
 * Each name is appended as text (childPath), so on Linux and macOS a link to `/c:` is walked to the
 * folder `c:` at the root, and a landing there is refused (refuseDrive), as pathe would read it as a drive.
 */
export function resolveTarget(absolutePath: string, landing: LandingRead = {}): string {
  return refuseDrive(whereItLands(absolutePath, landing), absolutePath)
}

/**
 * How a landing is read: `shares`, on Windows the sources of the workspace's mounts on a network share, where a path on
 * a share may land (D84 (1)); none elsewhere, so a share stays refused. `platform`: the host's unless a test imitates
 * another.
 */
export interface LandingRead { shares?: readonly string[]; platform?: NodeJS.Platform }

function whereItLands(absolutePath: string, landing: LandingRead): string {
  const read = (path: string) => nativePath(path, landing.platform, landing.shares)
  let real: string
  try {
    // The C library's realpath, as the kernel resolves: Node's own folds a link target's `..` as text.
    real = realpathSync.native(absolutePath)
  } catch (error) {
    if (isLinkLoop(error)) throw tooManyLinks(absolutePath)
    if (!isMissingPathError(error)) throw error
    const root = pathRoot(absolutePath)
    if (root === '') throw new ToolInputError(`${absolutePath} is not an absolute path, so where it lands cannot be checked`)
    const walked = walk(root, absolutePath.slice(root.length).split('/'), { links: 0 }, read)
    return walked.kind === 'directory' ? diskCase(walked.path, read) : walked.path
  }
  return read(real)
}

/**
 * Where an entry really is, the entry itself and never what a link there points to: its folder resolved as resolveTarget
 * resolves any path, and its own name kept as written, as a delete unlinks a link and a move moves or replaces it. Null
 * where the path names no entry in a folder: a root (`/`, a drive), or a name Buckle would read as another path.
 */
export function resolveEntry(absolutePath: string, landing: LandingRead = {}): { path: string; directory: string; name: string } | null {
  const parent = parentDirectory(absolutePath)
  const name = basename(absolutePath)
  if (parent === absolutePath || !isPlainName(name, landing.platform)) return null
  const directory = resolveTarget(parent, landing)
  return { path: childPath(directory, name), directory, name }
}

/** The same resolution for callers that await; kept async so a later non-blocking lookup changes no caller. */
export async function realPathOrPlanned(absolutePath: string, landing: LandingRead = {}): Promise<string> {
  return resolveTarget(absolutePath, landing)
}

/**
 * Where a walk ended: an existing directory, anything else that exists (a file), or a place that does
 * not exist yet. Only a directory has anything beneath it (review L2 of the second re-review).
 */
interface Landing { path: string; kind: 'directory' | 'other' | 'missing' }

function walk(start: string, parts: string[], budget: { links: number }, read: (path: string) => string): Landing {
  let current = start
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue
    if (part === '..') { current = parentDirectory(current); continue }
    const next = childPath(current, part)
    const rest = parts.slice(index + 1)
    let info: Stats
    try {
      info = lstatSync(next)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      return { path: planned(childPath(diskCase(current, read), part), rest), kind: 'missing' }
    }
    if (info.isSymbolicLink()) {
      if (++budget.links > MAX_LINKS) throw tooManyLinks(next)
      // Windows answers with backslashes; nothing is folded, so a `..` still climbs from where the link lands.
      const target = withForwardSlashes(readlinkSync(next))
      const root = pathRoot(target)
      const landing = walk(root === '' ? current : root, target.slice(root.length).split('/'), budget, read)
      if (landing.kind === 'directory') { current = landing.path; continue }
      return beyond(landing, rest)
    }
    if (!info.isDirectory()) return beyond({ path: diskCase(next, read), kind: 'other' }, rest)
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
  const names = rest.filter(part => part !== '' && part !== '.')
  return names.length === 0 ? missing : childPath(missing, names.join('/'))
}

/**
 * A link-free existing path as the disk names it (on macOS, in the case it stores); the text as it is
 * when the path went away meanwhile, which the pinned open then refuses or creates as judged.
 */
function diskCase(path: string, read: (path: string) => string): string {
  let real: string
  try { real = realpathSync.native(path) } catch { return path }
  return read(real)
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
