import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'pathe'
import { ToolInputError } from './tool.js'

/** True when candidate is the directory itself or sits underneath it. Both must be absolute. */
export function isInside(directory: string, candidate: string): boolean {
  const fromDirectory = relative(resolve(directory), resolve(candidate))
  if (fromDirectory === '') return true
  return !fromDirectory.startsWith('..') && !isAbsolute(fromDirectory)
}

export function isInsideAny(directories: string[], candidate: string): boolean {
  return directories.some(directory => isInside(directory, candidate))
}

/**
 * A path the operating system or a person hands Buckle (a real path, the working or home directory, a state
 * directory, a workspace root) in the form pathe gives every path: forward slashes, `.` and `..` folded, a drive
 * letter in upper case. What unsupportedPath names is refused rather than read as another place. On Linux and macOS a
 * leading `//` is the root, as the kernel reads it, where pathe would keep it as a Windows share.
 */
export function nativePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const normal = normalize(withForwardSlashes(path, platform))
  return platform !== 'win32' && normal.startsWith('//') ? normal.replace(/^\/+/, '/') : normal
}

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
  if (reason) throw new ToolInputError(`${path} ${reason}, so Buckle refuses it rather than read it as another path`, { code: 'PERMISSION_DENIED' })
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * Why pathe cannot name a path as the operating system does. On Windows, a network share or a device path
 * (`\\server\share`, `\\?\C:\`): pathe's resolve reads `//server/share` as `/server/share`, a folder on the current
 * drive, so a root there would be judged in one place and reached in another. Elsewhere, a backslash, which is part of
 * a name there and a separator to pathe, and a leading drive letter (`c:/x`), which pathe reads as a Windows drive and
 * the kernel as a name in the working directory.
 */
function unsupportedPath(path: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return /^[\\/]{2}/.test(path) ? 'is on a network share or is a device path, which Buckle does not use on Windows' : null
  if (path.includes('\\')) return 'holds a backslash, which Buckle reads as a separator'
  return /^[A-Za-z]:(?:\/|$)/.test(path) ? 'starts with a drive letter, which Buckle reads as a Windows drive' : null
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
export function isInsideComparable(directory: string, candidate: string, caseInsensitive?: boolean): boolean {
  return isInside(comparablePath(directory, caseInsensitive), comparablePath(candidate, caseInsensitive))
}

/** Path segments, case-folded, for pattern rules that must not be defeated by casing. */
export function segments(path: string): string[] {
  return path.split(sep).filter(Boolean).map(segment => segment.toLowerCase())
}
