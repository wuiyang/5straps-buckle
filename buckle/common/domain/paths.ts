import { isAbsolute, relative, resolve, sep } from 'node:path'

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
