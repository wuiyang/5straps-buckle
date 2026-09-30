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
 */
export function comparablePath(path: string, caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'): string {
  return caseInsensitive ? path.normalize('NFC').toLowerCase() : path
}

/** Path segments, case-folded, for pattern rules that must not be defeated by casing. */
export function segments(path: string): string[] {
  return path.split(sep).filter(Boolean).map(segment => segment.toLowerCase())
}
