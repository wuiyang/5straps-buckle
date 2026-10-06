import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'pathe'
import { ToolInputError } from './tool.js'

/**
 * True when candidate is the directory itself or sits underneath it. Both must be absolute. Two paths from different
 * roots (pathRoot), such as two drives, are apart. The relative result is never read as a path of its own: pathe's
 * isAbsolute takes `c:/x`, a folder named `c:` on Linux, for a drive, which put `<ws>/c:/x` outside its workspace.
 */
export function isInside(directory: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const from = resolve(directory)
  const to = resolve(candidate)
  if (pathRoot(from) !== pathRoot(to)) return false
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
  return refuseDrive(normalize(platform === 'win32' ? named : named.replace(/^\/{2,}/, '/')), path, platform)
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

/** The working directory in pathe's form (nativePath). */
export function workingDirectory(): string {
  return nativePath(process.cwd())
}

/** The home directory in pathe's form (nativePath). */
export function homeDirectory(): string {
  return nativePath(homedir())
}

/** A path a person typed, absolute or relative to the working directory, as an absolute path in pathe's form. */
export function typedPath(path: string): string {
  const named = nativePath(path)
  return isAbsolute(named) ? resolve(named) : resolve(workingDirectory(), named)
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
 * relative. A drive letter alone (`C:`) names that drive's working directory, so it is relative.
 */
export function pathRoot(path: string): string {
  const share = /^\/\/[^/]+\/[^/]+/.exec(path)
  if (share) return `${share[0]}/`
  if (/^[A-Za-z]:\//.test(path)) return `${path[0]!.toUpperCase()}:/`
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
 * A path as the filesystem compares it: macOS's and Windows' default volumes ignore case (macOS also
 * Unicode normalization), so there a path is folded before a boundary compares it; elsewhere exactly.
 * The fold is upper then lower case, which Unicode defines without a locale, so the long s (U+017F)
 * and the final sigma fold to `s` and `σ` as case folding does; toLowerCase alone kept them. It folds
 * at least as much as a volume does, so only restrictions (protected roots, owner deny and ask rules)
 * compare by it: a wider fold there denies more, never less.
 */
export function comparablePath(path: string, caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'): string {
  return caseInsensitive ? path.normalize('NFC').toUpperCase().toLowerCase() : path
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
