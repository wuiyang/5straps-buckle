import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'pathe'
import { ToolInputError } from './tool.js'

/**
 * True when candidate is the directory itself or sits underneath it. Both must be absolute. Two paths from different
 * roots (pathRoot), such as two drives, are apart. The relative result is never read as a path of its own: pathe's
 * isAbsolute takes `c:/x`, a folder named `c:` on Linux, for a drive, which put `<ws>/c:/x` outside its workspace.
 */
export function isInside(directory: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const from = resolvePath(directory)
  const to = resolvePath(candidate)
  if (pathRoot(from, platform) !== pathRoot(to, platform)) return false
  const fromDirectory = relative(from, to)
  return fromDirectory !== '..' && !fromDirectory.startsWith('../') && !(platform !== 'win32' && fromDirectory.startsWith('/'))
}

export function isInsideAny(directories: string[], candidate: string, platform?: NodeJS.Platform): boolean {
  return directories.some(directory => isInside(directory, candidate, platform))
}

/**
 * A path the operating system or a person hands Buckle (a real path, the working or home directory, a state
 * directory, a workspace root) in the form pathe gives every path: forward slashes, `.` and `..` folded, a drive
 * letter in upper case. What unsupportedPath names is refused rather than read as another place. On Linux and macOS
 * only a leading `/` is absolute and a leading `//` is the root, as the kernel reads them, where pathe would keep `//x`
 * as a Windows share and read `//.x` as relative; the folded path is refused where it lands on a drive (refuseDrive).
 */
export function nativePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const named = withForwardSlashes(path, platform)
  return refuseDrive(onDrive([platform === 'win32' ? named : named.replace(/^\/{2,}/, '/')], first => normalize(first)), path, platform)
}

/**
 * pathe's resolve, with a drive kept: pathe resolves `C:/` and `C:/a/..` to `/C:`, and `C:/a/../..` to `/`, a folder
 * or the root of whichever drive is current, so a workspace at a drive's root held none of its files and `C:/` held
 * `D:/`. Here a path that starts on a drive is resolved beneath that drive's root, which a `..` cannot climb past, as
 * Windows does, and a bare drive is `C:/`, never `/C:`. A relative path is resolved against the working directory.
 */
export function resolvePath(...paths: string[]): string {
  const all = [process.cwd(), ...paths]
  return onDrive(all.slice(all.findLastIndex(path => isAbsolute(path))), (first, rest) => resolve(first, ...rest))
}

/**
 * pathe's resolve or normalize (`fold`), starting from `first`: when it starts on a drive, the rest is folded beneath
 * `/`, where a `..` stops, and put back on the drive. pathe drops a drive a `..` climbs past, and leaves a bare one
 * as `/C:` (driveForm).
 */
function onDrive(paths: string[], fold: (first: string, rest: string[]) => string): string {
  const [first = '', ...rest] = paths
  const drive = /^([A-Za-z]):[\\/]/.exec(first)
  if (!drive) return driveForm(fold(first, rest))
  const below = fold(`/${first.slice(3)}`, rest)
  return below.startsWith('/') ? `${drive[1]!.toUpperCase()}:${below}` : driveForm(below)
}

/** A drive in the form pathe gives a drive path elsewhere: `/C:` is `C:/`, and the letter is upper case. */
function driveForm(path: string): string {
  const bare = /^\/([A-Za-z]):$/.exec(path)
  if (bare) return `${bare[1]!.toUpperCase()}:/`
  return /^[a-z]:\//.test(path) ? `${path[0]!.toUpperCase()}${path.slice(1)}` : path
}

/**
 * A path pathe folded or resolved, refused off Windows where it starts with a drive letter: pathe folds `./C:/x`,
 * `/C:/x`, `a/../C:/x`, and `/ws/../C:/x` to `C:/x`, which the kernel there opens relative to the working directory.
 * `named` is the path as it was handed over, for the refusal.
 */
export function refuseDrive(path: string, named: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' && DRIVE_FIRST.test(path)) throw unsupported(named, 'lands on a drive letter once `.`, `..`, and repeated slashes are folded, which Buckle reads as a Windows drive')
  return path
}

/** A drive letter that starts a path: `C:` alone or before a separator. */
const DRIVE_FIRST = /^[A-Za-z]:(?:[\\/]|$)/
/** A drive pathe's own resolve leaves bare, `/C:` alone or before a separator. */
const ROOTED_DRIVE = /^\/[A-Za-z]:(?:\/|$)/

/** The working directory in pathe's form (nativePath). */
export function workingDirectory(platform: NodeJS.Platform = process.platform): string {
  return nativePath(process.cwd(), platform)
}

/** The home directory in pathe's form (nativePath). */
export function homeDirectory(platform: NodeJS.Platform = process.platform): string {
  return nativePath(homedir(), platform)
}

/** A path a person typed, absolute or relative to the working directory, as an absolute path in pathe's form. */
export function typedPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const named = nativePath(path, platform)
  return isAbsolute(named) ? resolvePath(named) : resolvePath(workingDirectory(platform), named)
}

/**
 * A path with its separators as pathe writes them and nothing folded, for a link target, whose `..` climbs from where
 * the component before it really lands. Refused where unsupportedPath says.
 */
export function withForwardSlashes(path: string, platform: NodeJS.Platform = process.platform): string {
  const reason = unsupportedPath(path, platform)
  if (reason) throw unsupported(path, reason)
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

function unsupported(path: string, reason: string): ToolInputError {
  return new ToolInputError(`${path} ${reason}, so Buckle refuses it rather than read it as another path`, { code: 'PERMISSION_DENIED' })
}

/**
 * Why pathe cannot name a path as the operating system does. On Windows, a network share or a device path
 * (`\\server\share`, `\\?\C:\`): pathe's resolve reads `//server/share` as `/server/share`, a folder on the current
 * drive, so a root there would be judged in one place and reached in another. Also on Windows, a colon anywhere but
 * after a drive letter that starts the path and comes before a separator or the end: NTFS reads `notes.txt:payload`
 * and `.env::$DATA` as a stream of the file, which listings and history never see, and `D:foo` as a path relative to
 * that drive's working directory. Elsewhere, a backslash, which is part of a name there and a separator to pathe, and
 * a leading drive letter (`c:/x`), which pathe reads as a Windows drive and the kernel as a name in the working
 * directory.
 */
function unsupportedPath(path: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(path)) return 'is on a network share or is a device path, which Buckle does not use on Windows'
    return path.replace(DRIVE_FIRST, '').includes(':') ? 'holds a colon that is not a drive letter\'s, which Windows reads as a file stream or a drive\'s working directory' : null
  }
  if (path.includes('\\')) return 'holds a backslash, which Buckle reads as a separator'
  return DRIVE_FIRST.test(path) ? 'starts with a drive letter, which Buckle reads as a Windows drive' : null
}

/**
 * The root a path in pathe's form starts from: `/`, a drive (`C:/`), or a share (`//server/share/`); empty when it is
 * relative. A drive letter alone (`C:`) names that drive's working directory, so it is relative. On Windows `/C:`, the
 * form pathe's own resolve gives a bare drive, is that drive (resolvePath never gives it); elsewhere it is a folder at
 * the root.
 */
export function pathRoot(path: string, platform: NodeJS.Platform = process.platform): string {
  const share = /^\/\/[^/]+\/[^/]+/.exec(path)
  if (share) return `${share[0]}/`
  if (/^[A-Za-z]:\//.test(path)) return `${path[0]!.toUpperCase()}:/`
  if (platform === 'win32' && ROOTED_DRIVE.test(path)) return `${path[1]!.toUpperCase()}:/`
  return path.startsWith('/') ? '/' : ''
}

/**
 * The directory above a path, and the root itself at a root, so a walk up ends where the parent is the path itself.
 * pathe's dirname goes on from `C:/` to `/`, and from a share to its server.
 */
export function parentDirectory(path: string): string {
  const root = pathRoot(path)
  if (root !== '' && (path === root || `${path}/` === root)) return root
  const parent = dirname(path)
  return parent.length < root.length ? root : parent
}

/** Each directory from an absolute path's root down to the path itself: `C:/a/b` gives `C:/`, `C:/a`, `C:/a/b`. */
export function descent(path: string): string[] {
  const steps = [pathRoot(path)]
  for (const name of path.slice(steps[0]!.length).split('/').filter(Boolean)) steps.push(join(steps.at(-1)!, name))
  return steps
}

/**
 * Whether a directory entry's name is one name pathe reads as itself. On Linux and macOS a name may hold a backslash,
 * which pathe reads as a separator, so `a\..\..\x` would be judged as a path two levels up while the kernel opens the
 * entry itself; such an entry is skipped or refused, never judged as another path.
 */
export function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name)
}

/**
 * A directory entry named relative to the root a walk started from, its name as listed: a name that is not one plain
 * name (a backslash on Linux) is shown with its backslash, never read as separators. `directory` is in pathe's form.
 */
export function entryBelowRoot(root: string, directory: string, name: string): string {
  const below = relative(root, directory)
  return below === '' ? name : `${below}/${name}`
}

/**
 * A path as the filesystem compares it: macOS's and Windows' default volumes ignore case (macOS also
 * Unicode normalization), so there a path is folded before a boundary compares it; elsewhere exactly.
 * The fold is upper then lower case, which Unicode defines without a locale, so the long s (U+017F)
 * and the final sigma fold to `s` and `σ` as case folding does; toLowerCase alone kept them. It folds
 * at least as much as a volume does, so only restrictions (protected roots, owner deny and ask rules)
 * compare by it: a wider fold there denies more, never less.
 */
export function comparablePath(path: string, caseInsensitive = ignoresCase()): string {
  return caseInsensitive ? path.normalize('NFC').toUpperCase().toLowerCase() : path
}

/** Whether a platform's default volume ignores case, as macOS's and Windows' do (comparablePath). */
export function ignoresCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * isInside on paths as the filesystem compares them: a case variant of a root is that root where the
 * disk ignores case, so a restriction never answers by spelling (review H2 of the second
 * proof-of-possession re-review). Restrictions only: see comparablePath.
 */
export function isInsideComparable(directory: string, candidate: string, caseInsensitive?: boolean, platform?: NodeJS.Platform): boolean {
  return isInside(comparablePath(directory, caseInsensitive), comparablePath(candidate, caseInsensitive), platform)
}

/** Path segments, case-folded, for pattern rules that must not be defeated by casing. */
export function segments(path: string): string[] {
  return path.split(sep).filter(Boolean).map(segment => segment.toLowerCase())
}
